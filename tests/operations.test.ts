import { describe, expect, it } from "vitest";
import type { BottleneckSample } from "@/lib/bottlenecks";
import {
  inactivityWatch,
  marAdherence,
  ResponseSlice,
  shiftTrend,
  slaSummary,
  taskCompliance,
  TaskRow,
} from "@/lib/operations";

const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0).getTime();

function sample(raisedMs: number, ackMs: number | null): BottleneckSample {
  return { id: `s`, gesture: "HELP", raisedAt: raisedMs, acknowledgedAt: ackMs, escalatedAt: null, resolvedAt: null };
}

describe("slaSummary", () => {
  const K = 1000;

  it("aggregates per staff and computes median/p90/SLA/honesty", () => {
    const slices: ResponseSlice[] = [
      { staffId: 1, name: "A", latencyMs: 60 * K, escalated: false, resolved: true },
      { staffId: 1, name: "A", latencyMs: 120 * K, escalated: false, resolved: true },
      { staffId: 1, name: "A", latencyMs: 180 * K, escalated: true, resolved: false },
      { staffId: 1, name: "A", latencyMs: 300 * K, escalated: false, resolved: false },
      { staffId: 1, name: "A", latencyMs: 240 * K, escalated: false, resolved: false },
      { staffId: 2, name: "B", latencyMs: 5000, escalated: false, resolved: false },
      { staffId: 2, name: "B", latencyMs: 9000, escalated: false, resolved: false },
      { staffId: Number.NaN, name: "system", latencyMs: 20 * K, escalated: true, resolved: false },
    ];
    const rows = slaSummary(slices);

    expect(rows).toHaveLength(2);

    const staff1 = rows.find((r) => r.staffId === 1);
    expect(staff1).toBeDefined();
    expect(staff1!.acked).toBe(5);
    expect(staff1!.medianMs).toBe(180 * K);
    expect(staff1!.p90Ms).toBe(300 * K);
    expect(staff1!.overSla).toBe(2);
    expect(staff1!.slaRate).toBeCloseTo(0.6);
    expect(staff1!.escalated).toBe(1);
    expect(staff1!.resolved).toBe(2);
    expect(staff1!.dataSufficient).toBe(true);

    const staff2 = rows.find((r) => r.staffId === 2);
    expect(staff2!.dataSufficient).toBe(false);

    expect(rows[0].staffId).toBe(1);
  });
});

describe("taskCompliance", () => {
  const now = at(2026, 8, 24, 12, 1);

  const rows: TaskRow[] = [
    { id: 1, kind: "positioning", status: "done", title: "Turn", bedCode: "B-1", patient: "P1", dueMs: at(2026, 8, 24, 9, 0), completedMs: at(2026, 8, 24, 9, 4), completedBy: "N1" },
    { id: 2, kind: "positioning", status: "done", title: "Turn", bedCode: "B-1", patient: "P1", dueMs: at(2026, 8, 24, 9, 0), completedMs: at(2026, 8, 24, 9, 10), completedBy: "N1" },
    { id: 3, kind: "positioning", status: "pending", title: "Turn", bedCode: "B-2", patient: "P2", dueMs: at(2026, 8, 24, 10, 0), completedMs: null, completedBy: null },
    { id: 4, kind: "observation", status: "done", title: "Rounds", bedCode: "B-3", patient: "P3", dueMs: at(2026, 8, 24, 11, 30), completedMs: at(2026, 8, 24, 11, 35), completedBy: "N2" },
    { id: 5, kind: "positioning", status: "in_progress", title: "Turn", bedCode: "B-4", patient: "P4", dueMs: at(2026, 8, 24, 12, 30), completedMs: null, completedBy: null },
    { id: 6, kind: "hygiene", status: "skipped", title: "Wash", bedCode: "B-5", patient: "P5", dueMs: at(2026, 8, 24, 11, 0), completedMs: null, completedBy: null },
  ];

  it("counts scheduled, on-time, overdue and skipped per kind", () => {
    const board = taskCompliance(rows, now);

    const positioning = board.byKind.find((k) => k.kind === "positioning");
    expect(positioning!.scheduled).toBe(4);
    expect(positioning!.done).toBe(2);
    expect(positioning!.onTime).toBe(1);
    expect(positioning!.overdue).toBe(1);
    expect(positioning!.skipped).toBe(0);
    expect(positioning!.onTimeRate).toBeCloseTo(0.5);

    const observation = board.byKind.find((k) => k.kind === "observation");
    expect(observation!.done).toBe(1);
    expect(observation!.onTime).toBe(1);
    expect(observation!.onTimeRate).toBeCloseTo(1);

    const hygiene = board.byKind.find((k) => k.kind === "hygiene");
    expect(hygiene!.skipped).toBe(1);
    expect(hygiene!.onTimeRate).toBeNull();

    expect(board.byKind.map((k) => k.kind)).toEqual(["positioning", "observation", "hygiene"]);
    expect(board.overallOnTimeRate).toBeCloseTo(2 / 3);
  });

  it("flags the overdue task with its age, newest first", () => {
    const board = taskCompliance(rows, now);
    expect(board.overdue).toHaveLength(1);
    expect(board.overdue[0].id).toBe(3);
    expect(board.overdue[0].overdueMs).toBe(now - at(2026, 8, 24, 10, 0));
  });
});

describe("marAdherence", () => {
  it("counts statuses and computes adherence", () => {
    const board = marAdherence([
      { bedCode: "B-1", patient: "P1", medication: "M", dose: "1t", status: "given", scheduledMs: null, administeredMs: null },
      { bedCode: "B-1", patient: "P1", medication: "M", dose: "1t", status: "given", scheduledMs: null, administeredMs: null },
      { bedCode: "B-1", patient: "P1", medication: "M", dose: "1t", status: "given", scheduledMs: null, administeredMs: null },
      { bedCode: "B-2", patient: "P2", medication: "M", dose: "1t", status: "missed", scheduledMs: null, administeredMs: null },
      { bedCode: "B-2", patient: "P2", medication: "M", dose: "1t", status: "held", scheduledMs: null, administeredMs: null },
      { bedCode: "B-3", patient: "P3", medication: "M", dose: "1t", status: "refused", scheduledMs: null, administeredMs: null },
    ]);
    expect(board.scheduled).toBe(6);
    expect(board.given).toBe(3);
    expect(board.missed).toBe(1);
    expect(board.held).toBe(1);
    expect(board.refused).toBe(1);
    expect(board.adherenceRate).toBeCloseTo(0.5);
  });

  it("is honest with no rows", () => {
    const board = marAdherence([]);
    expect(board.scheduled).toBe(0);
    expect(board.adherenceRate).toBeNull();
  });
});

describe("inactivityWatch", () => {
  const now = at(2026, 8, 24, 12, 0);

  it("keeps watch kinds, flags due items and counts by kind, newest first", () => {
    const watch = inactivityWatch(
      [
        { id: 1, kind: "inactivity", severity: "high", title: "No movement", session: "S1", bedCode: "B-1", patient: "P1", raisedMs: at(2026, 8, 24, 9, 0) },
        { id: 2, kind: "fall", severity: "critical", title: "Fall", session: "S2", bedCode: "B-2", patient: "P2", raisedMs: at(2026, 8, 24, 11, 0) },
        { id: 3, kind: "help", severity: "high", title: "Help", session: "S3", bedCode: "B-3", patient: "P3", raisedMs: at(2026, 8, 24, 8, 0) },
        { id: 4, kind: "inactivity", severity: "moderate", title: "No movement", session: "S4", bedCode: "B-4", patient: "P4", raisedMs: at(2026, 8, 24, 8, 0) },
      ],
      now,
    );

    expect(watch.items.map((i) => i.id)).toEqual([4, 1, 2]);
    expect(watch.items.find((i) => i.id === 1)!.repositioningDue).toBe(true);
    expect(watch.items.find((i) => i.id === 1)!.ageMs).toBe(3 * 60 * 60 * 1000);
    expect(watch.items.find((i) => i.id === 2)!.repositioningDue).toBe(false);
    expect(watch.dueCount).toBe(2);
    expect(watch.byKind).toEqual({ inactivity: 2, fall: 1 });
  });
});

describe("shiftTrend", () => {
  it("buckets by 8h slot, computes medians and relative change", () => {
    const trends = shiftTrend(
      [
        sample(at(2026, 8, 24, 9, 30), at(2026, 8, 24, 9, 30) + 180_000),
        sample(at(2026, 8, 24, 10, 0), at(2026, 8, 24, 10, 0) + 240_000),
        sample(at(2026, 8, 24, 17, 30), at(2026, 8, 24, 17, 30) + 300_000),
        sample(at(2026, 8, 24, 23, 0), at(2026, 8, 24, 23, 0) + 60_000),
        sample(at(2026, 8, 25, 9, 0), at(2026, 8, 25, 9, 0) + 120_000),
        sample(at(2026, 8, 25, 9, 10), at(2026, 8, 25, 9, 10) + 120_000),
        sample(at(2026, 8, 2, 9, 0), at(2026, 8, 2, 9, 0) + 50_000),
        sample(at(2026, 8, 24, 9, 40), null),
      ],
      at(2026, 8, 24, 12, 0),
    );

    expect(trends).toHaveLength(3);
    expect(trends.map((p) => `${p.day} ${p.slot}`)).toEqual(["Sep 24 08–16", "Sep 24 16–24", "Sep 25 08–16"]);
    expect(trends[0].count).toBe(2);
    expect(trends[0].medianMs).toBe(180_000);
    expect(trends[0].changePct).toBeNull();
    expect(trends[1].medianMs).toBe(60_000);
    expect(trends[1].changePct).toBeCloseTo(-66.6666, 1);
    expect(trends[2].medianMs).toBe(120_000);
    expect(trends[2].changePct).toBeCloseTo(100, 1);
  });

  it("returns nothing when no slot has acked requests", () => {
    expect(shiftTrend([sample(at(2026, 8, 24, 9, 0), null)], at(2026, 8, 24, 12, 0))).toHaveLength(0);
  });
});