import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { RowDataPacket } from "mysql2";

/**
 * `getOrCreateSession` mints a console credential through next/headers on the
 * claim path, so a stand-in request scope is needed here too.
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

loadDotEnv();

const { getOrCreateSession, verifyConsoleToken, touchSession, mintViewerCredential } = await import(
  "../src/lib/server/clinical"
);
const { execute, queryOne, closePool } = await import("../src/lib/server/db");
const { hashToken } = await import("../src/lib/server/crypto");

/**
 * The console credential is what a scanned QR actually turns into: possession of
 * the code lets a device mint its own read credential for that bed. These tests
 * pin that behaviour in SQL -- a mocked database would agree with a wrong query,
 * so they run against the real schema under a reserved session-code prefix and
 * clean up after themselves.
 */
const PREFIX = "TST";

let counter = 0;
function code(): string {
  counter += 1;
  return `${PREFIX}-${process.pid % 1000}-${counter}`;
}

const createdCodes: string[] = [];
async function newSession(): Promise<string> {
  const c = code();
  createdCodes.push(c);
  return c;
}

afterAll(async () => {
  for (const c of createdCodes) {
    await execute("DELETE FROM gestures WHERE session_id IN (SELECT id FROM console_sessions WHERE session_code = ?)", [c]);
    await execute("DELETE FROM vitals WHERE session_id IN (SELECT id FROM console_sessions WHERE session_code = ?)", [c]);
    await execute(
      "DELETE FROM session_metrics WHERE session_id IN (SELECT id FROM console_sessions WHERE session_code = ?)",
      [c],
    );
    await execute("DELETE FROM console_sessions WHERE session_code = ?", [c]);
  }
  await closePool();
});

describe("console credential issuance", () => {
  it("mints a token exactly once, and that token verifies", async () => {
    const c = await newSession();
    const first = await getOrCreateSession(c);
    expect(first.created).toBe(true);
    expect(first.token).toBeTruthy();

    // The plaintext is the credential; it must actually work.
    const verified = await verifyConsoleToken(c, first.token);
    expect(verified).not.toBeNull();
    expect(verified?.code).toBe(c);

    // A second call must not mint again -- that is how a stranger locks the real
    // console out of a known bed.
    const second = await getOrCreateSession(c);
    expect(second.created).toBe(false);
    expect(second.token).toBeNull();
    expect(second.session.id).toBe(first.session.id);
  });

  it("never stores the plaintext token", async () => {
    const c = await newSession();
    const { token } = await getOrCreateSession(c);
    const row = await queryOne<RowDataPacket & { console_token_hash: string }>(
      "SELECT console_token_hash FROM console_sessions WHERE session_code = ?",
      [c],
    );
    expect(row!.console_token_hash).toBe(hashToken(token!));
    expect(row!.console_token_hash).not.toBe(token!);
  });

  it("gives only the winner of a concurrent create a usable token", async () => {
    const c = await newSession();

    // Two devices booting the same bed at the same moment.
    const results = await Promise.all([getOrCreateSession(c), getOrCreateSession(c)]);

    const creators = results.filter((r) => r.created);
    const tokens = results.map((r) => r.token).filter((t): t is string => t !== null);

    // Exactly one insert may win the unique key.
    expect(creators).toHaveLength(1);
    expect(tokens).toHaveLength(1);

    // The bug this pins: the loser's freshly minted token used to be returned
    // even though only the winner's hash was ever stored. The console would then
    // persist a credential that can never verify, and since the cookie is
    // immutable that bed is unclaimable forever.
    const winner = tokens[0];
    expect(await verifyConsoleToken(c, winner)).not.toBeNull();

    // And the session is not a duplicate.
    const rows = await queryOne<RowDataPacket & { n: number }>(
      "SELECT COUNT(*) AS n FROM console_sessions WHERE session_code = ?",
      [c],
    );
    expect(Number(rows!.n)).toBe(1);
  });

  it("lets a second device mint its own viewer credential for the same bed", async () => {
    const c = await newSession();
    const first = await getOrCreateSession(c);
    expect(first.created).toBe(true);

    // A nurse scanning the QR after the bedside console claimed the bed. Under
    // the old single-token model this was a 409 dead end; now it mints a fresh
    // viewer credential that verifies against the SAME session.
    const viewer = await mintViewerCredential(first.session.id);
    expect(viewer.length).toBeGreaterThanOrEqual(16);

    const verified = await verifyConsoleToken(c, viewer);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(first.session.id);

    // The bedside console's original credential still works alongside it.
    expect(await verifyConsoleToken(c, first.token!)).not.toBeNull();

    // The viewer credential authorises only THIS session, not another bed.
    const other = await getOrCreateSession(await newSession());
    expect(await verifyConsoleToken(other.session.code, viewer)).toBeNull();
  });
});

describe("console token verification", () => {
  it("refuses a wrong, empty or malformed token", async () => {
    const c = await newSession();
    const { token } = await getOrCreateSession(c);

    expect(await verifyConsoleToken(c, null)).toBeNull();
    expect(await verifyConsoleToken(c, "")).toBeNull();
    expect(await verifyConsoleToken(c, "short")).toBeNull();
    expect(await verifyConsoleToken(c, "x".repeat(200))).toBeNull();
    // Same length, one byte different.
    const nearMiss = (token!.slice(0, -1) + (token!.endsWith("A") ? "B" : "A"));
    expect(await verifyConsoleToken(c, nearMiss)).toBeNull();
    // Another bed's credential must not open this one.
    const other = await getOrCreateSession(await newSession());
    expect(await verifyConsoleToken(c, other.token)).toBeNull();
  });

  it("keeps a session alive for its whole window, not five hours less", async () => {
    const c = await newSession();
    const { session, token } = await getOrCreateSession(c);

    // Three hours of validity left. This is the case that matters: the old code
    // read the DATETIME as local time, so on a UTC+5:30 host "now + 3h" became
    // "3h - 5h30m" and the console was refused mid-shift with no error. Run on a
    // UTC host the old bug is invisible, so this test can only ever fail where
    // the bug is real, never spuriously.
    await execute("UPDATE console_sessions SET expires_at = DATE_ADD(NOW(3), INTERVAL 3 HOUR) WHERE id = ?", [
      session.id,
    ]);

    expect(await verifyConsoleToken(c, token)).not.toBeNull();
  });

  it("refuses an expired session regardless of a correct token", async () => {
    const c = await newSession();
    const { session, token } = await getOrCreateSession(c);
    expect(await verifyConsoleToken(c, token)).not.toBeNull();

    await execute("UPDATE console_sessions SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?", [
      session.id,
    ]);

    expect(await verifyConsoleToken(c, token)).toBeNull();
  });

  it("refuses a revoked session", async () => {
    const c = await newSession();
    const { session, token } = await getOrCreateSession(c);
    await execute("UPDATE console_sessions SET status = 'ended' WHERE id = ?", [session.id]);
    expect(await verifyConsoleToken(c, token)).toBeNull();
  });
});

describe("touchSession", () => {
  it("extends an active session so a 12h shift does not go dark in its last hour", async () => {
    const c = await newSession();
    const { session } = await getOrCreateSession(c);

    // Pretend the console was provisioned eight hours ago with six left.
    await execute(
      "UPDATE console_sessions SET expires_at = DATE_ADD(NOW(3), INTERVAL 6 HOUR), last_seen_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ?",
      [session.id],
    );
    const before = await queryOne<RowDataPacket & { minutes: number }>(
      "SELECT TIMESTAMPDIFF(MINUTE, NOW(3), expires_at) AS minutes FROM console_sessions WHERE id = ?",
      [session.id],
    );
    expect(Number(before!.minutes)).toBeLessThan(6 * 60);

    await touchSession(session.id);

    const after = await queryOne<RowDataPacket & { minutes: number; last_seen: string }>(
      "SELECT TIMESTAMPDIFF(MINUTE, NOW(3), expires_at) AS minutes, last_seen_at AS last_seen FROM console_sessions WHERE id = ?",
      [session.id],
    );
    // The old code only wrote last_seen_at, so a shift starting at 07:00 lost its
    // link at 19:00 regardless of use. It must now be pushed back out.
    expect(Number(after!.minutes)).toBeGreaterThan(Number(before!.minutes));
    expect(after!.minutes).toBeGreaterThan(11 * 60);
  });
});

describe("session code normalisation", () => {
  it("rejects codes that could not be a real bed label", async () => {
    for (const bad of ["", "  ", "ab", "x".repeat(33), "bed/1", "a b c", "<script>"]) {
      await expect(getOrCreateSession(bad)).rejects.toThrow();
    }
  });

  it("accepts the shapes a printed QR label actually uses", async () => {
    const c = await newSession();
    const { session } = await getOrCreateSession(` ${c.toLowerCase()} `);
    expect(session.code).toBe(c);
  });
});
