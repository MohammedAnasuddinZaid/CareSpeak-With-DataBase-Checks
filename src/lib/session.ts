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

export function getNurseDashboardUrl(sessionId: string): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/nurse-view?session=${sessionId}`;
}
