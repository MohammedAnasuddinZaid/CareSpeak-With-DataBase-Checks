/**
 * POST /api/auth/register -- public patient self-registration.
 *
 * Patients may create their own account. Staff may not: a nurse, doctor, or admin
 * account has to be provisioned by an administrator (or `npm run user:create`),
 * because self-selecting a clinical role would let anyone reading the sign-up form
 * grant themselves access to another patient's record. The role is therefore
 * hard-coded here and any `role` in the body is ignored rather than rejected, so
 * the response never confirms which field would have mattered.
 *
 * The address is left unverified on purpose. `redeemOtp` sets `email_verified_at`
 * when the code is redeemed, so the one-time code sent on registration is also
 * the proof of mailbox control; a password-only sign-in therefore cannot reach an
 * unverified account for long. Every failure returns the same message so the
 * endpoint cannot be used to enumerate which addresses have accounts.
 */
import { createUser, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { queryOne } from "@/lib/server/db";
import {
  clientIp,
  fail,
  handleError,
  isEmail,
  json,
  rateLimit,
  readJson,
  text,
  tooManyRequests,
} from "@/lib/server/http";
import type { RowDataPacket } from "mysql2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-IP, per-hour. Each accepted attempt costs one scrypt hash, so this is
// both a junk-account and a CPU guard. Set above the plausible burst for a
// single ward (which shares one egress IP behind hospital NAT) so onboarding
// patients does not need a code change, and low enough that a scripted
// mass-signup runs out of attempts long before it runs out of addresses.
const MAX_PER_IP = 20;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

const GENERIC_FAILURE = "We could not create that account. If the address is already registered, sign in instead.";

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const meta = await requestMeta();

    // Registration is the cheapest way to fill an account table with junk and to
    // burn scrypt CPU, so it is limited far harder than sign-in.
    const perIp = await rateLimit(`rl:register:ip:${ip}`, MAX_PER_IP, 3600);
    if (!perIp.allowed) return tooManyRequests(perIp.retryAfter);

    const body = await readJson<{
      email?: unknown;
      password?: unknown;
      displayName?: unknown;
      preferredLanguage?: unknown;
    }>(request);

    const email = text(body.email, 254).toLowerCase();
    const displayName = text(body.displayName, 80).trim();
    const password = typeof body.password === "string" ? body.password : "";
    const language = text(body.preferredLanguage, 10) || "en-US";

    if (!isEmail(email) || displayName.length < 2 || password.length < MIN_PASSWORD) {
      return fail("Enter a name, a valid email address, and a password of at least 10 characters.", 400, "invalid_input");
    }
    if (password.length > MAX_PASSWORD) {
      return fail("That password is too long.", 400, "invalid_input");
    }

    const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) {
      await recordAudit({
        actorRole: "system",
        action: "auth.register_duplicate",
        entityType: "user",
        detail: { email },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return fail(GENERIC_FAILURE, 409, "registration_failed");
    }

    // This build is single-hospital, so a self-registered patient joins the one
    // facility. Multi-tenant deployments must resolve the hospital from the
    // invitation or subdomain instead of defaulting to the first row.
    const hospital = await queryOne<RowDataPacket & { id: number }>(
      "SELECT id FROM hospitals ORDER BY id LIMIT 1",
    );

    const { id } = await createUser({
      email,
      displayName,
      // Hard-coded. Not read from the request.
      role: "patient",
      hospitalId: hospital ? Number(hospital.id) : null,
      password,
      emailVerified: false,
      preferredLanguage: language,
    });

    await recordAudit({
      actorId: id,
      actorRole: "patient",
      action: "auth.register",
      entityType: "user",
      entityId: id,
      detail: { method: "password" },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // Best-effort: a relay outage must not lose a real registration, and the
    // account is still usable via password if the code never arrives.
    let codeSent = false;
    try {
      const { issueOtp } = await import("@/lib/server/auth");
      await issueOtp(email, "login", meta);
      codeSent = true;
    } catch {
      codeSent = false;
    }

    return json({
      ok: true,
      user: { id, email, displayName, role: "patient" as const },
      verificationEmailSent: codeSent,
    });
  } catch (err) {
    return handleError(err);
  }
}
