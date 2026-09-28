/**
 * Drop and recreate the CareSpeak database.
 *
 * Destructive by definition, so it refuses to run anywhere that could plausibly
 * be production. The guard is a name allowlist rather than a NODE_ENV check: a
 * misconfigured NODE_ENV is easy, but someone pointing this at a live hospital
 * database is exactly the mistake worth making impossible.
 *
 *   npm run db:reset     # drop + migrate + seed
 *
 * Pass --yes to skip the interactive confirmation.
 */
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { loadDotEnv } from "../src/lib/server/env";

loadDotEnv();

/** Only these may ever be destroyed. */
const DESTROYABLE = new Set(["carespeak", "carespeak_dev", "carespeak_test", "test", "s_u"]);

function databaseNameFrom(uri: string): string {
  const path = uri.replace(/^mysql:\/\/[^@/]*@[^/]*/, "");
  return decodeURIComponent(path.replace(/^\//, "").split("?")[0]);
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) throw new Error("DATABASE_URL is not set (see .env.example)");

  const dbName = databaseNameFrom(uri);
  if (!DESTROYABLE.has(dbName.toLowerCase())) {
    throw new Error(
      `Refusing to drop "${dbName}": it is not in the destroyable allowlist ` +
        `(${[...DESTROYABLE].join(", ")}). This tool only exists for local ` +
        `development databases.`,
    );
  }

  if (!process.argv.includes("--yes")) {
    console.log(`This will DROP and recreate the "${dbName}" database.`);
    console.log("All data in it will be permanently lost.");
    const reply = process.env.CI ? "n" : prompt("Type the database name to confirm: ");
    if (reply !== dbName) {
      console.log("Aborted: confirmation did not match.");
      return;
    }
  }

  const serverOnly = uri.replace(/^mysql:\/\/([^@/]*)@([^/]*)\/.*$/, "mysql://$1@$2");
  const conn = await createConnection({ uri: serverOnly, multipleStatements: true });
  try {
    // Confirm the server is reachable and see what we are about to remove.
    const [dbs] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS tables_count FROM information_schema.tables WHERE table_schema = ?",
      [dbName],
    );
    const tableCount = Number(dbs[0]?.tables_count ?? 0);

    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    console.log(`Dropped and recreated "${dbName}" (had ${tableCount} tables).`);
    console.log("Run: npm run db:migrate && npm run db:seed");
  } finally {
    await conn.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
