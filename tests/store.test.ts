import { describe, it, expect } from "vitest";
import { getSessionStore } from "../src/lib/server/store";

/** The store singleton is promise-memoized; tests just use whatever driver
 *  resolves (memory without env config — the default for CI). */
const store = await getSessionStore();

function entry(overrides: Partial<Parameters<typeof store.appendEntry>[1]> = {}) {
  return {
    id: `t_${Math.random().toString(36).slice(2, 10)}`,
    gesture: "HELP",
    description: "test",
    confidence: 0.9,
    type: "hand" as const,
    timestamp: Date.now(),
    language: "en-US",
    source: "camera" as const,
    ...overrides,
  };
}

describe.skipIf(store.driver !== "memory")("SessionStore (MemoryDriver)", () => {
  it("serverTime is strictly monotonic per session — same-ms bursts cannot be skipped by a > cursor", async () => {
    const session = `MONO${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const a = await store.appendEntry(session, entry());
    const b = await store.appendEntry(session, entry());
    expect(b.serverTime!).toBeGreaterThan(a.serverTime!);
    const sinceA = await store.getEntriesSince(session, a.serverTime!);
    expect(sinceA.map((e) => e.id)).toContain(b.id); // previously dropped on clock ties
  });

  it("a duplicate POST never resurrects lifecycle state (ack survives)", async () => {
    const session = `DUP${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const e = await store.appendEntry(session, entry());
    await store.setStatus(session, e.id, "acknowledge");
    // late duplicate re-POST of the same id (offline outbox flush echo)
    await store.appendEntry(session, entry({ id: e.id }));
    const after = await store.getEntriesSince(session, 0);
    const found = after.find((x) => x.id === e.id)!;
    expect(found.status).toBe("acknowledge");
    expect(found.acknowledged).toBe(true);
  });

  it("setStatus bumps serverTime so caught-up SSE clients observe status changes", async () => {
    const session = `STS${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const e = await store.appendEntry(session, entry());
    const before = e.serverTime!;
    await new Promise((r) => setTimeout(r, 5));
    await store.setStatus(session, e.id, "escalate");
    const all = await store.getEntriesSince(session, 0);
    const found = all.find((x) => x.id === e.id)!;
    expect(found.serverTime!).toBeGreaterThan(before);
    expect(found.status).toBe("escalate");
    expect(found.escalated).toBe(true);
  });

  it("status transitions never move backwards (resolve is terminal)", async () => {
    const session = `RNK${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const e = await store.appendEntry(session, entry());
    await store.setStatus(session, e.id, "resolve");
    await store.setStatus(session, e.id, "acknowledge"); // stale action arrives late
    const all = await store.getEntriesSince(session, 0);
    const found = all.find((x) => x.id === e.id)!;
    expect(found.status).toBe("resolve");
    expect(found.resolved).toBe(true);
  });
});
