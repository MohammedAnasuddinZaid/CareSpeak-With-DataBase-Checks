/**
 * GET /api/me/history -- the signed-in patient's own record, across sessions.
 *
 * This is what makes "log in and see my previous data" true. The console-scoped
 * readers in clinical.ts answer "what has this bedside device seen since it was
 * switched on"; a patient who has closed the tab, or come back on a different
 * device, has neither that session code nor that device id, so nothing scoped to
 * the session can find their history. This reads by `patient_id` instead, which
 * is the one identifier that survives.
 *
 * Authorisation is deliberately narrow and is not re-implemented here:
 * `requireRole("patient")` proves there is a signed-in patient, and the id it
 * returns is used as the *only* value in the WHERE clause. There is no
 * `?patientId=` parameter to tamper with, so there is no path from this handler
 * to another patient's row — the only way to read someone else's history is to
 * be staff on a clinical screen, which is a different endpoint by design.
 */
import { requireRole } from "@/lib/server/auth";
import { readPatientHistory } from "@/lib/server/clinical";
import { handleError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireRole("patient");
    const history = await readPatientHistory(user.id);
    // `json()` already sets `cache-control: no-store`, which is what a patient's
    // own record needs: it must not sit in a shared cache, or in the bfcache
    // after sign-out.
    return json({ ok: true, ...history });
  } catch (err) {
    return handleError(err);
  }
}
