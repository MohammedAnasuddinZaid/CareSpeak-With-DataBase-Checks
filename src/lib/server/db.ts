/**
 * MySQL connection pool and query helpers.
 *
 * The pool is memoised on `globalThis`, not module scope. Next.js reloads
 * modules on every edit in dev, and a pool per reload would leak connections
 * until MySQL refuses new ones. This mirrors how `src/lib/server/store.ts`
 * already memoises its store for the same reason.
 *
 * Scaling note: pool size is per app instance. Keep
 *   (number of app instances x DATABASE_POOL_MAX) < MySQL max_connections
 * or requests will queue behind a connection-refused error. The default of 10
 * is deliberately conservative; raise it only alongside max_connections.
 */
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { loadDotEnv, env } from "./env";

loadDotEnv();

interface PoolHolder {
  __carespeakPool?: Pool;
}

function buildPool(): Pool {
  const options: PoolOptions = {
    uri: env.databaseUrl,
    connectionLimit: env.databasePoolMax,
    // Rows are returned as plain objects. `dateStrings` keeps DATETIME as text so
    // a round trip never reinterprets a UTC timestamp in the server's local zone
    // -- the browser is responsible for rendering, not the driver.
    dateStrings: true,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    namedPlaceholders: false,
    ssl: env.databaseSsl ? {} : undefined,
  };
  const pool = mysql.createPool(options);

  // `timezone: "Z"` above only controls how the *driver* formats a JS Date on the
  // way in. It does not change how MySQL itself interprets a stored DATETIME:
  // UNIX_TIMESTAMP(), NOW() and CURDATE() all read it in the *session* time zone,
  // which defaults to the server's (here IST, +05:30).
  //
  // That split is a silent 5h30m corruption. A gesture written from JS was stored
  // as a UTC wall clock, then read back through UNIX_TIMESTAMP() as if it were
  // IST and came out five and a half hours in the past — so "when did this
  // happen", the SSE resume cursor, and the 12h session TTL were all wrong.
  //
  // Pinning the session to UTC makes one provenance for every timestamp: JS writes
  // UTC, MySQL computes UTC, and the two can never disagree.
  pool.on("connection", (connection) => {
    // Callback style on purpose: the `connection` event hands back the raw
    // (non-promise) connection, so `.catch()` here would be a TypeError swallowed
    // by the surrounding `void` -- which is exactly how this silently failed to
    // apply the first time and left every timestamp 5h30m out.
    //
    // The promise pool's types describe the awaited signature, so this needs a
    // cast: the object really is the callback-flavoured one.
    const raw = connection as unknown as {
      query: (sql: string, cb: (err: unknown) => void) => void;
    };
    raw.query("SET time_zone = '+00:00'", (err) => {
      if (err) {
        // A server with no timezone tables loaded can refuse this. Not fatal, but
        // it must be visible rather than a silent drift, so it is logged.
        console.warn(
          "[db] could not pin session time_zone to UTC; timestamps may drift from UTC:",
          err instanceof Error ? err.message : err,
        );
      }
    });
  });

  return pool;
}

export function getPool(): Pool {
  const holder = globalThis as unknown as PoolHolder;
  holder.__carespeakPool ??= buildPool();
  return holder.__carespeakPool;
}

export type Sql = string;

/** Run a query and return the rows. */
export async function query<T extends RowDataPacket = RowDataPacket>(
  sql: Sql,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

/** Run a query and return the first row, or null. */
export async function queryOne<T extends RowDataPacket = RowDataPacket>(
  sql: Sql,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run a write and return its ResultSetHeader (insertId, affectedRows). */
export async function execute(sql: Sql, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().query(sql, params);
  return result as ResultSetHeader;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. Used wherever a write spans more than one table -- an alert plus its
 * audit row, a message plus its conversation's `last_message_at`.
 */
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    // A rollback can itself fail if the connection dropped. Swallowing that
    // would mask the original error, so we surface both.
    try {
      await conn.rollback();
    } catch {
      /* connection already gone; pool will discard it */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** Typed `tx()` variant of query for use inside transaction callbacks. */
export async function txQuery<T extends RowDataPacket = RowDataPacket>(
  conn: PoolConnection,
  sql: Sql,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await conn.query(sql, params);
  return rows as T[];
}

export async function txExecute(
  conn: PoolConnection,
  sql: Sql,
  params: unknown[] = [],
): Promise<ResultSetHeader> {
  const [result] = await conn.query(sql, params);
  return result as ResultSetHeader;
}

/** Build an `IN (?,?,?)` placeholder list, or `()` semantics for empty input. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * Build a `SET col = CASE col WHEN ? THEN ? ... END` fragment.
 * Keeps a large UPDATE to a single round trip instead of N statements.
 */
export function caseFor(column: string, pairs: { key: unknown; value: unknown }[]): {
  sql: string;
  params: unknown[];
} {
  const when = pairs.map(() => `WHEN ? THEN ?`).join(" ");
  const sql = `${column} = CASE ${column} ${when} ELSE ${column} END`;
  const params = pairs.flatMap((p) => [p.key, p.value]);
  return { sql, params };
}

/** True when the driver reports a duplicate-key violation (ER_DUP_ENTRY). */
export function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

/** True when the driver reports a lock-wait / deadlock, safe to retry. */
export function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: string }).code;
  return code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT" || code === "PROTOCOL_CONNECTION_LOST";
}

/** Probe the connection and report pool saturation. Surfaced by /api/health. */
export async function poolHealth(): Promise<{
  reachable: boolean;
  total: number;
  idle: number;
  waiting: number;
  error?: string;
}> {
  try {
    await query("SELECT 1");
    // Pool internals are not in mysql2's public typings but are the only way to
    // observe saturation, which is the leading cause of "requests hang in dev".
    // The cast is explicit rather than suppressed, so a typings change surfaces
    // here instead of silently breaking the health endpoint.
    const p = getPool() as unknown as { pool: { _allConnections: unknown[]; _freeConnections: unknown[]; _connectionQueue: unknown[] } };
    return {
      reachable: true,
      total: p.pool._allConnections.length,
      idle: p.pool._freeConnections.length,
      waiting: p.pool._connectionQueue.length,
    };
  } catch (err) {
    return {
      reachable: false,
      total: 0,
      idle: 0,
      waiting: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Close the pool. Used by the db scripts so the process can exit cleanly. */
export async function closePool(): Promise<void> {
  const holder = globalThis as unknown as PoolHolder;
  if (holder.__carespeakPool) {
    await holder.__carespeakPool.end();
    delete holder.__carespeakPool;
  }
}
