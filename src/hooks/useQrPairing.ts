"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrCreatePairToken,
  regeneratePairToken,
  registerPairToken,
  fetchPairStatus,
  type PairStatus,
} from "@/lib/pairing";

/**
 * Live pairing telemetry for the patient console: registers this bed's unique
 * QR token with the server once, then polls the scan log while the tab is
 * visible so the patient sees "📱 Nurse phone linked" the moment their QR is
 * used — no more blind pairing.
 */
export function useQrPairing(sessionId: string | undefined): PairStatus & { token: string; rotate: () => void } {
  const [status, setStatus] = useState<PairStatus>({
    registered: false,
    linkedDevices: 0,
    lastScanAt: null,
    lastScanIp: null,
  });
  const [token, setToken] = useState("");
  const tokenRef = useRef("");

  useEffect(() => {
    if (!sessionId) return;
    const t = getOrCreatePairToken(sessionId);
    tokenRef.current = t;
    setToken(t);
    registerPairToken(sessionId, t);
    void fetchPairStatus(sessionId, t).then((s) => s && setStatus(s));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !tokenRef.current) return;
    let stopped = false;
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return; // save battery/data
      void fetchPairStatus(sessionId, tokenRef.current).then((s) => {
        if (!stopped && s) setStatus(s);
      });
    };
    const t = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [sessionId]);

  /** Invalidate every QR printed with the old token and re-render a fresh one. */
  const rotate = useCallback(() => {
    if (!sessionId) return;
    const next = regeneratePairToken(sessionId);
    tokenRef.current = next;
    setToken(next);
    setStatus((s) => ({ ...s, scans: [], linkedDevices: 0 }));
  }, [sessionId]);

  return { ...status, token, rotate };
}
