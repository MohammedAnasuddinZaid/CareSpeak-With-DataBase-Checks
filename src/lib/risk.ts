import { DeviceVitals, GestureLogEntry, PatientMetrics } from "@/types";
import { Citation } from "./clinicalBasis";
export interface RiskAssessment {
  score: number; // 0..100
  band: "low" | "moderate" | "high" | "critical";
  factors: RiskFactor[];
  /**
   * Exact additive attribution (closed-form Shapley values).
   * The score is a sum of per-factor components, so for an additive game the
   * Shapley value of factor i is EXACTLY φᵢ = componentᵢ(x) − componentᵢ(x₀)
   * where x₀ is the healthy baseline — the same quantity SHAP estimates by
   * sampling on black-box models, computed here with zero approximation.
   * Invariant (test-asserted): baseValue + Σφᵢ === score.
   */
  baseValue: number;
  attribution: { key: string; label: string; phi: number; detail: string; citation?: Citation }[];
}

export interface RiskFactor {
  key: string;
  label: string;
  weight: number;
  detail: string;
  citation?: Citation;
}

const HELP_WINDOW_MS = 10 * 60 * 1000;

/** Component functions: weight each factor contributes at an arbitrary input.
 *  Keeping them pure is what makes the Shapley decomposition exact. */
type Component = (input: TriageInput) => RiskFactor | null;

interface TriageInput {
  metrics: PatientMetrics | null;
  vitals: Pick<DeviceVitals, "heartRate" | "spo2"> | null;
  log: GestureLogEntry[];
  now: number;
}

const healthyBaseline: TriageInput = {
  metrics: { alertnessScore: 80, blinkRate: 15, movementActivity: 0.3 },
  vitals: { heartRate: 75, spo2: 97 },
  log: [],
  now: 0,
};

const components: Component[] = [
  // ── NEWS2-aligned vital parameters (wearable) ──
  (i) => {
    const hr = i.vitals?.heartRate;
    if (hr == null) return null;
    const w = hr <= 40 || hr > 130 ? 25 : (hr < 50 || hr > 110 ? 12 : 0);
    if (w === 0) return null;
    return {
      key: "hr",
      label: "Heart rate deviation",
      weight: w,
      detail: `${Math.round(hr)} bpm${hr > 130 || hr < 50 ? " — NEWS2 aggregate-risk range" : ""}`,
      citation: { docId: "RCP-NEWS2", section: "hr" },
    };
  },
  (i) => {
    const spo2 = i.vitals?.spo2;
    if (spo2 == null) return null;
    const w = spo2 <= 91 ? 30 : spo2 <= 93 ? 18 : spo2 <= 95 ? 8 : 0;
    if (w === 0) return null;
    return {
      key: "spo2",
      label: "Low oxygen saturation",
      weight: w,
      detail: `SpO₂ ${Math.round(spo2)}%`,
      citation: { docId: "RCP-NEWS2", section: "spo2-scale1" },
    };
  },
  // ── Eye-derived wellness (camera) ──
  (i) => {
    const alertness = i.metrics?.alertnessScore;
    if (alertness == null) return null;
    const w = alertness < 25 ? 30 : alertness < 45 ? 18 : alertness < 65 ? 8 : 0;
    if (w === 0) return null;
    return {
      key: "alertness",
      label: "Low alertness",
      weight: w,
      detail: `Alertness ${Math.round(alertness)}%`,
      citation: { docId: "CS-ADVISORY", section: "alertness" },
    };
  },
  (i) => {
    const blink = i.metrics?.blinkRate;
    if (blink == null) return null;
    const abnormal = blink < 6 || blink > 40;
    if (!abnormal) return null;
    const w = blink < 3 || blink > 55 ? 15 : 8;
    return {
      key: "blink",
      label: "Abnormal blink rate",
      weight: w,
      detail: `${Math.round(blink)} blinks/min (typical 10–30)`,
      citation: { docId: "CS-ADVISORY", section: "blink-rate" },
    };
  },
  (i) => {
    const movement = i.metrics?.movementActivity;
    if (movement == null) return null;
    if (movement > 0.02 && movement < 0.95) return null;
    const w = movement <= 0.02 ? 12 : 8;
    return {
      key: "movement",
      label: movement <= 0.02 ? "Prolonged stillness" : "Agitated movement",
      weight: w,
      detail: `Movement index ${Math.round(movement * 100)}%`,
      citation: { docId: "CS-ADVISORY", section: "movement" },
    };
  },
  // ── Communication-behaviour signals ──
  (i) => {
    const recentHelp = i.log.filter(
      (e) => e.gesture === "HELP" && i.now - e.timestamp < HELP_WINDOW_MS
    ).length;
    if (recentHelp < 2) return null;
    return {
      key: "help_freq",
      label: "Repeated HELP calls",
      weight: Math.min(30, recentHelp * 10),
      detail: `${recentHelp}× HELP in last 10 min`,
      citation: { docId: "CS-ADVISORY", section: "help-frequency" },
    };
  },
  (i) => {
    const unackedCritical = i.log.filter(
      (e) => (e.gesture === "EMERGENCY" || e.escalated) && !e.resolved && !e.acknowledged && i.now - e.timestamp < HELP_WINDOW_MS
    ).length;
    if (unackedCritical === 0) return null;
    return {
      key: "unacked",
      label: "Unresolved critical alerts",
      weight: Math.min(25, unackedCritical * 25),
      detail: `${unackedCritical} unhandled`,
      citation: { docId: "NICE-CG50", section: "monitoring" },
    };
  },
];

function evaluate(input: TriageInput): RiskFactor[] {
  return components
    .map((c) => c(input))
    .filter((f): f is RiskFactor => f !== null);
}

/**
 * Transparent, auditable risk score for the clinician dashboard.
 * Deliberately rule-based and ADDITIVE so every point can be attributed to a
 * named factor with a clinical citation — no black box, judge-defensible math.
 */
export function computeRisk(
  metrics: PatientMetrics | null | undefined,
  log: GestureLogEntry[],
  now = Date.now(),
  vitals?: Pick<DeviceVitals, "heartRate" | "spo2"> | null
): RiskAssessment {
  const input: TriageInput = { metrics: metrics ?? null, vitals: vitals ?? null, log, now };

  const observed = evaluate(input);
  const baselineFactors = evaluate(healthyBaseline);
  const baselineByKey = new Map(baselineFactors.map((f) => [f.key, f]));

  let raw = 0;
  const factors: RiskFactor[] = [];
  const attribution: RiskAssessment["attribution"] = [];

  for (const f of observed) {
    raw += f.weight;
    factors.push(f);
    const baseWeight = baselineByKey.get(f.key)?.weight ?? 0;
    const phi = f.weight - baseWeight;
    if (phi !== 0) {
      attribution.push({ key: f.key, label: f.label, phi, detail: f.detail, citation: f.citation });
    }
  }

  // The displayed score is clamped to 0..100; scale φ proportionally so the
  // SHAP efficiency invariant stays EXACT against the displayed number even
  // when multiple max-severity factors coexist (Σφ ≡ score always).
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  if (raw > 100 || raw < 0) {
    const scale = raw === 0 ? 1 : score / raw;
    for (const a of attribution) a.phi *= scale;
  }

  const band: RiskAssessment["band"] =
    score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "moderate" : "low";

  attribution.sort((a, b) => b.phi - a.phi);
  return { score, band, factors, baseValue: 0, attribution };
}
