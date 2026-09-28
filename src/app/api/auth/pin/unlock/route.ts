/**
 * POST /api/auth/pin/unlock -- bedside quick unlock.
 *
 * A nurse on a ward round opens a bed console perhaps twenty times a shift.
 * Making them complete a Google OAuth round trip each time is unusable, and
 * making them type a full password on a tablet with gloves on is worse. So each
 * staff member sets a 6-digit PIN once, and the console offers a numeric pad.
 *
 * The threat model is explicit: a 6-digit PIN is ~20 bits, so it is deliberately
 * weak against a determined offline attack. It is acceptable here because
 *   * the hash is scrypt, so an attacker must guess online,
 *   * guesses are bounded by a per-IP limit *and* a ward-wide budget, so total
 *     online work is capped no matter how many source IPs it is spread across,
 *   * five replays of a valid PIN lock the other account for 15 minutes,
 *   * the PIN grants a *scoped, expiring* console session, not account access.
 * It never issues an account-level cookie and cannot reach any other bed's data.
 *
 * The honest limit: because the pad is anonymous, a *total* non-match cannot be
 * attributed to any one account, so per-account counters cannot advance on a
 * pure guessing run. That is precisely why the ward-wide budget -- not the
 * per-account counter -- is what actually bounds an online brute force.
 */
import { cookies } from "next/headers";
import type { RowDataPacket } from "mysql2";

import { execute, query, queryOne } from "@/lib/server/db";
import { generateCode, hashToken, verifyPassword } from "@/lib/server/crypto";
import { recordAudit } from "@/lib/server/audit";
import { getBus, topics } from "@/lib/server/realtime";
import { env } from "@/lib/server/env";
import {
  clientIp,
  fail,
  handleError,
  isSessionCode,
  json,
  rateLimit,
  readJson,
  text,
  tooManyRequests,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS_PER_IP = 40;
const MAX_ATTEMPTS_PER_WARD = 120;
const PIN_FAILURES_BEFORE_LOCK = 5;
const PIN_LOCK_MINUTES = 15;
const CONSOLE_TTL_SECONDS = 12 * 3600;

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const body = await readJson<{ pin?: unknown; session?: unknown; consoleToken?: unknown }>(request);
    const pin = text(body.pin, 6);
    const sessionCode = text(body.session, 64).toUpperCase();
    const consoleToken = text(body.consoleToken, 128);

    if (!/^\d{6}$/.test(pin)) {
      return fail("Enter your 6-digit PIN.", 400, "invalid_input");
    }
    if (!isSessionCode(sessionCode)) {
      return fail("That console code is not valid.", 400, "invalid_input");
    }

    const perIp = await rateLimit(`rl:pin:ip:${ip}`, MAX_ATTEMPTS_PER_IP, 300);
    if (!perIp.allowed) return tooManyRequests(perIp.retryAfter);

    // One request costs `scrypt x (number of PIN holders)`, and the keyspace is
    // only 10^6. The per-IP limit does not close that: a botnet spreads attempts
    // across thousands of addresses and the pad stays grindable. This budget is
    // keyed ward-wide, not per-IP, so the total guessing work is capped no
    // matter how many sources it arrives from.
    const wardBudget = await rateLimit("rl:pin:ward", MAX_ATTEMPTS_PER_WARD, 300);
    if (!wardBudget.allowed) return tooManyRequests(wardBudget.retryAfter);

    // Per-staff bucket, so one person hammering the pad cannot lock the ward out
    // of their own account by exhausting a shared egress IP.
    const staffRows = await query<RowDataPacket & { user_id: number; quick_pin_hash: Buffer | null; quick_pin_failures: number; is_pin_locked: number; display_name: string; role: string }>(
      // `is_pin_locked` is computed by MySQL: `quick_pin_locked_until` is a naive
      // DATETIME written with NOW(3), so comparing it against a JS Date would
      // read it in the app host's timezone instead of the database's.
      `SELECT s.user_id, s.quick_pin_hash, s.quick_pin_failures,
              (s.quick_pin_locked_until IS NOT NULL AND s.quick_pin_locked_until > NOW(3)) AS is_pin_locked,
              u.display_name, u.role
         FROM staff_profiles s
         JOIN users u ON u.id = s.user_id
        WHERE s.quick_pin_hash IS NOT NULL
          AND u.status = 'active'
        LIMIT 200`,
    );

    // Verify against every candidate with a constant work factor. Returning
    // early on the first match would leak which staff member the PIN belongs to
    // via response time.
    let matched: { user_id: number; display_name: string; role: string } | null = null;
    let anyVerified = false;
    for (const row of staffRows) {
      const ok = await verifyPassword(pin, row.quick_pin_hash ? row.quick_pin_hash.toString("utf8") : null);
      if (ok) {
        anyVerified = true;
        if (!row.is_pin_locked) {
          matched = { user_id: Number(row.user_id), display_name: String(row.display_name), role: String(row.role) };
        }
      }
    }

    if (!anyVerified) {
      return fail("That PIN is not recognised.", 401, "invalid_pin");
    }
    if (!matched) {
      return fail("That PIN is temporarily locked. Try again shortly.", 429, "pin_locked");
    }

    // A PIN match is a failed attempt for every *other* PIN holder. An attacker
    // walking the ward with a stolen PIN could otherwise keep the real owner's
    // counter pinned at zero forever and unlock indefinitely. This is the only
    // failure a shared anonymous pad can attribute to an account, so it is the
    // case that actually advances the 15-minute lock.
    await execute(
      `UPDATE staff_profiles
          SET quick_pin_failures = quick_pin_failures + 1,
              quick_pin_locked_until = CASE
                WHEN quick_pin_failures + 1 >= ? THEN DATE_ADD(NOW(3), INTERVAL ? MINUTE)
                ELSE quick_pin_locked_until
              END
        WHERE quick_pin_hash IS NOT NULL AND user_id <> ?`,
      [PIN_FAILURES_BEFORE_LOCK, PIN_LOCK_MINUTES, matched.user_id],
    );
    await execute(
      "UPDATE staff_profiles SET quick_pin_failures = 0, quick_pin_locked_until = NULL WHERE user_id = ?",
      [matched.user_id],
    );

    const consoleRow = await queryOne<RowDataPacket & { id: number }>(
      `SELECT cs.id FROM console_sessions cs
        WHERE cs.session_code = ? AND cs.status = 'active'
          AND (cs.expires_at IS NULL OR cs.expires_at > NOW(3))`,
      [sessionCode],
    );
    if (!consoleRow) {
      return fail("That bedside console is not active.", 404, "console_not_found");
    }

    const bus = await getBus();
    await bus.touch(
      `${topics.console(sessionCode)}:presence`,
      JSON.stringify({ userId: matched.user_id, name: matched.display_name, role: matched.role, at: Date.now() }),
      120,
    );

    await recordAudit({
      actorId: matched.user_id,
      actorRole: matched.role === "admin" ? "admin" : matched.role === "doctor" ? "doctor" : "nurse",
      action: "auth.pin_unlock",
      entityType: "console_session",
      entityId: consoleRow.id,
      detail: { sessionCode, name: matched.display_name },
      ip,
      userAgent: request.headers.get("user-agent")?.slice(0, 255) ?? null,
    });

    // The console token is re-issued so a PIN unlock produces a fresh,
    // time-boxed credential rather than handing back whatever long-lived secret
    // the tablet already had.
    const freshToken = generateCode(32);
    await execute(
      "UPDATE console_sessions SET console_token_hash = ?, last_seen_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE id = ?",
      [hashToken(freshToken), CONSOLE_TTL_SECONDS, consoleRow.id],
    );

    const store = await cookies();
    store.set("cs_console", freshToken, {
      httpOnly: true,
      secure: env.appOrigin.startsWith("https://"),
      sameSite: "lax",
      path: "/",
      maxAge: CONSOLE_TTL_SECONDS,
    });

    return json({
      ok: true,
      unlockedAs: { name: matched.display_name, role: matched.role },
      consoleToken: freshToken,
      expiresInSeconds: CONSOLE_TTL_SECONDS,
    });
  } catch (err) {
    return handleError(err);
  }
}
