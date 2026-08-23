import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOLDOWN_MS = 120_000;
const lastSent = new Map<string, number>();

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
  if (!/^[A-Z0-9_-]{3,32}$/.test(body.session.toUpperCase())) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }

  // Never spam families/staff: one dispatch per session+gesture per 2 minutes.
  const key = `${body.session}:${body.gesture}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < COOLDOWN_MS) {
    return NextResponse.json({ ok: true, suppressed: true });
  }
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.clear();

  const contacts = (body.contacts ?? []).filter((c) => /^[+0-9]{8,15}$/.test(c)).slice(0, 5);
  const message =
    `🚨 CareSpeak ALERT: Patient ${body.patient ?? body.session} raised ${body.gesture} ` +
    `and it is unacknowledged. Console: ${req.headers.get("origin") ?? ""}/nurse-view?session=${body.session}`;

  if (process.env.MSG91_AUTH_KEY && contacts.length > 0) {
    try {
      await fetch("https://control.msg91.com/api/v5/flow/", {
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
      return NextResponse.json({ ok: true, provider: "msg91", dispatched: contacts.length });
    } catch {
      return NextResponse.json({ ok: false, provider: "msg91", error: "dispatch failed" }, { status: 502 });
    }
  }

  // Demo mode — the chain is fully observable in logs without any keys.
  console.log(`[notify] would dispatch to ${contacts.length || 0} contact(s):`, message);
  return NextResponse.json({ ok: true, provider: "logging-only", dispatched: contacts.length });
}
