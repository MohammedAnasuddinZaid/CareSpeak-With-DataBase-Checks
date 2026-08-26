/**
 * QR pairing registry — per-session unique pairing tokens + scan tracking.
 *
 * Every patient console generates a cryptographically-random pairing token and
 * bakes it into its QR code (`?session=X&pair=TOKEN`), so each bed's QR is
 * UNIQUE even though the dashboard origin is shared. When any device scans the
 * code, it reports back here with its IP + user-agent; the patient console (and
 * the ward board) can then see exactly which device is linked to which bed.
 *
 * Storage is in-memory with a 24h TTL: pairing metadata is ephemeral by design
 * (the session ID itself remains the sync key). Bounded per session — a ward
 * of busy beds can't grow this without limit.
 */
import { PairScanInfo } from "@/types";

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCANS_PER_SESSION = 20;
const MAX_SESSIONS = 2000;

interface PairRecord {
  token: string;
  registeredAt: number;
  scans: PairScanInfo[];
}

const g = globalThis as unknown as { __carespeakPairing?: Map<string, PairRecord> };
const registry: Map<string, PairRecord> = (g.__carespeakPairing ??= new Map());

function prune(): void {
  const cutoff = Date.now() - SCAN_TTL_MS;
  for (const [session, rec] of registry) {
    if (rec.registeredAt < cutoff && rec.scans.every((s) => s.at < cutoff)) {
      registry.delete(session);
      continue;
    }
    rec.scans = rec.scans.filter((s) => s.at >= cutoff);
  }
  // hard cap so junk sessions can't balloon memory
  while (registry.size > MAX_SESSIONS) {
    const oldest = registry.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

/** Patient console calls this on mount: registers (or re-affirms) its token. */
export function registerPairToken(session: string, token: string): boolean {
  if (!token || token.length > 64) return false;
  prune();
  const existing = registry.get(session);
  if (existing) {
    existing.registeredAt = Date.now();
    return existing.token === token;
  }
  registry.set(session, { token, registeredAt: Date.now(), scans: [] });
  return true;
}

/** Replace the current token — old QR links stop registering scans instantly. */
export function rotatePairToken(session: string): string | null {
  const rec = registry.get(session);
  if (!rec) return null;
  const token = crypto.randomUUID().replace(/-/g, "");
  rec.token = token;
  rec.registeredAt = Date.now();
  return token;
}

export function verifyPairToken(session: string, token: string): boolean {
  const rec = registry.get(session);
  return !!rec && !!token && rec.token === token;
}

/** Whether this session has ever registered a pairing token. */
export function hasRegistration(session: string): boolean {
  return registry.has(session);
}

function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || headers.get("cf-connecting-ip")?.trim() || "local";
}

/** A scanning device reports itself. Requires the token from the QR itself,
 *  so arbitrary third parties can't poison a bed's scan log. */
export function recordScan(
  session: string,
  token: string,
  role: string,
  userAgent: string | null,
  headers: Headers
): PairScanInfo | null {
  if (!verifyPairToken(session, token)) return null;
  const scan: PairScanInfo = {
    at: Date.now(),
    ip: clientIp(headers),
    device: (userAgent ?? "unknown").replace(/[^\w ./()+-]/g, "").slice(0, 80),
    role: role.slice(0, 16),
  };
  const rec = registry.get(session)!;
  rec.scans.unshift(scan);
  if (rec.scans.length > MAX_SCANS_PER_SESSION) rec.scans.length = MAX_SCANS_PER_SESSION;
  return scan;
}

export function getScans(session: string): PairScanInfo[] {
  return registry.get(session)?.scans ?? [];
}

/** Compact summary for ward tiles / patient consoles. */
export function getPairSummary(session: string): {
  linkedDevices: number;
  lastScanAt: number | null;
  lastScanIp: string | null;
} {
  const scans = getScans(session);
  return {
    linkedDevices: new Set(scans.map((s) => s.ip)).size,
    lastScanAt: scans[0]?.at ?? null,
    lastScanIp: scans[0]?.ip ?? null,
  };
}
