import { NextRequest, NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";
import { sanitizeVitals, clampFinite } from "@/lib/server/vitals";
import { AlertAction, DeviceVitals, GestureLogEntry, NurseReply, PatientMetrics } from "@/types";

export const dynamic = "force-dynamic";

const GESTURES = new Set(["YES", "NO", "HELP", "WATER", "HELLO", "EMERGENCY", "SYSTEM"]);

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Sessions are case-insensitive everywhere: ingest uppercases silently while
 *  sync/stream used to hard-reject lowercase — a mixed-case ID produced a
 *  wearable that "worked" with dashboards that showed nothing. */
function normalizeSession(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z0-9_-]{3,32}$/.test(s.toUpperCase());
}

function sanitizeEntry(raw: unknown): GestureLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<GestureLogEntry>;
  if (typeof e.id !== "string" || e.id.length > 64) return null;
  if (typeof e.gesture !== "string" || !GESTURES.has(e.gesture)) return null;
  if (typeof e.confidence !== "number" || !isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) return null;
  if (typeof e.timestamp !== "number" || !isFinite(e.timestamp)) return null;
  return {
    id: e.id,
    gesture: e.gesture,
    description: typeof e.description === "string" ? e.description.slice(0, 300) : "",
    confidence: e.confidence,
    type: e.type === "eye" ? "eye" : e.type === "system" ? "system" : "hand",
    timestamp: Math.min(e.timestamp, Date.now() + 5000),
    language: typeof e.language === "string" ? e.language.slice(0, 10) : "en-US",
    source: e.source === "demo" || e.source === "iot" || e.source === "manual" || e.source === "system" ? e.source : "camera",
    escalated: !!e.escalated,
    escalatedBy: e.escalatedBy === "system" ? "system" : undefined,
    sessionId: undefined,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const rawSession = searchParams.get("session");
  if (!rawSession || !normalizeSession(rawSession)) return bad("Invalid session");
  const session = rawSession.toUpperCase();

  const since = Number(searchParams.get("since") ?? "0");
  const store = await getSessionStore();
  const [entries, patientMetrics, vitals, replies] = await Promise.all([
    store.getEntriesSince(session, isFinite(since) ? since : 0),
    store.getMetrics(session),
    store.getVitals(session),
    store.getRepliesSince(session, isFinite(since) ? Math.max(since - 60000, 0) : 0),
  ]);

  return NextResponse.json(
    { entries, patientMetrics, vitals, replies, serverTime: Date.now(), driver: store.driver },
    { headers: { "Cache-Control": "no-store" } }
  );
}

interface SyncBody {
  type?: string;
  sessionId?: string;
  entry?: GestureLogEntry;
  entryId?: string;
  action?: AlertAction;
  patientMetrics?: PatientMetrics;
  reply?: NurseReply;
  deviceId?: string;
  vitals?: Omit<DeviceVitals, "receivedAt">;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as SyncBody | null;
  if (!body || typeof body.type !== "string") return bad("Invalid request");
  if (body.sessionId !== undefined && !normalizeSession(body.sessionId)) return bad("Invalid session");
  const session = body.sessionId?.toUpperCase() ?? "default";
  const store = await getSessionStore();

  switch (body.type) {
    case "new_gesture": {
      const entry = sanitizeEntry(body.entry);
      if (!entry) return bad("Invalid entry payload");
      await store.appendEntry(session, entry);
      return NextResponse.json({ ok: true, serverTime: Date.now() });
    }
    case "acknowledge":
    case "escalate":
    case "resolve": {
      if (typeof body.entryId !== "string" || body.entryId.length === 0 || body.entryId.length > 64)
        return bad("Invalid entryId");
      await store.setStatus(session, body.entryId, body.type);
      return NextResponse.json({ ok: true, serverTime: Date.now() });
    }
    case "metrics": {
      const m = body.patientMetrics;
      if (!m || typeof m !== "object") return bad("Invalid metrics");
      // NaN passes `typeof === "number"` and used to be stored verbatim — a NaN
      // alertnessScore silently disabled the low-alertness escalation rule.
      const clean: PatientMetrics = {};
      const blinkRate = clampFinite(m.blinkRate, 0, 500);
      if (blinkRate !== undefined) clean.blinkRate = blinkRate;
      const alertness = clampFinite(m.alertnessScore, 0, 100);
      if (alertness !== undefined) clean.alertnessScore = alertness;
      const closure = clampFinite(m.eyeClosureDuration, 0, 6 * 60 * 60 * 1000);
      if (closure !== undefined) clean.eyeClosureDuration = closure;
      const movement = clampFinite(m.movementActivity, 0, 1);
      if (movement !== undefined) clean.movementActivity = movement;
      await store.setMetrics(session, (body.deviceId ?? "unknown").slice(0, 64), clean);
      return NextResponse.json({ ok: true });
    }
    case "vitals": {
      const v = body.vitals;
      if (!v || typeof v.deviceId !== "string") return bad("Invalid vitals");
      await store.setVitals(session, {
        deviceId: v.deviceId.slice(0, 64),
        ...sanitizeVitals(v),
        receivedAt: Date.now(),
      });
      return NextResponse.json({ ok: true, serverTime: Date.now() });
    }
    case "reply": {
      const r = body.reply;
      if (!r || typeof r.text !== "string" || r.text.trim().length === 0 || r.text.length > 200)
        return bad("Invalid reply");
      await store.setReply(session, {
        id: r.id?.slice(0, 64) ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: r.text.trim(),
        lang: r.lang?.slice(0, 10) ?? "en-US",
        from: r.from?.slice(0, 40) ?? "Nurse",
        timestamp: Date.now(),
      });
      return NextResponse.json({ ok: true, serverTime: Date.now() });
    }
    default:
      return bad("Unknown type");
  }
}
