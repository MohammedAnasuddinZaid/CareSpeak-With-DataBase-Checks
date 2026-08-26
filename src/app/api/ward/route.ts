import { NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";
import { getPairSummary } from "@/lib/server/pairing";

export const dynamic = "force-dynamic";

/**
 * Multi-patient ward overview.
 * GET /api/ward -> recently-active sessions with compact summaries so a single
 * nurse can monitor an entire ward from one screen. Includes per-bed QR pairing
 * telemetry (linked devices, last scan IP/time). Pairs with /ward (UI).
 */
export async function GET(): Promise<NextResponse> {
  const store = await getSessionStore();
  const sessions = await store.getActiveSessions();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const freshCutoff = Date.now() - 2 * 60 * 60 * 1000; // registry TTL parity

  const rows = await Promise.all(
    sessions
      .filter((s) => s.lastSeen >= freshCutoff)
      .slice(0, 50)
      .map(async ({ session, lastSeen }) => {
        try {
          const [entries, metrics, vitals] = await Promise.all([
            store.getEntriesSince(session, cutoff),
            store.getMetrics(session),
            store.getVitals(session),
          ]);
          let last = entries[0] ?? null;
          for (const e of entries) {
            if ((e.serverTime ?? e.timestamp) > (last?.serverTime ?? last?.timestamp ?? 0)) last = e;
          }
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const pairing = getPairSummary(session);
          return {
            session,
            lastSeen,
            lastGesture: last?.gesture ?? null,
            lastAt: last ? (last.serverTime ?? last.timestamp) : null,
            unacknowledged: entries.filter((e) => e.status === "none").length,
            escalated: entries.filter((e) => e.status === "escalate").length,
            today: entries.filter((e) => (e.serverTime ?? e.timestamp) >= todayStart.getTime()).length,
            alertness: Object.values(metrics)[0]?.alertnessScore ?? null,
            movement: Object.values(metrics)[0]?.movementActivity ?? null,
            heartRate: Object.values(vitals)[0]?.heartRate ?? null,
            spo2: Object.values(vitals)[0]?.spo2 ?? null,
            sosActive: !!Object.values(vitals)[0]?.sosActive,
            linkedDevices: pairing.linkedDevices,
            lastScanAt: pairing.lastScanAt,
            lastScanIp: pairing.lastScanIp,
          };
        } catch {
          return {
            session,
            lastSeen,
            lastGesture: null as string | null,
            lastAt: null as number | null,
            unacknowledged: 0,
            escalated: 0,
            today: 0,
            alertness: null as number | null,
            movement: null as number | null,
            heartRate: null as number | null,
            spo2: null as number | null,
            sosActive: false,
            linkedDevices: 0,
            lastScanAt: null as number | null,
            lastScanIp: null as string | null,
          };
        }
      })
  );

  return NextResponse.json({ sessions: rows, serverTime: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
