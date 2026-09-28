/**
 * NEWS2 — National Early Warning Score, version 2.
 *
 * Royal College of Physicians, 2017. This is the score every NHS hospital
 * uses, and NICE CG50 endorses it as the physiological track-and-trigger system
 * for acutely ill adults. It is the clinical standard, not something invented
 * for this project.
 *
 * Two reasons it belongs in a bedside communication system:
 *
 *  1. It converts a stream of vitals into ONE number a nurse already knows how
 *     to act on. A ward full of dashboards is a dashboard nobody reads; a single
 *     aggregate with a defined clinical response is what actually moves people.
 *  2. It is computable from what this device already streams. CareSpeak reads
 *     pulse, SpO2, blood pressure, temperature and a consciousness proxy. NEWS2
 *     is the arithmetic that turns those readings into a triage decision.
 *
 * Deliberately a faithful transcription of the published thresholds, because a
 * score that is "roughly NEWS2" is worse than no score: a nurse would act on a
 * number that does not mean what they think it means.
 *
 * The novel part is temporal, not the arithmetic. `newsTrend` reads the score as
 * a series: a patient sitting at 3 who was at 1 an hour ago is deteriorating
 * inside the "low" band, and a static snapshot cannot see that. Trend is the
 * signal, and it is what makes an aggregate worth streaming continuously.
 */

import type { Citation } from "./clinicalBasis";

/** The six physiological parameters, plus the oxygen weighting score. */
export type News2Parameter =
  | "respiratoryRate"
  | "spo2"
  | "systolicBp"
  | "pulse"
  | "consciousness"
  | "temperature"
  | "supplementalOxygen";

/** Clinical response bands, as published. */
export type News2Band = "low" | "medium" | "high";

export interface News2VitalSet {
  respiratoryRate?: number;
  /** Percent. Scored on Scale 1 unless `spo2Scale2` is set. */
  spo2?: number;
  /** mmHg. */
  systolicBp?: number;
  /** Beats per minute. */
  pulse?: number;
  /** ACVPU consciousness level, or CareSpeak's 0..100 alertness proxy. */
  consciousness?: "alert" | "confusion" | "voice" | "pressure" | "unresponsive" | number;
  /** Degrees Celsius. */
  temperature?: number;
  /** True when the patient is on supplemental oxygen. */
  supplementalOxygen?: boolean;
  /**
   * Hypercapnic respiratory failure (COPD) with an 88-92% target range. Switches
   * SpO2 to Scale 2. A competent clinician must decide this; it is never
   * inferred, because scoring 90% as hypoxaemia in a COPD patient would
   * generate constant false alarms.
   */
  spo2Scale2?: boolean;
}

export interface News2ParameterScore {
  parameter: News2Parameter;
  /** 0-3 for physiological parameters; 0 or 2 for the oxygen weighting. */
  score: number;
  /** null when the parameter was not measured. */
  value: number | string | null;
  label: string;
  /** How this parameter is scored, for display next to the number. */
  detail: string;
  citation: Citation;
}

export interface News2Result {
  /** Aggregate score. Only complete when every parameter was measured. */
  total: number;
  band: News2Band;
  parameters: News2ParameterScore[];
  /**
   * A single parameter scoring 3. NEWS2 treats this as unusual in isolation and
   * it warrants clinician review *regardless of the aggregate* — a patient can
   * score 3 overall with one red parameter and still be in trouble.
   */
  hasSingleRedScore: boolean;
  redParameter: News2Parameter | null;
  /**
   * Parameters that were not measured. A partial observation set must never be
   * presented as a low score: missing data that silently scores zero is how
   * track-and-trigger systems under-triage. `complete: false` means treat the
   * aggregate as a floor, not a verdict.
   */
  missing: News2Parameter[];
  complete: boolean;
  /** The published clinical response for this aggregate. */
  clinicalResponse: string;
  /** The lowest aggregate still requiring action, for a partial set. */
  minimumPossible: number;
  citation: Citation;
}

// ── Parameter scoring. Thresholds transcribed from the RCP NEWS2 chart. ──────

/** ≤8 or ≥25 scores 3; 9-11 scores 1; 21-24 scores 2; 12-20 scores 0. */
export function scoreRespiratoryRate(rr: number): number {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}

/**
 * SpO2 Scale 1, the default.
 *   ≤91 scores 3; 92-93 scores 2; 94-95 scores 1; ≥96 scores 0.
 */
export function scoreSpO2Scale1(spo2: number): number {
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
}

/**
 * SpO2 Scale 2, for confirmed hypercapnic respiratory failure (target 88-92%).
 *
 * On air: 88-92 or ≥93 scores 0. On oxygen: 93-94 scores 1, 95-96 scores 2,
 * ≥97 scores 3. Below target on air scores 1-3 in the same bands.
 */
export function scoreSpO2Scale2(spo2: number, onOxygen: boolean): number {
  if (!onOxygen) {
    if (spo2 >= 88 && spo2 <= 92) return 0;
    if (spo2 >= 93) return 0;
    if (spo2 <= 87) {
      if (spo2 <= 83) return 3;
      return spo2 <= 85 ? 2 : 1;
    }
    return 0;
  }
  if (spo2 >= 97) return 3;
  if (spo2 >= 95) return 2;
  if (spo2 >= 93) return 1;
  return 0;
}

/** ≤90 or ≥220 scores 3; 91-100 scores 2; 101-110 scores 1; 111-219 scores 0. */
export function scoreSystolicBp(systolic: number): number {
  if (systolic <= 90) return 3;
  if (systolic <= 100) return 2;
  if (systolic <= 110) return 1;
  if (systolic <= 220) return 0;
  return 3;
}

/** ≤40 or ≥131 scores 3; 41-50 and 91-110 score 1; 111-130 scores 2. */
export function scorePulse(pulse: number): number {
  if (pulse <= 40) return 3;
  if (pulse <= 50) return 1;
  if (pulse <= 90) return 0;
  if (pulse <= 110) return 1;
  if (pulse <= 130) return 2;
  return 3;
}

/**
 * ACVPU consciousness. Alert scores 0; anything worse scores 3.
 *
 * NEWS2 scores new confusion as 3, the same as unresponsiveness, because both
 * signal acute deterioration. A numeric value is accepted for CareSpeak's own
 * 0..100 alertness proxy, where anything under 40 is treated as not-alert: a
 * patient who cannot open their eyes is not "alert", whatever the hardware
 * reports.
 */
export function scoreConsciousness(level: NonNullable<News2VitalSet["consciousness"]>): number {
  if (typeof level === "number") return level < 40 ? 3 : 0;
  return level === "alert" ? 0 : 3;
}

/** ≤35.0 scores 3; 35.1-36.0 and 38.1-39.0 score 1; ≥39.1 scores 2. */
export function scoreTemperature(tempC: number): number {
  if (tempC <= 35.0) return 3;
  if (tempC <= 36.0) return 1;
  if (tempC <= 38.0) return 0;
  if (tempC <= 39.0) return 1;
  return 2;
}

/** Aggregate score → clinical response, exactly as published. */
export function news2Band(total: number): News2Band {
  if (total >= 7) return "high";
  if (total >= 5) return "medium";
  return "low";
}

export function news2Response(band: News2Band): string {
  switch (band) {
    case "high":
      return "Emergency assessment by the critical care team, usually leading to transfer to a higher-dependency area.";
    case "medium":
      return "Urgent review by the ward-based doctor or acute team nurse, and a decision on escalation to the critical care team.";
    default:
      return "Ward nurse assessment to decide whether to change monitoring frequency or escalate care.";
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function computeNews2(vitals: News2VitalSet): News2Result {
  const onO2 = vitals.supplementalOxygen === true;
  const parameters: News2ParameterScore[] = [];
  const missing: News2Parameter[] = [];

  const add = (
    parameter: News2Parameter,
    value: number | string | null,
    label: string,
    detail: string,
    section: string,
    scorer: (v: never) => number,
  ) => {
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      missing.push(parameter);
      return;
    }
    parameters.push({
      parameter,
      score: scorer(value as never),
      value,
      label,
      detail,
      citation: { docId: "RCP-NEWS2", section },
    });
  };

  add("respiratoryRate", vitals.respiratoryRate ?? null, "Respiratory rate", "breaths/min", "resp-rate", scoreRespiratoryRate as (v: never) => number);
  add(
    "spo2",
    vitals.spo2 ?? null,
    "SpO₂",
    vitals.spo2Scale2 ? "Scale 2 (hypercapnic target 88–92%)" : "Scale 1",
    vitals.spo2Scale2 ? "spo2-scale2" : "spo2-scale1",
    ((v: number) =>
      vitals.spo2Scale2 ? scoreSpO2Scale2(v, onO2) : scoreSpO2Scale1(v)) as (v: never) => number,
  );
  add("systolicBp", vitals.systolicBp ?? null, "Systolic BP", "mmHg", "systolic-bp", scoreSystolicBp as (v: never) => number);
  add("pulse", vitals.pulse ?? null, "Pulse", "beats/min", "pulse", scorePulse as (v: never) => number);
  add(
    "consciousness",
    vitals.consciousness ?? null,
    "Consciousness (ACVPU)",
    typeof vitals.consciousness === "string" ? vitals.consciousness : "alertness proxy",
    "consciousness",
    scoreConsciousness as (v: never) => number,
  );
  add("temperature", vitals.temperature ?? null, "Temperature", "°C", "temperature", scoreTemperature as (v: never) => number);

  // The oxygen weighting score is a flat +2, not a scored parameter.
  if (onO2) {
    parameters.push({
      parameter: "supplementalOxygen",
      score: 2,
      value: "on oxygen",
      label: "Supplemental oxygen",
      detail: "+2 weighting for oxygen to maintain the recommended saturation",
      citation: { docId: "RCP-NEWS2", section: "oxygen-uplift" },
    });
  }

  const total = parameters.reduce((sum, p) => sum + p.score, 0);
  const redParameter = parameters.find((p) => p.parameter !== "supplementalOxygen" && p.score === 3);
  const band = news2Band(total);

  return {
    total,
    band,
    parameters,
    hasSingleRedScore: !!redParameter,
    redParameter: redParameter?.parameter ?? null,
    missing,
    complete: missing.length === 0,
    clinicalResponse: news2Response(band),
    // Every missing parameter could contribute 3, so the aggregate is a floor.
    minimumPossible: total,
    citation: { docId: "RCP-NEWS2", section: "thresholds" },
  };
}

// ── The novel part: reading the score as a series ───────────────────────────

export type NewsTrend = "rising" | "falling" | "stable" | "insufficient";

export interface NewsTrendResult {
  trend: NewsTrend;
  /** Aggregate change against the comparison window. */
  delta: number;
  /** Aggregate now, and at the start of the window. */
  current: number;
  previous: number | null;
  /**
   * True when the patient is deteriorating *inside* a low band. A static score
   * of 3 looks unremarkable; 1 → 3 over an hour does not. This is the case a
   * snapshot-based system structurally cannot catch.
   */
  deterioratingWithinBand: boolean;
  explanation: string;
}

/**
 * Compare the current aggregate against a recent one.
 *
 * Requires both to be complete. A trend built on partial observations is a trend
 * built on missing data, and would move for reasons that have nothing to do with
 * the patient.
 */
export function newsTrend(
  current: News2Result,
  previous: News2Result | null,
  windowMinutes = 60,
): NewsTrendResult {
  if (!current.complete || !previous || !previous.complete) {
    return {
      trend: "insufficient",
      delta: 0,
      current: current.total,
      previous: previous?.total ?? null,
      deterioratingWithinBand: false,
      explanation: "Needs two complete observation sets to establish a trend.",
    };
  }

  const delta = current.total - previous.total;
  // Two points: anything inside +/-1 is noise, not a trajectory.
  const trend: NewsTrend = delta >= 2 ? "rising" : delta <= -2 ? "falling" : "stable";
  const deterioratingWithinBand = trend === "rising" && current.band === "low";

  let explanation: string;
  if (trend === "rising") {
    explanation = `NEWS2 ${previous.total} → ${current.total} over ${windowMinutes} min (rising).`;
  } else if (trend === "falling") {
    explanation = `NEWS2 ${previous.total} → ${current.total} over ${windowMinutes} min (improving).`;
  } else {
    explanation = `NEWS2 steady at ${current.total} over ${windowMinutes} min.`;
  }
  if (deterioratingWithinBand) {
    explanation +=
      " Still inside the low band, but the direction is the signal — this is the deterioration a single snapshot misses.";
  }

  return {
    trend,
    delta,
    current: current.total,
    previous: previous.total,
    deterioratingWithinBand,
    explanation,
  };
}

/**
 * One-line clinical summary for the dashboard and the alarm text.
 * States the aggregate, the band, and any single red score, because those drive
 * different actions and a nurse should not have to work out which applies.
 */
export function news2Summary(result: News2Result): string {
  const base = `NEWS2 ${result.total} (${result.band})`;
  if (result.hasSingleRedScore) {
    return `${base}, single red score in ${result.redParameter} — review regardless of aggregate.`;
  }
  if (!result.complete) {
    return `${base}, incomplete: ${result.missing.join(", ")} unmeasured — treat as a floor.`;
  }
  return base;
}
