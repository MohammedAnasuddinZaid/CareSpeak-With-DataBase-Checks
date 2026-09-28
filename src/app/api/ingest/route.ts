import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getSessionStore } from "@/lib/server/store";
import { sanitizeVitals } from "@/lib/server/vitals";
import { getBus } from "@/lib/server/realtime";
import { publishConsoleEvent } from "@/lib/server/publish";
import { env } from "@/lib/server/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One SOS per device+session per this many ms. */
const SOS_DEDUP_MS = 5_000;

/**
 * Compare a presented secret against the configured one in constant time.
 *
 * `provided !== token` short-circuits on the first differing byte, which leaks
 * a prefix-length oracle: an attacker can recover the token a byte at a time
 * from response timing. For a shared secret guarding clinical writes, use
 * timingSafeEqual. Note the length check has to happen first because
 * timingSafeEqual throws on mismatched lengths — and a wrong *length* is not a
 * secret worth hiding, only the content is.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * IoT bridge for ESP32 / Raspberry Pi wearables.
 *
 * POST /api/ingest
 *   headers: { "x-device-token": CARESPEAK_DEVICE_TOKEN }
 *   body: { session, deviceId, type: "vitals" | "sos",
 *           heartRate?, spo2?, temperature?, batteryPct?, rssi? }
 *
 * - "vitals"  -> stored per-session, rendered on the nurse dashboard.
 * - "sos"     -> creates an EMERGENCY entry that fans out to every console
 *                exactly like a patient gesture (buzzer + dashboard + TTS).
 *
 * Demo mode: with CARESPEAK_DEVICE_TOKEN unset the endpoint accepts everything,
 * so judges can test hardware without configuring secrets. That is a real
 * vulnerability, not a feature — `env.auditConfiguration()` reports it as a
 * problem, and /api/health surfaces it, so an exposed deployment is visible
 * rather than silently open.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = env.deviceToken;
  if (token && !secretMatches(request.headers.get("x-device-token"), token)) {
    return NextResponse.json({ ok: false, error: "Unauthorized device" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    session?: string;
    deviceId?: string;
    type?: string;
    heartRate?: number;
    spo2?: number;
    temperature?: number;
    sosActive?: boolean;
    batteryPct?: number;
    rssi?: number;
  } | null;

  if (!body || typeof body.session !== "string" || !/^[A-Z0-9_-]{3,32}$/.test(body.session.toUpperCase())) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }
  const session = body.session.toUpperCase();
  const deviceId = (body.deviceId ?? "esp32").slice(0, 64);
  const store = await getSessionStore();
  const now = Date.now();

  if (body.type === "sos") {
    // Cluster-wide dedup. The previous in-process Map meant N app instances
    // turned one button press into N emergency alerts, and a cold start reset
    // every window. A SETNX claim is atomic, so exactly one instance wins
    // regardless of how many are running or which one the device reaches.
    let claimed = true;
    try {
      claimed = await (await getBus()).claim(`sos:${session}:${deviceId}`, SOS_DEDUP_MS / 1000);
    } catch {
      // Bus unavailable: fail open and let the emergency through. Dedup is a
      // nuisance-avoidance measure; dropping a real SOS to preserve it would be
      // the far worse failure.
    }
    if (!claimed) {
      return NextResponse.json({ ok: true, deduped: true, serverTime: now });
    }

    const entry = {
      id: `iot_${now}_${Math.random().toString(36).slice(2, 8)}`,
      gesture: "EMERGENCY",
      description: "EMERGENCY — SOS button pressed on wearable device",
      confidence: 1,
      type: "system" as const,
      timestamp: now,
      language: "en-US",
      source: "iot" as const,
      escalated: true,
      escalatedBy: "system" as const,
    };
    await store.appendEntry(session, entry);
    // Durable: this is the single most consequential event in the system. It
    // goes to every live console immediately and survives a reconnect replay.
    publishConsoleEvent(session, "alert", entry, { durable: true });
    return NextResponse.json({ ok: true, serverTime: now });
  }

  if (body.type === "vitals") {
    await store.setVitals(session, {
      deviceId,
      ...sanitizeVitals(body),
      receivedAt: now,
    });
    // Not durable. Vitals arrive every 15s per device; retaining each one in a
    // stream would fill the replay window with data the client already has, at
    // the cost of a live subscriber being pushed off the socket.
    publishConsoleEvent(session, "vitals", { deviceId });
    return NextResponse.json({ ok: true, serverTime: now });
  }

  return NextResponse.json({ ok: false, error: "Unknown type" }, { status: 400 });
}
