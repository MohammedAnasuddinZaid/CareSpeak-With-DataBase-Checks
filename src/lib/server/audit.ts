/**
 * Tamper-evident audit log.
 *
 * Each row stores `sha256(prev_hash || canonical_row)`. Editing or deleting any
 * historical row changes that row's hash, which invalidates every hash after it,
 * so tampering is detectable by a single pass rather than being invisible.
 *
 * This is a *deterrence and detection* mechanism, not a security boundary. The
 * chain lives in the same database as the data it describes, so an attacker with
 * write access could recompute the whole chain. The honest guarantee is: an
 * ordinary accidental edit or a direct SQL mistake in a hurry is caught, and any
 * recomputation leaves a visible discontinuity at the point the chain was
 * forked. A hospital compliance review is asking "could this have been quietly
 * altered?", and a re-derivable chain answers that well enough at this cost.
 *
 * The chain is append-only by convention and must be written inside the same
 * transaction as the action it records, or the two can disagree.
 */
import type { RowDataPacket } from "mysql2";

import { query, queryOne, transaction, txExecute, txQuery } from "./db";
import { hmacHex } from "./crypto";

export type AuditRole = "patient" | "nurse" | "doctor" | "admin" | "system" | "device";

export interface AuditInput {
  actorId?: number | null;
  /** Snapshot of the actor's display name, so the log still names them if the account is later removed. */
  actorLabel?: string | null;
  actorRole?: AuditRole;
  action: string;
  entityType: string;
  entityId?: number | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Canonical serialisation. Field order is fixed by construction (object literal
 * order is stable for string keys in V8), and nested objects are sorted so a
 * caller passing `{b, a}` hashes identically to `{a, b}`.
 */
function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The fields that are covered by a row's hash. */
export interface AuditRowFields {
  actorId: number | null;
  actorLabel: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: number | null;
  detail: unknown;
  ip: string | null;
  userAgent: string | null;
  at: string;
}

/**
 * The one place a row's hash is computed.
 *
 * `recordAudit` and `verifyAuditChain` MUST agree on this, down to the field
 * order and the timestamp spelling, or a chain nobody tampered with reports
 * itself as forged. Deriving both from a single exported function is what makes
 * that agreement structural instead of a promise: there is no second
 * implementation that can drift.
 */
export function auditRowHash(prevHash: string, fields: AuditRowFields): string {
  const body = canonicalise({
    actorId: fields.actorId,
    actorLabel: fields.actorLabel,
    actorRole: fields.actorRole,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId,
    detail: fields.detail,
    // Forensic fields. They are inside the hash because "who came from where,
    // with what client" is exactly what an investigation asks, so an edit to
    // them has to break the chain just like an edit to `action` does.
    ip: fields.ip,
    userAgent: fields.userAgent,
    at: fields.at,
  });
  return hmacHex(`${prevHash}|${body}`);
}

/** The genesis value. Any fixed constant works; this is self-describing. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Append one audit row, chaining from the current head.
 *
 * Uses `SELECT ... FOR UPDATE` on the head row inside a transaction so two
 * concurrent writers cannot both read the same `prev_hash` and fork the chain.
 * With no rows yet there is nothing to lock, so the genesis insert relies on the
 * primary key on `version`/`id` to reject the second writer.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  const actorRole: AuditRole = input.actorRole ?? "system";

  // The timestamp is generated once and used for BOTH the hashed body and the
  // stored `created_at`. Letting MySQL stamp `created_at` with NOW(3) while the
  // hash covers a separately-taken `new Date()` makes the two disagree by a few
  // milliseconds, so verification can never reproduce the original hash -- the
  // chain then reports tampering on rows nobody touched. `toIso` reverses
  // `mysqlUtc` exactly, so the round-trip is lossless.
  const at = new Date();

  // Truncate to the column widths BEFORE hashing, never after. Hashing the
  // untruncated value while storing the truncated one would leave any caller
  // that passed an over-long action with a row that can never verify, which
  // reads as tampering in a compliance report.
  const action = input.action.slice(0, 64);
  const entityType = input.entityType.slice(0, 48);

  // Truncate the forensic columns to their new widths before hashing, using the
  // same values that go into the row, so a long X-Forwarded-For string cannot
  // produce a row that can never verify.
  const ip = input.ip ? input.ip.slice(0, 45) : null;
  const userAgent = input.userAgent ? input.userAgent.slice(0, 255) : null;

  // Snapshot the actor's name. `actor_id` is deliberately not a foreign key any
  // more, so it survives the account being deleted -- but a bare id is not a
  // name, and an audit trail that reads "actor 412" after that person left the
  // hospital answers no one's question. Resolved centrally so no call site can
  // forget, and callers that already hold the name still pass it to save the
  // lookup.
  let actorLabel = input.actorLabel ? input.actorLabel.slice(0, 120) : null;
  if (!actorLabel && input.actorId) {
    try {
      const who = await queryOne<RowDataPacket & { display_name: string }>(
        "SELECT display_name FROM users WHERE id = ?",
        [input.actorId],
      );
      if (who?.display_name) actorLabel = String(who.display_name).slice(0, 120);
    } catch {
      // A missing name is a cosmetic loss, not a reason to drop the audit row.
    }
  }

  try {
    await transaction(async (conn) => {
      const [head] = await txQuery<RowDataPacket & { hash: string }>(
        conn,
        "SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      const prevHash = head?.hash ?? GENESIS_HASH;
      const hash = auditRowHash(prevHash, {
        actorId: input.actorId ?? null,
        actorLabel,
        actorRole,
        action,
        entityType,
        entityId: input.entityId ?? null,
        detail: input.detail ?? null,
        ip,
        userAgent,
        at: at.toISOString(),
      });

      await txExecute(
        conn,
        `INSERT INTO audit_log
           (actor_id, actor_label, actor_role, action, entity_type, entity_id, detail, ip, user_agent, prev_hash, hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.actorId ?? null,
          actorLabel,
          actorRole,
          action,
          entityType,
          input.entityId ?? null,
          input.detail ? JSON.stringify(input.detail) : null,
          ip,
          userAgent,
          prevHash,
          hash,
          mysqlUtc(at),
        ],
      );
    });
  } catch (err) {
    // An audit failure must never block the clinical action it describes, but it
    // must be loud: a silently missing audit row is exactly the gap the chain
    // exists to close.
    console.error("[audit] failed to append entry:", err instanceof Error ? err.message : err);
  }
}

export interface ChainVerification {
  ok: boolean;
  rows: number;
  /** 1-based id of the first row whose hash does not follow from the previous. */
  brokenAtId: number | null;
  reason: string | null;
}

/**
 * Walk the whole chain and recompute every hash. This is the check a compliance
 * reviewer runs, and the one that makes the guarantee meaningful rather than
 * decorative: it detects an edit made directly in the database.
 *
 * Rows are read in id order in pages so a large log does not have to fit in
 * memory, and the page boundary is a resumable checkpoint.
 */
export async function verifyAuditChain(pageSize = 5000): Promise<ChainVerification> {
  let afterId = 0;
  let prevHash = GENESIS_HASH;
  let rows = 0;

  for (;;) {
    const page = await query<RowDataPacket & Record<string, unknown>>(
      `SELECT id, actor_id, actor_label, actor_role, action, entity_type, entity_id, detail,
              ip, user_agent, prev_hash, hash, created_at
         FROM audit_log
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
      [afterId, pageSize],
    );
    if (page.length === 0) break;

    for (const row of page) {
      rows += 1;
      const id = Number(row.id);

      if (row.prev_hash !== prevHash) {
        return {
          ok: false,
          rows,
          brokenAtId: id,
          reason: `prev_hash does not match the previous row's hash (expected ${prevHash.slice(0, 12)}…, found ${String(row.prev_hash).slice(0, 12)}…)`,
        };
      }

      const expected = auditRowHashFromStored(prevHash, row);

      if (expected !== row.hash) {
        return {
          ok: false,
          rows,
          brokenAtId: id,
          reason: "row contents do not hash to the stored value (the row was edited after it was written)",
        };
      }

      prevHash = String(row.hash);
      afterId = id;
    }

    if (page.length < pageSize) break;
  }

  return { ok: true, rows, brokenAtId: null, reason: null };
}

function parseDetail(detail: unknown): unknown {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "string") return detail;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

/**
 * The pool is configured with `dateStrings: true`, so DATETIME arrives as text.
 * Values are always written in UTC by `mysqlUtc`, so a naive relabelling with `Z`
 * is the exact inverse.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    // "2026-09-25 22:44:53.123" -> "2026-09-25T22:44:53.123Z", matching what
    // canonicalise saw at write time.
    const normalised = value.includes("T") ? value : value.replace(" ", "T");
    return `${normalised}Z`;
  }
  return String(value);
}

/**
 * A Date as a MySQL DATETIME(3) literal in UTC. DATETIME carries no timezone,
 * so storing UTC wall-clock time is what makes `toIso` a lossless inverse --
 * storing the DB server's local time would silently shift every hash.
 */
function mysqlUtc(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Hash a row exactly as it was persisted, straight from a raw driver row.
 *
 * The single reader used by both `verifyAuditChain` and the chain-repair tool.
 * Sharing it is the point: a repair that re-hashed with its own idea of the
 * canonical form would produce a chain that fails verification, or worse, a
 * "verified" chain that proves nothing.
 */
export function auditRowHashFromStored(prevHash: string, row: Record<string, unknown>): string {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    // `ip` was VARBINARY before migration 003, so pre-migration rows arrive as a
    // Buffer. Decode rather than stringify, or those rows would hash as "[object
    // Object]"-ish noise instead of their original text.
    if (Buffer.isBuffer(v)) return v.toString("utf8");
    return String(v);
  };
  return auditRowHash(prevHash, {
    actorId: num(row.actor_id),
    actorLabel: str(row.actor_label),
    actorRole: row.actor_role as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: num(row.entity_id),
    detail: parseDetail(row.detail),
    ip: str(row.ip),
    userAgent: str(row.user_agent),
    at: toIso(row.created_at),
  });
}

/** Most recent entries for a patient or entity, for the clinical timeline view. */
export async function auditTrailFor(entityType: string, entityId: number, limit = 100) {
  return query<RowDataPacket>(
    `SELECT id, actor_id, actor_role, action, entity_type, entity_id, detail, created_at
       FROM audit_log
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [entityType, entityId, limit],
  );
}

export async function auditHead(): Promise<{ hash: string; id: number } | null> {
  const row = await queryOne<RowDataPacket & { hash: string; id: number }>(
    "SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1",
  );
  return row ? { hash: String(row.hash), id: Number(row.id) } : null;
}
