import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { RowDataPacket } from "mysql2";

/**
 * `issueSession` writes its cookies through next/headers, which throws outside a
 * real request scope. A minimal in-memory store stands in for one, so the session
 * half of the sign-in path is exercised rather than skipped.
 */
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import { loadDotEnv } from "../src/lib/server/env";

// Static imports hoist above loadDotEnv(), which is fine: every value in `env`
// is a lazy getter, so nothing reads process.env until a function is called.
loadDotEnv();

const {
  signInWithPassword,
  issueOtp,
  redeemOtp,
  createUser,
  loadAuthUser,
  canAccessPatient,
  generateOtpCode,
} = await import("../src/lib/server/auth");
const { execute, query, queryOne, closePool } = await import("../src/lib/server/db");
const { recordAudit, verifyAuditChain, auditRowHash } = await import("../src/lib/server/audit");
const { hashOtpCode, hashPassword, verifyPassword } = await import("../src/lib/server/crypto");

/**
 * These exercise the real MySQL-backed auth code against the real schema, because
 * the parts most likely to be wrong -- hash comparison, the lockout counter, the
 * OTP attempt budget, the staff-assignment join -- are all SQL, and a mocked
 * database would happily agree with a wrong query.
 *
 * Rows are created under a reserved domain and deleted afterwards, so a run
 * cannot corrupt the seeded demo ward.
 */
const DOMAIN = "auth-test.invalid";
const PASSWORD = "Correct-Horse-9";
const meta = { ip: "127.0.0.1", userAgent: "vitest" };
const otpMeta = { ip: "127.0.0.1" };

let hospitalId = 0;
const created: number[] = [];
const emails: string[] = [];


async function newUser(
  role: "patient" | "nurse" | "doctor" | "admin",
  password: string | undefined = PASSWORD,
  emailPrefix: string = role,
): Promise<number> {
  const email = `${emailPrefix}.${created.length}.${Date.now().toString(36)}@${DOMAIN}`;
  emails.push(email);
  const { id } = await createUser({
    email,
    displayName: `Test ${role}`,
    role,
    hospitalId,
    password,
    emailVerified: true,
  });
  created.push(id);
  return id;
}

beforeAll(async () => {
  // A hospital is a hard requirement for these rows, and the seed may not have
  // run on a fresh checkout.
  const existing = await queryOne<RowDataPacket & { id: number }>("SELECT id FROM hospitals ORDER BY id LIMIT 1");
  if (existing) {
    hospitalId = existing.id;
  } else {
    const res = await execute("INSERT INTO hospitals (name, code) VALUES (?,?)", [
      "Auth Test Hospital",
      "AUTHTEST",
    ]);
    hospitalId = res.insertId;
  }
});

afterAll(async () => {
  for (const id of created) {
    // Order matters: children before parents, or the FKs reject the delete.
    // audit_log is deliberately NOT cleaned: it is an append-only hash chain, so
    // deleting a row from the middle would break every later row's prev_hash and
    // make `npm run db:verify:audit` fail for real. Probe rows accumulate, which
    // is the correct behaviour for an audit trail.
    await execute("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
    await execute("DELETE FROM care_assignments WHERE staff_id = ? OR patient_id = ?", [id, id]);
    await execute("DELETE FROM patient_profiles WHERE user_id = ?", [id]);
    await execute("DELETE FROM staff_profiles WHERE user_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  // email_otps is keyed by address, not user_id, so it is cleared by email.
  for (const email of emails) {
    await execute("DELETE FROM email_otps WHERE email = ?", [email]);
  }
  await closePool();
});

describe("password hashing", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("salts, so the same password never yields the same hash", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
  });
});

describe("signInWithPassword", () => {
  it("accepts the right password and returns the user", async () => {
    const id = await newUser("nurse");
    const email = await emailOf(id);
    const result = await signInWithPassword(email, PASSWORD, meta);
    expect(result.ok).toBe(true);
    expect(result.user?.id).toBe(id);
    expect(result.user?.role).toBe("nurse");
  });

  it("matches the email case-insensitively", async () => {
    const id = await newUser("nurse", PASSWORD, "case");
    const email = await emailOf(id);
    const result = await signInWithPassword(email.toUpperCase(), PASSWORD, meta);
    expect(result.ok).toBe(true);
  });

  it("returns a uniform error for a wrong password and an unknown address", async () => {
    const id = await newUser("nurse", PASSWORD, "wrongpw");
    const known = await signInWithPassword(await emailOf(id), "not-the-password", meta);
    const unknown = await signInWithPassword(`nobody@${DOMAIN}`, "not-the-password", meta);

    // Identical on the wire, so the endpoint cannot be used to enumerate staff.
    expect(known.ok).toBe(false);
    expect(known.error).toBe("invalid_credentials");
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe("invalid_credentials");
  });

  it("increments failed_logins and locks the account after repeated failures", async () => {
    const id = await newUser("nurse", PASSWORD, "lockout");
    const email = await emailOf(id);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signInWithPassword(email, "nope", meta);
    }

    const row = await queryOne<RowDataPacket & { failed_logins: number; locked_until: string | null }>(
      "SELECT failed_logins, locked_until FROM users WHERE id = ?",
      [id],
    );
    expect(Number(row?.failed_logins)).toBeGreaterThanOrEqual(5);
    expect(row?.locked_until).not.toBeNull();

    // Internally the real reason is reported so it can be written to the audit
    // log; the login route collapses it to a single message before the client
    // ever sees it (see src/app/api/auth/login/route.ts).
    const locked = await signInWithPassword(email, PASSWORD, meta);
    expect(locked.ok).toBe(false);
    expect(locked.error).toBe("locked");
  });

  it("clears the failure counter after a successful sign-in", async () => {
    const id = await newUser("nurse", PASSWORD, "recovers");
    const email = await emailOf(id);
    await signInWithPassword(email, "nope", meta);
    await signInWithPassword(email, "nope", meta);

    const ok = await signInWithPassword(email, PASSWORD, meta);
    expect(ok.ok).toBe(true);

    const row = await queryOne<RowDataPacket & { failed_logins: number }>(
      "SELECT failed_logins FROM users WHERE id = ?",
      [id],
    );
    expect(Number(row?.failed_logins)).toBe(0);
  });

  it("refuses a suspended account", async () => {
    const id = await newUser("nurse", PASSWORD, "suspended");
    const email = await emailOf(id);
    await execute("UPDATE users SET status = 'suspended' WHERE id = ?", [id]);
    const result = await signInWithPassword(email, PASSWORD, meta);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("suspended");
  });
});

describe("OTP", () => {
  it("binds the hash to the code, the purpose and the address", () => {
    const address = `bind@${DOMAIN}`;
    const base = hashOtpCode("123456", "login", address);

    // A code emailed for login must not be redeemable as a signup code, and a
    // code issued to one address must not work for another.
    expect(hashOtpCode("123456", "signup", address)).not.toBe(base);
    expect(hashOtpCode("123456", "login", `other@${DOMAIN}`)).not.toBe(base);
    expect(hashOtpCode("123456", "login", address.toUpperCase())).toBe(base);
    expect(hashOtpCode("654321", "login", address)).not.toBe(base);
  });

  it("generates six-digit codes", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("redeems a code it issued", async () => {
    const id = await newUser("nurse", PASSWORD, "otp");
    const email = await emailOf(id);
    const code = await issueOtp(email, "login", otpMeta);
    const result = await redeemOtp(email, code, "login", meta);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe(id);
  });

  it("consumes the code so the same code cannot be replayed", async () => {
    const id = await newUser("nurse", PASSWORD, "replay");
    const email = await emailOf(id);
    const code = await issueOtp(email, "login", otpMeta);

    const first = await redeemOtp(email, code, "login", meta);
    expect(first.ok).toBe(true);

    const second = await redeemOtp(email, code, "login", meta);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("invalid");
  });

  it("rejects a wrong code and invalidates it once attempts run out", async () => {
    const id = await newUser("nurse", PASSWORD, "attempts");
    const email = await emailOf(id);
    const code = await issueOtp(email, "login", otpMeta);

    for (let i = 0; i < 5; i += 1) {
      const wrong = await redeemOtp(email, "000000", "login", meta);
      expect(wrong.ok).toBe(false);
    }

    // Five wrong guesses burned the valid code: the attempt budget is the
    // defence, so the real code is now useless.
    const after = await redeemOtp(email, code, "login", meta);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toBe("too_many_attempts");
  });

  it("refuses a code issued for a different purpose", async () => {
    const id = await newUser("nurse", PASSWORD, "purpose");
    const email = await emailOf(id);
    const code = await issueOtp(email, "signup", otpMeta);
    const result = await redeemOtp(email, code, "login", meta);
    expect(result.ok).toBe(false);
  });

  it("rejects an expired code", async () => {
    const id = await newUser("nurse", PASSWORD, "expiry");
    const email = await emailOf(id);
    const code = await issueOtp(email, "login", otpMeta);
    await execute(
      "UPDATE email_otps SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE email = ? AND consumed_at IS NULL",
      [email],
    );
    const result = await redeemOtp(email, code, "login", meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("expired");
  });

  it("supersedes an outstanding code when a new one is issued", async () => {
    const id = await newUser("nurse", PASSWORD, "supersede");
    const email = await emailOf(id);
    const first = await issueOtp(email, "login", otpMeta);
    const second = await issueOtp(email, "login", otpMeta);

    const stale = await redeemOtp(email, first, "login", meta);
    expect(stale.ok).toBe(false);

    const fresh = await redeemOtp(email, second, "login", meta);
    expect(fresh.ok).toBe(true);
  });

  it("does not invent a session for an unknown address", async () => {
    const result = await redeemOtp(`ghost@${DOMAIN}`, "123456", "login", meta);
    expect(result.ok).toBe(false);
    // Reported the same way as a wrong code, so redeeming cannot be used to
    // confirm which addresses have accounts.
    if (!result.ok) expect(result.error).toBe("invalid");
  });
});

describe("loadAuthUser", () => {
  it("returns the patient profile fields for a patient", async () => {
    const id = await newUser("patient");
    const user = await loadAuthUser(id);
    expect(user?.role).toBe("patient");
    expect(user?.mrn).toBeTruthy();
  });

  it("returns null for a deleted user rather than throwing", async () => {
    expect(await loadAuthUser(999_999_999)).toBeNull();
  });
});

describe("canAccessPatient", () => {
  it("lets a patient reach only their own record", async () => {
    const patient = await loadAuthUser(await newUser("patient", PASSWORD, "self"));
    const other = await newUser("patient", PASSWORD, "other");

    expect(await canAccessPatient(patient!, patient!.id)).toBe(true);
    expect(await canAccessPatient(patient!, other)).toBe(false);
  });

  it("lets an admin reach any patient", async () => {
    const admin = await loadAuthUser(await newUser("admin", PASSWORD, "adm"));
    const patient = await newUser("patient", PASSWORD, "admtarget");
    expect(await canAccessPatient(admin!, patient)).toBe(true);
  });

  it("grants a nurse access only to patients they are assigned to", async () => {
    const nurseId = await newUser("nurse", PASSWORD, "nurseassign");
    const nurse = await loadAuthUser(nurseId);
    const assigned = await newUser("patient", PASSWORD, "assigned");
    const unassigned = await newUser("patient", PASSWORD, "unassigned");

    await execute(
      "INSERT INTO care_assignments (staff_id, patient_id, assigned_at) VALUES (?,?,NOW(3))",
      [nurseId, assigned],
    );

    expect(await canAccessPatient(nurse!, assigned)).toBe(true);
    expect(await canAccessPatient(nurse!, unassigned)).toBe(false);
  });

  it("withdraws access when the assignment ends", async () => {
    const nurseId = await newUser("nurse", PASSWORD, "nurseend");
    const nurse = await loadAuthUser(nurseId);
    const patient = await newUser("patient", PASSWORD, "endtarget");

    await execute(
      "INSERT INTO care_assignments (staff_id, patient_id, assigned_at) VALUES (?,?,NOW(3))",
      [nurseId, patient],
    );
    expect(await canAccessPatient(nurse!, patient)).toBe(true);

    await execute(
      "UPDATE care_assignments SET unassigned_at = NOW(3) WHERE staff_id = ? AND patient_id = ?",
      [nurseId, patient],
    );
    expect(await canAccessPatient(nurse!, patient)).toBe(false);
  });
});

describe("audit chain", () => {
  it("verifies a chain it wrote itself", async () => {
    await recordAudit({
      actorId: null,
      actorRole: "system",
      action: "test.chain_probe",
      entityType: "system",
      entityId: null,
      detail: { probe: true, n: 1 },
      ip: "127.0.0.1",
      userAgent: "vitest",
    });

    const result = await verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.rows).toBeGreaterThan(0);
  });

  /*
   * Tamper detection is asserted against the pure hash rather than by editing a
   * real audit row. Editing one is destructive and self-defeating: audit_log is
   * append-only, so a test that tampers with row N breaks the chain for every
   * row after it and leaves `db:verify:audit` failing for real. The property
   * that matters -- any changed field changes the hash -- is the same property
   * the database-level check relies on.
   */
  it("changes the hash when any covered field is altered", () => {
    const base = {
      actorId: 7,
      actorLabel: "Meera Iyer",
      actorRole: "nurse",
      action: "vitals.alert_raised",
      entityType: "patient",
      entityId: 42,
      detail: { hr: 121, note: "chest pain" },
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      at: "2026-01-02T03:04:05.678Z",
    };
    const original = auditRowHash("a".repeat(64), base);

    const mutations: Array<[string, Partial<typeof base>]> = [
      ["actorId", { actorId: 8 }],
      ["actorLabel", { actorLabel: "Someone Else" }],
      ["actorRole", { actorRole: "admin" }],
      ["action", { action: "vitals.alert_cleared" }],
      ["entityType", { entityType: "device" }],
      ["entityId", { entityId: 43 }],
      ["detail", { detail: { hr: 120, note: "chest pain" } }],
      // The forensic columns are inside the hash on purpose: rewrites the source
      // IP or user-agent of a row are exactly what an investigation looks for,
      // so they must break the chain like any other edit.
      ["ip", { ip: "198.51.100.4" }],
      ["userAgent", { userAgent: "curl/8.0.0" }],
      ["timestamp", { at: "2026-01-02T03:04:05.679Z" }],
    ];

    for (const [field, patch] of mutations) {
      expect(auditRowHash("a".repeat(64), { ...base, ...patch }), `${field} must be covered`).not.toBe(
        original,
      );
    }
  });

  it("changes the hash when the previous link changes, so a deletion is detectable", () => {
    const fields = {
      actorId: null,
      actorLabel: null,
      actorRole: "system" as const,
      action: "a",
      entityType: "system",
      entityId: null,
      detail: null,
      ip: null,
      userAgent: null,
      at: "2026-01-02T03:04:05.678Z",
    };
    expect(auditRowHash("a".repeat(64), fields)).not.toBe(auditRowHash("b".repeat(64), fields));
  });

  it("is insensitive to key order but sensitive to values", () => {
    const hash = (detail: Record<string, unknown>) =>
      auditRowHash("a".repeat(64), {
        actorId: null,
        actorLabel: null,
        actorRole: "system",
        action: "a",
        entityType: "system",
        entityId: null,
        detail,
        ip: null,
        userAgent: null,
        at: "2026-01-02T03:04:05.678Z",
      });

    // MySQL reorders JSON object keys on storage, so verification must not
    // depend on the order they come back in.
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1, b: 2 })).not.toBe(hash({ a: 1, b: 3 }));
  });

  it("truncates to the column width before hashing, so a long action still verifies", async () => {
    const longAction = `test.${"x".repeat(200)}`;
    await recordAudit({
      actorId: null,
      actorRole: "system",
      action: longAction,
      entityType: "system",
      entityId: null,
      detail: { probe: "long" },
    });

    // The column truncated it to varchar(64); if the hash had covered the
    // untruncated value, this row could never verify again.
    // detail is a native JSON column, so it is compared with JSON_EXTRACT rather
    // than `= ?`, which would stringify the object and never match.
    const row = await queryOne<RowDataPacket & { action: string }>(
      "SELECT action FROM audit_log WHERE JSON_UNQUOTE(JSON_EXTRACT(detail, '$.probe')) = ? ORDER BY id DESC LIMIT 1",
      ["long"],
    );
    expect(row?.action).toHaveLength(64);

    const result = await verifyAuditChain();
    expect(result.ok).toBe(true);
  });
});

async function emailOf(id: number): Promise<string> {
  const row = await queryOne<RowDataPacket & { email: string }>("SELECT email FROM users WHERE id = ?", [id]);
  return row!.email;
}
