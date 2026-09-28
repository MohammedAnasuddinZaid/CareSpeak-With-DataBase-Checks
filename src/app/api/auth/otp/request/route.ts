/**
 * POST /api/auth/otp/request -- email a one-time sign-in code.
 *
 * Always responds 200 with the same body whether or not the address exists.
 * A different status for an unknown address is an account-enumeration oracle,
 * which matters more here than usual: the address space is a hospital's staff
 * list, and "that email is not registered" is exactly the information an
 * attacker wants before a credential-stuffing run.
 */
import { issueOtp, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { mailConfigured, sendOtpEmail } from "@/lib/server/mailer";
import { queryOne } from "@/lib/server/db";
import type { RowDataPacket } from "mysql2";
import { isEmail, clientIp, fail, handleError, json, rateLimit, readJson, text, tooManyRequests } from "@/lib/server/http";
import { env } from "@/lib/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_IP = 8;
const MAX_PER_ADDRESS = 3;

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const meta = await requestMeta();
    const email = text((await readJson<{ email?: unknown }>(request)).email, 254).toLowerCase();

    if (!isEmail(email)) return fail("Enter a valid email address.", 400, "invalid_input");

    const perIp = await rateLimit(`rl:otp:ip:${ip}`, MAX_PER_IP, 900);
    if (!perIp.allowed) return tooManyRequests(perIp.retryAfter);

    const perAddress = await rateLimit(`rl:otp:addr:${email}`, MAX_PER_ADDRESS, 900);
    if (!perAddress.allowed) return tooManyRequests(perAddress.retryAfter);

    if (!mailConfigured()) {
      // Surfaced as a real error rather than a silent no-op: a login screen
      // that accepts an email and never sends anything is worse than one that
      // says the feature is unavailable.
      return fail(
        "Email sign-in is not configured on this server. Use a password or Google Sign-In.",
        503,
        "mail_unavailable",
      );
    }

    const existing = await queryOne<RowDataPacket & { id: number; status: string }>(
      "SELECT id, status FROM users WHERE email = ?",
      [email],
    );

    if (existing && existing.status === "suspended") {
      // Same uniform 200 as the success path, for the same reason.
      return json({ ok: true, expiresInSeconds: env.otpTtl, delivery: "suppressed" });
    }

    const code = await issueOtp(email, "login", meta);
    const mail = await sendOtpEmail(email, code, "login");

    await recordAudit({
      actorId: existing?.id ?? null,
      actorRole: "system",
      action: "auth.otp_requested",
      entityType: "user",
      entityId: existing?.id ?? null,
      detail: { email, delivered: mail.delivered },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return json({
      ok: true,
      expiresInSeconds: env.otpTtl,
      // Never the code itself. In development, where there is no real inbox to
      // check, returning it is the difference between a testable flow and a
      // flow that needs a live mailbox. Hard-disabled whenever APP_ORIGIN is a
      // real host, so this can never leak on a deployment.
      devCode: isLocalOrigin() ? code : undefined,
      delivery: mail.delivered ? "sent" : "unavailable",
    });
  } catch (err) {
    return handleError(err);
  }
}

/** True only for a loopback origin, never merely a non-https one. */
function isLocalOrigin(): boolean {
  try {
    const host = new URL(env.appOrigin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
