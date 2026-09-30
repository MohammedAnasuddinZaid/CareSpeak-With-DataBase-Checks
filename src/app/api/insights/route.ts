import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorizeRead, normalizeCode } from "@/lib/server/clinical";
import { sessionInsight, wardInsight } from "@/lib/server/insights";
import { getCurrentUser, requireStaff } from "@/lib/server/auth";
import { handleError } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The console credential, if this browser holds one (HttpOnly cookie). */
async function consoleToken(): Promise<string | null> {
  return (await cookies()).get("cs_console")?.value ?? null;
}

/** Fall back to a header so a kiosk build can present the token explicitly. */
function tokenHeader(request: NextRequest): string | null {
  const h = request.headers.get("x-console-token");
  return h && h.length >= 16 && h.length <= 128 ? h : null;
}

/**
 * Care-flow analysis (PNH1): how long a patient's need sat before a nurse
 * acknowledged, escalated or resolved it.
 *
 * `GET /api/insights?session=CODE` → one bed, using the bedside console
 * credential (no sign-in needed, exactly like the sync read).
 * `GET /api/insights` → ward-wide, clinical account only, like the ward board.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = normalizeCode(searchParams.get("session"));

  if (code) {
    const token = tokenHeader(request) ?? (await consoleToken());
    const user = await getCurrentUser();
    const { auth, session } = await authorizeRead(code, token, user);

    if (!auth.ok) {
      return auth.reason === "unauthenticated"
        ? NextResponse.json(
            { ok: false, error: "Sign in to view this bed's care flow." },
            { status: 401 },
          )
        : NextResponse.json(
            { ok: false, error: "You are not assigned to this patient." },
            { status: 403 },
          );
    }
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "This bed console is not provisioned." },
        { status: 403 },
      );
    }
    const insight = await sessionInsight(session);
    return NextResponse.json(
      { ok: true, ...insight },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let user;
  try {
    user = await requireStaff();
  } catch (err) {
    return handleError(err);
  }
  const insight = await wardInsight(user);
  return NextResponse.json(
    { ok: true, ...insight },
    { headers: { "Cache-Control": "no-store" } },
  );
}