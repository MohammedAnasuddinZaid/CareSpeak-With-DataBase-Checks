import type { BottleneckSample } from "./bottlenecks";
import { percentile } from "./bottlenecks";

/**
 * "Operations command" analytics: what a ward actually *did*, drawn from the
 * audit columns the database already writes.
 *
 * - Response scoreboard: per-staff time-to-acknowledge against an SLA, using
 *   `alerts.ack_by / ack_at` — real attributed human actions.
 * - Rounding / repositioning board: today's `care_tasks` (positioning, round,
 *   hygiene, mobility…) as scheduled / overdue / on-time.
 * - MAR: today's `medication_admin` scheduled-vs-given adherence.
 * - Repositioning watch: open inactivity / fall / bed-exit alerts and how long
 *   they have sat.
 * - Shift trend: median time-to-ack by 8-hour slot, so PNH1 improvement is
 *   measurable across shifts rather than asserted.
 */

export const SLA_TARGET_MS = 3 * 60 * 1000;
export const ON_TIME_GRACE_MS = 5 * 60 * 1000;
export const MIN_SCOREBOARD_SAMPLES = 3;
export const REPOSITIONING_DUE_MS = 2 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Staff response scoreboard                                                   */
/* -------------------------------------------------------------------------- */

export interface ResponseSlice {
  staffId: number;
  name: string;
  latencyMs: number;
  escalated: boolean;
  resolved: boolean;
}

export interface StaffSla {
  staffId: number;
  name: string;
  acked: number;
  medianMs: number | null;
  p90Ms: number | null;
  slaRate: number | null;
  overSla: number;
  escalated: number;
  resolved: number;
  dataSufficient: boolean;
}

/** Per-staff SLA board. Worst adherence first; thin samples flagged, never ranked. */
export function slaSummary(slices: ResponseSlice[]): StaffSla[] {
  const by = new Map<number, ResponseSlice[]>();
  for (const s of slices) {
    if (!Number.isInteger(s.staffId)) continue;
    const list = by.get(s.staffId);
    if (list) list.push(s);
    else by.set(s.staffId, [s]);
  }

  const rows: StaffSla[] = [];
  for (const [staffId, list] of by) {
    const lats = list
      .map((s) => s.latencyMs)
      .filter((m): m is number => Number.isFinite(m))
      .sort((a, b) => a - b);
    const overSla = lats.reduce((n, m) => (m > SLA_TARGET_MS ? n + 1 : n), 0);
    rows.push({
      staffId,
      name: list[0]?.name ?? `#${staffId}`,
      acked: list.length,
      medianMs: percentile(lats, 50),
      p90Ms: percentile(lats, 90),
      slaRate: lats.length ? (lats.length - overSla) / lats.length : null,
      overSla,
      escalated: list.filter((s) => s.escalated).length,
      resolved: list.filter((s) => s.resolved).length,
      dataSufficient: list.length >= MIN_SCOREBOARD_SAMPLES,
    });
  }

  return rows.sort((a, b) => {
    if (a.dataSufficient !== b.dataSufficient) return a.dataSufficient ? -1 : 1;
    return (a.slaRate ?? 1) - (b.slaRate ?? 1) || b.acked - a.acked;
  });
}

/* -------------------------------------------------------------------------- */
/* Rounding / repositioning task board                                         */
/* -------------------------------------------------------------------------- */

export interface TaskRow {
  id: number;
  kind: string;
  status: string;
  title: string | null;
  bedCode: string | null;
  patient: string | null;
  dueMs: number | null;
  completedMs: number | null;
  completedBy: string | null;
}

export interface KindBoard {
  kind: string;
  scheduled: number;
  done: number;
  onTime: number;
  overdue: number;
  skipped: number;
  onTimeRate: number | null;
}

export interface OverdueTask {
  id: number;
  kind: string;
  title: string | null;
  bedCode: string | null;
  patient: string | null;
  dueMs: number;
  overdueMs: number;
}

export interface RoundingBoard {
  byKind: KindBoard[];
  overdue: OverdueTask[];
  overallOnTimeRate: number | null;
}

const TASK_ORDER = ["positioning", "observation", "mobility", "hygiene", "medication", "nutrition", "other"];

export function taskCompliance(rows: TaskRow[], now: number): RoundingBoard {
  const byKind = new Map<string, KindBoard>();
  const overdue: OverdueTask[] = [];
  let doneTotal = 0;
  let onTimeTotal = 0;

  for (const r of rows) {
    let board = byKind.get(r.kind);
    if (!board) {
      board = { kind: r.kind, scheduled: 0, done: 0, onTime: 0, overdue: 0, skipped: 0, onTimeRate: null };
      byKind.set(r.kind, board);
    }
    board.scheduled += 1;

    if (r.status === "done") {
      board.done += 1;
      doneTotal += 1;
      const onTime =
        r.completedMs !== null &&
        r.completedMs !== undefined &&
        r.dueMs !== null &&
        Number.isFinite(r.dueMs) &&
        r.completedMs <= r.dueMs + ON_TIME_GRACE_MS;
      if (onTime) {
        board.onTime += 1;
        onTimeTotal += 1;
      }
    } else if (r.status === "skipped") {
      board.skipped += 1;
    } else if (r.status === "pending" || r.status === "in_progress") {
      if (r.dueMs !== null && Number.isFinite(r.dueMs) && now > r.dueMs + ON_TIME_GRACE_MS) {
        board.overdue += 1;
        overdue.push({
          id: r.id,
          kind: r.kind,
          title: r.title,
          bedCode: r.bedCode,
          patient: r.patient,
          dueMs: r.dueMs,
          overdueMs: now - r.dueMs,
        });
      }
    }
  }

  const boardRows = [...byKind.values()].sort(
    (a, b) => TASK_ORDER.indexOf(a.kind) - TASK_ORDER.indexOf(b.kind),
  );
  for (const board of boardRows) {
    board.onTimeRate = board.done ? board.onTime / board.done : null;
  }
  overdue.sort((a, b) => b.overdueMs - a.overdueMs);

  return {
    byKind: boardRows,
    overdue,
    overallOnTimeRate: doneTotal ? onTimeTotal / doneTotal : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Medication administration record                                           */
/* -------------------------------------------------------------------------- */

export interface MarRow {
  bedCode: string | null;
  patient: string | null;
  medication: string;
  dose: string | null;
  status: string;
  scheduledMs: number | null;
  administeredMs: number | null;
}

export interface MarBoard {
  scheduled: number;
  given: number;
  missed: number;
  held: number;
  refused: number;
  adherenceRate: number | null;
}

export function marAdherence(rows: MarRow[]): MarBoard {
  let scheduled = 0;
  let given = 0;
  let missed = 0;
  let held = 0;
  let refused = 0;
  for (const r of rows) {
    scheduled += 1;
    if (r.status === "given") given += 1;
    else if (r.status === "missed") missed += 1;
    else if (r.status === "held") held += 1;
    else if (r.status === "refused") refused += 1;
  }
  return { scheduled, given, missed, held, refused, adherenceRate: scheduled ? given / scheduled : null };
}

/* -------------------------------------------------------------------------- */
/* Repositioning / inactivity watch                                           */
/* -------------------------------------------------------------------------- */

export interface OpenAlertRow {
  id: number;
  kind: string;
  severity: string;
  title: string | null;
  session: string | null;
  bedCode: string | null;
  patient: string | null;
  raisedMs: number;
}

export interface WatchItem extends OpenAlertRow {
  ageMs: number;
  repositioningDue: boolean;
}

export interface RepositioningWatch {
  items: WatchItem[];
  dueCount: number;
  byKind: Record<string, number>;
}

const WATCH_KINDS = new Set(["inactivity", "fall", "bed_exit", "wandering"]);

export function inactivityWatch(rows: OpenAlertRow[], now: number): RepositioningWatch {
  const items: WatchItem[] = [];
  const byKind: Record<string, number> = {};
  let dueCount = 0;

  for (const r of rows) {
    if (!WATCH_KINDS.has(r.kind)) continue;
    const ageMs = Math.max(0, now - r.raisedMs);
    const repositioningDue = ageMs >= REPOSITIONING_DUE_MS;
    items.push({ ...r, ageMs, repositioningDue });
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (repositioningDue) dueCount += 1;
  }
  items.sort((a, b) => b.ageMs - a.ageMs);

  return { items, dueCount, byKind };
}

/* -------------------------------------------------------------------------- */
/* Shift trend                                                                 */
/* -------------------------------------------------------------------------- */

export interface ShiftPoint {
  slot: string;
  day: string;
  startMs: number;
  count: number;
  medianMs: number | null;
  changePct: number | null;
}

function slotLabel(ms: number): string {
  return new Date(ms).getHours() === 0 ? "00\u201308" : new Date(ms).getHours() === 8 ? "08\u201316" : "16\u201324";
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Median time-to-acknowledge per 8-hour slot over the last `days` days.
 * A later slot's `changePct` is the % change versus the previous slot, so a
 * ward can show PNH1 moving in the right direction instead of just counting.
 */
export function shiftTrend(samples: BottleneckSample[], now: number, days = 7): ShiftPoint[] {
  const slots = new Map<number, number[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.raisedAt)) continue;
    const ack = s.acknowledgedAt;
    if (ack === null || ack === undefined || !Number.isFinite(ack)) continue;
    const d = new Date(s.raisedAt);
    const slotStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(d.getHours() / 8) * 8).getTime();
    const list = slots.get(slotStart);
    if (list) list.push(ack - s.raisedAt);
    else slots.set(slotStart, [ack - s.raisedAt]);
  }

  const today = new Date(now);
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - (days - 1) * 86_400_000;

  const points: ShiftPoint[] = [];
  for (const [startMs, lats] of slots) {
    if (startMs < cutoff) continue;
    lats.sort((a, b) => a - b);
    points.push({
      slot: slotLabel(startMs),
      day: dayLabel(startMs),
      startMs,
      count: lats.length,
      medianMs: percentile(lats, 50),
      changePct: null,
    });
  }
  points.sort((a, b) => a.startMs - b.startMs);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev.medianMs !== null && cur.medianMs !== null && prev.medianMs !== 0) {
      cur.changePct = ((cur.medianMs - prev.medianMs) / prev.medianMs) * 100;
    }
  }

  return points;
}