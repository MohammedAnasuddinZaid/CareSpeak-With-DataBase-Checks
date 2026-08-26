import { NextRequest, NextResponse } from "next/server";
import {
  registerPairToken,
  rotatePairToken,
  recordScan,
  getPairSummary,
  getScans,
  verifyPairToken,
  hasRegistration,
} from "@/lib/server/pairing";

export const dynamic = "force-dynamic";

function valid(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z0-9_-]{3,32}$/.test(s.toUpperCase());
}

/**
 * QR pairing + scan tracking.
 *
 * POST { action: "register", session, pair }        — patient console mounts
 * POST { action: "rotate",   session, pair }        — regenerate the QR token
 * POST { action: "scan",     session, pair, role? } — a device just scanned the QR
 * GET  /api/pair?session=X&pair=T                   — pairing status + scan log
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    session?: string;
    pair?: string;
    role?: string;
  } | null;

  if (!body || !valid(body.session)) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }
  const session = body.session.toUpperCase();
  const pair = typeof body.pair === "string" ? body.pair : "";

  switch (body.action) {
    case "register": {
      const ok = registerPairToken(session, pair);
      return NextResponse.json({ ok, serverTime: Date.now() });
    }
    case "rotate": {
      const token = rotatePairToken(session);
      if (!token) return NextResponse.json({ ok: false, error: "Not registered" }, { status: 404 });
      return NextResponse.json({ ok: true, pair: token, serverTime: Date.now() });
    }
    case "scan": {
      const scan = recordScan(
        session,
        pair,
        (body.role ?? "nurse").replace(/[^a-z]/gi, "").slice(0, 16) || "device",
        req.headers.get("user-agent"),
        req.headers
      );
      if (!scan) return NextResponse.json({ ok: false, error: "Invalid pairing token" }, { status: 403 });
      return NextResponse.json({ ok: true, summary: getPairSummary(session), serverTime: Date.now() });
    }
    default:
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("session");
  if (!raw || !valid(raw)) {
    return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  }
  const session = raw.toUpperCase();
  const pair = searchParams.get("pair") ?? "";
  // Scan details require the pairing token; the anonymous summary is harmless.
  const authorized = pair.length > 0 && verifyPairToken(session, pair);
  return NextResponse.json(
    {
      ok: true,
      registered: hasRegistration(session),
      summary: getPairSummary(session),
      ...(authorized ? { scans: getScans(session) } : {}),
      serverTime: Date.now(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
