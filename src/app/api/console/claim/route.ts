import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getOrCreateSession,
  isSessionReadable,
  mintViewerCredential,
  normalizeCode,
  verifyConsoleToken,
} from "@/lib/server/clinical";
import { env } from "@/lib/server/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `Secure` is decided by the origin the app actually serves over, not by
 * `NODE_ENV`. A production build (npm start) served over LAN HTTP is the common
 * demo path here -- phones scan a QR that points at `http://192.168.x.x:3000`.
 * If the flag were `NODE_ENV === "production"` the phone browser would silently
 * reject the cookie over plain HTTP, and every subsequent /api/sync and
 * /api/stream request would arrive without the console credential and 401 in an
 * endless reconnect loop. Match the auth cookies: Secure only when the app is
 * truly served over HTTPS.
 */
const COOKIE_SECURE = env.appOrigin.startsWith("https://");
const COOKIE_SAME_SITE = "lax" as const;
const COOKIE_MAX_AGE = 12 * 60 * 60;

/**
 * Console credential claim.
 *
 * The session code in a bed's QR is what opens the bed: scanning the QR or
 * typing the code is enough to view the live record, no sign-in required.
 * Login is reserved for clinical ACTIONS (acknowledge / escalate / resolve /
 * reply) and history, not for reading the current bed.
 *
 * The read credential is a fresh 256-bit token stored in an HttpOnly cookie
 * that the browser attaches automatically and script cannot read. Every device
 * that presents a valid code gets its OWN credential:
 *
 *   - A brand-new session is created on first sight and the caller's token is
 *     stored as the session's primary credential (`console_sessions.console_token_hash`).
 *   - An existing session (the bedside console already claimed it) mints a
 *     second credential in `console_viewers` for this browser. The bedside
 *     console's original token is untouched, so it keeps working, and every
 *     other phone that scans the same QR gets its own copy.
 *
 * Repeating a claim while already holding a valid token for *this* session is a
 * no-op. An invalid code is refused, and an expired or ended session cannot be
 * claimed because reads are refused at verification time.
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

  // Already holding a valid token for *this* session: refresh nothing, mint
  // nothing. This must verify against the session, not merely check that a
  // cookie is present -- a console holding bed A's token would otherwise walk
  // into bed B and be told it was already provisioned.
  if (held && (await verifyConsoleToken(code, held))) {
    return NextResponse.json({ ok: true, session: code, issued: false });
  }

  const { session, token, created } = await getOrCreateSession(code);

  // Refuse a bed that can never be read, BEFORE any credential is minted.
  //
  // `getOrCreateSession` finds the row for a code whether or not it is still
  // live, so for an ended or expired session it returns that dead row with
  // `token: null` and `created: false`. Falling straight through to
  // `mintViewerCredential` there produced the worst possible failure: a 200 with
  // a fresh cookie for a session whose every read is refused with 401. The
  // console believed it had paired, opened /api/stream, and then had nothing but
  // 401s to show for it -- so it sat on "Reconnecting…" for the rest of the
  // shift, retrying a link that was never going to open, with no error anywhere
  // to explain why. Re-pairing the live bed (which mints a new code) is the only
  // way out, so that is what the response now says.
  if (!(await isSessionReadable(session.id))) {
    return NextResponse.json(
      { ok: false, error: "This bed session has ended. Scan the current QR code to pair again." },
      { status: 403 },
    );
  }

  if (!created || !token) {
    // The session is already claimed by another device (usually the bedside
    // console). That is not a dead end for the scanning nurse: mint this
    // browser its own viewer credential so the view just works.
    const fresh = await mintViewerCredential(session.id);
    jar.set("cs_console", fresh, {
      httpOnly: true,
      sameSite: COOKIE_SAME_SITE,
      secure: COOKIE_SECURE,
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
    return NextResponse.json({ ok: true, session, id: session.id, issued: true, rotated: false });
  }

  jar.set("cs_console", token, {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
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