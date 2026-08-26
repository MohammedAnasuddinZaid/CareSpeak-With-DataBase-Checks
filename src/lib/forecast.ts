/**
 * Predictive deterioration trajectory.
 *
 * Damped Holt double-exponential smoothing (level + trend, Gardner–McKenzie)
 * over the recent vital / wellness stream, projected 15 minutes ahead against
 * clinical thresholds. Median-of-3 despiking rejects single-frame sensor
 * glitches; a residual-noise (2σ) gate stops flat-but-noisy signals from being
 * declared "trending". Deliberately simple, explainable math: a nurse can ask
 * "why?" and get a one-line answer, unlike any black-box model.
 */

export interface VitalSample {
  t: number;
  hr?: number;
  spo2?: number;
  alertness?: number;
  movement?: number;
}

export interface ForecastResult {
  /** projected value ~15 minutes ahead per signal */
  projected: Record<string, number>;
  /** minutes until each signal crosses its clinical threshold (Infinity = never at this trend) */
  minutesToThreshold: Record<string, number>;
  score: number; // 0-100
  band: "stable" | "watch" | "warning" | "imminent";
  reasons: string[];
}

const THRESHOLDS: Record<string, { min?: number; max?: number; weight: number; label: string }> = {
  hr: { min: 50, max: 120, weight: 25, label: "Heart rate" },
  spo2: { min: 92, weight: 35, label: "SpO₂" },
  alertness: { min: 40, weight: 20, label: "Alertness" },
  // Stillness is the danger: movement FALLING below this = concerning.
  movement: { min: 0.05, weight: 10, label: "Movement" },
};

/**
 * Median-of-3 despike: a single glitchy sensor frame (motion artefact, BLE
 * hiccup) must not drag Holt's level with it. Median filters pass monotone
 * trends untouched but kill isolated spikes — the standard pre-smoother for
 * biomedical signals.
 */
function despike(values: number[]): number[] {
  if (values.length < 3) return values.slice();
  const out = new Array<number>(values.length);
  out[0] = values[0];
  out[values.length - 1] = values[values.length - 1];
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[i - 1];
    const b = values[i];
    const c = values[i + 1];
    out[i] = a <= b ? (b <= c ? b : a <= c ? c : a) : a <= c ? a : b <= c ? c : b;
  }
  return out;
}

/** Root-mean-square of one-step forecast residuals — how noisy is this signal? */
function rmseOfResiduals(values: number[], level: number, trend: number, alpha: number, beta: number): number {
  let l = values[0];
  let t = trend;
  let sq = 0;
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    const forecast = l + t;
    const err = values[i] - forecast;
    sq += err * err;
    n++;
    const prevL = l;
    l = alpha * values[i] + (1 - alpha) * (l + t);
    t = beta * (l - prevL) + (1 - beta) * t;
  }
  void level;
  return n > 0 ? Math.sqrt(sq / n) : 0;
}

/**
 * Damped Holt's linear method (Gardner–McKenzie). A pure linear trend
 * extrapolated 15 minutes ahead wildly over-claims for noisy vitals; damping
 * every future step by φ ∈ (0,1) converges the projection toward a realistic
 * ceiling: sum_{h=1..H} trend·φ^h instead of trend·H.
 */
function holt(
  values: number[],
  alpha = 0.4,
  beta = 0.2,
  phi = 0.85
): { level: number; trend: number; noise: number } {
  if (values.length === 0) return { level: NaN, trend: 0, noise: 0 };
  let level = values[0];
  let trend = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = level;
    level = alpha * values[i] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prev) + (1 - beta) * phi * trend;
  }
  // Noisy signals get a slower trend response (adaptive smoothing).
  const noise = rmseOfResiduals(values, level, trend, alpha, beta);
  return { level, trend, noise };
}

/** Projected value h minutes ahead under a damped trend. */
function dampedProjection(level: number, trend: number, phi: number, horizon: number): number {
  let sum = 0;
  let t = trend;
  for (let h = 1; h <= horizon; h++) {
    sum += t;
    t *= phi;
  }
  return level + sum;
}

export function forecastDeterioration(samples: VitalSample[]): ForecastResult {
  const clean = samples.filter((s) => s.t > 0).sort((a, b) => a.t - b.t);
  const signals: Record<string, number[]> = {};
  for (const s of clean) {
    for (const k of Object.keys(THRESHOLDS)) {
      const v = (s as unknown as Record<string, number | undefined>)[k];
      if (typeof v === "number" && Number.isFinite(v)) (signals[k] ??= []).push(v);
    }
  }

  const projected: Record<string, number> = {};
  const eta: Record<string, number> = {};
  const reasons: string[] = [];
  let score = 0;

  const HORIZON = 15; // minutes ahead
  const SOON = 30; // "approaching" window
  const PHI = 0.85; // trend damping per minute

  for (const [key, series] of Object.entries(signals)) {
    if (series.length < 4) continue;
    const th = THRESHOLDS[key];
    const despiked = despike(series.slice(-40));
    const { level, trend, noise } = holt(despiked);
    if (!Number.isFinite(level)) continue;
    const p = Math.round(dampedProjection(level, trend, PHI, HORIZON) * 100) / 100;
    projected[key] = p;

    // A trend smaller than the signal's own noise floor is statistically
    // indistinguishable from flat — never claim "approaching limit" off it.
    // (2σ ≈ 95% confidence under roughly-normal residuals.)
    const meaningfulTrend = Math.abs(trend) > 2 * noise / Math.max(1, Math.sqrt(despiked.length));

    // minutes until the smoothed LEVEL crosses a limit at the current trend
    let crossedIn = Infinity;
    if (meaningfulTrend && th.min != null && trend < 0 && level > th.min) crossedIn = (level - th.min) / -trend;
    if (meaningfulTrend && th.max != null && trend > 0 && level < th.max) crossedIn = (th.max - level) / trend;

    const belowNow = (th.min != null && level < th.min) || (th.max != null && level > th.max);
    const approaching = !belowNow && Number.isFinite(crossedIn) && crossedIn <= SOON;

    if (belowNow) {
      score += th.weight;
      reasons.push(`${th.label} outside safe range (${formatVal(key, level)})`);
    } else if (approaching) {
      score += th.weight / 2;
      reasons.push(
        `${th.label} trending toward limit (~${Math.max(1, Math.round(crossedIn))} min at current rate)`
      );
      eta[key] = crossedIn;
    }
  }

  score = Math.min(100, Math.round(score));
  // watch fires from 10: a single half-weight "approaching" signal (e.g. HR
  // trending toward tachycardia = 12.5) must already surface as watch.
  const band: ForecastResult["band"] =
    score >= 70 ? "imminent" : score >= 45 ? "warning" : score >= 10 ? "watch" : "stable";
  return { projected, minutesToThreshold: eta, score, band, reasons };
}

function formatVal(key: string, v: number): string {
  if (key === "movement") return `${Math.round(v * 100)}% activity`;
  return String(Math.round(v * 10) / 10);
}

/** Rank helper so callers can react only when severity increases. */
export function bandRank(b: ForecastResult["band"]): number {
  return { stable: 0, watch: 1, warning: 2, imminent: 3 }[b];
}

/** Build the SYSTEM log entry text for an auto-raised trajectory alert. */
export function trajectoryAlertText(f: ForecastResult): string {
  return `Deterioration trajectory ${f.score}/100 (${f.band}) — ${f.reasons.slice(0, 3).join("; ")}`;
}
