/**
 * POST /api/auth/login -- email + password sign-in.
 *
 * Rate limited per IP and per account. The account bucket matters: a shared
 * hospital workstation means several legitimate nurses behind one egress IP, so
 * IP alone would either be uselessly loose or lock out a whole ward.
 */
import { signInWithPassword, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { isEmail, clientIp, fail, handleError, json, rateLimit, readJson, text, tooManyRequests } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_IP = 20;
const MAX_PER_ACCOUNT = 8;

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const meta = await requestMeta();

    const perIp = await rateLimit(`rl:login:ip:${ip}`, MAX_PER_IP, 300);
    if (!perIp.allowed) return tooManyRequests(perIp.retryAfter);

    const body = await readJson<{ email?: unknown; password?: unknown }>(request);
    const email = text(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (!isEmail(email) || password.length === 0) {
      return fail("Enter a valid email address and password.", 400, "invalid_input");
    }

    const perAccount = await rateLimit(`rl:login:acct:${email}`, MAX_PER_ACCOUNT, 300);
    if (!perAccount.allowed) return tooManyRequests(perAccount.retryAfter);

    const result = await signInWithPassword(email, password, meta);

    if (!result.ok) {
      // One message for every failure mode. Distinguishing "locked" from
      // "wrong password" tells an attacker which accounts exist.
      await recordAudit({
        actorRole: "system",
        action: "auth.login_failed",
        entityType: "user",
        detail: { email, reason: result.error },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return fail("Email or password is incorrect.", 401, "invalid_credentials");
    }

    await recordAudit({
      actorId: result.user!.id,
      actorRole: result.user!.role,
      action: "auth.login",
      entityType: "user",
      entityId: result.user!.id,
      detail: { method: "password" },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return json({ user: result.user });
  } catch (err) {
    return handleError(err);
  }
}
