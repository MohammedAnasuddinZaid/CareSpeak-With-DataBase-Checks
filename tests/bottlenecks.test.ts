import { describe, it, expect } from "vitest";
import { GestureLogEntry } from "../src/types";
import {
  BottleneckSample,
  sanitizeSample,
  samplesFromEntries,
  percentile,
  latencyOf,
  computeFunnel,
  buildBottleneckReport,
  detectBottlenecks,
  isHighAcuity,
  fmtMs,
  fmtRate,
  BREACH_OPEN_MS,
  STUCK_ESCALATED_MS,
} from "../src/lib/bottlenecks";

function entry(partial: Partial<GestureLogEntry> & { id: string; timestamp: number }): GestureLogEntry {
  return {
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    language: "en-US",
    ...partial,
  };
}

function sample(partial: Partial<BottleneckSample> & { id: string; raisedAt: number }): BottleneckSample {
  return {
    gesture: "HELP",
    acknowledgedAt: null,
    escalatedAt: null,
    resolvedAt: null,
    ...partial,
  };
}

describe("sanitizeSample", () => {
  it("rejects non-object input defensively", () => {
    const now = Date.now();
    expect(sanitizeSample(null, now)).toBeNull();
    expect(sanitizeSample(undefined, now)).toBeNull();
  });

  it("drops samples raised impossibly far in the future", () => {
    const now = Date.now();
    expect(sanitizeSample(sample({ id: "x", raisedAt: now + 60_000 }), now)).toBeNull();
    expect(sanitizeSample(sample({ id: "x", raisedAt: now + 3_000 }), now)).not.toBeNull();
  });

  it("clamps an acknowledgement recorded before the raise to zero latency", () => {
    const now = Date.now();
    const out = sanitizeSample(
      sample({ id: "x", raisedAt: now - 10_000, acknowledgedAt: now - 30_000 }),
      now,
    );
    expect(out?.acknowledgedAt).toBe(out?.raisedAt);
  });

  it("drops lifecycle timestamps that are impossibly future", () => {
    const now = Date.now();
    const out = sanitizeSample(
      sample({ id: "x", raisedAt: now - 10_000, acknowledgedAt: now + 60_000 }),
      now,
    );
    expect(out?.acknowledgedAt).toBeNull();
  });

  it("upper-cases unknown gesture names defensively", () => {
    const now = Date.now();
    expect(sanitizeSample(sample({ id: "x", raisedAt: now - 1000, gesture: "help" }), now)?.gesture).toBe("HELP");
  });
});

describe("samplesFromEntries", () => {
  it("deduplicates replayed rows by id, keeping the first", () => {
    const now = Date.now();
    const entries = [
      entry({ id: "a", timestamp: now - 60_000, acknowledgedAt: now - 30_000 }),
      entry({ id: "a", timestamp: now - 60_000, acknowledgedAt: now - 10_000 }), // replay, ignored
      entry({ id: "b", timestamp: now - 40_000 }),
    ];
    const samples = samplesFromEntries(entries, now);
    expect(samples).toHaveLength(2);
    const a = samples.find((s) => s.id === "a");
    expect(a?.acknowledgedAt).toBe(now - 30_000);
  });

  it("skips entries with a bogus raise time", () => {
    const now = Date.now();
    const samples = samplesFromEntries(
      [entry({ id: "bad", timestamp: Number.NaN }), entry({ id: "ok", timestamp: now - 1000 })],
      now,
    );
    expect(samples.map((s) => s.id)).toEqual(["ok"]);
  });
});

describe("percentile", () => {
  it("computes nearest-rank percentiles", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(arr, 50)).toBe(5);
    expect(percentile(arr, 90)).toBe(9);
    expect(percentile(arr, 100)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("latencyOf", () => {
  it("returns empty stats when nothing was acknowledged", () => {
    const now = Date.now();
    const stats = latencyOf([sample({ id: "a", raisedAt: now - 1000 })], "acknowledgedAt");
    expect(stats.n).toBe(0);
    expect(stats.medianMs).toBeNull();
  });

  it("reports mean/median/p90/max over ack latency", () => {
    const now = Date.now();
    const samples = [10, 20, 30, 40, 50].map((sec, i) =>
      sample({ id: `a${i}`, raisedAt: now - 50_000, acknowledgedAt: now - 50_000 + sec * 1000 }),
    );
    const stats = latencyOf(samples, "acknowledgedAt");
    expect(stats.n).toBe(5);
    expect(stats.meanMs).toBe(30_000);
    expect(stats.medianMs).toBe(30_000);
    expect(stats.p90Ms).toBe(50_000);
    expect(stats.maxMs).toBe(50_000);
  });
});

describe("computeFunnel", () => {
  it("counts lifecycle transitions and rates", () => {
    const now = Date.now();
    const samples = [
      sample({ id: "a", raisedAt: now - 1000, acknowledgedAt: now - 500 }),
      sample({ id: "b", raisedAt: now - 1000, acknowledgedAt: now - 400, escalatedAt: now - 300 }),
      sample({
        id: "c",
        raisedAt: now - 1000,
        acknowledgedAt: now - 400,
        escalatedAt: now - 300,
        resolvedAt: now - 100,
      }),
      sample({ id: "d", raisedAt: now - 1000 }),
    ];
    const funnel = computeFunnel(samples);
    expect(funnel.raised).toBe(4);
    expect(funnel.acknowledged).toBe(3);
    expect(funnel.escalated).toBe(2);
    expect(funnel.resolved).toBe(1);
    expect(funnel.ackRate).toBeCloseTo(0.75);
  });

  it("returns null rates for an empty feed instead of dividing by zero", () => {
    const funnel = computeFunnel([]);
    expect(funnel.raised).toBe(0);
    expect(funnel.ackRate).toBeNull();
    expect(funnel.escalationRate).toBeNull();
  });
});

describe("detectBottlenecks", () => {
  it("flags high-acuity requests open past the breach window", () => {
    const now = Date.now();
    const notes = detectBottlenecks(
      [sample({ id: "a", gesture: "HELP", raisedAt: now - (BREACH_OPEN_MS + 10_000) })],
      now,
    );
    expect(notes.some((n) => n.kind === "critical_open")).toBe(true);
  });

  it("clears the breach the moment the request is acknowledged", () => {
    const now = Date.now();
    const notes = detectBottlenecks(
      [
        sample({
          id: "a",
          gesture: "HELP",
          raisedAt: now - (BREACH_OPEN_MS + 10_000),
          acknowledgedAt: now - 5_000,
        }),
      ],
      now,
    );
    expect(notes.some((n) => n.kind === "critical_open")).toBe(false);
  });

  it("flags escalated-but-unresolved chains past 15 minutes", () => {
    const now = Date.now();
    const notes = detectBottlenecks(
      [
        sample({
          id: "a",
          raisedAt: now - (STUCK_ESCALATED_MS + 60_000),
          escalatedAt: now - (STUCK_ESCALATED_MS + 5_000),
        }),
      ],
      now,
    );
    expect(notes.some((n) => n.kind === "stuck_escalated")).toBe(true);
  });

  it("flags a ward where over half of requests go unacknowledged", () => {
    const now = Date.now();
    const samples = Array.from({ length: 6 }, (_, i) =>
      sample({
        id: `a${i}`,
        raisedAt: now - 30_000,
        acknowledgedAt: i < 2 ? now - 10_000 : null,
      }),
    );
    const notes = detectBottlenecks(samples, now);
    expect(notes.some((n) => n.kind === "low_ack_rate")).toBe(true);
  });

  it("flags median time-to-ack beyond the response-time target", () => {
    const now = Date.now();
    const samples = Array.from({ length: 6 }, (_, i) =>
      sample({
        id: `a${i}`,
        raisedAt: now - 300_000,
        acknowledgedAt: now - 30_000, // 4.5 min latency, over the 3 min target
      }),
    );
    const notes = detectBottlenecks(samples, now);
    expect(notes.some((n) => n.kind === "slow_acknowledgement")).toBe(true);
  });

  it("stays silent on a healthy feed", () => {
    const now = Date.now();
    const samples = Array.from({ length: 6 }, (_, i) =>
      sample({
        id: `a${i}`,
        gesture: "HELP",
        raisedAt: now - 30_000,
        acknowledgedAt: now - 20_000 + i, // fast, ~10s, sub-breach
      }),
    );
    const notes = detectBottlenecks(samples, now);
    expect(notes.some((n) => n.kind === "critical_open")).toBe(false);
    expect(notes.some((n) => n.kind === "slow_acknowledgement")).toBe(false);
    expect(notes.some((n) => n.kind === "low_ack_rate")).toBe(false);
  });

  it("does not invent a slow-period trend from one sample", () => {
    const now = Date.now();
    const samples = [sample({ id: "a", raisedAt: now - 30_000, acknowledgedAt: now - 100 }), sample({ id: "b", raisedAt: now - 20_000, acknowledgedAt: now - 200 })];
    const notes = detectBottlenecks(samples, now);
    expect(notes.some((n) => n.kind === "slow_period")).toBe(false);
  });
});

describe("buildBottleneckReport", () => {
  it("computes the analysis window from raise times", () => {
    const now = Date.now();
    const report = buildBottleneckReport(
      [
        sample({ id: "a", raisedAt: now - 20_000 }),
        sample({ id: "b", raisedAt: now - 10_000 }),
      ],
      now,
    );
    expect(report.windowStartMs).toBe(now - 20_000);
    expect(report.windowEndMs).toBe(now - 10_000);
  });

  it("is honest about insufficient data", () => {
    const now = Date.now();
    const report = buildBottleneckReport([sample({ id: "a", raisedAt: now - 1000 })], now);
    expect(report.dataSufficient).toBe(false);
  });

  it("reports the empty-feed case without raising", () => {
    const now = Date.now();
    const report = buildBottleneckReport([], now);
    expect(report.funnel.raised).toBe(0);
    expect(report.dataSufficient).toBe(false);
    expect(report.notes.some((n) => n.kind === "no_data")).toBe(true);
  });
});

describe("helpers", () => {
  it("classifies high-acuity gestures", () => {
    expect(isHighAcuity("HELP")).toBe(true);
    expect(isHighAcuity("EMERGENCY")).toBe(true);
    expect(isHighAcuity("IN_PAIN")).toBe(true);
    expect(isHighAcuity("HELLO")).toBe(false);
    expect(isHighAcuity("help")).toBe(true); // normalised up-case
  });

  it("formats durations humanly", () => {
    expect(fmtMs(42_000)).toBe("42s");
    expect(fmtMs(192_000)).toBe("3m 12s");
    expect(fmtMs(3_840_000)).toBe("1h 04m");
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(Number.NaN)).toBe("—");
  });

  it("formats rates as integers", () => {
    expect(fmtRate(0.75)).toBe("75%");
    expect(fmtRate(null)).toBe("—");
  });
});