import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOLDOWN_MS = 120_000;
const MAX_TRACKED_KEYS = 500;
const lastSent = new Map<string, number>();

/** Origin headers are client-controlled — never echo them raw into SMS text. */
function safeOrigin(h: string | null): string {
  if (!h) return "";
  try {
    return new URL(h).origin;
  } catch {
    return "";
  }
}

/** Evict the OLDEST throttle entries (insertion order) instead of bulk-clearing,
 *  which previously let an attacker reset every legitimate cooldown by spraying
 *  junk sessions. */
function evictOldest(): void {
  while (lastSent.size > MAX_TRACKED_KEYS) {
    const oldest = lastSent.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastSent.delete(oldest);
  }
}

const KNOWN_GESTURES = new Set(["YES", "NO", "HELP", "WATER", "HELLO", "EMERGENCY", "SYSTEM"]);

/**
 * Escalation-chain dispatcher. Called by the nurse console when an EMERGENCY
 * sits unacknowledged for 60s. With MSG91 credentials configured it sends a
 * WhatsApp-template/SMS message to each contact; without keys it logs the
 * dispatch (demo mode) so the full chain is still visible end-to-end.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    session?: string;
    patient?: string;
    gesture?: string;
    contacts?: string[];
  } | null;

  if (!body?.session || !body.gesture) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const session = body.session.toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(session)) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }
  // Whitelist the gesture and clamp patient text — both are interpolated into
  // provider template variables and drive real messaging costs.
  const gesture = KNOWN_GESTURES.has(body.gesture) ? body.gesture : "EMERGENCY";
  const patient = (body.patient ?? session).slice(0, 40);

  // Never spam families/staff: one dispatch per session+gesture per 2 minutes.
  // Key on the NORMALIZED case ("abc"/"ABC" used to bypass the throttle).
  const key = `${session}:${gesture}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < COOLDOWN_MS) {
    return NextResponse.json({ ok: true, suppressed: true });
  }
  evictOldest();

  const contacts = (body.contacts ?? []).filter((c) => /^[+0-9]{8,15}$/.test(c)).slice(0, 5);
  const message =
    `🚨 CareSpeak ALERT: Patient ${patient} raised ${gesture} ` +
    `and it is unacknowledged. Console: ${safeOrigin(req.headers.get("origin"))}/nurse-view?session=${session}`;

  if (process.env.MSG91_AUTH_KEY && contacts.length > 0) {
    try {
      const res = await fetch("https://control.msg91.com/api/v5/flow/", {
        method: "POST",
        headers: {
          authkey: process.env.MSG91_AUTH_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template_id: process.env.MSG91_TEMPLATE_ID ?? "",
          short_urls: "0",
          recipients: contacts.map((mobiles) => ({ mobiles, MESSAGE: message })),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // Cooldown is recorded ONLY on success: a provider blip must not
      // suppress retries during a real, unacknowledged emergency.
      lastSent.set(key, now);
      return NextResponse.json({ ok: true, provider: "msg91", dispatched: contacts.length });
    } catch {
      return NextResponse.json({ ok: false, provider: "msg91", error: "dispatch failed" }, { status: 502 });
    }
  }

  // Demo mode — the chain is fully observable in logs without any keys.
  console.log(`[notify] would dispatch to ${contacts.length || 0} contact(s):`, message);
  lastSent.set(key, now);
  return NextResponse.json({ ok: true, provider: "logging-only", dispatched: contacts.length });
}
