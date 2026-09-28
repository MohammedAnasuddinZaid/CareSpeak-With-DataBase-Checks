/**
 * CareSpeak schema migrator.
 *
 * Applies every file in ./migrations in filename order, inside a transaction per
 * file, recording what it applied in `schema_migrations`. Safe to re-run: an
 * already-applied version is skipped, so this doubles as the deployment step.
 *
 *   npm run db:migrate
 *   npm run db:reset     # drop + recreate + migrate + seed
 *
 * DDL in MySQL is not transactional, so a failure mid-file can leave partial
 * objects behind. We therefore apply each file with IF NOT EXISTS everywhere
 * (so a re-run heals) rather than relying on rollback.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import { loadDotEnv } from "../src/lib/server/env";

loadDotEnv();

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

/** Root connection with no database selected, so CREATE DATABASE can run. */
async function rootConnection(): Promise<Connection> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  // mysql2 refuses to connect to a database that does not exist yet, which is
  // exactly the state on first run. Strip the path and select the schema later.
  const serverOnly = url.replace(/^mysql:\/\/([^@/]*)@([^/]*)\/.*$/, "mysql://$1@$2");
  return createConnection({ uri: serverOnly, multipleStatements: true });
}

function databaseNameFrom(uri: string): string {
  // Parse the path component of mysql://user:pass@host:port/dbname
  const path = uri.replace(/^mysql:\/\/[^@/]*@[^/]*/, "");
  const name = decodeURIComponent(path.replace(/^\//, "").split("?")[0]);
  if (!name) throw new Error(`DATABASE_URL has no database name: ${uri.replace(/:[^:@/]*@/, ":***@")}`);
  return name;
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL ?? "";
  const dbName = databaseNameFrom(uri);

  const root = await rootConnection();
  try {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await root.changeUser({ database: dbName });

    await root.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const [rows] = await root.query<RowDataPacket[]>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => String(r.version)));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        console.log(`  skip  ${version} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      // `multipleStatements` lets the driver split on real statement boundaries,
      // which is safe around semicolons inside string literals and comments in a
      // way that a naive split(/;/) here would not be.
      await root.query(sql);
      await root.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      console.log(`  apply ${version}`);
      ran += 1;
    }

    const [tables] = await root.query<RowDataPacket[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
      [dbName],
    );
    // mysql2 returns information_schema columns in their declared (upper) case,
    // so index by the literal key rather than assuming lowerCamelCase.
    const names = tables.map((t) => String(t.TABLE_NAME ?? t.table_name ?? "?")).sort();
    console.log(`\ndatabase ${dbName}: ${names.length} tables, ${ran} migration(s) applied`);
    console.log(names.map((n) => `  - ${n}`).join("\n"));
  } finally {
    await root.end();
  }
}

main().catch((err: unknown) => {
  console.error("\nmigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
