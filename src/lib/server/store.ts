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
}

const MAX_ENTRIES = 2000;
const TTL_MS = 60 * 60 * 1000;

class MemoryDriver implements SessionStore {
  readonly driver = "memory" as const;
  private entries = new Map<string, StoredEntry[]>();
  private metrics = new Map<string, Map<string, PatientMetrics>>();
  private vitals = new Map<string, Map<string, DeviceVitals>>();
  private replies = new Map<string, NurseReply[]>();
  private lastPrune = 0;

  constructor() {
    if (typeof setInterval !== "undefined") {
      const t = setInterval(() => this.prune(), 5 * 60 * 1000);
      if (typeof t.unref === "function") t.unref();
    }
  }

  private prune() {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, list] of this.entries) {
      const next = list.filter((e) => (e.serverTime ?? e.timestamp) > cutoff);
      if (next.length === 0) this.entries.delete(k);
      else this.entries.set(k, next);
    }
    for (const [k, replies] of this.replies) {
      const next = replies.filter((r) => r.timestamp > cutoff);
      if (next.length === 0) this.replies.delete(k);
      else this.replies.set(k, next);
    }
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
    const stored: StoredEntry = { ...entry, serverTime: now, status: "none" };
    const list = this.entries.get(session) ?? [];
    // idempotent on entry.id (protects against double-POST)
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    this.entries.set(session, list);
    return stored;
  }

  async getEntriesSince(session: string, since: number): Promise<StoredEntry[]> {
    const list = this.entries.get(session) ?? [];
    return list.filter((e) => (e.serverTime ?? e.timestamp) > since);
  }

  async setStatus(session: string, entryId: string, status: "acknowledge" | "escalate" | "resolve"): Promise<void> {
    const list = this.entries.get(session) ?? [];
    const found = [...list].reverse().find((e) => e.id === entryId);
    if (found) {
      found.status = status;
      if (status === "resolve") found.resolvedAt = Date.now();
    }
  }

  async setMetrics(session: string, deviceId: string, metrics: PatientMetrics): Promise<void> {
    const m = this.metrics.get(session) ?? new Map();
    m.set(deviceId, { ...metrics, lastSeen: new Date().toISOString() });
    this.metrics.set(session, m);
  }

  async getMetrics(session: string): Promise<Record<string, PatientMetrics>> {
    return Object.fromEntries(this.metrics.get(session) ?? []);
  }

  async setVitals(session: string, vitals: DeviceVitals): Promise<void> {
    const v = this.vitals.get(session) ?? new Map();
    v.set(vitals.deviceId, { ...vitals, receivedAt: Date.now() });
    this.vitals.set(session, v);
  }

  async getVitals(session: string): Promise<Record<string, DeviceVitals>> {
    return Object.fromEntries(this.vitals.get(session) ?? []);
  }

  async setReply(session: string, reply: NurseReply): Promise<void> {
    const list = this.replies.get(session) ?? [];
    list.push(reply);
    if (list.length > 50) list.splice(0, list.length - 50);
    this.replies.set(session, list);
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
  hset: (key: string, values: Record<string, unknown>) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, unknown>>;
};

function redisKey(session: string): { entries: string; metrics: string; vitals: string; replies: string } {
  return {
    entries: `cs:${session}:entries`,
    metrics: `cs:${session}:metrics`,
    vitals: `cs:${session}:vitals`,
    replies: `cs:${session}:replies`,
  };
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
      const stored: StoredEntry = { ...entry, serverTime: now, status: "none" };
      await redis.zadd(redisKey(session).entries, { score: now, member: JSON.stringify(stored) });
      return stored;
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
      // Re-append the mutated entry at current time so SSE clients pick it up.
      const all = await redis.zrange(redisKey(session).entries, "-inf", "+inf", { byScore: true });
      for (let i = all.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(all[i]) as StoredEntry;
          if (e.id === entryId) {
            e.status = status;
            if (status === "resolve") e.resolvedAt = Date.now();
            await redis.zadd(redisKey(session).entries, { score: Date.now(), member: JSON.stringify(e) });
            break;
          }
        } catch {}
      }
    }

    async setMetrics(session: string, deviceId: string, metrics: PatientMetrics): Promise<void> {
      await redis.hset(redisKey(session).metrics, { [deviceId]: JSON.stringify({ ...metrics, lastSeen: new Date().toISOString() }) });
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
      await redis.hset(redisKey(session).vitals, { [vitals.deviceId]: JSON.stringify({ ...vitals, receivedAt: Date.now() }) });
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
      await redis.zadd(redisKey(session).replies, { score: reply.timestamp, member: JSON.stringify(reply) });
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

/* HMR-safe singleton */
const g = globalThis as unknown as { __carespeakStore?: SessionStore };

export async function getSessionStore(): Promise<SessionStore> {
  if (g.__carespeakStore) return g.__carespeakStore;
  let store: SessionStore = new MemoryDriver();
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      store = await createRedisDriver();
    } catch {
      store = new MemoryDriver();
    }
  }
  g.__carespeakStore = store;
  return store;
}
