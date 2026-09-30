import type { RowDataPacket } from "mysql2/promise";
import { query } from "./db";
import { readEntries, ConsoleSession } from "./clinical";
import {
  BottleneckReport,
  BottleneckSample,
  buildBottleneckReport,
  samplesFromEntries,
  sanitizeSample,
  STALLED_BED_MS,
} from "@/lib/bottlenecks";
import type { AuthUser } from "./auth";

/**
 * PNH1 care-flow analysis on top of the persisted gesture lifecycle.
 *
 * Nothing here can be answered by the in-memory live store: it leans on the
 * `ack_at` / `escalated_at` / `resolved_at` columns the database has been
 * writing all along, so a nurse (or a hospital ops person) can finally see
 * *time-to-response* instead of just "there are 3 open alerts". A single bed,
 * read with just the bedside console credential; the whole ward, staff-only —
 * the same access split as the existing sync and ward endpoints.
 */

/* -------------------------------------------------------------------------- */
/* One bed                                                                     */
/* -------------------------------------------------------------------------- */

export interface SessionInsight {
  scope: "session";
  session: string;
  serverTime: number;
  report: BottleneckReport;
  lastActivityMs: number | null;
}

export async function sessionInsight(session: ConsoleSession): Promise<SessionInsight> {
  const now = Date.now();
  const entries = await readEntries(session.id, 0);
  const samples = samplesFromEntries(entries, now);
  return {
    scope: "session",
    session: session.code,
    serverTime: now,
    report: buildBottleneckReport(samples, now),
    lastActivityMs: samples.length
      ? Math.max(...samples.map((s) => s.raisedAt))
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The whole ward                                                              */
/* -------------------------------------------------------------------------- */

export interface WardBedInsight {
  session: string;
  bed: string | null;
  patient: string | null;
  report: BottleneckReport;
  lastActivityMs: number | null;
  stalled: boolean;
}

export interface WardInsight {
  scope: "ward";
  serverTime: number;
  occupancy: { activeSessions: number; stalledBeds: number };
  overall: BottleneckReport;
  perSession: WardBedInsight[];
}

interface WardFeedRow extends RowDataPacket {
  session_code: string;
  bed_code: string | null;
  display_name: string | null;
  gesture_id: number;
  client_key: string | null;
  gesture: string | null;
  occurred_ms: number | null;
  ack_ms: number | null;
  escalated_ms: number | null;
  resolved_ms: number | null;
}

interface WardSessionRow extends RowDataPacket {
  session_code: string;
  bed_code: string | null;
  display_name: string | null;
  patient_id: number | null;
  created_ms: number | null;
  last_seen_ms: number | null;
}

/**
 * Mirror of the ward board's ABAC scope: admins see everything; a nurse sees
 * the beds of patients they are actively assigned to, plus unbound beds (no
 * patient record yet, which still need triage visibility).
 */
function scopeClause(user: AuthUser): string {
  if (user.role === "admin") return "";
  return `AND (s.patient_id IS NULL OR EXISTS (
              SELECT 1 FROM care_assignments ca
               WHERE ca.staff_id = ${Number(user.id)}
                 AND ca.patient_id = s.patient_id
                 AND ca.unassigned_at IS NULL))`;
}

/** Recent 72h of gesture lifecycle across the ward's active beds. */
function wardFeedSql(user: AuthUser): string {
  return `
  SELECT s.session_code,
         b.bed_code,
         p.display_name,
         g.id AS gesture_id,
         g.client_key,
         COALESCE(g.gesture, 'UNKNOWN') AS gesture,
         UNIX_TIMESTAMP(g.occurred_at) * 1000 AS occurred_ms,
         UNIX_TIMESTAMP(g.ack_at)         * 1000 AS ack_ms,
         UNIX_TIMESTAMP(g.escalated_at)   * 1000 AS escalated_ms,
         UNIX_TIMESTAMP(g.resolved_at)    * 1000 AS resolved_ms
    FROM console_sessions s
    JOIN gestures g
      ON g.session_id = s.id
     AND g.created_at >= NOW() - INTERVAL 72 HOUR
    LEFT JOIN beds b   ON b.id = s.bed_id
    LEFT JOIN users p  ON p.id = s.patient_id
   WHERE s.status = 'active' AND s.expires_at > NOW(3)
         ${scopeClause(user)}
   ORDER BY g.created_at DESC, g.id DESC
   LIMIT 2000`;
}

function wardSessionsSql(user: AuthUser): string {
  return `
  SELECT s.session_code,
         b.bed_code,
         p.display_name,
         s.patient_id,
         UNIX_TIMESTAMP(s.created_at)   * 1000 AS created_ms,
         UNIX_TIMESTAMP(s.last_seen_at) * 1000 AS last_seen_ms
    FROM console_sessions s
    LEFT JOIN beds b  ON b.id = s.bed_id
    LEFT JOIN users p ON p.id = s.patient_id
   WHERE s.status = 'active' AND s.expires_at > NOW(3)
         ${scopeClause(user)}
   ORDER BY b.bed_code IS NULL, b.bed_code ASC
   LIMIT 200`;
}

export async function wardInsight(user: AuthUser): Promise<WardInsight> {
  const now = Date.now();

  const [feedRows, sessionRows] = await Promise.all([
    query<WardFeedRow>(wardFeedSql(user)),
    query<WardSessionRow>(wardSessionsSql(user)),
  ]);

  const feedBySession = new Map<string, BottleneckSample[]>();
  for (const r of feedRows) {
    const sample = sanitizeSample(
      {
        id: r.client_key ?? String(r.gesture_id),
        gesture: r.gesture ?? "UNKNOWN",
        raisedAt: r.occurred_ms === null ? NaN : Number(r.occurred_ms),
        acknowledgedAt: r.ack_ms ? Number(r.ack_ms) : null,
        escalatedAt: r.escalated_ms ? Number(r.escalated_ms) : null,
        resolvedAt: r.resolved_ms ? Number(r.resolved_ms) : null,
      },
      now,
    );
    if (!sample) continue;
    const list = feedBySession.get(r.session_code) ?? [];
    list.push(sample);
    feedBySession.set(r.session_code, list);
  }

  const allSamples: BottleneckSample[] = [];
  const perSession: WardBedInsight[] = [];

  for (const s of sessionRows) {
    const samples = feedBySession.get(s.session_code) ?? [];
    allSamples.push(...samples);
    const lastActivityMs = samples.length
      ? Math.max(...samples.map((x) => x.raisedAt))
      : s.last_seen_ms
        ? Number(s.last_seen_ms)
        : s.created_ms
          ? Number(s.created_ms)
          : null;
    perSession.push({
      session: s.session_code,
      bed: s.bed_code,
      patient: s.display_name,
      report: buildBottleneckReport(samples, now),
      lastActivityMs,
      stalled:
        lastActivityMs === null ||
        (Number.isFinite(lastActivityMs) && now - lastActivityMs > STALLED_BED_MS),
    });
  }

  return {
    scope: "ward",
    serverTime: now,
    occupancy: {
      activeSessions: sessionRows.length,
      stalledBeds: perSession.filter((p) => p.stalled).length,
    },
    overall: buildBottleneckReport(allSamples, now),
    perSession,
  };
}