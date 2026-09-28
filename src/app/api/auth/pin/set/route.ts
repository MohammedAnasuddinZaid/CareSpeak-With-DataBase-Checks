/**
 * POST /api/auth/pin/set -- enrol or change the ward-walk quick PIN.
 *
 * Requires a signed-in staff account, and re-verifies the current password (or
 * Google session age) is not enough on its own: changing an unlock credential
 * should require proving you still know the primary one, so a borrowed unlocked
 * browser cannot silently re-key the account.
 */
import type { RowDataPacket } from "mysql2";

import { requireStaff, type AuthUser } from "@/lib/server/auth";
import { execute, queryOne } from "@/lib/server/db";
import { hashPassword } from "@/lib/server/crypto";
import { recordAudit } from "@/lib/server/audit";
import { requestMeta } from "@/lib/server/auth";
import { fail, handleError, json, readJson, text } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user: AuthUser = await requireStaff();
    const meta = await requestMeta();
    const body = await readJson<{ pin?: unknown; currentPassword?: unknown }>(request);
    const pin = text(body.pin, 6);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

    if (!/^\d{6}$/.test(pin)) {
      return fail("Choose a 6-digit PIN.", 400, "invalid_pin");
    }
    // 000000, 111111 and friends are the first things anyone tries.
    if (/^(\d)\1{5}$/.test(pin)) {
      return fail("Avoid repeated digits in your PIN.", 400, "weak_pin");
    }

    const account = await queryOne<RowDataPacket & { password_hash: string | null; google_sub: string | null }>(
      "SELECT password_hash, google_sub FROM users WHERE id = ?",
      [user.id],
    );
    if (!account) return fail("Account not found.", 404, "no_account");

    // A password account must re-enter the password. A Google-only account has
    // no password to check, so it relies on the signed-in session alone.
    if (account.password_hash) {
      const { verifyPassword } = await import("@/lib/server/crypto");
      if (!(await verifyPassword(currentPassword, account.password_hash))) {
        await recordAudit({
          actorId: user.id,
          actorRole: user.role,
          action: "auth.pin_set_denied",
          entityType: "user",
          entityId: user.id,
          detail: { reason: "password_mismatch" },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return fail("Your current password is not correct.", 401, "invalid_password");
      }
    }

    const hash = await hashPassword(pin);
    const existing = await queryOne<RowDataPacket & { user_id: number }>(
      "SELECT user_id FROM staff_profiles WHERE user_id = ?",
      [user.id],
    );

    if (existing) {
      await execute(
        `UPDATE staff_profiles
            SET quick_pin_hash = ?, quick_pin_failures = 0, quick_pin_locked_until = NULL
          WHERE user_id = ?`,
        [hash, user.id],
      );
    } else {
      await execute(
        `INSERT INTO staff_profiles (user_id, staff_role, quick_pin_hash) VALUES (?,?,?)`,
        [user.id, user.role === "doctor" ? "doctor" : user.role === "admin" ? "admin" : "nurse", hash],
      );
    }

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.pin_set",
      entityType: "user",
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
