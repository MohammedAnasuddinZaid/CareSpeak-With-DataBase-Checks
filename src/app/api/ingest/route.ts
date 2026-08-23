import { NextRequest, NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** device+session -> last SOS ms (per-instance; resets on cold start, which is fine) */
const lastSosAt = new Map<string, number>();

/**
 * IoT bridge for ESP32 / Raspberry Pi wearables.
 *
 * POST /api/ingest
 *   headers: { "x-device-token": process.env.CARESPEAK_DEVICE_TOKEN }
 *   body: { session, deviceId, type: "vitals" | "sos",
 *           heartRate?, spo2?, temperature?, batteryPct?, rssi? }
 *
 * - "vitals"  -> stored per-session, rendered on the nurse dashboard.
 * - "sos"     -> creates an EMERGENCY entry that fans out to every console
 *                exactly like a patient gesture (buzzer + dashboard + TTS).
 *
 * If CARESPEAK_DEVICE_TOKEN is unset the endpoint runs in demo mode (accepts
 * all requests) so judges can test hardware without configuring secrets.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = process.env.CARESPEAK_DEVICE_TOKEN;
  if (token) {
    const provided = request.headers.get("x-device-token");
    if (provided !== token) {
      return NextResponse.json({ ok: false, error: "Unauthorized device" }, { status: 401 });
    }
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

  if (!body || typeof body.session !== "string" || !/^[A-Z0-9_-]{3,32}$/.test(body.session)) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }
  const deviceId = (body.deviceId ?? "esp32").slice(0, 64);
  const store = await getSessionStore();

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && isFinite(v) ? v : undefined;

  // Per-device SOS throttle: one event per device+session per 5s (defends against
  // buggy firmware or a stuck button fanning out dozens of emergencies).
  const now = Date.now();
  if (body.type === "sos") {
    const key = `${body.session.toUpperCase()}|${deviceId}`;
    const last = lastSosAt.get(key) ?? 0;
    if (now - last < 5000) {
      return NextResponse.json({ ok: true, deduped: true, serverTime: now });
    }
    lastSosAt.set(key, now);
    if (lastSosAt.size > 500) lastSosAt.clear();
    await store.appendEntry(body.session.toUpperCase(), {
      id: `iot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      gesture: "EMERGENCY",
      description: "EMERGENCY \u2014 SOS button pressed on wearable device",
      confidence: 1,
      type: "system",
      timestamp: Date.now(),
      language: "en-US",
      source: "iot",
      escalated: true,
      escalatedBy: "system",
    });
    return NextResponse.json({ ok: true, serverTime: Date.now() });
  }

  if (body.type === "vitals") {
    await store.setVitals(body.session.toUpperCase(), {
      deviceId,
      heartRate: num(body.heartRate),
      spo2: num(body.spo2),
      temperature: num(body.temperature),
      batteryPct: num(body.batteryPct),
      rssi: num(body.rssi),
      sosActive: !!body.sosActive,
      receivedAt: now,
    });
    return NextResponse.json({ ok: true, serverTime: now });
  }

  return NextResponse.json({ ok: false, error: "Unknown type" }, { status: 400 });
}
