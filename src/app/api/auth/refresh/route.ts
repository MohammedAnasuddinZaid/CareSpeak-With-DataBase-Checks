/**
 * POST /api/auth/refresh -- rotate the session.
 *
 * Called by the client on load and on a 401, so it is the one route that runs
 * while unauthenticated by design. It is safe because the refresh token lives in
 * an httpOnly cookie scoped to /api/auth: a cross-site request cannot read it,
 * and SameSite=Lax keeps it off cross-origin subrequests.
 */
import { refreshSession, requestMeta } from "@/lib/server/auth";
import { handleError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await refreshSession(await requestMeta());
    if (!user) {
      // 200 with `user: null` rather than 401. This is a normal poll, and a 401
      // here would trip the client's global sign-out handler on every anonymous
      // page view.
      return json({ user: null });
    }
    return json({ user });
  } catch (err) {
    return handleError(err);
  }
}
