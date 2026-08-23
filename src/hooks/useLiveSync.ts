"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNetworkSync,
  NetworkSync,
  ConnStatus,
  Transport,
} from "@/lib/networkSync";
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
}

export interface LiveSyncApi {
  syncRef: React.MutableRefObject<NetworkSync | null>;
  status: ConnStatus;
  transport: Transport;
  remoteMetrics: Record<string, PatientMetrics>;
  vitals: Record<string, DeviceVitals>;
  latestReply: NurseReply | null;
  sendAlert: (entry: GestureLogEntry) => void;
  sendAction: (action: import("@/types").AlertAction) => void;
  sendReply: (text: string, from?: string) => void;
  sendPatientMetrics: (metrics: PatientMetrics) => void;
}

export function useLiveSync({ sessionId, enabled = true, onAlert }: UseLiveSyncOptions = {}): LiveSyncApi {
  const syncRef = useRef<NetworkSync | null>(null);
  const alertCb = useRef(onAlert);
  alertCb.current = onAlert;

  const [status, setStatus] = useState<ConnStatus>("disconnected");
  const [transport, setTransport] = useState<Transport>("none");
  const [remoteMetrics, setRemoteMetrics] = useState<Record<string, PatientMetrics>>({});
  const [vitals, setVitals] = useState<Record<string, DeviceVitals>>({});
  const [latestReply, setLatestReply] = useState<NurseReply | null>(null);

  useEffect(() => {
    if (!enabled) {
      syncRef.current = null;
      return;
    }
    const sync = createNetworkSync({
      sessionId,
      onAlert: (e) => alertCb.current?.(e),
      onStatusUpdate: () => {},
      onMetrics: (m) => setRemoteMetrics((prev) => ({ ...prev, ...m })),
      onVitals: (v) => setVitals((prev) => ({ ...prev, ...v })),
      onReply: (r) => setLatestReply(r),
      onStatusChange: (s, t) => {
        setStatus(s);
        setTransport(t);
      },
    });
    syncRef.current = sync;
    return () => {
      sync.destroy();
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

  return { syncRef, status, transport, remoteMetrics, vitals, latestReply, sendAlert, sendAction, sendReply, sendPatientMetrics };
}
