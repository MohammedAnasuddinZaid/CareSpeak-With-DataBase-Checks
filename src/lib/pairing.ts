"use client";

import { PairScanInfo } from "@/types";

/**
 * Client side of the unique-QR tracking system.
 *
 * Each patient console owns a cryptographically-random pairing token that is
 * baked into its QR code, making every bed's QR unique. The console registers
 * the token with the server on mount; any device that scans the QR reports a
 * "scan" with its IP/device, which the console (and ward board) display live.
 */

const TOKEN_PREFIX = "carespeak_pair_";

function randomToken(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable per-session token — survives refreshes, unique per bed. */
export function getOrCreatePairToken(sessionId: string): string {
  if (typeof window === "undefined") return "";
  const key = TOKEN_PREFIX + sessionId;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const token = randomToken();
    localStorage.setItem(key, token);
    return token;
  } catch {
    return randomToken();
  }
}

/** Invalidate every QR printed with the old token. */
export function regeneratePairToken(sessionId: string): string {
  if (typeof window === "undefined") return "";
  const token = randomToken();
  try {
    localStorage.setItem(TOKEN_PREFIX + sessionId, token);
  } catch {}
  void fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rotate", session: sessionId }),
  }).catch(() => {});
  registerPairToken(sessionId, token);
  return token;
}

export function registerPairToken(sessionId: string, token: string): void {
  void fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "register", session: sessionId, pair: token }),
  }).catch(() => {});
}

export interface PairStatus {
  registered: boolean;
  linkedDevices: number;
  lastScanAt: number | null;
  lastScanIp: string | null;
  scans?: PairScanInfo[];
}

export async function fetchPairStatus(sessionId: string, token: string): Promise<PairStatus | null> {
  try {
    const res = await fetch(
      `/api/pair?session=${encodeURIComponent(sessionId)}&pair=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as PairStatus & { ok: boolean };
    return data.ok ? data : null;
  } catch {
    return null;
  }
}
