/**
 * Event-driven Server-Sent Events pump.
 *
 * ── The problem this replaces ───────────────────────────────────────────────
 * The original stream was a poll wearing an SSE costume. `/api/stream` woke on
 * a timer and asked the store "anything new?", so:
 *
 *   * latency was bounded by IDLE_TICK_MS (2.2s), not by the network;
 *   * every connected client cost a full store read per tick even when silent;
 *   * the client needed a 2s REST reconciliation poll *on top*, because the
 *     serverless SSE handler and the writer were often on different instances
 *     and genuinely could not see each other's writes.
 *
 * ── The new shape ──────────────────────────────────────────────────────────
 * Push is the primary path and a timer is the safety net, which is the inverse
 * of the old design. A write publishes to the bus; every live socket for that
 * bed is already connected and receives the frame in ~1ms on a LAN. The
 * reconcile tick then drops to a slow heartbeat whose only job is to catch
 * anything the bus lost (a Redis restart, a pod evicted mid-publish, a frame
 * that arrived while a client was mid-reconnect).
 *
 * Critically, the bus is *not* trusted as the record. `reconcile` re-reads the
 * authoritative store every time, so a dropped frame costs a few seconds of
 * latency, never correctness. That is what makes it safe to make the fast path
 * a cache-and-notify design.
 */
import type { NextRequest } from "next/server";
import type { BusEvent } from "./realtime";

/**
 * A reconcile that re-reads authoritative state and writes any new frames.
 * Must be safe to call concurrently with itself — the pump serialises it.
 */
export type ReconcileFn = (
  emit: (event: string, data: unknown, id?: string) => void,
) => Promise<void>;

export interface SsePumpOptions {
  request: NextRequest;
  /**
   * Attach to the bus. `emit` is the coalescing entry point: call it once per
   * received event, not once per frame. Returns a detach function.
   *
   * This is allowed to reject (e.g. Redis down). A rejected subscribe must not
   * kill the stream — the reconcile safety net still delivers everything, just
   * at the slow cadence instead of instantly.
   */
  subscribe: (emit: (event: BusEvent) => void) => Promise<() => Promise<void>>;
  reconcile: ReconcileFn;
  /** Safety-net cadence. 0 disables it, which is only safe in tests. */
  reconcileMs?: number;
  /** Comment-frame cadence to keep proxies from reaping an idle connection. */
  keepaliveMs?: number;
  /** Payload for the opening `hello` event. */
  hello?: unknown;
  /** Milliseconds to coalesce a burst of bus events into one reconcile. */
  coalesceMs?: number;
}

/** Headers that make an SSE response survive nginx, Vercel and browsers. */
export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    // `no-transform` stops proxies that "optimise" responses from buffering
    // them, which would reintroduce exactly the latency we just removed.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disables nginx response buffering. Without it a 1ms push becomes 2.2s.
    "X-Accel-Buffering": "no",
  };
}

export function createSseStream(opts: SsePumpOptions): ReadableStream<Uint8Array> {
  const {
    request,
    subscribe,
    reconcile,
    reconcileMs = 5_000,
    keepaliveMs = 15_000,
    hello,
    coalesceMs = 25,
  } = opts;

  const encoder = new TextEncoder();
  let closed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let detach: (() => Promise<void>) | null = null;
  /** Serialises reconciles; two concurrent reads would interleave cursors. */
  let reconciling = false;
  let pending = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  const stopTimers = () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (coalesceTimer) clearTimeout(coalesceTimer);
    reconcileTimer = null;
    keepaliveTimer = null;
    coalesceTimer = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The socket died between the liveness check and this enqueue.
          closed = true;
          stopTimers();
        }
      };

      const emit = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        try {
          const idLine = id !== undefined ? `id: ${id}\n` : "";
          write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          closed = true;
          stopTimers();
        }
      };

      /** Coalesced kick: many events in a burst produce one reconcile. */
      const kick = () => {
        if (closed || pending) return;
        pending = true;
        if (coalesceTimer) clearTimeout(coalesceTimer);
        coalesceTimer = setTimeout(() => {
          coalesceTimer = null;
          void runReconcile();
        }, coalesceMs);
      };

      const runReconcile = async () => {
        if (closed) return;
        if (reconciling) {
          // A write landed mid-read. Re-run after this pass so the write is not
          // left sitting until the next slow tick.
          pending = true;
          return;
        }
        reconciling = true;
        pending = false;
        try {
          await reconcile(emit);
        } catch {
          // Transient store error. Keep the stream open: the next tick retries,
          // and a closed stream would force the client through a full reconnect
          // for what is usually a transient blip.
        } finally {
          reconciling = false;
        }
        if (pending && !closed) kick();
      };

      const scheduleReconcile = () => {
        if (closed || reconcileMs <= 0) return;
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          void runReconcile().then(scheduleReconcile);
        }, reconcileMs);
      };

      if (hello !== undefined) emit("hello", hello);

      void subscribe(() => kick())
        .then((off) => {
          detach = off;
          if (closed) void off();
        })
        .catch((err: unknown) => {
          // Bus unavailable. The stream still works via the safety net, so log
          // and continue rather than 500-ing a client that has data to read.
          console.error(
            `[sse] bus subscribe failed (${err instanceof Error ? err.message : String(err)}); ` +
              "continuing on the reconcile timer",
          );
        });

      // Prime the client with current state so it renders immediately on connect
      // instead of waiting up to reconcileMs for the first frame.
      void runReconcile().then(scheduleReconcile);

      if (keepaliveMs > 0) {
        keepaliveTimer = setInterval(() => {
          // A comment frame: ignored by EventSource, but it proves liveness to
          // any intermediary deciding whether the connection is still useful.
          write(`: keepalive ${Date.now()}\n\n`);
        }, keepaliveMs);
      }

      const teardown = () => {
        if (closed) return;
        closed = true;
        stopTimers();
        void detach?.();
        detach = null;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", teardown);
    },
    cancel() {
      closed = true;
      stopTimers();
      void detach?.();
      detach = null;
    },
  });
}
