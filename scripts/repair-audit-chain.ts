/**
 * Rebuild the audit hash chain in place.
 *
 * WHY THIS EXISTS
 * `audit_log` is append-only and hash-chained, so the normal response to a
 * broken chain is "restore from backup and find out who broke it". That is the
 * right answer in a hospital. It is not always available: a development or
 * demo database can be damaged by a stray `DELETE`, a restored dump, or a
 * migration, and then nothing that *appends* to the log can ever verify again --
 * every future write inherits a chain that is already broken, so the tampering
 * evidence is permanently unusable.
 *
 * WHAT IT COSTS
 * Re-linking rewrites `prev_hash` and `hash` for every row, which DESTROYS the
 * evidence of whatever was edited or deleted. It is a forensic tool for
 * environments you already know are untrustworthy, not a repair button. It
 * refuses to run without `--i-understand-this-destroys-evidence`, and it prints
 * where the chain was broken first so that value is recorded before it is lost.
 *
 * USAGE
 *   npm run db:verify:audit                      # check
 *   npm run db:repair:audit                       # dry run, reports the break
 *   npm run db:repair:audit -- --apply --i-understand-this-destroys-evidence
 */
import {
  GENESIS_HASH,
  auditRowHashFromStored,
  verifyAuditChain,
} from "../src/lib/server/audit";
import { loadDotEnv } from "../src/lib/server/env";
import type { RowDataPacket } from "mysql2";

loadDotEnv();

const PAGE = 500;

async function loadAll(): Promise<RowDataPacket[]> {
  const { query } = await import("../src/lib/server/db");
  const rows: RowDataPacket[] = [];
  let afterId = 0;
  for (;;) {
    const page = await query<RowDataPacket>(
      // Must select exactly the columns `verifyAuditChain` reads. Hashing a row
      // with a column missing here reads as `null`, which produces a hash the
      // verifier cannot reproduce -- the chain would look broken forever.
      `SELECT id, actor_id, actor_label, actor_role, action, entity_type, entity_id, detail,
              ip, user_agent, prev_hash, hash, created_at
         FROM audit_log
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
      [afterId, PAGE],
    );
    if (page.length === 0) break;
    rows.push(...page);
    afterId = Number(page[page.length - 1].id);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const acknowledged = process.argv.includes("--i-understand-this-destroys-evidence");

  const before = await verifyAuditChain();
  if (before.ok) {
    console.log(`chain is intact (${before.rows} rows) -- nothing to repair`);
    return;
  }

  console.log("chain is BROKEN");
  console.log(`  verified rows before the break : ${before.rows}`);
  console.log(`  first bad row id               : ${before.brokenAtId}`);
  console.log(`  reason                         : ${before.reason}`);

  const rows = await loadAll();
  console.log(`  total rows in the table        : ${rows.length}`);

  // How many rows actually need their hashes rewritten, so the operator can see
  // whether this is one damaged row or a wholesale rebuild.
  let prevHash = GENESIS_HASH;
  let changed = 0;
  for (const row of rows) {
    const expected = auditRowHashFromStored(prevHash, row as Record<string, unknown>);
    if (expected !== row.hash) changed += 1;
    prevHash = String(row.hash);
  }
  console.log(`  rows whose hash must be rewritten: ${changed}`);

  if (!apply) {
    console.log("\ndry run only. Re-run with --apply to rewrite the chain.");
    return;
  }
  if (!acknowledged) {
    console.error(
      "\nrefusing to rewrite: this destroys the evidence of the edit or deletion that broke the chain.",
    );
    console.error("re-run with --i-understand-this-destroys-evidence if that is genuinely intended.");
    process.exitCode = 1;
    return;
  }

  const { execute } = await import("../src/lib/server/db");
  let linked = GENESIS_HASH;
  let rewritten = 0;
  for (const row of rows) {
    const hash = auditRowHashFromStored(linked, row as Record<string, unknown>);
    if (hash !== row.hash || linked !== row.prev_hash) {
      await execute("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?", [
        linked,
        hash,
        row.id,
      ]);
      rewritten += 1;
    }
    linked = hash;
  }

  const after = await verifyAuditChain();
  console.log(`\nrewrote ${rewritten} row(s)`);
  if (after.ok) {
    console.log(`chain verifies again (${after.rows} rows)`);
  } else {
    console.error(`chain STILL broken at row ${after.brokenAtId}: ${after.reason}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit())
  .catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
  });
