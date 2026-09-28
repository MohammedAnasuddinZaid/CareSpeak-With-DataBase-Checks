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

/** True when an App Password is configured, so the UI can hide the OTP option. */
export function mailConfigured(): boolean {
  return Boolean(env.smtp.user && env.smtp.pass);
}

const OTP_SUBJECT: Record<string, string> = {
  login: "Your CareSpeak sign-in code",
  signup: "Your CareSpeak verification code",
  verify_email: "Verify your CareSpeak email address",
  pin_reset: "Your CareSpeak security code",
};

export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: string,
): Promise<MailResult> {
  const ttlMinutes = Math.max(1, Math.round(env.otpTtl / 60));
  const subject = OTP_SUBJECT[purpose] ?? OTP_SUBJECT.login;

  const text = [
    `${env.smtp.fromName} sign-in code`,
    "",
    `    ${code}`,
    "",
    `This code expires in ${ttlMinutes} minutes.`,
    "",
    "If you did not request this code, you can ignore this email. Nobody at",
    "CareSpeak will ever ask you for this code by phone or in person.",
    "",
    "Never share it, including with someone claiming to be hospital staff.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0b1220;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e6edf7">
    <div style="max-width:520px;margin:0 auto;padding:32px 20px">
      <div style="background:#111c2e;border:1px solid #1f2f47;border-radius:16px;padding:28px">
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#6ea8ff">${escapeHtml(env.smtp.fromName)}</p>
        <h1 style="margin:0 0 20px;font-size:20px;font-weight:650">Sign-in code</h1>
        <div style="background:#0b1220;border:1px solid #2a3d5c;border-radius:12px;padding:22px;text-align:center">
          <div style="font-size:34px;font-weight:700;letter-spacing:.34em;font-variant-numeric:tabular-nums;color:#fff">${escapeHtml(code)}</div>
        </div>
        <p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#9fb2cc">
          This code expires in ${ttlMinutes} minutes.
        </p>
        <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6d819c">
          If you did not request it, ignore this email. Nobody from CareSpeak will ask you
          for this code by phone or in person, including anyone claiming to be hospital staff.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const tx = transporter();
  if (!tx) {
    return { delivered: false, reason: "SMTP is not configured (SMTP_USER / SMTP_APP_PASSWORD)" };
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
