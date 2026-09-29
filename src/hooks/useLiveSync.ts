"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNetworkSync,
  NetworkSync,
  ConnStatus,
  Transport,
} from "@/lib/networkSync";
import { claimConsoleToken, hasStaffSession, type ClaimState } from "@/lib/session";
import {
  DeviceVitals,
  GestureLogEntry,
  NurseReply,
  PatientMetrics,
} from "@/types";

export interface UseLiveSyncOptions {
  sessionId?: string;
  /** false = do not open any connection (e.g. nurse console before pairing). */
  enabled?: boolean;
  /** Called for every newly observed gesture entry (remote or local echo). */
  onAlert?: (entry: GestureLogEntry) => void;
  /** Called for every incoming reply (nurse -> patient, or companion -> nurse). */
  onReply?: (reply: NurseReply) => void;
}

export interface LiveSyncApi {
  syncRef: React.MutableRefObject<NetworkSync | null>;
  status: ConnStatus;
  transport: Transport;
  /** Server-side store backend reported by the API. */
  driver: "memory" | "redis" | "mysql" | null;
  remoteMetrics: Record<string, PatientMetrics>;
  vitals: Record<string, DeviceVitals>;
  latestReply: NurseReply | null;
  /**
   * Whether this browser holds the console credential for the bed.
   *
   * The sync connection is not opened until this resolves, because the server now
   * refuses an unauthorised read — opening first produced a socket that 401'd and
   * then sat in a reconnect loop the patient could do nothing about.
   */
  claim: ClaimState;
  /** Why a claim was denied: staff take-over forbidden vs anonymous 409. */
  claimDeniedReason: "unauthenticated" | "forbidden" | null;
  /** True when the server rotated the console token on us (staff take-over). */
  claimRotated?: boolean;
  sendAlert: (entry: GestureLogEntry) => void;
  sendAction: (action: import("@/types").AlertAction) => void;
  sendReply: (text: string, from?: string) => void;
  sendPatientMetrics: (metrics: PatientMetrics) => void;
}

export function useLiveSync({ sessionId, enabled = true, onAlert, onReply }: UseLiveSyncOptions = {}): LiveSyncApi {
  const syncRef = useRef<NetworkSync | null>(null);
  const alertCb = useRef(onAlert);
  alertCb.current = onAlert;
  const replyCb = useRef(onReply);
  replyCb.current = onReply;

  const [status, setStatus] = useState<ConnStatus>("disconnected");
  const [transport, setTransport] = useState<Transport>("none");
  const [driver, setDriver] = useState<"memory" | "redis" | "mysql" | null>(null);
  const [remoteMetrics, setRemoteMetrics] = useState<Record<string, PatientMetrics>>({});
  const [vitals, setVitals] = useState<Record<string, DeviceVitals>>({});
  const [latestReply, setLatestReply] = useState<NurseReply | null>(null);
  const [claim, setClaim] = useState<ClaimState>("idle");
  const [claimDeniedReason, setClaimDeniedReason] = useState<"unauthenticated" | "forbidden" | null>(null);
  const [claimRotated, setClaimRotated] = useState(false);

  useEffect(() => {
    if (!enabled) {
      syncRef.current = null;
      return;
    }
    // Session identity changed: drop the previous patient's metrics/vitals so
    // switching beds never shows stale data from the last one.
    setRemoteMetrics({});
    setVitals({});
    setLatestReply(null);

    let cancelled = false;
    let sync: NetworkSync | null = null;

    // Claim the console credential first, then connect.
    //
    // A `denied` claim is NOT the same thing as "an error, carry on". It means
    // this bed is already provisioned to a different browser, and connecting
    // anyway means every GET and POST returns 401 -- so the console sits there
    // reconnecting forever, showing a patient nothing but a spinner. The only
    // caller that may proceed after a denial is a signed-in staff account, whose
    // own session authorises the read; anything else stops here and renders the
    // re-pairing state.
    (async () => {
      setClaim("claiming");
      const result = await claimConsoleToken(sessionId ?? "default");
      if (cancelled) return;
      setClaim(result.state);
      setClaimDeniedReason(result.deniedReason);
      setClaimRotated(Boolean(result.rotated));

      if (result.state === "denied" || result.state === "error") {
        const signedIn = await hasStaffSession();
        if (cancelled) return;
        // A signed-in staff member may proceed on an assignment even without a
        // console credential (the sync API authorises by their own session).
        // But an anonymous denial is terminal: connecting would loop on 401.
        if (!signedIn) {
          setStatus("denied");
          return;
        }
      }

      sync = createNetworkSync({
        sessionId,
        onAlert: (e) => alertCb.current?.(e),
        onStatusUpdate: () => {},
        onMetrics: (m) => setRemoteMetrics((prev) => ({ ...prev, ...m })),
        onVitals: (v) => setVitals((prev) => ({ ...prev, ...v })),
        onReply: (r) => {
          setLatestReply(r);
          replyCb.current?.(r);
        },
        onDriver: (d) => setDriver(d as "memory" | "redis" | "mysql"),
        onStatusChange: (s, t) => {
          setStatus(s);
          setTransport(t);
        },
      });
      syncRef.current = sync;
    })();

    return () => {
      cancelled = true;
      sync?.destroy();
      syncRef.current = null;
    };
    // Reconnect only when the session identity actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);

  const sendAlert = useCallback((entry: GestureLogEntry) => {
    void syncRef.current?.sendAlert(entry);
  }, []);

  const sendAction = useCallback((action: import("@/types").AlertAction) => {
    void syncRef.current?.sendAction(action);
  }, []);

  const sendReply = useCallback(
    (text: string, from = "Nurse") => {
      void syncRef.current?.sendReply({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text,
        lang: typeof localStorage !== "undefined" ? localStorage.getItem("carespeak_language") ?? "en-US" : "en-US",
        from,
      });
    },
    []
  );

  const sendPatientMetrics = useCallback(
    (metrics: PatientMetrics) => {
      const deviceId =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("carespeak_device_id") ?? "unknown"
          : "unknown";
      void syncRef.current?.sendPatientMetrics(metrics, deviceId);
    },
    []
  );

  return { syncRef, status, transport, driver, remoteMetrics, vitals, latestReply, claim, claimDeniedReason, claimRotated, sendAlert, sendAction, sendReply, sendPatientMetrics };
}
