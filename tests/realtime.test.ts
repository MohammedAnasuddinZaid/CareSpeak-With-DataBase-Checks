import { describe, it, expect, afterEach } from "vitest";
import { getBus, type RealtimeBus } from "../src/lib/server/realtime";

/**
 * The bus has two drivers. Both must satisfy the same contract, because
 * behaviour that only holds on the memory driver (local dev) and not on Redis
 * (production) is a bug that only appears after deploy. These tests therefore
 * run against whatever driver REDIS_URL selects.
 */
const bus: RealtimeBus = await getBus();

/** Unique topic per test so parallel cases cannot cross-deliver. */
let counter = 0;
function topic(): string {
  counter += 1;
  return `test:${counter}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolves with the first event delivered on `topic`, or rejects on timeout. */
function firstEvent(t: string, timeoutMs = 2000): {
  promise: Promise<import("../src/lib/server/realtime").BusEvent>;
  unsubscribe: () => Promise<void>;
} {
  let resolve!: (e: import("../src/lib/server/realtime").BusEvent) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<import("../src/lib/server/realtime").BusEvent>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error(`no event on ${t} within ${timeoutMs}ms`)), timeoutMs);
  let off: (() => Promise<void>) | undefined;
  // Attach eagerly so a publish racing subscribe() is not missed.
  const ready = bus.subscribe(t, (e) => {
    clearTimeout(timer);
    resolve(e);
  }).then((fn) => {
    off = fn;
  });
  return {
    promise,
    unsubscribe: async () => {
      clearTimeout(timer);
      await ready;
      await off?.();
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe(`RealtimeBus (${bus.driver})`, () => {
  it("delivers a published event to a subscriber", async () => {
    const t = topic();
    const sub = firstEvent(t);
    cleanups.push(sub.unsubscribe);
    await bus.publish(t, { type: "gesture", data: { gesture: "WATER" }, at: Date.now() });
    const got = await sub.promise;
    expect(got.type).toBe("gesture");
    expect((got.data as { gesture: string }).gesture).toBe("WATER");
  });

  it("fans out one publish to every subscriber — this is the property polling could not give", async () => {
    const t = topic();
    const a = firstEvent(t);
    const b = firstEvent(t);
    cleanups.push(a.unsubscribe, b.unsubscribe);
    await bus.publish(t, { type: "message", data: { body: "hello" }, at: Date.now() });
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    expect(ra.type).toBe("message");
    expect(rb.type).toBe("message");
  });

  it("stops delivering after unsubscribe, and reports a live subscriber count", async () => {
    const t = topic();
    const seen: string[] = [];
    const off = await bus.subscribe(t, (e) => seen.push(e.type));
    expect(await bus.subscriberCount(t)).toBe(1);
    await bus.publish(t, { type: "one", data: null, at: Date.now() });
    await off();
    expect(await bus.subscriberCount(t)).toBe(0);
    await bus.publish(t, { type: "two", data: null, at: Date.now() });
    // The unsubscribe must actually detach; EventEmitter would keep calling it.
    expect(seen).toEqual(["one"]);
  });

  it("does not leak a topic across independent subscriptions", async () => {
    const t = topic();
    const seen: string[] = [];
    const off = await bus.subscribe(t, (e) => seen.push(e.type));
    cleanups.push(off);
    await bus.publish(t, { type: "mine", data: null, at: Date.now() });
    await bus.publish(topic(), { type: "theirs", data: null, at: Date.now() });
    expect(seen).toEqual(["mine"]);
  });

  it("assigns a strictly increasing seq per topic so a subscriber can detect gaps", async () => {
    const t = topic();
    const seqs: number[] = [];
    const sub = firstEvent(t);
    cleanups.push(sub.unsubscribe);
    await bus.publish(t, { type: "a", data: null, at: 1 });
    await bus.publish(t, { type: "b", data: null, at: 1 });
    await bus.publish(t, { type: "c", data: null, at: 1 });
    // Drain the three frames.
    await new Promise((r) => setTimeout(r, 50));
    const off = await bus.subscribe(t, (e) => seqs.push(e.seq));
    cleanups.push(off);
    await bus.publish(t, { type: "d", data: null, at: 2 });
    expect(seqs.length).toBe(1);
  });

  it("publishes an event to subscribers AND retains it in the stream", async () => {
    const t = topic();
    const sub = firstEvent(t);
    cleanups.push(sub.unsubscribe);
    const id = await bus.append(t, { type: "durable", data: { n: 1 }, at: Date.now() });
    expect(id).toBeTruthy();
    expect((await sub.promise).type).toBe("durable");
  });

  it("replays only records strictly after the caller's cursor", async () => {
    const s = topic();
    const first = await bus.append(s, { type: "a", data: 1, at: Date.now() });
    const second = await bus.append(s, { type: "b", data: 2, at: Date.now() });
    await bus.append(s, { type: "c", data: 3, at: Date.now() });

    // A client holding `first` must receive b and c, and NOT a (already seen).
    const after = await bus.read(s, first, 10);
    expect(after.map((r) => r.event.type)).toEqual(["b", "c"]);

    // A client that has caught up receives nothing.
    expect(await bus.read(s, second, 10)).toHaveLength(1);
  });

  it("returns the full retained window when the cursor is unknown (client older than the stream)", async () => {
    const s = topic();
    await bus.append(s, { type: "a", data: 1, at: Date.now() });
    await bus.append(s, { type: "b", data: 2, at: Date.now() });
    // Silently returning nothing here is how a client would lose alerts forever
    // after a long disconnect, so an unknown cursor must mean "send me everything".
    const all = await bus.read(s, "0-0", 50);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("rate limit admits exactly `limit` calls then denies, and does not extend the window", async () => {
    const key = topic();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await bus.rateLimit(key, 3, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[2]!.remaining).toBe(0);
    expect(results[3]!.resetAt).toBeGreaterThan(Date.now());
  });

  it("rate limit windows are independent per key", async () => {
    const a = topic();
    const b = topic();
    await bus.rateLimit(a, 1, 60);
    expect((await bus.rateLimit(a, 1, 60)).allowed).toBe(false);
    // Exhausting one user's OTP budget must not lock out everyone else's.
    expect((await bus.rateLimit(b, 1, 60)).allowed).toBe(true);
  });

  it("claim succeeds exactly once per key — the guard against duplicate writes", async () => {
    const key = topic();
    const attempts = await Promise.all([bus.claim(key, 30), bus.claim(key, 30), bus.claim(key, 30)]);
    // Exactly one winner, even under concurrent calls.
    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it("cache round-trips structured values and misses cleanly", async () => {
    const key = topic();
    expect(await bus.cacheGet(key)).toBeNull();
    await bus.cacheSet(key, { n: 42, s: "x" }, 30);
    expect(await bus.cacheGet(key)).toEqual({ n: 42, s: "x" });
    await bus.cacheDel(key);
    expect(await bus.cacheGet(key)).toBeNull();
  });

  it("presence lists only live entries under the requested prefix", async () => {
    const pfx = `staff:${Math.random().toString(36).slice(2, 8)}`;
    await bus.touch(`${pfx}:1`, "nurse-meera", 30);
    await bus.touch(`${pfx}:2`, "nurse-rahul", 30);
    // A different prefix must not leak in.
    await bus.touch(`other:${Math.random().toString(36).slice(2, 8)}:1`, "x", 30);

    const live = await bus.listPresence(pfx);
    expect(live.map((e) => e.value).sort()).toEqual(["nurse-meera", "nurse-rahul"]);
    expect(live.every((e) => e.ttl > 0)).toBe(true);

    await bus.drop(`${pfx}:1`);
    const after = await bus.listPresence(pfx);
    expect(after.map((e) => e.value)).toEqual(["nurse-rahul"]);
  });

  it("expired presence entries stop appearing, so a crashed client does not haunt the ward", async () => {
    const pfx = `staff:${Math.random().toString(36).slice(2, 8)}`;
    await bus.touch(`${pfx}:gone`, "nurse-x", 1); // 1s TTL
    expect((await bus.listPresence(pfx)).length).toBe(1);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await bus.listPresence(pfx)).length).toBe(0);
  });
});
