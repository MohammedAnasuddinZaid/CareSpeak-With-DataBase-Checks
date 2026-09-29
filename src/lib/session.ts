import { SessionInfo } from "@/types";

const SESSION_KEY = "carespeak_session";
const DEVICE_KEY = "carespeak_device_id";
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous I,O,0,1

function randomId(length = 6): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function generateDeviceId(): string {
  if (typeof window !== "undefined") {
    try {
      const existing = localStorage.getItem(DEVICE_KEY);
      if (existing) return existing;
    } catch {}
  }
  const id = `device_${Date.now().toString(36)}_${randomId(6).toLowerCase()}`;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {}
  }
  return id;
}

export function getOrCreateSession(): SessionInfo {
  if (typeof window === "undefined") {
    return { sessionId: randomId(), deviceId: "server", createdAt: Date.now() };
  }
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as SessionInfo;
      if (parsed.sessionId && parsed.deviceId) return parsed;
    }
  } catch {}
  const session: SessionInfo = {
    sessionId: randomId(),
    deviceId: generateDeviceId(),
    createdAt: Date.now(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
  return session;
}

/** Pair this device to an existing session (QR scan / manual entry) */
export function setSessionId(sessionId: string): SessionInfo {
  const clean = sessionId.trim().toUpperCase();
  const session: SessionInfo = {
    sessionId: clean,
    deviceId: generateDeviceId(),
    createdAt: Date.now(),
  };
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {}
  }
  return session;
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

export function getSession(): SessionInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) return JSON.parse(stored) as SessionInfo;
  } catch {}
  return null;
}

const ORIGIN_KEY = "carespeak_dashboard_origin";

/**
 * Origin used inside pairing URLs / QR codes. Defaults to the current origin,
 * but when the patient device is on localhost the QR would be useless for
 * other devices — the user can persist a reachable origin (e.g. http://192.168.1.5:3000).
 */
export function getDashboardOrigin(): string {
  if (typeof window === "undefined") return "";
  try {
    const saved = localStorage.getItem(ORIGIN_KEY);
    if (saved && /^https?:\/\//.test(saved)) return saved.replace(/\/+$/, "");
  } catch {}
  return window.location.origin;
}

export function setDashboardOrigin(origin: string): void {
  if (typeof window === "undefined") return;
  try {
    const clean = origin.trim().replace(/\/+$/, "");
    if (clean && /^https?:\/\//.test(clean)) localStorage.setItem(ORIGIN_KEY, clean);
    else localStorage.removeItem(ORIGIN_KEY);
  } catch {}
}

export function getNurseDashboardUrl(sessionId: string): string {
  if (typeof window === "undefined") return "";
  return `${getDashboardOrigin()}/nurse-view?session=${sessionId}`;
}

/* -------------------------------------------------------------------------- */
/* Console credential                                                          */
/* -------------------------------------------------------------------------- */

export type ClaimState = "idle" | "claiming" | "granted" | "denied" | "error";

export interface ClaimResult {
  state: ClaimState;
  /** 403 (staff, not assigned) vs 409 (anonymous). */
  deniedReason: "unauthenticated" | "forbidden" | null;
  /** Server rotated the console token for us (staff take-over). */
  rotated?: boolean;
}

/**
 * Ask the server to provision this browser as the console for `sessionId`.
 *
 * The session code in the bed's QR is a public handle; the credential that
 * actually authorises reads is a separate token the server sets as an HttpOnly
 * cookie. Because it is HttpOnly, nothing in this file ever sees it — there is no
 * token in localStorage to leak through an XSS bug, and no client code that
 * could forget to attach it.
 *
 * Safe to call on every mount: the server only mints a token for a session that
 * does not exist yet, and a repeat call from a browser that already holds the
 * valid token is a no-op. A `409` means "this bed belongs to a different
 * browser". An anonymised 409 cannot be clicked past, but a signed-in staff
 * member assigned to that bed is rotated onto it in the same request — so the
 * nurse-view passes that through rather than treating every denial as the end.
 */
export async function claimConsoleToken(sessionId: string): Promise<ClaimResult> {
  if (typeof window === "undefined") return { state: "idle", deniedReason: null };
  try {
    const res = await fetch("/api/console/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionId }),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { rotated?: boolean } | null;
      return { state: "granted", deniedReason: null, rotated: body?.rotated };
    }
    if (res.status === 409 || res.status === 403) {
      // 403 arrives with `reason` already decided by the server; a 409 without
      // a rotation path means the caller was not signed in as assigned staff.
      return { state: "denied", deniedReason: res.status === 403 ? "forbidden" : "unauthenticated" };
    }
    return { state: "error", deniedReason: null };
  } catch {
    return { state: "error", deniedReason: null };
  }
}

/** Whether this browser currently holds a console credential for `sessionId`. */
export async function hasConsoleToken(sessionId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const res = await fetch(
      `/api/console/claim?session=${encodeURIComponent(sessionId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return false;
    return Boolean((await res.json())?.authorized);
  } catch {
    return false;
  }
}

/**
 * Whether this browser is signed in as a member of staff.
 *
 * Used to tell the two reasons a console claim can be denied apart: a nurse
 * opening a bed they are assigned to is expected to be denied a *console
 * credential* and still allowed to read, whereas a random kiosk that is not
 * signed in is not allowed anything. Without this distinction the hook either
 * locks nurses out or waves unpaired devices through.
 */
export async function hasStaffSession(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const res = await fetch("/api/auth/session", { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { user?: { role?: string } | null } | null;
    const role = body?.user?.role;
    return role === "nurse" || role === "doctor" || role === "admin";
  } catch {
    return false;
  }
}
