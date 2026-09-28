/**
 * Outbound transactional email over SMTP (Gmail by default).
 *
 * Uses an App Password, never the account password: Google refuses plain
 * password auth for SMTP, and an App Password can be revoked on its own without
 * touching the account's real credentials.
 *
 * Delivery is best-effort by design. `sendMail` never throws -- an unreachable
 * SMTP server must not turn a login attempt into a 500, and it must not stop the
 * OTP row from being written (the user can still be told to check spam, and a
 * demo on a laptop with no network should still complete). The returned
 * `delivered` boolean is what the caller logs, so a misconfigured mailer is
 * visible in /api/health instead of silently eating every OTP.
 */
import nodemailer, { type Transporter } from "nodemailer";

import { env, loadDotEnv } from "./env";

loadDotEnv();

let cached: Transporter | null = null;
let cachedKey = "";

function transporter(): Transporter | null {
  const { user, pass, host, port, secure } = env.smtp;
  if (!user || !pass) return null;

  // Rebuild only if the configuration changed, so a test can point the mailer at
  // a different host without being served a stale connection.
  const key = `${host}:${port}:${secure}:${user}`;
  if (cached && cachedKey === key) return cached;

  cached = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // A hospital tablet on a ward network is not the public internet. Cap the
    // handshake so a blackholed port fails in seconds instead of hanging a
    // request thread for the socket default.
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });
  cachedKey = key;
  return cached;
}

export interface MailResult {
  delivered: boolean;
  reason?: string;
  messageId?: string;
}

/**
 * Which transport this deployment can actually use.
 *
 * `smtp` is fine from a laptop and wrong from Vercel: Gmail rejects sign-in
 * from datacenter IP ranges, so an OTP configured over Gmail silently stops
 * arriving the moment it is deployed. `resend` is plain HTTPS and works from
 * serverless, which is why it is preferred when a key is present.
 */
export type MailProvider = "resend" | "smtp" | "none";

export function mailProvider(): MailProvider {
  if (env.resendApiKey) return "resend";
  if (env.smtp.user && env.smtp.pass) return "smtp";
  return "none";
}

/** True when a usable transport is configured, so the UI can offer the OTP option. */
export function mailConfigured(): boolean {
  return mailProvider() !== "none";
}

/** Resend's testing sender. Only ever delivers to the Resend account owner. */
const RESEND_SANDBOX_FROM = "onboarding@resend.dev";

const FREE_MAIL_DOMAIN =
  /@(gmail|yahoo|hotmail|outlook|icloud|me|proton(mail)?|aol)\.[a-z]{2,}$/i;

/**
 * Resolve the From address Resend will accept.
 *
 * Resend refuses to send from an unverified domain, and a free-mail address can
 * never be verified -- gmail.com belongs to Google. Passing MAIL_FROM straight
 * through therefore produces a 403 on every send. The choice is:
 *
 *  - MAIL_FROM on a domain the operator has verified -> use it, real sending
 *  - MAIL_FROM is a free-mail address            -> fall back to the sandbox
 *
 * The sandbox is a real limitation, not a safe default: it delivers ONLY to the
 * email address registered on the Resend account. `mailRecipientScope` reports
 * that so a deployment cannot appear healthy while no patient can be reached.
 */
export function resolveResendFrom(): { from: string; sandbox: boolean } {
  const configured = (process.env.MAIL_FROM || "").trim();
  const fromName = env.smtp.fromName || "CareSpeak";

  if (!configured) return { from: RESEND_SANDBOX_FROM, sandbox: true };
  if (FREE_MAIL_DOMAIN.test(configured)) return { from: RESEND_SANDBOX_FROM, sandbox: true };

  return { from: `${fromName} <${configured}>`, sandbox: false };
}

/**
 * Who this deployment can actually reach.
 *
 * `all`     -- a verified sending domain, so any patient's address works.
 * `owner`   -- the Resend sandbox, which delivers only to the account owner's
 *              own email address. OTPs for any other patient will fail.
 */
export function mailRecipientScope(): "all" | "owner" | "unknown" {
  if (mailProvider() !== "resend") return "unknown";
  return resolveResendFrom().sandbox ? "owner" : "all";
}

/**
 * Send via the Resend HTTP API.
 *
 * Deliberately not SMTP: Resend's SMTP endpoint needs a long-lived connection
 * that serverless functions do not have, and the REST API needs nothing but
 * `fetch`, which is built in.
 */
async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<MailResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const message = `Resend ${res.status}: ${detail.slice(0, 300)}`;
      console.error("[mail] Resend delivery failed:", message);
      return { delivered: false, reason: message };
    }

    const data = (await res.json()) as { id?: string };
    return { delivered: true, messageId: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mail] Resend request failed:", message);
    return { delivered: false, reason: message };
  }
}

interface OtpCopy {
  title: string;
  subject: string;
  intro: string;
}

/**
 * Per-purpose copy, so a signup code and a PIN reset do not read identically.
 * A message that does not match what the user was doing is how a real code
 * becomes a convincing phishing lure.
 */
const OTP_SUBJECT: Record<string, OtpCopy> = {
  login: {
    title: "Your sign-in code",
    subject: "Your CareSpeak sign-in code",
    intro: "Use this code to sign in to your bedside console or ward dashboard.",
  },
  signup: {
    title: "Verify your email",
    subject: "Your CareSpeak verification code",
    intro: "Confirm this address to finish creating your CareSpeak account.",
  },
  verify_email: {
    title: "Confirm your email",
    subject: "Verify your CareSpeak email address",
    intro: "Confirm this address to secure your CareSpeak account.",
  },
  pin_reset: {
    title: "Reset your PIN",
    subject: "Your CareSpeak security code",
    intro: "Use this code to choose a new CareSpeak PIN.",
  },
};

export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: string,
): Promise<MailResult> {
  const ttlMinutes = Math.max(1, Math.round(env.otpTtl / 60));
  const copy = OTP_SUBJECT[purpose] ?? OTP_SUBJECT.login;
  const { title, subject, intro } = copy;
  const { brand } = env;

  const text = [
    `${brand.name} sign-in code`,
    "",
    `    ${code}`,
    "",
    intro,
    "",
    `This code expires in ${ttlMinutes} minutes.`,
    "",
    "If you did not request this code, you can ignore this email. Nobody at",
    `${brand.name} will ever ask you for this code by phone or in person.`,
    "",
    "Never share it, including with someone claiming to be hospital staff.",
    "",
    "--",
    `${brand.founder}`,
    `${brand.name} — ${brand.tagline}`,
    `Support: ${brand.supportEmail}`,
  ].join("\n");

  // Table layout and inline styles throughout. Email clients strip <style>
  // blocks, and animation is best-effort: Outlook and Gmail desktop ignore
  // @keyframes entirely. The code is therefore rendered as static, high-contrast
  // text FIRST, and every animation is decoration on top of something already
  // readable. A stripped animation must never cost someone their sign-in.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#070d18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf7;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(intro)} — your ${escapeHtml(brand.name)} code is ${escapeHtml(code)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070d18;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0f1a2e;border:1px solid #1e2f4a;border-radius:20px;overflow:hidden">

          <tr>
            <td style="padding:30px 30px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:15px;font-weight:700;letter-spacing:.02em;color:#ffffff">${escapeHtml(brand.name)}</p>
                    <p style="margin:2px 0 0;font-size:12px;letter-spacing:.06em;color:#6ea8ff">${escapeHtml(brand.tagline)}</p>
                  </td>
                  <td align="right" style="font-size:11px;color:#5b7292;letter-spacing:.1em;text-transform:uppercase">Sign-in</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 30px 0">
              <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:650;color:#ffffff">${escapeHtml(title)}</h1>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#9fb2cc">${escapeHtml(intro)}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 30px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#071120;border:1px solid #24395c;border-radius:16px">
                <tr>
                  <td align="center" style="padding:30px 16px">
                    <div style="font-size:40px;font-weight:700;letter-spacing:.3em;text-indent:.3em;font-variant-numeric:tabular-nums;color:#ffffff;line-height:1.1">${escapeHtml(code)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 30px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:70%;background:#1b3a5c;border-radius:999px;height:6px;font-size:0;line-height:0">&nbsp;</td>
                  <td width="30%" style="font-size:0;line-height:0">&nbsp;</td>
                </tr>
              </table>
              <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#7f95b3">
                Expires in <strong style="color:#c9d9ee;font-weight:600">${ttlMinutes} minutes</strong>. Enter it on the sign-in screen to reach your bedside console or ward dashboard.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 30px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1526;border:1px solid #1e2f4a;border-radius:12px">
                <tr>
                  <td style="padding:16px 18px">
                    <p style="margin:0 0 6px;font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:#e0a34a">Did not request this?</p>
                    <p style="margin:0;font-size:13px;line-height:1.65;color:#93a8c4">
                      Ignore this email and nothing happens. Nobody from ${escapeHtml(brand.name)} will ask you for this code by phone or in person, including anyone claiming to be hospital staff.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 30px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1e2f4a">
                <tr>
                  <td style="padding:20px 0 0">
                    <p style="margin:0;font-size:13px;font-weight:600;color:#c9d9ee">${escapeHtml(brand.founder)}</p>
                    <p style="margin:3px 0 0;font-size:12px;line-height:1.6;color:#7f95b3">Founder, ${escapeHtml(brand.name)}</p>
                    <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#5b7292">
                      Support: <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#6ea8ff;text-decoration:none">${escapeHtml(brand.supportEmail)}</a>
                    </p>
                  </td>
                  <td align="right" valign="top" style="padding:20px 0 0;font-size:11px;line-height:1.7;color:#4a6180">
                    ${escapeHtml(env.appOrigin.replace(/^https?:\/\//, ""))}<br>
                    Runs offline. Video stays on device.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="max-width:560px;margin:18px auto 0;font-size:11px;line-height:1.7;color:#41536d;text-align:center">
          Sent by ${escapeHtml(brand.name)} because a sign-in was requested for this address.<br>
          Clinical access is logged and encrypted.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Resend first when configured: it is the only transport that survives being
  // deployed, so an SMTP config left over from local dev must not take priority.
  if (env.resendApiKey) {
    return sendViaResend(env.resendApiKey, resolveResendFrom().from, to, subject, text, html);
  }

  const tx = transporter();
  if (!tx) {
    return {
      delivered: false,
      reason:
        "No mail transport configured: set RESEND_API_KEY (recommended, works on Vercel) or SMTP_USER + SMTP_APP_PASSWORD (local only).",
    };
  }

  try {
    const info = await tx.sendMail({
      from: { name: env.smtp.fromName, address: env.smtp.from },
      to,
      subject,
      text,
      html,
    });
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mail] OTP delivery failed:", message);
    return { delivered: false, reason: message };
  }
}

/** Escape interpolated values. The code is digits, but the from-name is not. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Close the pooled SMTP connection. Used by scripts and tests. */
export async function closeMailer(): Promise<void> {
  if (cached) {
    cached.close();
    cached = null;
    cachedKey = "";
  }
}
