import { NextRequest } from "next/server";
import { getSessionStore } from "@/lib/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOT_TICK_MS = 350;    // push cadence right after activity
const HOT_WINDOW_MS = 8000; // how long fast-polling persists after a change
const IDLE_TICK_MS = 2200;  // cadence when nothing has happened for a while

/**
 * Server-Sent Events live stream — replaces the old 100ms polling.
 * One persistent connection per dashboard; server pushes only new data.
 * Clients automatically fall back to interval polling if SSE is unavailable
 * (e.g. aggressive corporate proxies), so this degrades gracefully.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get("session") ?? "";
  if (!/^[A-Z0-9_-]{3,32}$/.test(session)) {
    return new Response("Invalid session", { status: 400 });
  }

  let cursor = Number(searchParams.get("since") ?? Date.now() - 60_000);
  const encoder = new TextEncoder();
  let closed = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  // Adaptive cadence: after any data change we tick fast (near-instant push),
  // then decay to an idle rate to keep serverless/Upstash costs tiny.
  let hotUntil = 0;
  let lastSnapshot = "";

  const stopLoop = () => {
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
  };

  const store = await getSessionStore();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
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
            store.getRepliesSince(session, cursor),
          ]);
          const snapshot = JSON.stringify({ m: metrics, v: vitals });
          if (entries.length > 0) {
            cursor = Math.max(...entries.map((e) => e.serverTime ?? e.timestamp));
            send("entries", entries);
          }
          if (replies.length > 0) send("replies", replies);
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            send("state", { patientMetrics: metrics, vitals, serverTime: Date.now(), cursor });
          }
          if (entries.length > 0 || replies.length > 0 ||
              Object.keys(metrics).length > 0 || Object.keys(vitals).length > 0) {
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
          }
        }
      }, 15000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        stopLoop();
        if (beatTimer) clearInterval(beatTimer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      stopLoop();
      if (beatTimer) clearInterval(beatTimer);
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
