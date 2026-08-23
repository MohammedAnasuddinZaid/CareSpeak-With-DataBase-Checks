import { describe, it, expect } from "vitest";
import { forecastDeterioration } from "../src/lib/forecast";
import type { VitalSample } from "../src/lib/forecast";

function series(n: number, start: number, delta: number, t0 = 0): VitalSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * 60000, hr: start + delta * i }));
}

describe("forecastDeterioration", () => {
  it("healthy flat vitals score zero (stable)", () => {
    const samples: VitalSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 60000,
      hr: 74,
      spo2: 98,
      alertness: 82,
      movement: 0.4,
    }));
    const f = forecastDeterioration(samples);
    expect(f.score).toBe(0);
    expect(f.band).toBe("stable");
    expect(f.reasons.length).toBe(0);
  });

  it("rising heart rate approaching 120 raises a watch/warning with an ETA", () => {
    const samples = series(38, 72, 1.25); // ends ≈118, trend ≈ +1.25/min
    const f = forecastDeterioration(samples);
    expect(f.projected.hr).toBeGreaterThan(120);
    expect(Number.isFinite(f.minutesToThreshold.hr)).toBe(true);
    expect(f.minutesToThreshold.hr).toBeLessThanOrEqual(30);
    expect(f.band).not.toBe("stable");
    expect(f.reasons.join(" ")).toMatch(/Heart rate/i);
  });

  it("falling SpO₂ below 92 counts as already-below (full weight)", () => {
    const samples: VitalSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 60000,
      spo2: 97 - 0.3 * i, // ends ≈91.3 — genuinely below the 92 limit
    }));
    const f = forecastDeterioration(samples);
    expect(f.score).toBeGreaterThanOrEqual(30); // spo2 weight = 35
    expect(f.reasons.join(" ")).toMatch(/SpO/i);
  });

  it("sparse short input does not crash or NaN", () => {
    const f = forecastDeterioration([
      { t: 1, hr: 80 },
      { t: 2, spo2: 96 },
    ]);
    expect(Number.isFinite(f.score)).toBe(true);
    expect(Object.values(f.projected).every((v) => Number.isFinite(v))).toBe(true);
  });
});
