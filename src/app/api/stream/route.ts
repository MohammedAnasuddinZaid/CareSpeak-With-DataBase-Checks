import { NextRequest } from "next/server";
import { getSessionStore } from "@/lib/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  let loopTimer: ReturnType<typeof setInterval> | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;

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

      const tick = async () => {
        if (closed) return;
        try {
          const [entries, metrics, vitals, replies] = await Promise.all([
            store.getEntriesSince(session, cursor),
            store.getMetrics(session),
            store.getVitals(session),
            store.getRepliesSince(session, cursor),
          ]);
          if (entries.length > 0) {
            cursor = Math.max(...entries.map((e) => e.serverTime ?? e.timestamp));
            send("entries", entries);
          }
          if (replies.length > 0) send("replies", replies);
          send("state", { patientMetrics: metrics, vitals, serverTime: Date.now(), cursor });
        } catch {
          // transient store error — keep the stream alive
        }
      };

      void tick();
      loopTimer = setInterval(() => void tick(), 1500);
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
        if (loopTimer) clearInterval(loopTimer);
        if (beatTimer) clearInterval(beatTimer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      if (loopTimer) clearInterval(loopTimer);
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
