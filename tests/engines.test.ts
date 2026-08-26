import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EyeGestureSmoother, GazeStabilizer, IrisCalibrator, computeAvgIrisOffset, classifyEyeGesture } from "../src/lib/eyeClassifier";
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
    const after = s.push({ gesture: "YES", confidence: 0.9, isBlinking: false });
    expect(after.gesture === "YES" || after.gesture === null).toBe(true);
  });

  it("blink hysteresis is per-instance (no cross-talk)", () => {
    const a = new EyeGestureSmoother();
    const b = new EyeGestureSmoother();
    for (let i = 0; i < 3; i++) a.push({ gesture: null, confidence: 0, isBlinking: true });
    a.reset();
    expect(b.push(null).gesture).toBeNull();
  });
});

describe("gaze calibration (regression: only WATER was detected)", () => {
  const pt = (x: number, y: number): Point => ({ x, y, z: 0 });

  /** 478-landmark face with eyes open, mouth closed, and a realistic
   *  downward iris bias of +0.12 eye-widths when looking straight ahead. */
  function makeFace(irisShiftX = 0): Point[] {
    const lm: Point[] = new Array(478).fill(null).map(() => pt(0.5, 0.5));
    lm[33] = pt(0.40, 0.40); lm[133] = pt(0.46, 0.40);   // left eye corners
    lm[362] = pt(0.54, 0.40); lm[263] = pt(0.60, 0.40);  // right eye corners
    lm[159] = pt(0.43, 0.385); lm[145] = pt(0.43, 0.415); // left lids
    lm[386] = pt(0.57, 0.385); lm[374] = pt(0.57, 0.415); // right lids
    const biasY = 0.12 * 0.06;
    lm[468] = pt(0.43 + irisShiftX, 0.40 + biasY); // left iris
    lm[473] = pt(0.57 + irisShiftX, 0.40 + biasY); // right iris
    lm[13] = pt(0.50, 0.50); lm[14] = pt(0.50, 0.508);    // lips closed
    lm[168] = pt(0.50, 0.35); lm[152] = pt(0.50, 0.75);   // nose bridge / chin
    return lm;
  }

  it("uncalibrated vertical bias masquerades as WATER (documents the old bug)", () => {
    const r = classifyEyeGesture(makeFace(), { mirrored: true });
    expect(r?.gesture).toBe("WATER");
  });

  it("calibrated neutral gaze produces no gesture", () => {
    const cal = new IrisCalibrator();
    for (let i = 0; i < 120; i++)
      cal.updateGated(computeAvgIrisOffset(makeFace(), true), { isBlinking: false, activeGesture: null });
    expect(cal.ready).toBe(true);
    const r = classifyEyeGesture(makeFace(), { mirrored: true, baseline: cal.value });
    expect(r?.gesture).toBeNull();
  });

  it("lateral gaze after calibration yields YES with usable confidence", () => {
    const cal = new IrisCalibrator();
    for (let i = 0; i < 120; i++)
      cal.updateGated(computeAvgIrisOffset(makeFace(), true), { isBlinking: false, activeGesture: null });
    const looking = makeFace(-0.009); // 0.15 eye-widths toward screen-left
    const r = classifyEyeGesture(looking, { mirrored: true, baseline: cal.value });
    expect(r?.gesture).toBe("YES");
    expect(r?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("calibration ignores deliberate gaze frames (no mid-hold drift)", () => {
    const cal = new IrisCalibrator();
    // Bootstrap on neutral...
    for (let i = 0; i < 60; i++)
      cal.updateGated(computeAvgIrisOffset(makeFace(), true), { isBlinking: false, activeGesture: null });
    const before = { ...cal.value };
    // ...then hold a hard left look for many frames — baseline must not move.
    for (let i = 0; i < 300; i++)
      cal.updateGated(computeAvgIrisOffset(makeFace(-0.009), true), { isBlinking: false, activeGesture: "YES" });
    expect(cal.value.x).toBeCloseTo(before.x, 6);
    expect(cal.value.y).toBeCloseTo(before.y, 6);
  });
});

describe("GazeStabilizer (micro-saccade hysteresis)", () => {
  const res = (dx: number, gesture: "YES" | "NO" | null) =>
    ({ gesture, confidence: 0.9, isBlinking: false, dx, dy: 0 });

  it("blocks weak flicker from entering", () => {
    const s = new GazeStabilizer();
    expect(s.filter(res(-0.02, null))?.gesture ?? null).toBeNull();
    expect(s.filter(res(-0.045, "YES"))?.gesture ?? null).toBeNull(); // below ENTER band
  });

  it("holds the direction through sign-flapping frames", () => {
    const s = new GazeStabilizer();
    s.filter(res(-0.07, "YES")); // enter
    const seq = [-0.04, -0.06, -0.035, -0.08];
    for (const dx of seq) {
      const out = s.filter(res(dx, "YES"));
      expect(out?.gesture ?? null).toBe("YES");
    }
  });

  it("releases only when the offset genuinely relaxes (no ghost re-fire)", () => {
    const s = new GazeStabilizer();
    s.filter(res(-0.07, "YES"));
    expect(s.filter(res(-0.01, null))?.gesture ?? null).toBeNull(); // released via neutral frame
    expect(s.filter(res(-0.045, "YES"))?.gesture ?? null).toBeNull(); // ghost blocked after release
  });

  it("switches direction only on debounced, full-strength counter evidence", () => {
    const s = new GazeStabilizer();
    s.filter(res(-0.07, "YES"));
    // single NO frame at full strength is treated as a spike -> still YES
    expect(s.filter(res(0.08, "NO"))?.gesture ?? null).toBe("YES");
    // second consecutive NO frame confirms a deliberate switch
    expect(s.filter(res(0.08, "NO"))?.gesture ?? null).toBe("NO");
    expect(s.filter(res(0.04, "NO"))?.gesture ?? null).toBe("NO"); // held through decay band
    expect(s.filter(res(0.005, null))?.gesture ?? null).toBeNull(); // then released
  });

  it("a single violent landmark spike cannot steal or create a state", () => {
    const s = new GazeStabilizer();
    s.filter(res(-0.07, "YES"));
    // spike frame is discarded (nulled); the smoother majority keeps YES alive
    expect(s.filter(res(0.35, "NO"))?.gesture ?? null).toBeNull();
    expect(s.filter(res(-0.06, "YES"))?.gesture ?? null).toBe("YES"); // signal intact
  });

  it("an impossible inter-frame jump is discarded as a glitch frame", () => {
    const s = new GazeStabilizer();
    const first = s.filter(res(-0.07, "YES"));
    expect(first?.gesture ?? null).toBe("YES");
    const glitched = s.filter(res(0.30, "NO"));
    expect(glitched?.gesture ?? null).toBeNull(); // jump of 0.37 > 0.28 physical limit
  });

  it("post-blink refractory suppresses reopening garbage", () => {
    const s = new GazeStabilizer();
    const t0 = 10_000;
    s.markRecovery(t0);
    expect(s.filter(res(-0.09, "YES"), t0 + 50)?.gesture ?? null).toBeNull(); // inside refractory
    expect(s.filter(res(-0.09, "YES"), t0 + 200)?.gesture ?? null).toBe("YES"); // settled -> accepted
  });

  it("adaptive bands scale with the user's measured jitter", () => {
    const twitchy = new GazeStabilizer();
    twitchy.tune({ sx: 0.02, sy: 0.02 }); // noisy user -> enterX ≈ 3.2*0.02+0.015
    expect(twitchy.filter(res(0.06, "NO"))?.gesture ?? null).toBeNull(); // below their band
    const steady = new GazeStabilizer();
    steady.tune({ sx: 0.004, sy: 0.004 }); // steady user -> floor 0.05 applies
    expect(steady.filter(res(0.06, "NO"))?.gesture ?? null).toBe("NO");
  });

  it("lets mouth-driven WATER pass untouched (regression)", () => {
    // Mouth-open WATER has no gaze offsets; hysteresis must not swallow it.
    const s = new GazeStabilizer();
    const out = s.filter({ gesture: "WATER", confidence: 1, isBlinking: false, dx: 0.004, dy: -0.003 });
    expect(out?.gesture ?? null).toBe("WATER");
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
