import { Citation, citationPassage } from "./clinicalBasis";

/**
 * Durable automation audit trail.
 *
 * Every decision the CareSpeak engine makes on its own — auto-escalations,
 * escalation-chain dispatches, trajectory SYSTEM alerts — is persisted here so
 * a shift can be REPLAYED and defended afterwards. The ephemeral automation
 * notes on the console disappear on refresh; this survives, exports to CSV,
 * and prints into the clinical report.
 */

const AUDIT_KEY = "carespeak_audit_log";
const MAX_ENTRIES = 300;

export type AuditKind =
  | "auto_escalate"      // rule engine escalated an entry
  | "escalation_chain"   // 60s unacked EMERGENCY → SMS/WhatsApp chain
  | "trajectory_alert"   // deterioration forecast crossed warning band
  | "alarm_state"        // siren armed/muted
  | "pairing_scan";      // a device linked via QR

export interface AuditEvent {
  id: string;
  at: number;
  kind: AuditKind;
  detail: string;
  sessionId?: string;
  citation?: Citation;
}

export function recordAudit(
  kind: AuditKind,
  detail: string,
  opts: { sessionId?: string; citation?: Citation } = {}
): AuditEvent {
  const event: AuditEvent = {
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    kind,
    detail,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.citation ? { citation: opts.citation } : {}),
  };
  try {
    const log = loadAuditLog();
    log.unshift(event);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(log.slice(0, MAX_ENTRIES)));
  } catch {}
  return event;
}

export function loadAuditLog(): AuditEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(AUDIT_KEY);
    return stored ? (JSON.parse(stored) as AuditEvent[]) : [];
  } catch {
    return [];
  }
}

export function clearAuditLog(): void {
  try {
    localStorage.removeItem(AUDIT_KEY);
  } catch {}
}

const KIND_LABELS: Record<AuditKind, string> = {
  auto_escalate: "Auto-escalation",
  escalation_chain: "Escalation chain",
  trajectory_alert: "Trajectory alert",
  alarm_state: "Alarm state",
  pairing_scan: "QR pairing",
};

/** Formula-injection-safe CSV of the full audit trail (report appendix). */
export function auditToCsv(events: AuditEvent[]): string {
  const safe = (v: unknown): string => {
    const s = String(v);
    return /^[=+@-]/.test(s) ? `'${s}` : s;
  };
  const header = ["id", "time_iso", "kind", "detail", "session", "citation"];
  const rows = events.map((e) =>
    [
      e.id,
      new Date(e.at).toISOString(),
      KIND_LABELS[e.kind],
      e.detail,
      e.sessionId ?? "",
      e.citation ? `${formatCitationShort(e.citation)} ${citationPassage(e.citation)}` : "",
    ]
      .map((v) => `"${safe(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

function formatCitationShort(c: Citation): string {
  return `${c.docId}\u00a7${c.section}`;
}
