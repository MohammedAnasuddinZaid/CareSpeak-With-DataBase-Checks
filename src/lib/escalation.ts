import { ESCALATION_RULES, GestureLogEntry, PatientMetrics } from "@/types";

export interface EscalationDecision {
  rule: "help_frequency" | "low_alertness" | "prolonged_inactivity";
  entryId: string;
  reason: string;
}

function isActionable(entry: GestureLogEntry): boolean {
  return !entry.acknowledged && !entry.escalated && !entry.resolved;
}

/**
 * Pure, unit-testable escalation engine. Evaluates the three published rules:
 *  - help_frequency:       >=3 HELP calls inside windowMs -> escalate newest unacknowledged HELP
 *  - low_alertness:        alertness < threshold sustained for windowMs -> escalate newest actionable entry
 *  - prolonged_inactivity: no entries AND stale metrics for >= threshold while session active
 */
export function evaluateEscalations(
  log: GestureLogEntry[],
  metrics: (PatientMetrics & { lastSeen?: string }) | null,
  now = Date.now()
): EscalationDecision[] {
  const decisions: EscalationDecision[] = [];
  const [helpFreq, lowAlert, inactivity] = ESCALATION_RULES;

  // Rule 1: help_frequency
  if (helpFreq) {
    const recentHelp = log.filter(
      (e) => e.gesture === "HELP" && now - e.timestamp <= helpFreq.windowMs
    );
    if (recentHelp.length >= helpFreq.threshold) {
      const target = [...recentHelp].sort((a, b) => b.timestamp - a.timestamp).find(isActionable);
      if (target) {
        decisions.push({
          rule: "help_frequency",
          entryId: target.id,
          reason: `${recentHelp.length} HELP calls within ${Math.round(helpFreq.windowMs / 1000)}s`,
        });
      }
    }
  }

  // Rule 2: low_alertness (sustained, based on metric freshness)
  if (lowAlert && metrics?.alertnessScore != null) {
    const fresh = metrics.lastSeen ? now - new Date(metrics.lastSeen).getTime() < lowAlert.windowMs : false;
    const low = metrics.alertnessScore < lowAlert.threshold;
    if (fresh && low) {
      // `.find(isActionable)` only: the old `|| (e.escalated && !e.resolved)`
      // clause could select an already-escalated entry that the outer guard
      // then rejected, silently aborting the rule even when older actionable
      // entries existed.
      const candidate = [...log].sort((a, b) => b.timestamp - a.timestamp).find(isActionable);
      if (candidate) {
        decisions.push({
          rule: "low_alertness",
          entryId: candidate.id,
          reason: `Alertness ${Math.round(metrics.alertnessScore)}% for ${Math.round(lowAlert.windowMs / 1000)}s`,
        });
      }
    }
  }

  // Rule 3: prolonged_inactivity (only when the patient device has gone quiet mid-session)
  if (inactivity && log.length > 0) {
    const latestTs = Math.max(...log.map((e) => e.timestamp));
    const metricsAge = metrics?.lastSeen ? now - new Date(metrics.lastSeen).getTime() : Infinity;
    const silentFor = now - Math.max(latestTs, isFinite(metricsAge) ? now - metricsAge : latestTs);
    const wasActiveRecently = now - latestTs < 30 * 60 * 1000;
    if (wasActiveRecently && silentFor >= inactivity.threshold && !log.some((e) => e.escalated && !e.resolved)) {
      // Attach to the newest entry that can still carry an escalation —
      // previously it targeted log[0] even when resolved, so the decision
      // no-op'd and the inactivity alert was lost entirely.
      const target = [...log].sort((a, b) => b.timestamp - a.timestamp).find((e) => !e.resolved && !e.escalated);
      if (target) {
        decisions.push({
          rule: "prolonged_inactivity",
          entryId: target.id,
          reason: `No patient activity for ${Math.round(silentFor / 1000)}s`,
        });
      }
    }
  }

  return decisions;
}
