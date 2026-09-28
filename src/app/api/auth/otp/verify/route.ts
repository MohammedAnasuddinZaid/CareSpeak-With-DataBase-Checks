/**
 * POST /api/auth/otp/verify -- redeem a one-time sign-in code.
 */
import { redeemOtp, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { isEmail, clientIp, fail, handleError, json, rateLimit, readJson, text, tooManyRequests } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_IP = 30;

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const meta = await requestMeta();
    const body = await readJson<{ email?: unknown; code?: unknown }>(request);
    const email = text(body.email, 254).toLowerCase();
    const code = text(body.code, 6);

    if (!isEmail(email) || !/^\d{6}$/.test(code)) {
      return fail("Enter the 6-digit code from your email.", 400, "invalid_input");
    }

    // A separate bucket from the send path: guessing a 6-digit code needs a
    // tight budget, and the row's own `max_attempts` is the inner belt.
    const perIp = await rateLimit(`rl:otpverify:ip:${ip}`, MAX_PER_IP, 900);
    if (!perIp.allowed) return tooManyRequests(perIp.retryAfter);
    const perAddress = await rateLimit(`rl:otpverify:addr:${email}`, 10, 900);
    if (!perAddress.allowed) return tooManyRequests(perAddress.retryAfter);

    const result = await redeemOtp(email, code, "login", meta);

    if (!result.ok) {
      await recordAudit({
        actorRole: "system",
        action: "auth.otp_failed",
        entityType: "user",
        detail: { email, reason: result.error },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      // `no_account` is reported distinctly because at this point the caller has
      // already proved control of the mailbox, so there is no enumeration leak
      // left to protect -- and silently failing would strand a real person who
      // mistyped their address.
      if (result.error === "no_account") {
        return fail("No CareSpeak account uses that email address.", 404, "no_account");
      }
      if (result.error === "too_many_attempts") {
        return fail("Too many incorrect attempts. Request a new code.", 429, "too_many_attempts");
      }
      if (result.error === "expired") {
        return fail("That code has expired. Request a new one.", 410, "expired");
      }
      return fail("That code is not correct.", 401, "invalid_code");
    }

    await recordAudit({
      actorId: result.user.id,
      actorRole: result.user.role,
      action: "auth.login",
      entityType: "user",
      entityId: result.user.id,
      detail: { method: "otp" },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return json({ user: result.user });
  } catch (err) {
    return handleError(err);
  }
}
