import { describe, it, expect } from "vitest";
import { sanitizeVitals } from "../src/lib/server/vitals";

describe("sanitizeVitals", () => {
  it("clamps physiologically impossible values instead of dropping them", () => {
    const v = sanitizeVitals({ heartRate: 9999, spo2: -50, temperature: 90, batteryPct: 250 });
    expect(v.heartRate).toBe(300);
    expect(v.spo2).toBe(50);
    expect(v.temperature).toBe(45);
    expect(v.batteryPct).toBe(100);
    expect(v.sosActive).toBe(false);
  });

  it("passes through realistic values untouched", () => {
    const v = sanitizeVitals({ heartRate: 78, spo2: 97, temperature: 36.6, batteryPct: 84, rssi: -62, sosActive: true });
    expect(v).toEqual({ heartRate: 78, spo2: 97, temperature: 36.6, batteryPct: 84, rssi: -62, sosActive: true });
  });

  it("rejects non-finite junk and wrong types", () => {
    const v = sanitizeVitals({
      heartRate: Number.NaN,
      spo2: Infinity,
      temperature: "36" as unknown as number,
      batteryPct: null as unknown as number,
      rssi: Number.NaN,
    });
    expect(v.heartRate).toBeUndefined();
    expect(v.spo2).toBeUndefined();
    expect(v.temperature).toBeUndefined();
    expect(v.batteryPct).toBeUndefined();
    expect(v.rssi).toBeUndefined();
  });

  it("survives null / undefined / garbage payloads", () => {
    expect(sanitizeVitals(null)).toEqual({ sosActive: false });
    expect(sanitizeVitals(undefined)).toEqual({ sosActive: false });
    expect(sanitizeVitals("hack" as unknown as Record<string, never>)).toEqual({ sosActive: false });
  });
});
