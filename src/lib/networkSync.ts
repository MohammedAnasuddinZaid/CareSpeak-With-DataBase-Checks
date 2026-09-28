import {
  AlertAction,
  DeviceVitals,
  GestureLogEntry,
  NurseReply,
  PatientMetrics,
} from "@/types";
import {
  enqueue,
  enqueueMetricsLatestWins,
  dequeueAll,
  remove as removeOutboxItem,
  OutboxPayload,
} from "./outbox";

const BROADCAST_CHANNEL = "carespeak_sync";
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_INTERVAL_MS = 15000;
const SSE_GRACE_MS = 6000;
/** While SSE is connected we still reconcile via REST every 2s. Critical on
 *  serverless (Vercel): /api/stream and /api/sync may run on different lambda
 *  instances, so SSE alone can miss writes unless Upstash Redis is configured. */
const RECONCILE_INTERVAL_MS = 2000;

/**
 * `denied` is a terminal state, not a retry state. It means the console could
 * not be paired with this bed and is not signed in as staff, so no amount of
 * reconnecting will help -- the UI must offer re-pairing instead of a spinner.
 */
export type ConnStatus = "connected" | "reconnecting" | "disconnected" | "denied";
export type Transport = "sse" | "poll" | "offline" | "none";

/**
 * Wording for the nurse-link badge, shared so every surface tells the patient
 * the same thing.
 *
 * The distinction that matters is `denied` vs `disconnected`. Both mean "not
 * connected", but only one of them resolves itself; telling an unpaired patient
 * "offline" invites them to wait forever for a link that is never coming.
 */
export function linkStatusLabel(status: ConnStatus, transport: Transport): string {
  switch (status) {
    case "connected":
      return `Nurse link · ${transport.toUpperCase()}`;
    case "reconnecting":
      return "Reconnecting…";
    case "denied":
      return "Bed not paired — ask a nurse to help";
    default:
      return "Nurse link offline";
  }
}

type StoredEntry = GestureLogEntry & { status?: string };

export interface NetworkSyncConfig {
  sessionId?: string;
  onAlert?: (entry: GestureLogEntry) => void;
  onStatusUpdate?: (entryId: string, status: NonNullable<StoredEntry["status"]>) => void;
  onMetrics?: (metrics: Record<string, PatientMetrics>) => void;
  onVitals?: (vitals: Record<string, DeviceVitals>) => void;
  onReply?: (reply: NurseReply) => void;
  onStatusChange?: (status: ConnStatus, transport: Transport) => void;
  onDriver?: (driver: "memory" | "redis") => void;
}

/**
 * Real-time sync client.
 *  - Primary:  Server-Sent Events (/api/stream) — one connection, instant push.
 *  - Fallback: adaptive interval polling (2.5s -> 15s exponential backoff).
 *  - Offline:  every outbound message is persisted to an IndexedDB outbox and
 *              flushed automatically when connectivity returns.
 */
export class NetworkSync {
  private cfg: NetworkSyncConfig;
  private es: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private bc: BroadcastChannel | null = null;
  private onlineHandler = () => void this.flushOutbox();
  private seenIds = new Set<string>();
  private knownStatus = new Map<string, string>();
  /** Replies are delivered exactly once per id across every transport —
   *  SSE redeliveries, REST reconcile windows and reconnects all funnel
   *  through deliverReply() which drops duplicates. */
  private seenReplyIds = new Set<string>();
  private cursor = Date.now() - 60_000;
  private pollInterval = POLL_INTERVAL_MS;
  private failures = 0;
  private status: ConnStatus = "disconnected";
  private transport: Transport = "none";
  private destroyed = false;
  private lastInboundAt = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private sseSilentStrikes = 0;
  private driver: "memory" | "redis" | null = null;

  constructor(cfg: NetworkSyncConfig) {
    this.cfg = cfg;
    try {
      this.bc = new BroadcastChannel(BROADCAST_CHANNEL);
      this.bc.onmessage = (ev: MessageEvent) => this.onBroadcast(ev.data);
    } catch {
      this.bc = null;
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onlineHandler);
      if (navigator.onLine === false) this.setStatus("disconnected", "offline");
    }
  }

  /* ── lifecycle ─────────────────────────────────────────── */

  connect(): void {
    if (this.destroyed) return;
    this.cursor = Date.now() - 60_000;
    this.lastInboundAt = Date.now();
    void this.openSse();
    this.startWatchdog();
  }

  destroy(): void {
    this.destroyed = true;
    this.closeSse();
    this.stopPolling();
    this.stopReconciliation();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", this.onlineHandler);
    try {
      this.bc?.close();
    } catch {}
    this.bc = null;
  }

  /* ── inbound ───────────────────────────────────────────── */

  private async openSse(): Promise<void> {
    const session = this.cfg.sessionId ?? "default";
    try {
      const es = new EventSource(
        `/api/stream?session=${encodeURIComponent(session)}&since=${this.cursor}`
      );
      this.es = es;

      es.addEventListener("open", () => {
        this.failures = 0;
        this.pollInterval = POLL_INTERVAL_MS;
        this.stopPolling();
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.sseSilentStrikes = 0;
        this.lastInboundAt = Date.now();
        this.setStatus("connected", "sse");
        this.startReconciliation(); // REST safety-net while SSE is up
        void this.flushOutbox();
        if (this.graceTimer) clearTimeout(this.graceTimer);
      });

      es.addEventListener("hello", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { driver?: "memory" | "redis" };
          if (data.driver && data.driver !== this.driver) {
            this.driver = data.driver;
            this.cfg.onDriver?.(data.driver);
          }
        } catch {}
        this.markInbound();
        this.setStatus("connected", "sse");
      });

      es.addEventListener("entries", (ev) => {
        try {
          const entries = JSON.parse((ev as MessageEvent).data) as StoredEntry[];
          this.markInbound();
          this.ingestEntries(entries);
        } catch {}
      });

      es.addEventListener("state", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            patientMetrics: Record<string, PatientMetrics>;
            vitals: Record<string, DeviceVitals>;
            serverTime: number;
          };
          this.markInbound();
          if (Object.keys(data.patientMetrics ?? {}).length > 0) this.cfg.onMetrics?.(data.patientMetrics);
          if (Object.keys(data.vitals ?? {}).length > 0) this.cfg.onVitals?.(data.vitals);
          this.setStatus("connected", "sse");
        } catch {}
      });

      es.addEventListener("replies", (ev) => {
        try {
          const replies = JSON.parse((ev as MessageEvent).data) as NurseReply[];
          this.markInbound();
          for (const r of replies) this.deliverReply(r);
        } catch {}
      });

      es.addEventListener("error", () => {
        // EventSource retries internally; give it a short grace period,
        // then degrade to polling so rural/2G networks still work.
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
          if (this.transport === "sse" && this.status !== "connected") {
            this.closeSse();
            this.startPolling();
          }
        }, SSE_GRACE_MS);
        this.setStatus(this.status === "disconnected" ? "disconnected" : "reconnecting", this.transport === "poll" ? "poll" : "sse");
      });
    } catch {
      this.startPolling();
    }
  }

  private ingestEntries(entries: StoredEntry[]): void {
    let newest = this.cursor;
    for (const e of entries) {
      const st = e.serverTime ?? e.timestamp;
      if (st > newest) newest = st;
      const prevStatus = this.knownStatus.get(e.id);
      if (prevStatus && e.status && e.status !== prevStatus) {
        this.cfg.onStatusUpdate?.(e.id, e.status as NonNullable<StoredEntry["status"]>);
      }
      this.knownStatus.set(e.id, e.status ?? "none");
      if (this.knownStatus.size > 3000) {
        // bound memory alongside seenIds on long-running dashboards
        for (const id of Array.from(this.knownStatus.keys()).slice(0, 1000)) this.knownStatus.delete(id);
      }
      if (!this.seenIds.has(e.id)) {
        this.seenIds.add(e.id);
        if (this.seenIds.size > 3000) {
          // bound memory on long-running dashboards
          for (const id of Array.from(this.seenIds).slice(0, 1000)) this.seenIds.delete(id);
        }
        this.cfg.onAlert?.(e);
      } else if (e.status === "acknowledge" || e.status === "escalate" || e.status === "resolve") {
        this.cfg.onStatusUpdate?.(e.id, e.status);
      }
    }
    this.cursor = Math.max(this.cursor, newest);
  }

  private closeSse(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.stopReconciliation();
  }

  /* ── reconciliation polling (REST safety-net while SSE is up) ── */

  private startReconciliation(): void {
    if (this.reconciliationTimer || this.destroyed) return;
    this.reconciliationTimer = setInterval(() => {
      if (!this.destroyed && this.es) void this.pollOnce();
    }, RECONCILE_INTERVAL_MS);
  }

  private stopReconciliation(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }

  /* ── poll fallback ─────────────────────────────────────── */

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.destroyed) return;
    this.pollInterval = POLL_INTERVAL_MS;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      void this.pollOnce().then(() => {
        if (!this.pollTimer && !this.destroyed && !this.es) {
          this.pollTimer = setInterval(() => void this.pollOnce(), this.pollInterval);
        }
      });
    }, 50);
  }

  /**
   * Self-heal: if SSE claims to be connected but delivers nothing (buffering
   * proxy, half-open socket), force a poll immediately and degrade to polling
   * permanently after repeated silent stretches.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer || typeof window === "undefined") return;
    this.watchdogTimer = setInterval(() => {
      if (this.destroyed || this.transport !== "sse") {
        if (this.transport !== "sse") this.sseSilentStrikes = 0;
        return;
      }
      if (Date.now() - this.lastInboundAt < 8000) {
        this.sseSilentStrikes = 0;
        return;
      }
      this.sseSilentStrikes++;
      void this.pollOnce();
      if (this.sseSilentStrikes >= 2) {
        this.closeSse();
        this.startPolling();
        this.sseSilentStrikes = 0;
      }
    }, 5000);
  }

  private markInbound(): void {
    this.lastInboundAt = Date.now();
    this.sseSilentStrikes = 0;
  }

  private async pollOnce(): Promise<void> {
    if (this.destroyed) return;
    try {
      const session = encodeURIComponent(this.cfg.sessionId ?? "default");      const res = await fetch(`/api/sync?session=${session}&since=${this.cursor}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        entries: StoredEntry[];
        patientMetrics: Record<string, PatientMetrics>;
        vitals: Record<string, DeviceVitals>;
        replies: NurseReply[];
        serverTime: number;
        driver?: "memory" | "redis";
      };
      this.failures = 0;
      this.pollInterval = POLL_INTERVAL_MS;
      this.markInbound();
      if (data.driver && data.driver !== this.driver) {
        this.driver = data.driver;
        this.cfg.onDriver?.(data.driver);
      }
      this.setStatus("connected", this.es ? "sse" : "poll");
      this.ingestEntries(data.entries ?? []);
      if (Object.keys(data.patientMetrics ?? {}).length > 0) this.cfg.onMetrics?.(data.patientMetrics);
      if (Object.keys(data.vitals ?? {}).length > 0) this.cfg.onVitals?.(data.vitals);
      for (const r of data.replies ?? []) this.deliverReply(r);
    } catch {
      this.failures++;
      this.pollInterval = Math.min(this.pollInterval * 2, MAX_POLL_INTERVAL_MS);
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      // First failure already means reconciliation is broken — never claim
      // "connected" while requests are failing.
      this.setStatus(
        "reconnecting",
        this.es ? "sse" : this.failures > 3 ? "offline" : "poll"
      );
      this.schedulePoll();
    }
  }

  /* ── outbound ──────────────────────────────────────────── */

  async post(body: unknown): Promise<boolean> {
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Send a gesture alert. Queues durably when offline. */
  async sendAlert(entry: GestureLogEntry): Promise<void> {
    const body = { type: "new_gesture", entry: { ...entry, sessionId: undefined }, sessionId: this.cfg.sessionId };
    const ok = await this.post(body);
    if (!ok) await enqueue({ channel: "alert", body: { type: "new_gesture", entry: { ...entry } } });
    else void this.flushOutbox();
    this.broadcast({ kind: "new_gesture", entry, sessionId: this.cfg.sessionId });
  }

  async sendAction(action: AlertAction): Promise<void> {
    const body = {
      type: action.type,
      entryId: action.entryId,
      action,
      sessionId: this.cfg.sessionId,
    };
    const ok = await this.post(body);
    if (!ok) await enqueue({ channel: "action", body: { type: action.type, entryId: action.entryId, action } });
    this.broadcast({ kind: "action", action, sessionId: this.cfg.sessionId });
  }

  async sendReply(reply: Omit<NurseReply, "timestamp">): Promise<void> {
    await this.post({ type: "reply", reply, sessionId: this.cfg.sessionId });
  }

  async sendPatientMetrics(metrics: PatientMetrics, deviceId: string): Promise<void> {
    const body = { type: "metrics", patientMetrics: metrics, deviceId, sessionId: this.cfg.sessionId };
    const ok = await this.post(body);
    if (!ok) await enqueueMetricsLatestWins({ channel: "metrics", body: { type: "metrics", patientMetrics: metrics, deviceId } });
  }

  async sendIoTVitals(vitals: Omit<DeviceVitals, "receivedAt">): Promise<void> {
    await this.post({ type: "vitals", vitals, sessionId: this.cfg.sessionId });
  }

  async flushOutbox(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const items = await dequeueAll();
    for (const item of items) {
      const payload: OutboxPayload = item.payload;
      const ok = await this.post(payload.body);
      if (ok) await removeOutboxItem(item.key);
      else break; // still offline — retry on next trigger
    }
  }

  /* ── local same-device tabs ────────────────────────────── */

  private broadcast(msg: import("@/types").SyncMessage): void {
    try {
      this.bc?.postMessage(msg);
    } catch {}
  }

  private onBroadcast(msg: import("@/types").SyncMessage): void {
    if (!msg || msg.sessionId !== this.cfg.sessionId) return;
    if (msg.kind === "new_gesture" && !this.seenIds.has(msg.entry.id)) {
      this.seenIds.add(msg.entry.id);
      this.knownStatus.set(msg.entry.id, "none");
      this.cfg.onAlert?.(msg.entry);
    }
    if (msg.kind === "action") {
      this.knownStatus.set(msg.action.entryId, msg.action.type);
      this.cfg.onStatusUpdate?.(msg.action.entryId, msg.action.type);
    }
    if (msg.kind === "reply") this.deliverReply(msg.reply);
  }

  /** Exactly-once reply delivery: dedupes across SSE, REST polling, reconnect
   *  replays and same-device broadcasts by reply id. */
  private deliverReply(r: NurseReply): void {
    if (!r || this.seenReplyIds.has(r.id)) return;
    this.seenReplyIds.add(r.id);
    if (this.seenReplyIds.size > 300) {
      for (const id of Array.from(this.seenReplyIds).slice(0, 100)) this.seenReplyIds.delete(id);
    }
    this.cfg.onReply?.(r);
  }

  /* ── status plumbing ───────────────────────────────────── */

  private setStatus(status: ConnStatus, transport: Transport): void {
    if (this.status === status && this.transport === transport) return;
    this.status = status;
    this.transport = transport;
    this.cfg.onStatusChange?.(status, transport);
  }

  getStatus(): ConnStatus {
    return this.status;
  }
  getTransport(): Transport {
    return this.transport;
  }
  getDriver(): "memory" | "redis" | null {
    return this.driver;
  }
}

export function createNetworkSync(config: NetworkSyncConfig): NetworkSync {
  const sync = new NetworkSync(config);
  sync.connect();
  return sync;
}
