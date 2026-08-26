import { describe, it, expect } from "vitest";
import { evaluateEscalations } from "../src/lib/escalation";
import { forecastDeterioration } from "../src/lib/forecast";
import { GestureLogEntry, ESCALATION_RULES } from "../src/types";

function mk(partial: Partial<GestureLogEntry>): GestureLogEntry {
  return {
    id: Math.random().toString(36).slice(2),
    gesture: "YES",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: Date.now(),
    language: "en-US",
    ...partial,
  };
}

describe("escalation engine (regression fixes)", () => {
  it("low_alertness escalates an older actionable entry even when a resolved one is newest", () => {
    const [, lowAlert] = ESCALATION_RULES;
    const now = Date.now();
    const log = [
      mk({ id: "resolved", timestamp: now - 1000, resolved: true, acknowledged: true }),
      mk({ id: "actionable", timestamp: now - 5000 }),
    ];
    const metrics = {
      alertnessScore: 10,
      lastSeen: new Date(now).toISOString(),
    };
    const decisions = evaluateEscalations(log, metrics as never, now);
    // the dead `|| (escalated && !resolved)` clause used to abort this rule
    expect(decisions.some((d) => d.rule === "low_alertness" && d.entryId === "actionable")).toBe(true);
    void lowAlert;
  });

  it("prolonged_inactivity attaches to a non-resolved target or does not fire at all", () => {
    const now = Date.now();
    const stale = now - 10 * 60 * 1000;
    const allResolved = [mk({ id: "r", timestamp: stale, resolved: true, acknowledged: true })];
    expect(evaluateEscalations(allResolved, null, now)).toHaveLength(0);

    const hasOpen = [
      mk({ id: "r", timestamp: stale - 1000, resolved: true, acknowledged: true }),
      mk({ id: "open", timestamp: stale }),
    ];
    const decisions = evaluateEscalations(hasOpen, null, now);
    const inact = decisions.find((d) => d.rule === "prolonged_inactivity");
    expect(inact?.entryId).toBe("open");
  });
});

describe("forecast maths (damped Holt + despike + noise gate)", () => {
  it("median-of-3 despiking rejects a single sensor spike", () => {
    const base = Array.from({ length: 12 }, (_, i) => 80);
    const withSpike = [...base];
    withSpike[5] = 300; // impossible jump
    const t = Date.now();
    const samples = withSpike.map((hr, i) => ({ t: t + i * 5000, hr }));
    const f = forecastDeterioration(samples);
    // level must stay near 80 — the spike must not be treated as real signal
    expect(f.projected.hr).toBeLessThan(110);
  });

  it("a flat noisy series is NOT declared trending toward a limit", () => {
    // oscillating around 88 SpO2 (safe), no real trend
    const t = Date.now();
    const samples = Array.from({ length: 40 }, (_, i) => ({
      t: t + i * 5000,
      spo2: 96 + Math.sin(i * 1.7) * 3,
    }));
    const f = forecastDeterioration(samples);
    expect(Object.keys(f.minutesToThreshold)).toHaveLength(0);
    expect(f.band).toBe("stable");
  });

  it("a genuine sustained decline still crosses its threshold (sensitivity kept)", () => {
    const t = Date.now();
    let spo2 = 99;
    const samples = Array.from({ length: 20 }, (_, i) => {
      spo2 -= 0.25; // real decline -> crosses 92% inside the 30-min window
      return { t: t + i * 60000, spo2 };
    });
    const f = forecastDeterioration(samples);
    // Either an ETA is projected, or the smoothed level already sits outside
    // the safe range — both are valid detections; silence is the only failure.
    const detected =
      Number.isFinite(f.minutesToThreshold.spo2) ||
      f.reasons.some((r) => r.startsWith("SpO₂"));
    expect(detected).toBe(true);
  });
});
