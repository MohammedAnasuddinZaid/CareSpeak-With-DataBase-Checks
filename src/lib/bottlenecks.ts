import { GestureLogEntry } from "@/types";

/**
 * Care-flow bottleneck analysis (PNH1).
 *
 * Everything in this module is pure and deterministic so it can be unit-tested
 * without a database. It measures the one number that matters at the bedside:
 * how long a patient's stated need sat unanswered. Every input is sanitised
 * before it is trusted — a bogus future timestamp, a negative latency or a
 * duplicated row must never inflate the "median time-to-ack" that a nurse uses
 * to decide where to walk next.
 *
 * The thresholds are deliberately conservative and the module reports "not
 * enough data" rather than inventing a trend from a single alert.
 */

export type BottleneckNoteKind =
  | "critical_open"
  | "stuck_escalated"
  | "slow_acknowledgement"
  | "low_ack_rate"
  | "slow_period"
  | "no_data";

export interface BottleneckNote {
  id: string;
  severity: "high" | "medium" | "low";
  kind: BottleneckNoteKind;
  title: string;
  detail: string;
}

export interface LatencyStats {
  n: number;
  meanMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

export interface FunnelCounts {
  raised: number;
  acknowledged: number;
  escalated: number;
  resolved: number;
  ackRate: number | null;
  escalationRate: number | null;
  resolveRate: number | null;
}

export interface GestureBreakdown {
  gesture: string;
  count: number;
  highAcuity: number;
  ackRate: number | null;
  avgAckMs: number | null;
  unansweredNow: number;
}

export interface HourLatency {
  /** 0–23, local wall-clock hour of when the need was raised. */
  hour: number;
  label: string;
  count: number;
  avgAckMs: number | null;
}

export interface BottleneckReport {
  windowStartMs: number | null;
  windowEndMs: number | null;
  funnel: FunnelCounts;
  ack: LatencyStats;
  escalate: LatencyStats;
  resolve: LatencyStats;
  perGesture: GestureBreakdown[];
  hourLatency: HourLatency[];
  notes: BottleneckNote[];
  /** True once there are enough samples for the numbers to mean something. */
  dataSufficient: boolean;
}

/** Gentle skew-tolerance: the server stamps entries, so we trust ±5s drift. */
const MAX_FUTURE_MS = 5000;

/** A high-acuity need is one that a patient cannot be left waiting on. */
const HIGH_ACUITY = new Set([
  "HELP",
  "EMERGENCY",
  "HARD_TO_BREATHE",
  "IN_PAIN",
  "NEED_MEDICINE",
  "NEED_INHALER",
  "NEED_DOCTOR",
  "NEED_NURSE",
  "FEEL_DIZZY",
  "FEEL_SCARED",
]);

/** A critical alert unanswered for this long is a standing breach. */
export const BREACH_OPEN_MS = 60_000;
/** Escalated but unresolved past this is a stuck escalation chain. */
export const STUCK_ESCALATED_MS = 15 * 60_000;
/** Median time-to-ack beyond this flags a slow-acknowledgement bottleneck. */
export const SLOW_ACK_SOFT_MS = 3 * 60_000;
/** Fewer than this fraction acknowledged = a sink where things vanish. */
export const LOW_ACK_RATE = 0.5;
/** A bed with no server-observed activity for this long counts as stalled. */
export const STALLED_BED_MS = 30 * 60_000;
/** At least this many samples before the module claims to see a pattern. */
export const MIN_SAMPLES = 5;

/** A single sanitised "need raised → how the staff responded" fact. */
export interface BottleneckSample {
  id: string;
  gesture: string;
  /** When the patient raised the need (ms epoch). */
  raisedAt: number;
  acknowledgedAt: number | null;
  escalatedAt: number | null;
  resolvedAt: number | null;
}

export function isHighAcuity(gesture: string): boolean {
  return HIGH_ACUITY.has(String(gesture ?? "").toUpperCase());
}

/**
 * Normalise one raw sample into something an analysis can trust.
 *
 * Returns null when the sample itself is unusable (non-finite/too-future
 * raise time). Latency timestamps are clamped to the raise time on the low
 * side (a live nurse can acknowledge while the request is still in flight)
 * and dropped entirely when they are impossibly far in the future.
 */
export function sanitizeSample(
  raw: BottleneckSample | null | undefined,
  now: number,
): BottleneckSample | null {
  if (!raw) return null;
  if (!raw.id || typeof raw.id !== "string") return null;
  if (!Number.isFinite(raw.raisedAt) || raw.raisedAt > now + MAX_FUTURE_MS) return null;

  const clampRaise = (t: number | null): number | null => {
    if (t === null || t === undefined) return null;
    if (!Number.isFinite(t)) return null;
    return Math.max(t, raw.raisedAt);
  };
  const dropImpossible = (t: number | null): number | null => {
    if (t === null || t === undefined) return null;
    if (!Number.isFinite(t)) return null;
    return t > now + MAX_FUTURE_MS ? null : t;
  };

  return {
    id: raw.id,
    gesture: String(raw.gesture ?? "UNKNOWN").toUpperCase() || "UNKNOWN",
    raisedAt: raw.raisedAt,
    acknowledgedAt: dropImpossible(clampRaise(raw.acknowledgedAt)),
    escalatedAt: dropImpossible(clampRaise(raw.escalatedAt)),
    resolvedAt: dropImpossible(clampRaise(raw.resolvedAt)),
  };
}

/** Adapt stored entries (readEntries output) into analysable samples. */
export function samplesFromEntries(entries: GestureLogEntry[], now: number): BottleneckSample[] {
  const seen = new Set<string>();
  const out: BottleneckSample[] = [];
  for (const e of entries) {
    if (!e || seen.has(e.id)) continue; // exactly-once: a sync replay must not double count
    seen.add(e.id);
    const sample = sanitizeSample(
      {
        id: e.id,
        gesture: e.gesture,
        raisedAt: e.timestamp,
        acknowledgedAt: e.acknowledgedAt ?? null,
        escalatedAt: e.escalatedAt ?? null,
        resolvedAt: e.resolvedAt ?? null,
      },
      now,
    );
    if (sample) out.push(sample);
  }
  return out;
}

export function percentile(sortedAscMs: number[], p: number): number | null {
  if (sortedAscMs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscMs.length));
  return sortedAscMs[Math.min(rank, sortedAscMs.length) - 1];
}

function packLatencies(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, meanMs: null, medianMs: null, p90Ms: null, maxMs: null };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    meanMs: sum / sorted.length,
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted[sorted.length - 1],
  };
}

/** Latency stats over every sample that has the given lifecycle marker. */
export function latencyOf(samples: BottleneckSample[], key: "acknowledgedAt" | "escalatedAt" | "resolvedAt"): LatencyStats {
  const lats: number[] = [];
  for (const s of samples) {
    const at = s[key];
    if (at !== null && at !== undefined && Number.isFinite(at)) lats.push(at - s.raisedAt);
  }
  return packLatencies(lats);
}

export function computeFunnel(samples: BottleneckSample[]): FunnelCounts {
  let acknowledged = 0;
  let escalated = 0;
  let resolved = 0;
  for (const s of samples) {
    if (s.acknowledgedAt !== null) acknowledged++;
    if (s.escalatedAt !== null) escalated++;
    if (s.resolvedAt !== null) resolved++;
  }
  const raised = samples.length;
  const rate = (n: number) => (raised === 0 ? null : n / raised);
  return {
    raised,
    acknowledged,
    escalated,
    resolved,
    ackRate: rate(acknowledged),
    escalationRate: rate(escalated),
    resolveRate: rate(resolved),
  };
}

export function perGestureBreakdown(samples: BottleneckSample[]): GestureBreakdown[] {
  const byGesture = new Map<string, BottleneckSample[]>();
  for (const s of samples) {
    const list = byGesture.get(s.gesture) ?? [];
    list.push(s);
    byGesture.set(s.gesture, list);
  }
  return [...byGesture.entries()]
    .map(([gesture, list]) => {
      let highAcuity = 0;
      let answered = 0;
      let unansweredNow = 0;
      let ackSum = 0;
      for (const s of list) {
        if (isHighAcuity(s.gesture)) highAcuity++;
        if (s.acknowledgedAt !== null) {
          answered++;
          ackSum += s.acknowledgedAt - s.raisedAt;
        } else {
          unansweredNow++;
        }
      }
      return {
        gesture,
        count: list.length,
        highAcuity,
        ackRate: list.length === 0 ? null : answered / list.length,
        avgAckMs: answered === 0 ? null : ackSum / answered,
        unansweredNow,
      };
    })
    .sort((a, b) => b.count - a.count || b.highAcuity - a.highAcuity)
    .slice(0, 12);
}

export function hourOfDayLatency(samples: BottleneckSample[]): HourLatency[] {
  const byHour = new Map<number, number[]>();
  for (const s of samples) {
    if (s.acknowledgedAt === null) continue;
    const hour = new Date(s.raisedAt).getHours();
    const list = byHour.get(hour) ?? [];
    list.push(s.acknowledgedAt - s.raisedAt);
    byHour.set(hour, list);
  }
  return [...byHour.entries()]
    .map(([hour, lats]) => {
      const sum = lats.reduce((a, b) => a + b, 0);
      return {
        hour,
        label: `${String(hour).padStart(2, "0")}:00`,
        count: lats.length,
        avgAckMs: sum / lats.length,
      };
    })
    .sort((a, b) => a.hour - b.hour);
}

/**
 * Flag the bottlenecks a charge nurse can actually act on.
 *
 * Each note carries enough wording to paste into a handover: which gesture,
 * how many, how long. `now` drives the "still open" age so a breached help
 * request that gets acknowledged mid-poll disappears from the list on the next
 * refresh rather than lingering as stale.
 */
export function detectBottlenecks(
  samples: BottleneckSample[],
  now: number,
  opts: { medianAckMs?: number | null } = {},
): BottleneckNote[] {
  const notes: BottleneckNote[] = [];

  if (samples.length === 0) {
    notes.push({
      id: "no_data",
      severity: "low",
      kind: "no_data",
      title: "No care events yet",
      detail: "Nothing has been charted for this bed, so there is no journey to analyse.",
    });
    return notes;
  }

  const open = samples.filter((s) => s.acknowledgedAt === null);
  const openBreached = open.filter(
    (s) => isHighAcuity(s.gesture) && now - s.raisedAt > BREACH_OPEN_MS,
  );
  if (openBreached.length > 0) {
    const kinds = [...new Set(openBreached.map((s) => s.gesture))].slice(0, 3).join(", ");
    notes.push({
      id: "critical_open",
      severity: openBreached.length >= 2 ? "high" : "medium",
      kind: "critical_open",
      title: `${openBreached.length} ${openBreached.length === 1 ? "critical request" : "critical requests"} unanswered over 1 min`,
      detail: `${kinds} has been waiting since the alert opened. A physician should be at this bed now.`,
    });
  }

  const stuck = samples.filter(
    (s) => s.escalatedAt !== null && s.resolvedAt === null && now - s.escalatedAt > STUCK_ESCALATED_MS,
  );
  if (stuck.length > 0) {
    notes.push({
      id: "stuck_escalated",
      severity: "medium",
      kind: "stuck_escalated",
      title: `${stuck.length} ${stuck.length === 1 ? "escalation is" : "escalations are"} stuck open`,
      detail: "Escalated but unresolved past 15 minutes — the chain fired but nobody closed it.",
    });
  }

  const raised = samples.length;
  const ackLatencies = latencyOf(samples, "acknowledgedAt");
  const reference =
    opts.medianAckMs ?? ackLatencies.medianMs ?? (ackLatencies.meanMs ?? null);
  if (raised >= MIN_SAMPLES && reference !== null && reference > SLOW_ACK_SOFT_MS) {
    notes.push({
      id: "slow_acknowledgement",
      severity: "medium",
      kind: "slow_acknowledgement",
      title: "Help requests move slower than 3 minutes",
      detail: `${Math.round(reference / 1000)}s median time-to-ack across ${raised} requests — above the response-time target.`,
    });
  }

  const funnel = computeFunnel(samples);
  if (raised >= MIN_SAMPLES && funnel.ackRate !== null && funnel.ackRate < LOW_ACK_RATE) {
    notes.push({
      id: "low_ack_rate",
      severity: "medium",
      kind: "low_ack_rate",
      title: "More than half of requests go unacknowledged",
      detail: `${Math.round(funnel.ackRate * 100)}% acknowledged over ${raised} requests — needs a handover, not a guess.`,
    });
  }

  const overallMedian =
    opts.medianAckMs ?? ackLatencies.medianMs ?? (ackLatencies.meanMs ?? null);
  const slowHours = hourOfDayLatency(samples).filter((h) => {
    if (h.count < 3 || overallMedian === null) return false;
    return h.avgAckMs !== null && h.avgAckMs > overallMedian * 1.5 && h.avgAckMs - overallMedian > 60_000;
  });
  for (const h of slowHours.slice(0, 3)) {
    if (h.avgAckMs === null) continue;
    notes.push({
      id: `slow_period_${h.hour}`,
      severity: "low",
      kind: "slow_period",
      title: `${h.label} is a slow window (${h.count} requests)`,
      detail: `Average time-to-ack ${h.avgAckMs >= 60_000 ? `${Math.round(h.avgAckMs / 60_000)}m` : `${Math.round(h.avgAckMs / 1000)}s`} around the ${h.label} handover period.`,
    });
  }

  return notes;
}

export function buildBottleneckReport(samples: BottleneckSample[], now: number): BottleneckReport {
  let windowStartMs: number | null = null;
  let windowEndMs: number | null = null;
  for (const s of samples) {
    if (windowStartMs === null || s.raisedAt < windowStartMs) windowStartMs = s.raisedAt;
    if (windowEndMs === null || s.raisedAt > windowEndMs) windowEndMs = s.raisedAt;
  }

  const ack = latencyOf(samples, "acknowledgedAt");
  return {
    windowStartMs,
    windowEndMs,
    funnel: computeFunnel(samples),
    ack,
    escalate: latencyOf(samples, "escalatedAt"),
    resolve: latencyOf(samples, "resolvedAt"),
    perGesture: perGestureBreakdown(samples),
    hourLatency: hourOfDayLatency(samples),
    notes: detectBottlenecks(samples, now, { medianAckMs: ack.medianMs }),
    dataSufficient: samples.length >= MIN_SAMPLES,
  };
}

/** Human duration for the UI: 42s, 3m 12s, 1h 04m. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}