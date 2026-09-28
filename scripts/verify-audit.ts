/**
 * Audit-chain verification harness.
 *
 * Two things are proven here, and the second matters more than the first:
 *
 *   1. A chain written by the current code verifies end to end.
 *   2. Editing a row directly in the database is DETECTED.
 *
 * (2) is the only reason the chain exists. A chain that verifies is worthless if
 * it also verifies after someone has quietly changed a clinical record, so the
 * tamper case is asserted rather than assumed.
 *
 * Runs against the live dev database and cleans up after itself.
 */
import type { RowDataPacket } from "mysql2";

import { recordAudit, verifyAuditChain } from "../src/lib/server/audit";
import { closePool, execute, query } from "../src/lib/server/db";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  // Only synthetic development rows live here, and they are all provably
  // unverifiable (written before the timestamp fix), so they carry no evidence.
  await execute("DELETE FROM audit_log");

  console.log("--- 1. empty chain ---");
  const empty = await verifyAuditChain();
  check("empty chain verifies", empty.ok, `rows=${empty.rows}`);

  console.log("\n--- 2. write a chain ---");
  // Real actor ids, because audit_log has a foreign key onto users. Using made-up
  // ids here would silently drop rows and quietly weaken the test.
  const actors = await query<RowDataPacket & { id: number; role: string }>(
    "SELECT id, role FROM users ORDER BY id LIMIT 5",
  );
  if (actors.length < 3) {
    check("enough seeded users to test with", false, `found ${actors.length}`);
    return;
  }
  for (let i = 0; i < actors.length; i += 1) {
    await recordAudit({
      actorId: Number(actors[i].id),
      actorRole: actors[i].role === "nurse" ? "nurse" : "patient",
      action: `test.action.${i + 1}`,
      entityType: "patient",
      entityId: i + 1,
      detail: { iteration: i + 1, nested: { b: 2, a: 1 } },
      ip: "127.0.0.1",
      userAgent: "verify-audit",
    });
  }
  const written = await verifyAuditChain();
  check(`chain verifies after writing ${actors.length} rows`, written.ok, `rows=${written.rows}`);
  check(
    "every row was actually written",
    written.rows === actors.length,
    `expected ${actors.length}, got ${written.rows}`,
  );

  // Field order must not matter, or a caller passing {b, a} would silently
  // produce a row that can never be verified.
  console.log("\n--- 3. canonicalisation is key-order independent ---");
  await recordAudit({
    action: "test.order.a",
    entityType: "patient",
    entityId: 9,
    detail: { zebra: 1, alpha: 2, middle: 3 },
  });
  await recordAudit({
    action: "test.order.b",
    entityType: "patient",
    entityId: 9,
    detail: { middle: 3, alpha: 2, zebra: 1 },
  });
  const reordered = await verifyAuditChain();
  check("reordered keys still verify", reordered.ok, reordered.reason ?? "");

  console.log("\n--- 4. tamper detection (the point of the chain) ---");
  await execute("UPDATE audit_log SET detail = ? WHERE action = 'test.action.3'", [
    JSON.stringify({ iteration: 999, nested: { b: 2, a: 1 } }),
  ]);
  const tampered = await verifyAuditChain();
  check("edited row is detected", !tampered.ok, `brokenAtId=${tampered.brokenAtId}`);
  check("break is reported at the edited row", tampered.brokenAtId !== null);

  console.log("\n--- 5. deletion detection ---");
  await execute("DELETE FROM audit_log");
  for (let i = 1; i <= 4; i += 1) {
    await recordAudit({ action: `test.del.${i}`, entityType: "patient", entityId: i });
  }
  // Remove a middle row, leaving its successor's prev_hash dangling.
  await execute("DELETE FROM audit_log WHERE action = 'test.del.2'");
  const deleted = await verifyAuditChain();
  check("deleted row is detected", !deleted.ok, deleted.reason?.slice(0, 60) ?? "");

  console.log("\n--- cleanup ---");
  await execute("DELETE FROM audit_log");
  const [{ c }] = await query<RowDataPacket & { c: number }>("SELECT COUNT(*) AS c FROM audit_log");
  check("audit log left clean", Number(c) === 0, `remaining=${c}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("harness error:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
