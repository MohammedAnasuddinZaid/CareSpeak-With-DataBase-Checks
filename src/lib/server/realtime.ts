/**
 * Realtime fan-out bus.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * CareSpeak's original transport polled. `/api/stream` woke up on a timer
 * (350ms while hot, 2200ms idle) and asked the store "anything new?". That
 * design has three compounding costs:
 *
 *   1. Latency is bounded below by the poll interval, not by the work. A nurse
 *      typing a reply pays up to 2.2s of pure waiting.
 *   2. Cost scales with *connections × tick rate*, not with actual traffic. A
 *      quiet ward still burns a store read per connected client twice a second.
 *      Against Upstash's 500k command/month free tier that is a few minutes of
 *      demo before exhaustion.
 *   3. Polling a *shared* store still is not push. On serverless the SSE
 *      handler and the writer routinely run on different instances, so the
 *      "poll" is really polling a replica, and messages arrive late or not at
 *      all. The old code papered over this with a 2s REST reconciliation poll
 *      in the client — an admission that push was not happening.
 *
 * A pub/sub bus inverts the cost model: the writer pays one PUBLISH, and every
 * subscriber already holding a socket gets the frame immediately. Latency
 * becomes network RTT (~1ms on a LAN, ~50-150ms across regions) instead of the
 * poll interval, and idle connections cost nothing.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Redis is a bus and a cache. It is never the system of record. Clinical rows
 * commit to MySQL *first*, and only then is an event published. A Redis flush,
 * failover, or total outage must never lose a vital sign or a nurse's reply —
 * it may only make delivery slower, which is why the SSE layer keeps a slow
 * reconcile tick as a safety net rather than trusting the bus exclusively.
 *
 * ── Driver selection ───────────────────────────────────────────────────────
 * REDIS_URL set    -> ioredis, one code path for local Redis, Upstash, Aiven,
 *                     Railway, ElastiCache. Only the URL differs.
 * REDIS_URL unset  -> in-process EventEmitter. Single instance only, and
 *                     /api/health reports `driver: "memory"` so the limitation
 *                     is visible rather than silent.
 */
import { EventEmitter } from "node:events";
import { loadDotEnv } from "./env";

loadDotEnv();

export interface BusEvent<T = unknown> {
  /** Event name, e.g. "gesture", "message", "alert", "vitals". */
  type: string;
  data: T;
  /** Server clock at publish. Authoritative; client clocks are untrusted. */
  at: number;
  /**
   * Monotonic per-topic sequence. Lets a subscriber detect a gap, which tells it
   * a reconcile is due. This is what replaces "poll until something shows up".
   */
  seq: number;
}

export interface StreamRecord {
  id: string;
  event: BusEvent;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms at which the current window resets. */
  resetAt: number;
}

export interface PresenceEntry {
  key: string;
  value: string;
  /** Seconds left on the TTL. 0 means the entry is already expired. */
  ttl: number;
}

export interface RealtimeBus {
  readonly driver: "memory" | "redis";

  /** Fan out to every live subscriber of `topic`. Fire-and-forget. */
  publish(topic: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<void>;

  /**
   * Receive events for `topic`. Returns an unsubscribe function; call it on
   * client disconnect or the handler leaks.
   */
  subscribe(topic: string, handler: (event: BusEvent) => void): Promise<() => Promise<void>>;

  /** Number of live subscribers, for diagnostics. */
  subscriberCount(topic: string): Promise<number>;

  // --- durable replay -----------------------------------------------------
  // Pub/Sub is fire-and-forget: a subscriber that is mid-reconnect misses
  // frames. Streams keep a bounded history so a reconnecting client can replay
  // exactly what it missed, using the id cursor it already holds.
  append(stream: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<string>;
  read(stream: string, afterId: string, count: number): Promise<StreamRecord[]>;
  trim(stream: string, maxLength: number): Promise<void>;

  // --- presence ------------------------------------------------------------
  touch(key: string, value: string, ttlSeconds: number): Promise<void>;
  drop(key: string): Promise<void>;
  listPresence(prefix: string): Promise<PresenceEntry[]>;

  // --- distributed rate limiting ------------------------------------------
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;

  // --- idempotency ---------------------------------------------------------
  /** Returns true exactly once per `key` per TTL. Used to kill double-writes. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;

  // --- cache ---------------------------------------------------------------
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  cacheDel(key: string): Promise<void>;

  close(): Promise<void>;
}

const MAX_STREAM_LENGTH = 500;

/* ------------------------------------------------------------------------- */
/* In-memory driver                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Process-local bus. Correct for a single Next.js instance (local dev, one
 * server on a hospital LAN) and the only driver that works with zero
 * infrastructure. Every method is async so callers are written once against the
 * interface and never branch on driver.
 */
class MemoryBus implements RealtimeBus {
  readonly driver = "memory" as const;
  private readonly emitter = new EventEmitter();
  private readonly streams = new Map<string, StreamRecord[]>();
  private readonly presence = new Map<string, { value: string; expiresAt: number }>();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  private readonly claims = new Map<string, number>();
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly seq = new Map<string, number>();
  private closed = false;

  constructor() {
    // A ward can legitimately have many consoles + dashboards subscribed at
    // once. Node's default cap of 10 listeners per event name would emit
    // spurious leak warnings and, past the cap, drop listeners outright.
    this.emitter.setMaxListeners(0);
    // A long-lived dev server with a timer-driven bus accumulates expired keys
    // forever without this; production Redis expires them server-side.
    const sweeper = setInterval(() => this.sweep(), 30_000);
    sweeper.unref();
  }

  private nextSeq(topic: string): number {
    const n = (this.seq.get(topic) ?? 0) + 1;
    this.seq.set(topic, n);
    return n;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.presence) if (v.expiresAt <= now) this.presence.delete(k);
    for (const [k, v] of this.claims) if (v <= now) this.claims.delete(k);
    for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    for (const [k, v] of this.counters) if (v.resetAt <= now) this.counters.delete(k);
  }

  async publish(topic: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<void> {
    if (this.closed) return;
    const full: BusEvent = { ...event, seq: event.seq ?? this.nextSeq(topic) };
    this.emitter.emit(topic, full);
  }

  async subscribe(topic: string, handler: (event: BusEvent) => void): Promise<() => Promise<void>> {
    this.emitter.on(topic, handler);
    return async () => {
      this.emitter.off(topic, handler);
    };
  }

  async subscriberCount(topic: string): Promise<number> {
    return this.emitter.listenerCount(topic);
  }

  async append(stream: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<string> {
    const full: BusEvent = { ...event, seq: event.seq ?? this.nextSeq(stream) };
    // Redis stream ids are "<ms>-<seq>"; mimic that so a cursor recorded in one
    // driver is still meaningful after switching to the other.
    const id = `${full.at}-${full.seq}`;
    const list = this.streams.get(stream) ?? [];
    list.push({ id, event: full });
    if (list.length > MAX_STREAM_LENGTH) list.splice(0, list.length - MAX_STREAM_LENGTH);
    this.streams.set(stream, list);
    await this.publish(stream, full);
    return id;
  }

  async read(stream: string, afterId: string, count: number): Promise<StreamRecord[]> {
    const list = this.streams.get(stream) ?? [];
    const at = list.findIndex((r) => r.id === afterId);
    // An unknown cursor means the client is older than the retained window, so
    // return everything rather than silently nothing.
    const from = at === -1 ? 0 : at + 1;
    return list.slice(from, from + count);
  }

  async trim(stream: string, maxLength: number): Promise<void> {
    const list = this.streams.get(stream);
    if (list && list.length > maxLength) list.splice(0, list.length - maxLength);
  }

  async touch(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.presence.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async drop(key: string): Promise<void> {
    this.presence.delete(key);
  }

  async listPresence(prefix: string): Promise<PresenceEntry[]> {
    const now = Date.now();
    const out: PresenceEntry[] = [];
    for (const [key, v] of this.presence) {
      if (!key.startsWith(prefix)) continue;
      const ttl = Math.max(0, Math.round((v.expiresAt - now) / 1000));
      if (ttl > 0) out.push({ key, value: v.value, ttl });
    }
    return out;
  }

  async rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    let entry = this.counters.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.counters.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.claims.get(key);
    if (existing !== undefined && existing > now) return false;
    this.claims.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async cacheDel(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.removeAllListeners();
  }
}

/* ------------------------------------------------------------------------- */
/* Redis driver                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Minimal slice of ioredis we depend on, declared locally so a driver swap or a
 * test double does not force the whole interface across the codebase.
 *
 * Signatures are kept permissive where ioredis itself is variadic (SET with
 * EX/NX/GET flags) — a narrower declared shape would reject legal calls at the
 * type level while still working at runtime, which is worse than no type at all.
 */
interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", handler: (channel: string, message: string) => void): unknown;
  xadd(stream: string, id: string, field: string, value: string): Promise<string>;
  xrange(stream: string, start: string, end: string, count: number): Promise<[string, string[]][]>;
  xtrim(stream: string, strategy: string, threshold: number): Promise<string>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  expire(key: string, seconds: number, mode: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

class RedisBus implements RealtimeBus {
  readonly driver = "redis" as const;
  private readonly prefix: string;
  private readonly pub: RedisLike;
  private readonly sub: RedisLike;
  /** topic -> live handler count, so `sub` is only resubscribed when needed. */
  private readonly topics = new Map<string, number>();
  /**
   * Local fan-out for handlers on *this* instance. Many SSE clients land on the
   * same Next.js process; without this each one would need its own Redis
   * subscription to the same channel, which ioredis does not deduplicate.
   */
  private readonly emitter = new EventEmitter();
  private closed = false;

  private constructor(pub: RedisLike, sub: RedisLike, prefix: string) {
    this.pub = pub;
    this.sub = sub;
    this.prefix = prefix;
    this.emitter.setMaxListeners(0);
    this.sub.on("message", (channel, message) => this.dispatch(channel, message));
  }

  static async create(url: string, prefix: string): Promise<RedisBus> {
    const { Redis } = await import("ioredis");
    // A dedicated connection per role: a connection in subscriber mode cannot
    // issue ordinary commands, so sharing one would break the publish path.
    const opts = {
      maxRetriesPerRequest: 2,
      // Fail fast instead of queueing forever when Redis is unreachable. A
      // hanging publish is worse than a dropped realtime frame, because MySQL
      // already holds the durable row and the SSE reconcile tick will pick it up.
      enableOfflineQueue: false,
    };
    const pub = new Redis(url, opts) as unknown as RedisLike;
    const sub = new Redis(url, opts) as unknown as RedisLike;
    return new RedisBus(pub, sub, prefix);
  }

  private channel(topic: string): string {
    return `${this.prefix}:topic:${topic}`;
  }

  private stream(stream: string): string {
    return `${this.prefix}:stream:${stream}`;
  }

  private dispatch(channel: string, message: string): void {
    const topic = channel.slice(`${this.prefix}:topic:`.length);
    let event: BusEvent;
    try {
      event = JSON.parse(message) as BusEvent;
    } catch {
      // A malformed frame must not tear down the connection; drop just this one.
      return;
    }
    this.emitter.emit(topic, event);
  }

  async publish(topic: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<void> {
    if (this.closed) return;
    const full: BusEvent = { ...event, seq: event.seq ?? Date.now() };
    // Always deliver locally first. With one Redis and several app instances the
    // publishing instance is usually a subscriber too, and it will not receive
    // its own PUBLISH echo unless it is genuinely subscribed to that channel.
    this.emitter.emit(topic, full);
    await this.pub.publish(this.channel(topic), JSON.stringify(full));
  }

  async subscribe(topic: string, handler: (event: BusEvent) => void): Promise<() => Promise<void>> {
    this.emitter.on(topic, handler);
    if ((this.topics.get(topic) ?? 0) === 0) {
      await this.sub.subscribe(this.channel(topic));
    }
    this.topics.set(topic, (this.topics.get(topic) ?? 0) + 1);

    return async () => {
      this.emitter.off(topic, handler);
      const remaining = (this.topics.get(topic) ?? 1) - 1;
      if (remaining <= 0) {
        this.topics.delete(topic);
        await this.sub.unsubscribe(this.channel(topic));
      } else {
        this.topics.set(topic, remaining);
      }
    };
  }

  async subscriberCount(topic: string): Promise<number> {
    return this.topics.get(topic) ?? 0;
  }

  async append(stream: string, event: Omit<BusEvent, "seq"> & { seq?: number }): Promise<string> {
    const full: BusEvent = { ...event, seq: event.seq ?? Date.now() };
    // "*" lets Redis allocate the id, which is monotonic and gap-free within
    // the stream — the same cursor property the MySQL AUTO_INCREMENT has.
    const id = await this.pub.xadd(this.stream(stream), "*", "event", JSON.stringify(full));
    await this.pub.xtrim(this.stream(stream), "MAXLEN", MAX_STREAM_LENGTH);
    await this.publish(stream, full);
    return id;
  }

  async read(stream: string, afterId: string, count: number): Promise<StreamRecord[]> {
    // XRANGE with a "("-prefixed start is *exclusive*, so this returns exactly
    // the records after the cursor. XREVRANGE cannot express an exclusive
    // start, which is why it is not used here.
    const rows = await this.pub.xrange(this.stream(stream), `(${afterId}`, "+", count);
    const out: StreamRecord[] = [];
    for (const [id, fields] of rows) {
      const idx = fields.indexOf("event");
      if (idx === -1) continue;
      try {
        out.push({ id, event: JSON.parse(fields[idx + 1]) as BusEvent });
      } catch {
        // Skip an unparseable record rather than failing the whole replay; the
        // client will reconcile against MySQL for anything it ends up missing.
      }
    }
    return out;
  }

  async trim(stream: string, maxLength: number): Promise<void> {
    await this.pub.xtrim(this.stream(stream), "MAXLEN", maxLength);
  }

  async touch(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.pub.set(`${this.prefix}:pres:${key}`, value, "EX", ttlSeconds);
  }

  async drop(key: string): Promise<void> {
    await this.pub.del(`${this.prefix}:pres:${key}`);
  }

  async listPresence(prefix: string): Promise<PresenceEntry[]> {
    const match = `${this.prefix}:pres:${prefix}*`;
    const keys = await this.pub.keys(match);
    const out: PresenceEntry[] = [];
    for (const key of keys) {
      const [value, ttlMs] = await Promise.all([this.pub.get(key), this.pub.pttl(key)]);
      if (value === null) continue;
      out.push({
        key: key.slice(`${this.prefix}:pres:`.length),
        value,
        ttl: ttlMs > 0 ? Math.round(ttlMs / 1000) : 0,
      });
    }
    return out;
  }

  async rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const k = `${this.prefix}:rl:${key}`;
    const count = await this.pub.incr(k);
    // EXPIRE ... NX sets the window only on the first increment, closing the
    // race where two concurrent requests both see count===1 and both set a
    // window (which would let a burst reset the clock indefinitely).
    if (count === 1) await this.pub.expire(k, windowSeconds, "NX");
    const ttlMs = await this.pub.pttl(k);
    const resetAt = Date.now() + (ttlMs > 0 ? ttlMs : windowSeconds * 1000);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    // SET NX returns "OK" only when the key was absent, so exactly one caller
    // across the entire cluster wins the claim.
    const res = await this.pub.set(`${this.prefix}:claim:${key}`, "1", "EX", ttlSeconds, "NX");
    return res === "OK";
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    const raw = await this.pub.get(`${this.prefix}:cache:${key}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.pub.set(`${this.prefix}:cache:${key}`, JSON.stringify(value), "EX", ttlSeconds);
  }

  async cacheDel(key: string): Promise<void> {
    await this.pub.del(`${this.prefix}:cache:${key}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter?.removeAllListeners();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

/* ------------------------------------------------------------------------- */
/* Selection                                                                 */
/* ------------------------------------------------------------------------- */

type BusPromise = Promise<RealtimeBus>;

// Memoized on globalThis, matching the existing store.ts pattern: Next.js
// re-evaluates route modules on every hot reload in development, and without
// this a reload would open a fresh pool of Redis connections each time until
// the file-descriptor limit is hit.
const g = globalThis as unknown as { __carespeakBusP?: BusPromise };

function initBus(): BusPromise {
  const url = process.env.REDIS_URL;
  const prefix = process.env.REDIS_KEY_PREFIX || "cs";
  if (!url) return Promise.resolve(new MemoryBus());
  return RedisBus.create(url, prefix).catch((err: unknown) => {
    // A configured-but-unreachable Redis must not take the app down. Clinical
    // data is already durable in MySQL; falling back to the in-process bus
    // degrades multi-instance fan-out to single-instance, which is slower but
    // correct, and /api/health will report the downgrade.
    console.error(
      `[realtime] Redis unreachable (${err instanceof Error ? err.message : String(err)}); ` +
        "falling back to the in-memory bus. Multi-device push will not cross instances.",
    );
    return new MemoryBus();
  });
}

export function getBus(): Promise<RealtimeBus> {
  g.__carespeakBusP ??= initBus();
  return g.__carespeakBusP;
}

/* ------------------------------------------------------------------------- */
/* Topic helpers                                                             */
/* ------------------------------------------------------------------------- */

/**
 * A bed is the unit of clinical attention, so it is the unit of fan-out. A
 * patient in bed 12 has one topic whether the subscriber is the bedside
 * console, the ward wall, a nurse's phone, or an alerting daemon.
 */
export const topics = {
  bed: (bedId: number | string) => `bed:${bedId}`,
  /** Direct-to-patient channel, keyed by console session code. */
  console: (sessionCode: string) => `console:${sessionCode}`,
  ward: (wardId: number | string) => `ward:${wardId}`,
  user: (userId: number | string) => `user:${userId}`,
} as const;

export const streams = {
  /** Durable per-bed event log backing reconnect replay. */
  bed: (bedId: number | string) => `bed:${bedId}`,
  console: (sessionCode: string) => `console:${sessionCode}`,
} as const;
