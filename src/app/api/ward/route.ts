import { NextResponse } from "next/server";
import { wardSnapshot } from "@/lib/server/clinical";
import { requireStaff } from "@/lib/server/auth";
import { handleError } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Multi-patient ward overview — the single widest read in the product.
 *
 * One call returns every live bed with its last gesture, heart rate, SpO₂, SOS
 * state, unacknowledged count, and the IP of the last pairing scan. Anonymous,
 * that hands a stranger the entire ward, so it requires a clinical account.
 *
 * Now backed by MySQL rather than the process-local store, which means the board
 * survives a restart, is correct across multiple server instances, and can be
 * scoped: a nurse sees the beds of patients they are actively assigned to, while
 * an admin sees everything. The previous version was one blanket staff check that
 * ignored assignment entirely.
 */
export async function GET(): Promise<NextResponse> {
  let user;
  try {
    user = await requireStaff();
  } catch (err) {
    return handleError(err);
  }

  const sessions = await wardSnapshot(user);
  return NextResponse.json(
    { sessions, serverTime: Date.now(), driver: "mysql" as const },
    { headers: { "Cache-Control": "no-store" } },
  );
}
