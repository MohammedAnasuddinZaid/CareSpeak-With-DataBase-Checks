/**
 * POST /api/auth/logout -- end the current session, or every session.
 */
import { getCurrentUser, signOut, requestMeta } from "@/lib/server/auth";
import { recordAudit } from "@/lib/server/audit";
import { handleError, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const meta = await requestMeta();
    // Read the user before clearing: after signOut the access cookie is gone.
    const user = await getCurrentUser();
    const allDevices = (await readJson<{ allDevices?: unknown }>(request)).allDevices === true;

    await signOut(allDevices);

    if (user) {
      await recordAudit({
        actorId: user.id,
        actorRole: user.role,
        action: allDevices ? "auth.logout_all" : "auth.logout",
        entityType: "user",
        entityId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
