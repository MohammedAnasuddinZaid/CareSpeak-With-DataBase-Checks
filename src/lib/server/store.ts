import { DeviceVitals, GestureLogEntry, NurseReply, PatientMetrics } from "@/types";

/**
 * Server-side session store with two interchangeable drivers:
 *  - MemoryDriver : default; zero-config, perfect for localhost + single node.
 *  - RedisDriver  : activated automatically when UPSTASH_REDIS_REST_URL is set;
 *                   makes state survive cold starts & span serverless instances.
 *
 * All timestamps stored/queried are SERVER receive times (ms epoch), which
 * eliminates client clock-skew from the sync protocol entirely.
 */

export type StoredEntry = GestureLogEntry & { status: "none" | "acknowledge" | "escalate" | "resolve" };

export interface SessionStore {
  readonly driver: "memory" | "redis";
  appendEntry(session: string, entry: Omit<GestureLogEntry, "serverTime">): Promise<StoredEntry>;
  getEntriesSince(session: string, since: number): Promise<StoredEntry[]>;
  setStatus(session: string, entryId: string, status: "acknowledge" | "escalate" | "resolve"): Promise<void>;
  setMetrics(session: string, deviceId: string, metrics: PatientMetrics): Promise<void>;
  getMetrics(session: string): Promise<Record<string, PatientMetrics>>;
  setVitals(session: string, vitals: DeviceVitals): Promise<void>;
  getVitals(session: string): Promise<Record<string, DeviceVitals>>;
  setReply(session: string, reply: NurseReply): Promise<void>;
  getRepliesSince(session: string, since: number): Promise<NurseReply[]>;
  /** Registry of recently-active sessions (for the multi-patient ward view). */
  getActiveSessions(): Promise<{ session: string; lastSeen: number }[]>;
}

const MAX_ENTRIES = 2000;
const TTL_MS = 60 * 60 * 1000;
/** Redis key lifetime — matches MemoryDriver's prune window (leak fix). */
const REDIS_TTL_SECONDS = 60 * 60;

/** Lifecycle progress ordering — a duplicate POST or a stale action must never
 *  move an entry backwards (e.g. acknowledge → none). */
export const STATUS_RANK: Record<StoredEntry["status"], number> = {
  none: 0,
  acknowledge: 1,
  escalate: 2,
  resolve: 3,
};

class MemoryDriver implements SessionStore {
  readonly driver = "memory" as const;
  private entries = new Map<string, StoredEntry[]>();
  private metrics = new Map<string, Map<string, PatientMetrics>>();
  private vitals = new Map<string, Map<string, DeviceVitals>>();
  private replies = new Map<string, NurseReply[]>();
  private registry = new Map<string, number>();
  /** Per-session monotonic serverTime clock: two events in the same wall-clock
   *  millisecond must never share a serverTime, or a `> since` cursor would
   *  silently drop the second one during bursts. */
  private lastServerTime = new Map<string, number>();
  private lastPrune = 0;

  constructor() {
    if (typeof setInterval !== "undefined") {
      const t = setInterval(() => this.prune(), 5 * 60 * 1000);
      if (typeof t.unref === "function") t.unref();
    }
  }

  private nextServerTime(session: string, now: number): number {
    const last = this.lastServerTime.get(session) ?? 0;
    const t = now > last ? now : last + 1;
    this.lastServerTime.set(session, t);
    return t;
  }

  private prune() {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, list] of this.entries) {
      const next = list.filter((e) => (e.serverTime ?? e.timestamp) > cutoff);
      if (next.length === 0) {
        this.entries.delete(k);
        this.lastServerTime.delete(k);
      } else this.entries.set(k, next);
    }
    for (const [k, replies] of this.replies) {
      const next = replies.filter((r) => r.timestamp > cutoff);
      if (next.length === 0) this.replies.delete(k);
      else this.replies.set(k, next);
    }
    for (const [k, seen] of this.registry) {
      if (seen < cutoff) this.registry.delete(k);
    }
    // Metrics/vitals maps previously grew forever (per-session per-device).
    for (const [k, m] of this.metrics) {
      if ((this.registry.get(k) ?? 0) < cutoff) {
        this.metrics.delete(k);
        continue;
      }
      for (const [d, v] of m) {
        const seen = v.lastSeen ? Date.parse(v.lastSeen) : NaN;
        if (Number.isFinite(seen) && seen < cutoff) m.delete(d);
      }
      if (m.size === 0) this.metrics.delete(k);
    }
    for (const [k, v] of this.vitals) {
      if ((this.registry.get(k) ?? 0) < cutoff) {
        this.vitals.delete(k);
        continue;
      }
      for (const [d, val] of v) {
        if (val.receivedAt < cutoff) v.delete(d);
      }
      if (v.size === 0) this.vitals.delete(k);
    }
  }

  private touch(session: string): void {
    this.registry.set(session, Date.now());
  }

  async getActiveSessions(): Promise<{ session: string; lastSeen: number }[]> {
    return [...this.registry.entries()]
      .map(([session, lastSeen]) => ({ session, lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private maybePrune(now: number) {
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now;
      this.prune();
    }
  }

  async appendEntry(session: string, entry: Omit<GestureLogEntry, "serverTime">): Promise<StoredEntry> {
    const now = Date.now();
    this.maybePrune(now);
    const stored: StoredEntry = { ...entry, serverTime: this.nextServerTime(session, now), status: "none" };
    const list = this.entries.get(session) ?? [];
    // Idempotent on entry.id (double-POST protection). A re-POST must never
    // resurrect clinical state: keep whichever lifecycle status has progressed
    // furthest so a late duplicate can't erase a nurse's acknowledge/resolve.
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      const prev = list[idx];
      if (STATUS_RANK[prev.status] > STATUS_RANK.none) {
        stored.status = prev.status;
        stored.acknowledged = prev.acknowledged || stored.acknowledged;
        stored.escalated = prev.escalated || stored.escalated;
        stored.resolved = prev.resolved || stored.resolved;
        stored.resolvedAt ??= prev.resolvedAt;
      }
      list[idx] = stored;
    } else {
      list.push(stored);
    }
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    this.entries.set(session, list);
    this.touch(session);
    return stored;
  }

  async getEntriesSince(session: string, since: number): Promise<StoredEntry[]> {
    const list = this.entries.get(session) ?? [];
    return list.filter((e) => (e.serverTime ?? e.timestamp) > since);
  }

  async setStatus(session: string, entryId: string, status: "acknowledge" | "escalate" | "resolve"): Promise<void> {
    const list = this.entries.get(session) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id !== entryId) continue;
      const e = list[i];
      // Skip no-progress transitions (escalated → acknowledge etc.).
      if (STATUS_RANK[status] <= STATUS_RANK[e.status] && status !== "resolve") return;
      e.status = status;
      // Mirror the boolean lifecycle flags so ward stats and merged clients agree.
      if (status === "acknowledge") { e.acknowledged = true; e.acknowledgedAt = Date.now(); }
      else if (status === "escalate") { e.escalated = true; e.escalatedAt = Date.now(); }
      else { e.resolved = true; e.acknowledged = true; e.resolvedAt = Date.now(); }
      // Bump serverTime so every caught-up SSE/REST client observes the change
      // (the Redis driver relies on re-append for the same reason).
      e.serverTime = this.nextServerTime(session, Date.now());
      break;
    }
  }

  async setMetrics(session: string, deviceId: string, metrics: PatientMetrics): Promise<void> {
    const m = this.metrics.get(session) ?? new Map();
    m.set(deviceId, { ...metrics, lastSeen: new Date().toISOString() });
    this.metrics.set(session, m);
    this.touch(session);
  }

  async getMetrics(session: string): Promise<Record<string, PatientMetrics>> {
    return Object.fromEntries(this.metrics.get(session) ?? []);
  }

  async setVitals(session: string, vitals: DeviceVitals): Promise<void> {
    const v = this.vitals.get(session) ?? new Map();
    v.set(vitals.deviceId, { ...vitals, receivedAt: Date.now() });
    this.vitals.set(session, v);
    this.touch(session);
  }

  async getVitals(session: string): Promise<Record<string, DeviceVitals>> {
    return Object.fromEntries(this.vitals.get(session) ?? []);
  }

  async setReply(session: string, reply: NurseReply): Promise<void> {
    const list = this.replies.get(session) ?? [];
    list.push(reply);
    if (list.length > 50) list.splice(0, list.length - 50);
    this.replies.set(session, list);
    this.touch(session);
  }

  async getRepliesSince(session: string, since: number): Promise<NurseReply[]> {
    return (this.replies.get(session) ?? []).filter((r) => r.timestamp > since);
  }
}

type RedisLike = {
  zadd: (key: string, opts: { score: number; member: string }) => Promise<unknown>;
  zrange: (
    key: string,
    start: number | string,
    stop: number | string,
    opts?: { byScore?: boolean; offset?: number; count?: number; rev?: boolean }
  ) => Promise<string[]>;
  zrem: (key: string, member: string) => Promise<unknown>;
  zremrangebyrank: (key: string, start: number, stop: number) => Promise<unknown>;
  zcard: (key: string) => Promise<number>;
  hset: (key: string, values: Record<string, unknown>) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, unknown>>;
  hdel: (key: string, fields: string[]) => Promise<unknown>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

function redisKey(session: string): { entries: string; metrics: string; vitals: string; replies: string } {
  return {
    entries: `cs:${session}:entries`,
    metrics: `cs:${session}:metrics`,
    vitals: `cs:${session}:vitals`,
    replies: `cs:${session}:replies`,
  };
}

const REGISTRY_KEY = "cs:registry"; // hash: session -> lastSeen(ms); powers /api/ward
/** Registry lifetime — sessions unseen for this long are evicted on read. */
const REGISTRY_TTL_SECONDS = 2 * 60 * 60;
const REGISTRY_TTL_MS = REGISTRY_TTL_SECONDS * 1000;

/** Keep the registry hash from growing forever (it used to never expire). */
async function touchRegistry(redis: RedisLike, session: string, now: number): Promise<void> {
  try {
    await redis.hset(REGISTRY_KEY, { [session]: String(now) });
    await redis.expire(REGISTRY_KEY, REGISTRY_TTL_SECONDS);
  } catch {}
}

async function createRedisDriver(): Promise<SessionStore> {
  const mod = await import("@upstash/redis");
  // One controlled cast at the IO boundary — we only use the four commands below.
  const redis = new mod.Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }) as unknown as RedisLike;

  class RedisDriver implements SessionStore {
    readonly driver = "redis" as const;

    async appendEntry(session: string, entry: Omit<GestureLogEntry, "serverTime">): Promise<StoredEntry> {
      const now = Date.now();
      const k = redisKey(session);
      // Idempotency: if this id already exists, keep its lifecycle progress and
      // refresh the member instead of appending a second stale-status copy.
      const existing = await this.findById(session, entry.id);
      let status: StoredEntry["status"] = "none";
      if (existing) {
        if (STATUS_RANK[existing.stored.status] > STATUS_RANK.none) {
          status = existing.stored.status;
          entry.acknowledged = existing.stored.acknowledged || entry.acknowledged;
          entry.escalated = existing.stored.escalated || entry.escalated;
          entry.resolved = existing.stored.resolved || entry.resolved;
        }
        await redis.zrem(k.entries, existing.member);
      }
      const stored: StoredEntry = { ...entry, serverTime: now, status };
      await redis.zadd(k.entries, { score: now, member: JSON.stringify(stored) });
      // Enforce the same cap the memory driver has (zset grows otherwise).
      const count = await redis.zcard(k.entries).catch(() => 0);
      if (count > MAX_ENTRIES) {
        void redis.zremrangebyrank(k.entries, 0, count - MAX_ENTRIES - 1).catch(() => {});
      }
      await redis.expire(k.entries, REDIS_TTL_SECONDS);
      void touchRegistry(redis, session, now);
      return stored;
    }

    private async findById(
      session: string,
      id: string
    ): Promise<{ stored: StoredEntry; member: string } | null> {
      const members = await redis
        .zrange(redisKey(session).entries, "-inf", "+inf", { byScore: true })
        .catch(() => [] as string[]);
      for (let i = members.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(members[i]) as StoredEntry;
          if (e.id === id) return { stored: e, member: members[i] };
        } catch {}
      }
      return null;
    }

    async getEntriesSince(session: string, since: number): Promise<StoredEntry[]> {
      const members = await redis.zrange(redisKey(session).entries, since + 1, "+inf", { byScore: true });
      return members
        .map((m) => {
          try {
            return JSON.parse(m) as StoredEntry;
          } catch {
            return null;
          }
        })
        .filter((x): x is StoredEntry => x !== null);
    }

    async setStatus(session: string, entryId: string, status: "acknowledge" | "escalate" | "resolve"): Promise<void> {
      // Replace (not duplicate) the stored copy so ward stats stay truthful and
      // the zset cannot grow on every action; the fresh serverTime re-publishes
      // the change to every SSE client.
      const found = await this.findById(session, entryId);
      if (!found) return;
      const { stored, member } = found;
      if (STATUS_RANK[status] <= STATUS_RANK[stored.status] && status !== "resolve") return;
      const now = Date.now();
      const updated: StoredEntry = { ...stored, status, serverTime: now };
      if (status === "acknowledge") { updated.acknowledged = true; updated.acknowledgedAt = now; }
      else if (status === "escalate") { updated.escalated = true; updated.escalatedAt = now; }
      else { updated.resolved = true; updated.acknowledged = true; updated.resolvedAt = now; }
      const k = redisKey(session);
      await redis.zrem(k.entries, member).catch(() => {});
      await redis.zadd(k.entries, { score: now, member: JSON.stringify(updated) });
    }

    async setMetrics(session: string, deviceId: string, metrics: PatientMetrics): Promise<void> {
      const k = redisKey(session).metrics;
      await redis.hset(k, { [deviceId]: JSON.stringify({ ...metrics, lastSeen: new Date().toISOString() }) });
      await redis.expire(k, REDIS_TTL_SECONDS);
      void touchRegistry(redis, session, Date.now());
    }

    async getMetrics(session: string): Promise<Record<string, PatientMetrics>> {
      const raw = await redis.hgetall(redisKey(session).metrics);
      const out: Record<string, PatientMetrics> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        try {
          out[k] = typeof v === "string" ? JSON.parse(v) : (v as PatientMetrics);
        } catch {}
      }
      return out;
    }

    async setVitals(session: string, vitals: DeviceVitals): Promise<void> {
      const k = redisKey(session).vitals;
      await redis.hset(k, { [vitals.deviceId]: JSON.stringify({ ...vitals, receivedAt: Date.now() }) });
      await redis.expire(k, REDIS_TTL_SECONDS);
      void touchRegistry(redis, session, Date.now());
    }

    async getVitals(session: string): Promise<Record<string, DeviceVitals>> {
      const raw = await redis.hgetall(redisKey(session).vitals);
      const out: Record<string, DeviceVitals> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        try {
          out[k] = typeof v === "string" ? JSON.parse(v) : (v as DeviceVitals);
        } catch {}
      }
      return out;
    }

    async setReply(session: string, reply: NurseReply): Promise<void> {
      const k = redisKey(session).replies;
      await redis.zadd(k, { score: reply.timestamp, member: JSON.stringify(reply) });
      await redis.expire(k, REDIS_TTL_SECONDS);
      void touchRegistry(redis, session, Date.now());
    }

    async getActiveSessions(): Promise<{ session: string; lastSeen: number }[]> {
      const raw = await redis.hgetall(REGISTRY_KEY).catch(() => ({}) as Record<string, unknown>);
      const out: { session: string; lastSeen: number }[] = [];
      const stale: string[] = [];
      const cutoff = Date.now() - REGISTRY_TTL_MS;
      for (const [k, v] of Object.entries(raw ?? {})) {
        const t = typeof v === "string" ? Number(v) : NaN;
        if (!Number.isFinite(t)) {
          stale.push(k);
          continue;
        }
        if (t < cutoff) {
          stale.push(k);
          continue;
        }
        out.push({ session: k, lastSeen: t });
      }
      if (stale.length > 0) void redis.hdel(REGISTRY_KEY, stale).catch(() => {});
      return out.sort((a, b) => b.lastSeen - a.lastSeen);
    }

    async getRepliesSince(session: string, since: number): Promise<NurseReply[]> {
      const members = await redis.zrange(redisKey(session).replies, since + 1, "+inf", { byScore: true });
      return members
        .map((m) => {
          try {
            return JSON.parse(m) as NurseReply;
          } catch {
            return null;
          }
        })
        .filter((x): x is NurseReply => x !== null);
    }
  }

  return new RedisDriver();
}

/* HMR-safe singleton. The PROMISE is memoized, not the resolved value: on a
 * cold start several requests arrive before any constructor finishes, and
 * memoizing only the value produced split-brain stores where events POSTed
 * through instance A were invisible to SSE streams holding instance B. */
const g = globalThis as unknown as { __carespeakStoreP?: Promise<SessionStore> };

function initStore(): Promise<SessionStore> {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return createRedisDriver().catch(() => Promise.resolve(new MemoryDriver()));
  }
  return Promise.resolve(new MemoryDriver());
}

export function getSessionStore(): Promise<SessionStore> {
  g.__carespeakStoreP ??= initStore();
  return g.__carespeakStoreP;
}
