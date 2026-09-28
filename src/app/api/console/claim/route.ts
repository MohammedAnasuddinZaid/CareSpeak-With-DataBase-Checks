import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getOrCreateSession, normalizeCode, verifyConsoleToken } from "@/lib/server/clinical";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Console credential claim.
 *
 * The session code in a bed's QR code is a *public handle*, not a credential —
 * anyone who photographs the QR must not be able to read that patient's vitals.
 * So the read credential is a separate 256-bit token kept in an HttpOnly cookie
 * that the browser attaches automatically and script cannot read.
 *
 * This endpoint is the provisioning step, and it is deliberately narrow:
 *
 *   - Minting only happens when the session does not exist yet. That is the
 *     bedside console claiming its own bed for the first time, where there is
 *     nothing yet to steal.
 *   - An existing session is NOT re-mintable anonymously, or anyone could call
 *     this against a known bed code and lock the real console out while reading
 *     the record with the token they just received.
 *   - Rotation requires either the current token or a staff account, and both
 *     audit the change.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { session?: unknown } | null = null;
  try {
    body = (await request.json()) as { session?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  const code = normalizeCode(body?.session);
  if (!code) return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });

  const jar = await cookies();
  const held = jar.get("cs_console")?.value ?? null;

  // Already holding a valid token for *this* session: refresh it, mint nothing.
  // This must verify the token against the session, not merely check that a
  // cookie is present -- a console holding bed A's token would otherwise walk
  // into bed B and be told it was already provisioned, which is a confusing way
  // to learn the truth.
  if (held && (await verifyConsoleToken(code, held))) {
    return NextResponse.json({ ok: true, session: code, issued: false });
  }

  const { session, token, created } = await getOrCreateSession(code);

  if (!created || !token) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This bed console is already provisioned. Sign in as staff to re-pair it, or restore the original browser profile.",
      },
      { status: 409 },
    );
  }

  jar.set("cs_console", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });

  return NextResponse.json({ ok: true, session, id: session.id, issued: true });
}

/**
 * Lets a console UI tell "provisions fine" from "needs re-pairing" without guessing.
 *
 * The answer must reflect whether the *presented* token actually authorises the
 * *requested* session. Checking only that some cookie is present was wrong in
 * both directions: a console holding another bed's token was told it was
 * authorised here, and a console whose token had been rotated away was told the
 * opposite.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const code = normalizeCode(new URL(request.url).searchParams.get("session"));
  if (!code) return NextResponse.json({ ok: false, error: "Invalid session" }, { status: 400 });
  const held = (await cookies()).get("cs_console")?.value ?? null;
  if (!held) return NextResponse.json({ ok: false, authorized: false }, { status: 401 });
  const session = await verifyConsoleToken(code, held);
  if (!session) return NextResponse.json({ ok: false, authorized: false }, { status: 401 });
  return NextResponse.json({ ok: true, authorized: true, session: code, id: session.id });
}
