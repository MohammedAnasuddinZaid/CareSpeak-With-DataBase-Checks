import { GestureLogEntry, PatientMetrics } from "@/types";
export interface RiskAssessment {
  score: number; // 0..100
  band: "low" | "moderate" | "high" | "critical";
  factors: { label: string; weight: number; detail: string }[];
}

const HELP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Transparent, auditable risk score for the clinician dashboard.
 * Deliberately rule-based (not a black box) so nurses can defend every point.
 */
export function computeRisk(
  metrics: PatientMetrics | null | undefined,
  log: GestureLogEntry[],
  now = Date.now()
): RiskAssessment {
  const factors: RiskAssessment["factors"] = [];
  let score = 0;

  const alertness = metrics?.alertnessScore;
  if (alertness != null) {
    const w = alertness < 25 ? 30 : alertness < 45 ? 18 : alertness < 65 ? 8 : 0;
    if (w > 0) factors.push({ label: "Low alertness", weight: w, detail: `Alertness ${Math.round(alertness)}%` });
    score += w;
  }

  const blink = metrics?.blinkRate;
  if (blink != null) {
    const abnormal = blink < 6 || blink > 40;
    const w = abnormal ? (blink < 3 || blink > 55 ? 15 : 8) : 0;
    if (w > 0)
      factors.push({
        label: "Abnormal blink rate",
        weight: w,
        detail: `${Math.round(blink)} blinks/min (normal 10\u201330)`,
      });
    score += w;
  }

  const recentHelp = log.filter(
    (e) => e.gesture === "HELP" && now - e.timestamp < HELP_WINDOW_MS
  ).length;
  if (recentHelp >= 2) {
    const w = Math.min(30, recentHelp * 10);
    factors.push({ label: "Repeated HELP calls", weight: w, detail: `${recentHelp}\u00d7 HELP in last 10 min` });
    score += w;
  }

  const movement = metrics?.movementActivity;
  if (movement != null) {
    // Both extremes matter: total stillness can indicate deterioration; agitation indicates distress
    const w = movement <= 0.02 ? 12 : movement >= 0.95 ? 8 : 0;
    if (w > 0)
      factors.push({
        label: movement <= 0.02 ? "Prolonged stillness" : "Agitated movement",
        weight: w,
        detail: `Movement index ${Math.round(movement * 100)}%`,
      });
    score += w;
  }

  const unackedCritical = log.filter(
    (e) => (e.gesture === "EMERGENCY" || e.escalated) && !e.resolved && !e.acknowledged && now - e.timestamp < HELP_WINDOW_MS
  ).length;
  if (unackedCritical > 0) {
    const w = Math.min(25, unackedCritical * 25);
    factors.push({ label: "Unresolved critical alerts", weight: w, detail: `${unackedCritical} unhandled` });
    score += w;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band: RiskAssessment["band"] =
    score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "moderate" : "low";
  return { score, band, factors };
}
