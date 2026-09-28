import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { authorizeRead, normalizeCode, readEntries, readMetrics, readReplies, readVitals } from "@/lib/server/clinical";
import { getCurrentUser } from "@/lib/server/auth";
import { getBus, topics } from "@/lib/server/realtime";
import { createSseStream, sseHeaders } from "@/lib/server/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events live stream.
 *
 * Now event-driven: a write publishes to the bus and this socket receives the
 * frame immediately. The previous implementation polled the store on a
 * 350-2200ms timer, which put a hard floor of 2.2s on nurse-to-patient message
 * latency and cost a store read per connected client per tick even when the
 * ward was silent. See `sse.ts` for the full rationale.
 *
 * A slow reconcile tick remains as a safety net. It is deliberately *not* the
 * primary path: the bus makes delivery instant, and the tick only exists to
 * repair frames lost to a Redis restart or a client reconnecting mid-publish.
 * Because every tick re-reads the authoritative store, a lost frame costs
 * latency and never correctness.
 *
 * Resume semantics are unchanged and still authoritative: each data event
 * carries an `id:` cursor, and EventSource resends it as `Last-Event-ID` on
 * reconnect, so the stream resumes exactly where it stopped rather than
 * replaying from the stale `?since=` in the original URL.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const code = normalizeCode(searchParams.get("session"));
  if (!code) {
    return new Response("Invalid session", { status: 400 });
  }

  // A long-lived socket is the easiest thing in the app to leave open and the
  // easiest to point at someone else's bed, so it is authorised exactly like the
  // polling read. EventSource cannot set headers, so the credential has to be the
  // HttpOnly console cookie (or a staff session) rather than a bearer token.
  const token = (await cookies()).get("cs_console")?.value ?? null;
  const { auth, session } = await authorizeRead(code, token, await getCurrentUser());
  if (!auth.ok) {
    return new Response(
      auth.reason === "unauthenticated" ? "Unauthorized" : "Forbidden",
      { status: auth.reason === "unauthenticated" ? 401 : 403 },
    );
  }
  if (!session) {
    return new Response("Console not provisioned", { status: 403 });
  }

  // `?since=` (empty value) used to parse as 0 and replay the ENTIRE store on
  // the first tick — treat blank/malformed cursors as "last minute".
  const fallback = Date.now() - 60_000;
  const lastEventId = request.headers.get("last-event-id");
  const rawSince = lastEventId ?? searchParams.get("since");
  let cursor = rawSince === null || rawSince.trim() === "" ? fallback : Number(rawSince);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = fallback;
  // Replies carry their own cursor. Sharing one with gesture entries meant a
  // reply stayed "unseen" until an unrelated gesture happened to advance it.
  let replyCursor = cursor;

  // Same-millisecond entries share a serverTime, so a `>` cursor alone can skip
  // them during a burst. Per-connection id memory makes delivery lossless
  // regardless of clock granularity (bounded, FIFO-evicted).
  const sentIds = new Set<string>();
  const sentOrder: string[] = [];
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

  const bus = await getBus();
  let lastSnapshot = "";

  const stream = createSseStream({
    request,
    hello: { driver: "mysql" as const, bus: bus.driver, serverTime: Date.now() },
    // Subscribe to this console's topic. A write from any app instance reaches
    // every socket, which is what previously could not happen across instances.
    subscribe: (emit) => bus.subscribe(topics.console(code), emit),
    reconcileMs: 5_000,
    keepaliveMs: 15_000,
    reconcile: async (emit) => {
      const [entries, metrics, vitals, replies] = await Promise.all([
        readEntries(session.id, cursor),
        readMetrics(session.id),
        readVitals(session.id),
        readReplies(session.id, replyCursor),
      ]);

      const fresh = entries.filter((e) => !sentIds.has(e.id));
      if (fresh.length > 0) {
        for (const e of fresh) {
          const st = e.serverTime ?? e.timestamp;
          if (st > cursor) cursor = st;
        }
        markSent(fresh.map((e) => e.id));
        emit("entries", fresh, String(cursor));
      }

      if (replies.length > 0) {
        replyCursor = Math.max(...replies.map((r) => r.timestamp));
        emit("replies", replies, String(replyCursor));
      }

      // Only emit state when it actually changed. Vitals are a hot stream and
      // re-sending an identical snapshot would burn bandwidth on every tick.
      const snapshot = JSON.stringify({ m: metrics, v: vitals });
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        emit("state", { patientMetrics: metrics, vitals, serverTime: Date.now(), cursor });
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
