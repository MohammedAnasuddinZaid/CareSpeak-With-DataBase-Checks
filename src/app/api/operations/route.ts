import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/server/auth";
import { handleError } from "@/lib/server/http";
import { wardOperations } from "@/lib/server/operations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Ward operations command: staff-response SLA, rounding/repositioning task
 * compliance, medication adherence and the repositioning watch.
 *
 * `GET /api/operations` → ward-wide, clinical account only. A nurse sees their
 * own scoreboard row plus the beds they are assigned to; admins see all rows.
 */
export async function GET(): Promise<NextResponse> {
  let user;
  try {
    user = await requireStaff();
  } catch (err) {
    return handleError(err);
  }
  try {
    const ops = await wardOperations(user);
    return NextResponse.json(
      { ok: true, ...ops },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleError(err);
  }
}