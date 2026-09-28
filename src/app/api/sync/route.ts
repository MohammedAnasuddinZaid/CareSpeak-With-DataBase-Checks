import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  appendGesture,
  authorizeRead,
  getOrCreateSession,
  normalizeCode,
  readSnapshot,
  setEntryStatus,
  setMetrics,
  setReply,
  setVitals,
  verifyConsoleToken,
} from "@/lib/server/clinical";
import { clampFinite } from "@/lib/server/vitals";
import { publishConsoleEvent } from "@/lib/server/publish";
import { getCurrentUser, isStaff, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { AlertAction, DeviceVitals, GestureLogEntry, NurseReply, PatientMetrics } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Actions only clinical staff may perform on a patient's record. */
const CLINICAL_ACTIONS = new Set(["acknowledge", "escalate", "resolve", "reply"]);

const GESTURES = new Set(["YES", "NO", "HELP", "WATER", "HELLO", "EMERGENCY", "SYSTEM"]);

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * The console credential, if this browser holds one.
 *
 * HttpOnly means script can never read it, so it rides along automatically and
 * there is no client-side token handling to get wrong or exfiltrate.
 */
async function consoleToken(): Promise<string | null> {
  return (await cookies()).get("cs_console")?.value ?? null;
}

/** Fall back to a header so a kiosk build can present the token explicitly. */
function tokenHeader(request: NextRequest): string | null {
  const h = request.headers.get("x-console-token");
  return h && h.length >= 16 && h.length <= 128 ? h : null;
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

/**
 * Read a session's clinical record.
 *
 * Previously this returned vitals, alerts and nurse messages to anyone who
 * guessed a bed code — a real PHI disclosure with no credential at all. It now
 * requires either the console token for that specific bed or a staff account
 * with an assignment to that patient.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const session = normalizeCode(searchParams.get("session"));
  if (!session) return bad("Invalid session");

  const since = Number(searchParams.get("since") ?? "0");
  const cursor = isFinite(since) ? since : 0;

  const token = tokenHeader(request) ?? (await consoleToken());
  const user = await getCurrentUser();
  const { auth, session: resolved } = await authorizeRead(session, token, user);

  if (!auth.ok) {
    return auth.reason === "unauthenticated"
      ? bad("Sign in to view this patient's record.", 401)
      : bad("You are not assigned to this patient.", 403);
  }
  if (!resolved) return bad("This bed console is not provisioned.", 403);

  const snap = await readSnapshot(resolved.id, cursor);
  return NextResponse.json(
    { ...snap, serverTime: Date.now(), driver: "mysql" as const },
    { headers: { "Cache-Control": "no-store" } },
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
  bySystem?: boolean;
  vitals?: Omit<DeviceVitals, "receivedAt">;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as SyncBody | null;
  if (!body || typeof body.type !== "string") return bad("Invalid request");

  const code = normalizeCode(body.sessionId ?? "default");
  if (!code) return bad("Invalid session");

  const token = tokenHeader(request) ?? (await consoleToken());
  const user = await getCurrentUser();

  // Acknowledging, escalating, resolving and replying are clinical acts on
  // someone else's record. A bedside console must not be able to acknowledge
  // itself, and an anonymous caller must not be able to close an alert or forge a
  // nurse reply that the patient will read on screen.
  if (CLINICAL_ACTIONS.has(body.type)) {
    if (!user) return bad("Sign in to perform this action.", 401);
    if (!isStaff(user)) return bad("Your role does not permit this action.", 403);
  }

  // Reads and clinical actions both go through the same authorisation gate, so a
  // nurse who is not assigned to this patient cannot touch it by guessing a code
  // any more than they can read it.
  const { auth, session } = await authorizeRead(code, token, user);
  if (!auth.ok) {
    if (CLINICAL_ACTIONS.has(body.type)) {
      return bad(
        auth.reason === "unauthenticated" ? "Sign in to perform this action." : "You are not assigned to this patient.",
        auth.reason === "unauthenticated" ? 401 : 403,
      );
    }
    // Device writes (gesture/metrics/vitals) are refused rather than silently
    // creating a session: an unknown bed code means a misconfigured device, and
    // auto-creating rows for arbitrary codes is how junk got into the store.
    return bad("This bed console is not provisioned.", 403);
  }
  if (!session) return bad("This bed console is not provisioned.", 403);

  switch (body.type) {
    case "new_gesture": {
      const entry = sanitizeEntry(body.entry);
      if (!entry) return bad("Invalid entry payload");
      const { created } = await appendGesture(session, entry);
      publishConsoleEvent(code, "gesture", { id: entry.id, gesture: entry.gesture });
      return NextResponse.json({ ok: true, serverTime: Date.now(), created });
    }
    case "acknowledge":
    case "escalate":
    case "resolve": {
      if (typeof body.entryId !== "string" || body.entryId.length === 0 || body.entryId.length > 64)
        return bad("Invalid entryId");
      const changed = await setEntryStatus(session, body.entryId, body.type, user, body.bySystem === true);
      if (!changed) return bad("That entry no longer exists.", 404);
      // Durable: a missed acknowledgement is a missed clinical action, and the
      // closed-loop escalation chain depends on every viewer agreeing.
      publishConsoleEvent(code, "status", { entryId: body.entryId, action: body.type }, { durable: true });
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
      await setMetrics(session.id, (body.deviceId ?? "unknown").slice(0, 64), clean);
      // Metrics arrive several times a second from the camera loop, so this is
      // the one hot path that stays non-durable; the subscriber coalesces.
      publishConsoleEvent(code, "metrics", clean);
      return NextResponse.json({ ok: true });
    }
    case "vitals": {
      const v = body.vitals;
      if (!v || typeof v.deviceId !== "string") return bad("Invalid vitals");
      await setVitals(session, { ...v, deviceId: v.deviceId.slice(0, 64), receivedAt: Date.now() });
      publishConsoleEvent(code, "vitals", { deviceId: v.deviceId.slice(0, 64) });
      return NextResponse.json({ ok: true, serverTime: Date.now() });
    }
    case "reply": {
      const r = body.reply;
      if (!r || typeof r.text !== "string" || r.text.trim().length === 0 || r.text.length > 200)
        return bad("Invalid reply");
      if (!user) return bad("Sign in to send a message.", 401);
      const reply: NurseReply = {
        id: r.id?.slice(0, 64) ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: r.text.trim(),
        lang: r.lang?.slice(0, 10) ?? "en-US",
        from: r.from?.slice(0, 40) ?? "Nurse",
        timestamp: Date.now(),
      };
      const { created } = await setReply(session, reply, user);
      const meta = await requestMeta();
      await recordAudit({
        actorId: user.id,
        actorRole: user.role,
        action: "message.send",
        entityType: "console_session",
        entityId: session.id,
        detail: { session: code, lang: reply.lang, chars: reply.text.length },
        ...meta,
      });
      // This is the path that used to feel slow. Durable, because a reply the
      // patient never receives is a patient left unable to ask for help.
      publishConsoleEvent(code, "reply", reply, { durable: true });
      return NextResponse.json({ ok: true, serverTime: reply.timestamp, created });
    }
    default:
      return bad("Unknown type");
  }
}
