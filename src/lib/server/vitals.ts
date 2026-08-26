/**
 * Clinical-range clamps for wearable vitals arriving over HTTP.
 * A buggy sensor or malformed payload must never poison charts,
 * the risk engine or the Holt trajectory forecast.
 */

export interface RawVitals {
  heartRate?: number;
  spo2?: number;
  temperature?: number;
  batteryPct?: number;
  rssi?: number;
  sosActive?: boolean;
}

export interface SanitizedVitals {
  heartRate?: number;
  spo2?: number;
  temperature?: number;
  batteryPct?: number;
  rssi?: number;
  sosActive: boolean;
}

function clampRange(n: unknown, min: number, max: number): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Reject NaN/Infinity and clamp into [min,max] — shared with /api/sync so a
 *  garbage metric can never poison charts or disable escalation rules. */
export function clampFinite(n: unknown, min: number, max: number): number | undefined {
  return clampRange(n, min, max);
}

/** Physiologically plausible envelopes (values outside are clamped, not dropped,
 *  so a single glitch frame cannot silently hide a device that IS streaming). */
const LIMITS = {
  heartRate: { min: 20, max: 300 },
  spo2: { min: 50, max: 100 },
  temperature: { min: 25, max: 45 },
  batteryPct: { min: 0, max: 100 },
} as const;

export function sanitizeVitals(v: RawVitals | null | undefined): SanitizedVitals {
  if (!v || typeof v !== "object") {
    return { sosActive: false };
  }
  return {
    heartRate: clampRange(v.heartRate, LIMITS.heartRate.min, LIMITS.heartRate.max),
    spo2: clampRange(v.spo2, LIMITS.spo2.min, LIMITS.spo2.max),
    temperature: clampRange(v.temperature, LIMITS.temperature.min, LIMITS.temperature.max),
    batteryPct: clampRange(v.batteryPct, LIMITS.batteryPct.min, LIMITS.batteryPct.max),
    rssi: typeof v.rssi === "number" && Number.isFinite(v.rssi) ? v.rssi : undefined,
    sosActive: !!v.sosActive,
  };
}
