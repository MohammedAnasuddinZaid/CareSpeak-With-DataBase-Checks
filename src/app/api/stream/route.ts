import { NextRequest } from "next/server";
import { getSessionStore } from "@/lib/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOT_TICK_MS = 350;    // push cadence right after a change
const HOT_WINDOW_MS = 8000; // how long fast-polling persists after a change
const IDLE_TICK_MS = 2200;  // cadence when nothing has happened for a while

/**
 * Server-Sent Events live stream — replaces the old 100ms polling.
 * One persistent connection per dashboard; server pushes only new data.
 * Clients automatically fall back to interval polling if SSE is unavailable
 * (e.g. aggressive corporate proxies), so this degrades gracefully.
 *
 * Resume semantics: every data event carries an `id:` (the server-time cursor).
 * When EventSource auto-reconnects the browser sends `Last-Event-ID`, so the
 * stream resumes exactly where it left off instead of replaying history from
 * the stale `?since=` the URL was built with.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get("session") ?? "";
  if (!/^[A-Z0-9_-]{3,32}$/.test(session)) {
    return new Response("Invalid session", { status: 400 });
  }

  // `?since=` (empty value) used to parse as 0 and replay the ENTIRE store on
  // the first tick — treat blank/malformed cursors as "last minute".
  const fallback = Date.now() - 60_000;
  const lastEventId = request.headers.get("last-event-id");
  const rawSince = lastEventId ?? searchParams.get("since");
  let cursor = rawSince === null || rawSince.trim() === "" ? fallback : Number(rawSince);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = fallback;
  // Replies have their OWN cursor — otherwise they'd be re-sent on every tick
  // until an unrelated gesture entry happened to advance the shared one.
  let replyCursor = cursor;
  const encoder = new TextEncoder();
  let closed = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  // Adaptive cadence: after any DATA CHANGE we tick fast (near-instant push),
  // then decay to an idle rate. (Testing mere presence of vitals kept every
  // wearable-equipped session hot forever — 350ms polling for hours.)
  let hotUntil = 0;
  let lastSnapshot = "";
  // Same-millisecond entries share a serverTime; a `>` cursor alone can skip
  // them during bursts. Per-connection id memory makes delivery lossless
  // regardless of clock granularity (bounded, FIFO-evicted).
  const sentIds = new Set<string>();
  const sentOrder: string[] = [];

  const stopLoop = () => {
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
  };
  const stopBeat = () => {
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
  };

  const store = await getSessionStore();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number | string) => {
        if (closed) return;
        try {
          const idLine = id !== undefined ? `id: ${id}\n` : "";
          controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
          stopLoop();
          stopBeat();
        }
      };
      const markSent = (ids: string[]) => {
        for (const id of ids) {
          if (sentIds.has(id)) continue;
          sentIds.add(id);
          sentOrder.push(id);
        }
        while (sentOrder.length > 1000) {
          const oldest = sentOrder.shift();
          if (oldest !== undefined) sentIds.delete(oldest);
        }
      };

      send("hello", { driver: store.driver, serverTime: Date.now() });

      let ticking = false;
      const tick = async () => {
        if (closed || ticking) return scheduleNext();
        ticking = true;
        try {
          const [entries, metrics, vitals, replies] = await Promise.all([
            store.getEntriesSince(session, cursor),
            store.getMetrics(session),
            store.getVitals(session),
            store.getRepliesSince(session, replyCursor),
          ]);
          const fresh = entries.filter((e) => !sentIds.has(e.id));
          const snapshot = JSON.stringify({ m: metrics, v: vitals });
          if (fresh.length > 0) {
            for (const e of fresh) {
              const st = e.serverTime ?? e.timestamp;
              if (st > cursor) cursor = st;
            }
            markSent(fresh.map((e) => e.id));
            send("entries", fresh, cursor);
            hotUntil = Date.now() + HOT_WINDOW_MS;
          }
          if (replies.length > 0) {
            replyCursor = Math.max(...replies.map((r) => r.timestamp));
            send("replies", replies, replyCursor);
            hotUntil = Date.now() + HOT_WINDOW_MS;
          }
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            send("state", { patientMetrics: metrics, vitals, serverTime: Date.now(), cursor });
            hotUntil = Date.now() + HOT_WINDOW_MS;
          }
        } catch {
          // transient store error — keep the stream alive
        } finally {
          ticking = false;
          scheduleNext();
        }
      };

      const scheduleNext = () => {
        if (closed) return;
        const delay = Date.now() < hotUntil ? HOT_TICK_MS : IDLE_TICK_MS;
        loopTimer = setTimeout(() => void tick(), delay);
      };

      void tick();
      beatTimer = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          } catch {
            closed = true;
            stopBeat();
            stopLoop();
          }
        }
      }, 15000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        stopLoop();
        stopBeat();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      stopLoop();
      stopBeat();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
