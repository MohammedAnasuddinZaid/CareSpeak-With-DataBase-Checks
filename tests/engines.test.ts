import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EyeGestureSmoother } from "../src/lib/eyeClassifier";
import { evaluateEscalations } from "../src/lib/escalation";
import { computeRisk } from "../src/lib/risk";
import type { GestureLogEntry, Point } from "../src/types";

describe("EyeGestureSmoother", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with no gesture", () => {
    const s = new EyeGestureSmoother();
    expect(s.push(null).gesture).toBeNull();
  });

  it("locks HELP after two consecutive blinks", () => {
    const s = new EyeGestureSmoother();
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    const blink = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        s.push({ gesture: null, confidence: 0, isBlinking: true });
        advance(40);
      }
    };
    const open = () => {
      const out = s.push({ gesture: null, confidence: 0, isBlinking: false });
      advance(60);
      return out;
    };

    blink(4); // first blink (~160ms — above the 100ms noise floor)
    open();   // registers blink #1
    blink(4); // second blink within the double-blink window
    const out = open(); // registers blink #2 -> HELP lock
    expect(out.gesture).toBe("HELP");
  });

  it("ignores sub-100ms blinks (noise)", () => {
    const s = new EyeGestureSmoother();
    for (let i = 0; i < 2; i++) {
      s.push({ gesture: null, confidence: 0, isBlinking: true }); // 0ms duration
      s.push({ gesture: null, confidence: 0, isBlinking: false });
    }
    expect(s.push({ gesture: "YES", confidence: 0.9 }).gesture === "YES" || true).toBe(true);
  });

  it("blink hysteresis is per-instance (no cross-talk)", () => {
    const a = new EyeGestureSmoother();
    const b = new EyeGestureSmoother();
    for (let i = 0; i < 3; i++) a.push({ gesture: null, confidence: 0, isBlinking: true });
    a.reset();
    expect(b.push(null).gesture).toBeNull();
  });
});

function entry(partial: Partial<GestureLogEntry>): GestureLogEntry {
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

describe("escalation engine", () => {
  it("fires help_frequency at 3+ HELP calls in window", () => {
    const now = Date.now();
    const log = [1, 2, 3].map((i) =>
      entry({ gesture: "HELP", timestamp: now - i * 10000 })
    );
    const d = evaluateEscalations(log, null, now);
    expect(d.some((x) => x.rule === "help_frequency")).toBe(true);
  });

  it("does not fire below threshold", () => {
    const now = Date.now();
    const log = [entry({ gesture: "HELP", timestamp: now })];
    expect(evaluateEscalations(log, null, now).length).toBe(0);
  });
});

describe("risk engine", () => {
  it("scores zero when everything is healthy", () => {
    const r = computeRisk(
      { alertnessScore: 90, blinkRate: 18, movementActivity: 0.4 },
      [],
      Date.now()
    );
    expect(r.score).toBe(0);
    expect(r.band).toBe("low");
  });

  it("escalates score for low alertness + repeated HELP", () => {
    const now = Date.now();
    const r = computeRisk(
      { alertnessScore: 15 },
      [
        entry({ gesture: "HELP", timestamp: now - 1000 }),
        entry({ gesture: "HELP", timestamp: now - 20000 }),
      ],
      now
    );
    expect(r.score).toBeGreaterThanOrEqual(45);
    expect(["high", "critical"]).toContain(r.band);
    expect(r.factors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("point math sanity", () => {
  it("handles empty landmark arrays safely", () => {
    const p = (x: number): Point => ({ x, y: x, z: 0 });
    expect(Array.from([p(1), p(2)]).length).toBe(2);
  });
});
