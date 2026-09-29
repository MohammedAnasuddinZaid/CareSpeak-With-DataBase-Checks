/**
 * Post-migration schema verification.
 *
 * A migration that runs without error is not proof the schema is correct, so
 * this asserts the properties the application actually depends on: the tables
 * exist, the enum domains accept the values the app writes, the partial-unique
 * trick on admissions behaves, and no table ended up without a primary key.
 *
 *   npm run db:studio
 */
import type { RowDataPacket } from "mysql2";
import { loadDotEnv } from "../src/lib/server/env";
import { getPool } from "../src/lib/server/db";

loadDotEnv();

const EXPECTED_TABLES = [
  "admissions", "alerts", "audit_log", "auth_sessions", "baselines",
  // `beds` was missing from this list until now. Because the check only asserts
  // that every *expected* table exists, omitting a table is the one mistake this
  // file cannot catch -- and `beds` is a core clinical table, not an extra.
  "beds", "care_assignments", "care_tasks", "console_sessions", "conversations",
  "devices", "email_otps", "gestures", "hospitals", "medication_admin",
  "messages", "notification_channels", "pain_assessments", "pairing_scans",
  "patient_profiles", "staff_profiles", "users", "vitals", "wards", "consents",
  // Added by migrations 003-005.
  "schema_migrations", "session_metrics",
  // Added by migration 006: per-session viewer credentials for multi-viewer beds.
  "console_viewers",
];

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const pool = getPool();
  // Parse the schema name out of the URI properly. A naive /\/(.*)$/ would match
  // the credentials in "mysql://user:pass@host:port/dbname".
  const db = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");

  console.log(`\nverifying schema of \`${db}\`\n`);

  // --- tables -------------------------------------------------------------
  const [tableRows] = await pool.query<RowDataPacket[]>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?",
    [db],
  );
  const present = new Set(tableRows.map((r) => r.t as string));
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  check(`all ${EXPECTED_TABLES.length} expected tables exist`, missing.length === 0, `missing: ${missing.join(", ")}`);

  // The reverse direction. A new migration adding a table does not break the
  // check above, so this list silently rots -- `beds` sat outside it while every
  // run still reported success, and a verifier that cannot fail is worse than no
  // verifier. An unexpected table means EXPECTED_TABLES needs updating.
  const unexpected = [...present].filter((t) => !EXPECTED_TABLES.includes(t));
  check(
    "no table is missing from the expected list",
    unexpected.length === 0,
    `add to EXPECTED_TABLES: ${unexpected.join(", ")}`,
  );

  // --- primary keys -------------------------------------------------------
  const [pkRows] = await pool.query<RowDataPacket[]>(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name NOT IN ('schema_migrations')
        AND table_name NOT IN (SELECT table_name FROM information_schema.table_constraints
                                WHERE table_schema = ? AND constraint_type = 'PRIMARY KEY')`,
    [db, db],
  );
  check("every table has a primary key", pkRows.length === 0, `${pkRows.length} without: ${pkRows.map((r) => r.t).join(", ")}`);

  // --- engine + charset ---------------------------------------------------
  const [engineRows] = await pool.query<RowDataPacket[]>(
    `SELECT table_name AS t, engine FROM information_schema.tables
      WHERE table_schema = ? AND engine <> 'InnoDB'`,
    [db],
  );
  check("every table is InnoDB (transactions + FKs)", engineRows.length === 0, engineRows.map((r) => `${r.t}:${r.engine}`).join(", "));

  // --- enum domains -------------------------------------------------------
  // The app writes these exact strings; a drifted enum surfaces as a runtime
  // 1265 "Data truncated" error, so assert them here instead.
  const enumExpectations: [string, string, string[]][] = [
    ["users", "role", ["patient", "nurse", "doctor", "admin"]],
    ["alerts", "kind", ["help", "emergency", "pain", "pain_inferred", "inactivity", "fall", "bed_exit", "wandering", "device", "vitals"]],
    ["alerts", "severity", ["info", "low", "moderate", "high", "critical"]],
    ["alerts", "status", ["open", "ack", "escalated", "resolved", "auto_resolved"]],
    ["vitals", "sos_active_is_tinyint", []],
  ];
  for (const [table, column, values] of enumExpectations) {
    if (values.length === 0) continue;
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COLUMN_TYPE AS ct FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?",
      [db, table, column],
    );
    const actual = String(rows[0]?.ct ?? "");
    const absent = values.filter((v) => !actual.includes(`'${v}'`));
    check(`${table}.${column} enum accepts all ${values.length} app values`, absent.length === 0, `missing: ${absent.join(", ")} (got ${actual})`);
  }

  // --- foreign keys -------------------------------------------------------
  const [fkRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.referential_constraints WHERE constraint_schema = ?`,
    [db],
  );
  const fkCount = Number(fkRows[0]?.n ?? 0);
  check("foreign keys are present", fkCount >= 25, `found ${fkCount}`);

  // --- behavioural: one active admission per patient ----------------------
  // This is the generated-column partial-unique trick. If it regresses, a
  // patient can be admitted to two beds at once and vitals fan out ambiguously.
  // Clear stale fixtures first. The previous run's cleanup sits *after* the
  // behavioural checks, so any failure between create and cleanup would leave
  // rows behind and the next run would trip over its own UNIQUE(email) key.
  // Child-first: admissions references users with ON DELETE RESTRICT.
  await pool.query(
    "DELETE a FROM admissions a JOIN users u ON u.id = a.patient_id WHERE u.email LIKE 'verify-%@t.invalid'",
  );
  await pool.query("DELETE FROM users WHERE email LIKE 'verify-%@t.invalid'");
  await pool.query(
    `INSERT INTO users (email, display_name, role) VALUES
       ('verify-a@t.invalid','A','patient'), ('verify-b@t.invalid','B','patient')`,
  );
  const [sel] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE email LIKE 'verify-%@t.invalid' ORDER BY id",
  );
  const [beds] = await pool.query<RowDataPacket[]>("SELECT id FROM beds ORDER BY id LIMIT 1");
  if (sel.length === 2 && beds.length >= 1) {
    await pool.query("INSERT INTO admissions (patient_id, bed_id) VALUES (?,?)", [sel[0].id, beds[0].id]);
    let secondBlocked = false;
    try {
      await pool.query("INSERT INTO admissions (patient_id, bed_id) VALUES (?,?)", [sel[0].id, beds[0].id]);
    } catch {
      secondBlocked = true;
    }
    check("a patient cannot hold two active admissions", secondBlocked);
    // Discharging must free the slot again.
    await pool.query("UPDATE admissions SET status='discharged', discharged_at=NOW(3) WHERE patient_id = ?", [sel[0].id]);
    let readmitOk = true;
    try {
      await pool.query("INSERT INTO admissions (patient_id, bed_id) VALUES (?,?)", [sel[0].id, beds[0].id]);
    } catch {
      readmitOk = false;
    }
    check("a discharged patient can be re-admitted", readmitOk);
  } else {
    check("verification fixtures could be created", false, "needs 2 users and 1 bed; run npm run db:seed first");
  }

  // --- the 128-bit console session id -------------------------------------
  const [col] = await pool.query<RowDataPacket[]>(
    "SELECT CHARACTER_MAXIMUM_LENGTH AS len, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll FROM information_schema.columns WHERE table_schema = ? AND table_name='console_sessions' AND column_name='session_code'",
    [db],
  );
  const codeLen = Number(col[0]?.len ?? 0);
  // 22 base32 characters = 128 bits, vs the old 6-char id at ~30 bits.
  check("console_sessions.session_code is 128-bit (>=22 chars)", codeLen >= 22, `length=${codeLen}`);
  // Must be binary, not the utf8mb4_0900_ai_ci table default: under a folded
  // collation 'AbC123' and 'abc123' are the same UNIQUE key, and a lookup would
  // match a casing the client never presented. ascii_bin is the tightest option
  // and is valid because base32 is ASCII by construction.
  // COLLATION_NAME is the authoritative column here -- CHARACTER_SET_NAME only
  // reports 'ascii' and cannot distinguish ascii_bin from ascii_general_ci.
  const coll = String(col[0]?.coll ?? "");
  check(
    "console_sessions.session_code uses a case-sensitive binary collation",
    coll.endsWith("_bin"),
    `collation=${coll} charset=${col[0]?.cs}`,
  );

  // --- vitals cursor is gap-free and indexed ------------------------------
  const [idx] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = 'vitals' AND column_name = 'received_at' AND seq_in_index = 1`,
    [db],
  );
  check("vitals has a leading index on received_at (SSE cursor scan)", Number(idx[0]?.n ?? 0) >= 1);

  // --- audit chain columns ------------------------------------------------
  const [auditCols] = await pool.query<RowDataPacket[]>(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name='audit_log' AND column_name IN ('prev_hash','hash')",
    [db],
  );
  check("audit_log has prev_hash + hash (tamper-evident chain)", auditCols.length === 2);

  // Probe fixtures reference each other, and admissions.patient_id is ON DELETE
  // RESTRICT by design (a patient with an admission record must not be hard
  // deleted). Unwind child-first so the FK is satisfied rather than bypassed.
  await pool.query(
    "DELETE a FROM admissions a JOIN users u ON u.id = a.patient_id WHERE u.email LIKE 'verify-%@t.invalid'",
  );
  await pool.query("DELETE FROM users WHERE email LIKE 'verify-%@t.invalid'");

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("verification failed:", err);
  process.exit(1);
});
