"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import {
  Bell,
  CheckCircle,
  Eye,
  Hand,
  Filter,
  Activity,
  AlertTriangle,
  Wifi,
  Smartphone,
  ArrowUpCircle,
  Send,
  Mic,
  FileText,
  Radio,
} from "lucide-react";
import { GestureLogEntry, NurseReply, ESCALATION_RULES } from "@/types";
import { getSession, setSessionId, clearSession } from "@/lib/session";
import { useLiveSync } from "@/hooks/useLiveSync";
import { evaluateEscalations } from "@/lib/escalation";
import { isAlarmMuted, setAlarmMuted, startAlarm, stopAlarm } from "@/lib/nurseAlarm";
import { addGestureLog } from "@/lib/gestureLog";
import { recordAudit } from "@/lib/auditTrail";
import { voiceAlert } from "@/lib/tts";
import {
  forecastDeterioration,
  bandRank,
  trajectoryAlertText,
  type ForecastResult,
  type VitalSample,
} from "@/lib/forecast";
import {
  computeStats,
  hourlyDistribution,
  dailyGestureCounts,
} from "@/lib/analytics";
import PatientMetricsCard from "@/components/PatientMetricsCard";
import ClinicianActions from "@/components/ClinicianActions";
import {
  TYPE_CONFIG,
  GESTURE_BADGES,
  formatRelativeTime,
  stripGesturePrefix,
} from "@/components/uiConstants";

const QUICK_REPLIES = ["On my way", "Please wait", "Doctor notified"];

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};

export default function NurseViewPage() {
  const [log, setLog] = useState<GestureLogEntry[]>([]);
  const [filter, setFilter] = useState<"all" | "hand" | "eye" | "unacknowledged">("all");
  const [sessionInput, setSessionInput] = useState("");
  const [paired, setPaired] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [micActive, setMicActive] = useState(false);
  const [autoNotes, setAutoNotes] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  /* ── live sync ── */
  const logRef = useRef<GestureLogEntry[]>([]);
  const handleAlert = useCallback((entry: GestureLogEntry) => {
    setLog((prev) => (prev.some((e) => e.id === entry.id) ? prev : [entry, ...prev]));
    // system notification when the tab isn't in focus (phone in pocket use-case)
    try {
      if (typeof document !== "undefined" && document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(`${entry.gesture} — CareSpeak`, {
          body: stripGesturePrefix(entry.description).slice(0, 110),
          tag: entry.id,
        });
      }
    } catch {}
  }, []);

  /* messages typed by someone sitting with the patient */
  const [patientMsgs, setPatientMsgs] = useState<NurseReply[]>([]);
  const [unseenMsgs, setUnseenMsgs] = useState(0);
  const seenCompanionIds = useRef<Set<string>>(new Set());
  const handleCompanionReply = useCallback((r: NurseReply) => {
    if (r.from === "Nurse") return; // ignore echo of our own outgoing replies
    if (seenCompanionIds.current.has(r.id)) return; // exactly-once (redelivery-proof)
    seenCompanionIds.current.add(r.id);
    setPatientMsgs((prev) => [r, ...prev].slice(0, 30));
    setUnseenMsgs((n) => n + 1);
  }, []);

  const { status, transport, driver, remoteMetrics, vitals, claim, claimDeniedReason, claimRotated, sendAction, sendReply, syncRef } = useLiveSync({
    sessionId: sessionInput,
    enabled: paired,
    onAlert: handleAlert,
    onReply: handleCompanionReply,
  });

  /* ── pairing: ?session= QR param ALWAYS wins over any stale saved session ── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSession = params.get("session");
    if (urlSession && /^[A-Z0-9_-]{3,32}$/.test(urlSession.trim().toUpperCase())) {
      const id = urlSession.trim().toUpperCase();
      setSessionId(id); // overwrite stale pairing in localStorage
      setSessionInput(id);
      setPaired(true);
      // Unique-QR tracking: report this scan so the patient console + ward board
      // see exactly which device linked to this bed (IP + device, once per tab).
      const pair = params.get("pair") ?? "";
      if (pair && !sessionStorage.getItem(`carespeak_scan_${id}_${pair}`)) {
        sessionStorage.setItem(`carespeak_scan_${id}_${pair}`, "1");
        void fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "scan", session: id, pair, role: "nurse" }),
        }).catch(() => {});
      }
      return;
    }
    const existing = getSession();
    if (existing?.sessionId) {
      setSessionInput(existing.sessionId);
      setPaired(true);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /* ── one-shot history backfill: a nurse joining mid-shift sees prior events ── */
  useEffect(() => {
    if (!paired || !sessionInput) return;
    let cancelled = false;
    fetch(`/api/sync?session=${encodeURIComponent(sessionInput)}&since=0`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { entries?: GestureLogEntry[] } | null) => {
        if (cancelled || !data?.entries?.length) return;
        setLog((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const older = data.entries!.filter((e) => !seen.has(e.id));
          if (older.length === 0) return prev;
          const merged = [...older, ...prev];
          merged.sort((a, b) => b.timestamp - a.timestamp);
          return merged;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paired, sessionInput]);

  /* ── automatic escalation engine (implements ESCALATION_RULES for real) ── */
  const primaryMetrics = useMemo(
    () => Object.values(remoteMetrics)[0] ?? null,
    [remoteMetrics]
  );
  logRef.current = log;

  /* NOTE: the escalation / escalation-chain / trajectory engines run in ONE
   * consolidated interval further down ("Automation Engine"). They used to live
   * in effects keyed on `primaryMetrics`, which changes identity on EVERY
   * metrics push (~3s) — tearing down each interval before it ever fired and
   * silently disabling both engines during live monitoring. Refs break that
   * dependency while keeping the tick logic pure and readable. */

  /* ── audible siren while any EMERGENCY is unacknowledged ── */
  const [alarmMutedState, setAlarmMutedState] = useState(isAlarmMuted());
  const unresolvedEmergencies = useMemo(
    () => log.filter((e) => e.gesture === "EMERGENCY" && !e.resolved),
    [log]
  );
  useEffect(() => {
    if (!paired) {
      stopAlarm();
      return;
    }
    if (unresolvedEmergencies.length > 0) startAlarm();
    else stopAlarm();
    return () => stopAlarm();
  }, [paired, unresolvedEmergencies.length]);

  /* ── flashing tab title when criticals are pending ── */
  const originalTitle = useRef(typeof document !== "undefined" ? document.title : "CareSpeak");
  useEffect(() => {
    const critical = unresolvedEmergencies.length > 0;
    if (!critical) {
      document.title = originalTitle.current;
      return;
    }
    let on = false;
    const t = setInterval(() => {
      on = !on;
      document.title = on ? `🚨 (${unresolvedEmergencies.length}) EMERGENCY` : originalTitle.current;
    }, 1100);
    return () => {
      clearInterval(t);
      document.title = originalTitle.current;
    };
  }, [unresolvedEmergencies.length]);

  /* ── notification permission on first user interaction after pairing ── */
  useEffect(() => {
    if (!paired || !("Notification" in window) || Notification.permission !== "default") return;
    const ask = () => {
      void Notification.requestPermission();
      window.removeEventListener("pointerdown", ask);
    };
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, [paired]);

  /* ── closed-loop escalation chain: EMERGENCY unacknowledged for 60s ──
   * (scan logic lives in the consolidated Automation Engine below) */
  const chainNotifiedRef = useRef<Set<string>>(new Set());

  /* ── actions ── */
  const handleAcknowledge = useCallback(
    (id: string) => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, acknowledged: true, acknowledgedAt: Date.now() } : e)));
      sendAction({ type: "acknowledge", entryId: id, timestamp: Date.now() });
    },
    [sendAction]
  );
  const handleEscalate = useCallback(
    (id: string) => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, escalated: true, escalatedBy: "staff" as const, escalatedAt: Date.now() } : e)));
      sendAction({ type: "escalate", entryId: id, timestamp: Date.now(), actor: "Staff" });
    },
    [sendAction]
  );
  const handleResolve = useCallback(
    (id: string) => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, resolved: true, acknowledged: true, resolvedAt: Date.now() } : e)));
      sendAction({ type: "resolve", entryId: id, timestamp: Date.now() });
    },
    [sendAction]
  );

  /* ── voice reply (Web Speech API, graceful fallback to typing) ── */
  const startVoiceReply = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setAutoNotes((n) => [`${new Date().toLocaleTimeString()} · Voice input not supported in this browser`, ...n]);
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = "en-IN";
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (e) => {
        const text = e.results?.[0]?.[0]?.transcript ?? "";
        if (text) setReplyText((prev) => (prev ? `${prev} ${text}` : text));
      };
      rec.onend = () => setMicActive(false);
      recognitionRef.current = rec;
      setMicActive(true);
      rec.start();
    } catch {
      setMicActive(false);
    }
  }, []);

  const handleSendReply = useCallback(
    (text?: string) => {
      const msg = (text ?? replyText).trim();
      if (!msg) return;
      sendReply(msg);
      setReplyText("");
      setAutoNotes((n) => [`${new Date().toLocaleTimeString()} · Sent "${msg}" to patient screen`, ...n].slice(0, 6));
    },
    [replyText, sendReply]
  );

  /* ── derived data (computed from the live polled log, not localStorage) ── */
  const stats = useMemo(() => computeStats(log, now), [log, now]);
  const hourlyData = useMemo(() => hourlyDistribution(log), [log]);
  const dailyData = useMemo(() => dailyGestureCounts(log, 7, now), [log, now]);

  const actionable = useMemo(
    () =>
      log.filter((e) => {
        if (e.resolved) return false;
        const isCritical = e.gesture === "HELP" || e.gesture === "EMERGENCY" || e.escalated;
        const recent = now - e.timestamp < 60 * 60 * 1000;
        return (isCritical || !e.acknowledged) && recent;
      }),
    [log, now]
  );

  const filteredLog = useMemo(() => {
    switch (filter) {
      case "hand": return log.filter((e) => e.type === "hand");
      case "eye": return log.filter((e) => e.type === "eye");
      case "unacknowledged": return log.filter((e) => !e.acknowledged);
      default: return log;
    }
  }, [log, filter]);

  const primaryVitals = useMemo(() => Object.values(vitals)[0] ?? null, [vitals]);

  /* ── predictive deterioration trajectory (Holt projection) ── */
  const vitalSamplesRef = useRef<VitalSample[]>([]);
  const [trajectory, setTrajectory] = useState<ForecastResult | null>(null);
  const lastWarnBandRef = useRef(0);

  /* ════════════════════════════════════════════════════════════════
   * AUTOMATION ENGINE — one stable 5s tick for three subsystems:
   *   1. ESCALATION RULES      (evaluateEscalations → auto-escalate)
   *   2. ESCALATION CHAIN      (EMERGENCY unacked 60s → /api/notify)
   *   3. TRAJECTORY FORECAST   (Holt projection → SYSTEM alert)
   *
   * All live values are read through refs so the interval survives the
   * ~3s metrics pushes that previously reset these timers forever.
   * ════════════════════════════════════════════════════════════════ */
  const metricsLiveRef = useRef(primaryMetrics);
  metricsLiveRef.current = primaryMetrics;
  const vitalsLiveRef = useRef(primaryVitals);
  vitalsLiveRef.current = primaryVitals;
  const sessionLiveRef = useRef(sessionInput);
  sessionLiveRef.current = sessionInput;
  const sendActionLiveRef = useRef(sendAction);
  sendActionLiveRef.current = sendAction;

  useEffect(() => {
    if (!paired) return;

    const tick = () => {
      const now = Date.now();
      const snapshot = logRef.current;
      const metrics = metricsLiveRef.current;
      const session = sessionLiveRef.current;
      if (!session) return;

      /* ── 1) escalation rules ── */
      const decisions = evaluateEscalations(snapshot, metrics, now);
      if (decisions.length > 0) {
        const byId = new Map(decisions.map((d) => [d.entryId, d]));

        // pure state transition
        setLog((prevLog) => {
          let changed = false;
          const next = prevLog.map((e) => {
            const d = byId.get(e.id);
            if (!d || e.escalated || e.resolved) return e;
            changed = true;
            return { ...e, escalated: true, escalatedBy: "system" as const, escalatedRule: d.rule, escalatedAt: now };
          });
          return changed ? next : prevLog;
        });

        // side effects outside the updater
        for (const e of snapshot) {
          const d = byId.get(e.id);
          if (!d || e.escalated || e.resolved) continue;
          sendActionLiveRef.current({
            type: "escalate",
            entryId: e.id,
            timestamp: now,
            actor: "CareSpeak Engine",
            bySystem: true,
          });
          recordAudit("auto_escalate", `Auto-escalated ${e.gesture} — ${d.reason}`, { sessionId: session });
          setAutoNotes((notes) =>
            [`${new Date().toLocaleTimeString()} · Auto-escalated ${e.gesture} — ${d.reason}`, ...notes].slice(0, 6)
          );
        }
      }

      /* ── 2) closed-loop escalation chain ── */
        for (const e of logRef.current) {
          if (e.gesture !== "EMERGENCY" || e.resolved || e.acknowledged) continue;
          if (now - e.timestamp < 60_000) continue;
          if (chainNotifiedRef.current.has(e.id)) continue;
          chainNotifiedRef.current.add(e.id);
          // Evict the OLDEST ids individually — wholesale clear() made still-
          // unacknowledged emergencies eligible for repeat SMS dispatch.
          if (chainNotifiedRef.current.size > 200) {
            const oldest = chainNotifiedRef.current.values().next().value;
            if (oldest !== undefined) chainNotifiedRef.current.delete(oldest);
          }

          sendActionLiveRef.current({
            type: "escalate",
            entryId: e.id,
            timestamp: now,
            actor: "Escalation Chain",
            bySystem: true,
          });
          recordAudit(
            "escalation_chain",
            "EMERGENCY unacknowledged 60s — escalation chain fired (WhatsApp/SMS dispatch attempted)",
            { sessionId: session, citation: { docId: "NICE-CG50", section: "monitoring" } }
          );
          setAutoNotes((notes) =>
            [
              `${new Date().toLocaleTimeString()} · ⛓ No ack in 60s — escalation chain fired (WhatsApp/SMS dispatch attempted)`,
              ...notes,
            ].slice(0, 6)
          );
          // Fire-and-forget dispatch; logs to server console when no provider keys are set.
          void fetch("/api/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session,
              patient: session,
              gesture: e.gesture,
              contacts: (() => {
                try {
                  return JSON.parse(localStorage.getItem("carespeak_contacts") ?? "[]") as string[];
                } catch {
                  return [] as string[];
                }
              })(),
            }),
          }).catch(() => {});
        }

      /* ── 3) trajectory forecast ── */
      const v = vitalsLiveRef.current;
      const arr = vitalSamplesRef.current;
      // Only sample FRESH data: a wearable that stopped transmitting must not
      // keep feeding its last reading into the Holt projection as if the
      // patient were still stable.
      const vitalsFresh = v?.receivedAt != null && now - v.receivedAt < 30_000;
      const metricsFresh =
        metrics?.lastSeen != null && now - new Date(metrics.lastSeen).getTime() < 30_000;
      if ((vitalsFresh && (v?.heartRate != null || v?.spo2 != null)) || metricsFresh) {
        arr.push({
          t: now,
          hr: vitalsFresh ? v?.heartRate ?? undefined : undefined,
          spo2: vitalsFresh ? v?.spo2 ?? undefined : undefined,
          alertness: metricsFresh ? metrics?.alertnessScore ?? undefined : undefined,
          movement: metricsFresh ? metrics?.movementActivity ?? undefined : undefined,
        });
        if (arr.length > 360) arr.splice(0, arr.length - 360); // ~30 min at 5s cadence
      }
      if (arr.length >= 6) {
        const f = forecastDeterioration(arr);
        setTrajectory(f);
        // auto-raise a SYSTEM alert only when severity increases
        const rank = bandRank(f.band);
        if (rank >= 2 && rank > lastWarnBandRef.current) {
          lastWarnBandRef.current = rank;
          const text = trajectoryAlertText(f);
          recordAudit("trajectory_alert", text, {
            sessionId: session,
            citation: { docId: "RCP-NEWS2", section: "response" },
          });
          const entry = addGestureLog(
            "SYSTEM",
            text,
            0.9,
            "system",
            voiceAlert.getLanguage(),
            { sessionId: session, source: "system" }
          );
          syncRef.current?.sendAlert(entry);
        } else if (rank === 0) {
          lastWarnBandRef.current = 0;
        }
      }
    };

    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired]);


  const statusColor =
    status === "connected" ? "bg-[#22a67e]" : status === "reconnecting" ? "bg-[#e8993e]" : "bg-[#d94a4a]";
  const statusText =
    status === "connected"
      ? `Live · ${transport.toUpperCase()}`
      : status === "reconnecting"
      ? "Reconnecting..."
      : status === "denied"
      ? claimRotated
        ? "Paired · take-over in progress"
        : "Not paired — this bed is already linked"
      : "Disconnected";

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* ── header ── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
                <Bell className="w-4 h-4" />
                Clinician Console
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Patient Communication Monitor</h1>
              <p className="mt-2 text-[#6e6e6e]">Real-time gesture alerts, wellness analytics and two-way messaging.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const next = !alarmMutedState;
                  setAlarmMuted(next);
                  setAlarmMutedState(next);
                  if (!next && unresolvedEmergencies.length > 0) startAlarm();
                }}
                aria-label={alarmMutedState ? "Enable alarm sound" : "Mute alarm sound"}
                title={alarmMutedState ? "Alarm muted — click to enable" : "Alarm armed — click to mute"}
                className={`p-2.5 rounded-xl border transition-colors ${
                  alarmMutedState
                    ? "bg-white border-[#ececec] text-[#9ca3af]"
                    : "bg-[#ecfdf5] border-[#a7f3d0] text-[#22a67e]"
                }`}
              >
                {alarmMutedState ? "🔇" : "🔔"}
              </button>
              <a href="/report" target="_blank" rel="noreferrer" className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm">
                <FileText className="w-4 h-4" />
                Shift Report
              </a>
            </div>
          </div>
        </motion.div>

        {/* ── pairing panel ── */}
        {!paired && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 p-5 rounded-2xl bg-[#c63a22]/5 border border-[#c63a22]/15">
            <div className="flex items-center gap-3 mb-3">
              <Smartphone className="w-5 h-5 text-[#c63a22]" />
              <h3 className="font-semibold text-[#1f1f1f] text-sm">Pair with Patient Device</h3>
            </div>
            <p className="text-xs text-[#6e6e6e] mb-3">
              Enter the Session ID shown on the patient&apos;s device (or scan the QR code shown there).
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={sessionInput}
                onChange={(e) => setSessionInput(e.target.value.toUpperCase())}
                placeholder="Enter Session ID (from the patient's device)"
                aria-label="Session ID"
                className="input flex-1 font-mono tracking-widest uppercase"
                maxLength={32}
              />
              <button
                onClick={() => {
                  if (sessionInput.trim().length >= 3) {
                    setSessionId(sessionInput.trim().toUpperCase());
                    setPaired(true);
                  }
                }}
                disabled={sessionInput.length < 3}
                className="btn-primary px-5 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Connect
              </button>
            </div>
          </motion.div>
        )}

        {paired && (
          <div className={`mb-6 flex items-center gap-3 px-4 py-2 rounded-xl border text-xs font-medium w-fit ${
            status === "connected" ? "bg-[#ecfdf5] border-[#a7f3d0] text-[#22a67e]"
            : status === "reconnecting" ? "bg-[#fffbeb] border-[#fde68a] text-[#e8993e]"
            : "bg-[#fef2f2] border-[#fecaca] text-[#d94a4a]"
          }`}>
            <span className={`relative flex w-2.5 h-2.5 ${status === "connected" ? "" : ""}`}>
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${statusColor}`} />
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${statusColor}`} />
            </span>
            <Wifi className="w-3.5 h-3.5" aria-hidden />
            {statusText}
            <span className="text-[#9ca3af]">· session {sessionInput}</span>
            <Radio className="w-3.5 h-3.5 ml-1 text-[#9ca3af]" aria-hidden />
            <button
              onClick={() => {
                clearSession();
                setPaired(false);
                setLog([]);
                setAutoNotes([]);
                setSessionInput("");
                // Full automation-state reset: without this, the next patient's
                // Holt forecast ran over the PREVIOUS patient's samples and
                // chain/seen-id memory leaked across sessions.
                vitalSamplesRef.current = [];
                lastWarnBandRef.current = 0;
                chainNotifiedRef.current.clear();
                seenCompanionIds.current.clear();
                setPatientMsgs([]);
                setUnseenMsgs(0);
                setTrajectory(null);
              }}
              className="ml-1 px-2 py-0.5 rounded-lg bg-white/70 hover:bg-white text-[#6e6e6e] hover:text-[#c63a22] border border-[#ececec] transition-colors"
              title="Pair with a different session"
            >
              Switch
            </button>
          </div>
        )}

        {/* ── recovery panel: a claim denial that a nurse is not incorrectly
             told to "re-pair" themselves. The QR is a public handle; a seed or
             second scan cannot mint a new credential anonymously, and the UI
             must say so and route to the correct remedy (staff sign-in) rather
             than looping the user back into the same dead 409. ── */}
        {paired && claim === "denied" && !claimRotated && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-5 rounded-2xl bg-[#c63a22]/5 border border-[#c63a22]/15"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#c63a22] mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-semibold text-[#1f1f1f] text-sm">Bed already linked to another console</h3>
                <p className="text-xs text-[#6e6e6e] mt-1">
                  {claimDeniedReason === "forbidden"
                    ? "You are signed in but not assigned to this bed, so the take-over was refused."
                    : "The QR code alone is not a credential. Sign in as a nurse assigned to this bed to take over this console."}
                </p>
                <a
                  href={`/login?next=${encodeURIComponent(`/nurse-view?session=${encodeURIComponent(sessionInput)}`)}`}
                  className="inline-flex items-center gap-2 mt-3 px-4 py-2 rounded-xl bg-[#c63a22] hover:bg-[#a92f19] text-white text-xs font-medium transition-colors"
                >
                  Sign in as staff to take over
                </a>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          {[
            { label: "Latest", value: log[0]?.gesture ?? "—", sub: log[0] ? formatRelativeTime(log[0].timestamp, now) : "No alerts" },
            { label: "Today", value: stats.today, sub: "gestures recorded" },
            { label: "Pending", value: stats.unacknowledged, sub: "needs review", accent: stats.unacknowledged > 0 },
            { label: "Escalated", value: stats.escalated, sub: "critical alerts", accent: stats.escalated > 0 },
            { label: "Total", value: stats.total, sub: "this session" },
          ].map((stat, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="card p-4">
              <div className="text-[10px] text-[#6e6e6e] uppercase tracking-wider font-medium mb-1">{stat.label}</div>
              <div className={`text-xl font-bold ${stat.accent ? "text-[#e8993e]" : "text-[#1f1f1f]"}`}>{stat.value}</div>
              <div className="text-[10px] text-[#6e6e6e] mt-0.5">{stat.sub}</div>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* ── left: feed + analytics ── */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-[#6e6e6e]" />
                {(["all", "unacknowledged", "hand", "eye"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-200 ${
                      filter === f ? "bg-[#c63a22]/10 text-[#c63a22] border border-[#c63a22]/20" : "text-[#6e6e6e] hover:text-[#1f1f1f] border border-transparent"
                    }`}
                  >
                    {f === "all" ? "All" : f === "unacknowledged" ? "Unread" : f === "hand" ? "Hand" : "Eye"}
                  </button>
                ))}
              </div>
              <div className="text-xs text-[#6e6e6e]">{filteredLog.length} of {log.length} entries</div>
            </div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-3xl border border-[#ececec] overflow-hidden bg-white">
              {filteredLog.length === 0 ? (
                <div className="text-center py-16">
                  <Bell className="w-12 h-12 text-[#d5d5d5] mx-auto mb-4" />
                  <p className="text-[#6e6e6e] font-medium">No gestures recorded yet</p>
                  <p className="text-[#9ca3af] text-xs mt-1">Alerts from the paired patient device stream in here instantly.</p>
                </div>
              ) : (
                <div className="divide-y divide-[#ececec] max-h-96 overflow-y-auto" role="log" aria-live="polite">
                  {filteredLog.map((entry) => {
                    const badge = GESTURE_BADGES[entry.gesture] ?? GESTURE_BADGES.HELP;
                    const isCritical = entry.gesture === "HELP" || entry.gesture === "EMERGENCY" || entry.escalated;
                    return (
                      <motion.div key={entry.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                        className={`flex items-center gap-4 px-6 py-4 transition-colors duration-200 ${
                          isCritical && !entry.resolved ? "bg-[#fef2f2] border-l-2 border-l-[#d94a4a]"
                          : !entry.acknowledged ? "bg-[#fdf4f0] border-l-2 border-l-[#c63a22]"
                          : "hover:bg-[#f5f3f0]"
                        }`}
                      >
                        <div className="w-10 h-10 rounded-xl bg-[#f5f3f0] flex items-center justify-center flex-shrink-0">
                          {entry.type === "eye" ? <Eye className="w-5 h-5 text-[#6e6e6e]" /> : entry.type === "system" ? <AlertTriangle className="w-5 h-5 text-[#6e6e6e]" /> : <Hand className="w-5 h-5 text-[#6e6e6e]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-bold text-sm ${isCritical ? "text-[#d94a4a]" : badge.text}`}>{entry.gesture}</span>
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>{badge.label}</span>
                            <span className="px-2 py-0.5 rounded bg-[#f5f3f0] text-[#6e6e6e] text-xs">{TYPE_CONFIG[entry.type] ? entry.type : "system"}</span>
                            {entry.escalatedBy === "system" && (
                              <span className="px-2 py-0.5 rounded bg-[#fffbeb] text-[#e8993e] text-[10px] font-bold border border-[#fde68a]">AUTO</span>
                            )}
                            {!entry.acknowledged && <span className="w-2 h-2 rounded-full status-active" aria-hidden />}
                          </div>
                          <div className="text-xs text-[#6e6e6e] mt-0.5 truncate">{stripGesturePrefix(entry.description)}</div>
                          <div className="text-xs text-[#9ca3af] mt-0.5">{formatRelativeTime(entry.timestamp, now)} · {Math.round(entry.confidence * 100)}% confidence</div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {!entry.acknowledged && (
                            <button onClick={() => handleAcknowledge(entry.id)} aria-label="Acknowledge"
                              className="p-2 rounded-lg bg-[#ecfdf5] hover:bg-[#d1fae5] text-[#22a67e] transition-colors duration-200"><CheckCircle className="w-4 h-4" /></button>
                          )}
                          {entry.acknowledged && !entry.escalated && !entry.resolved && (
                            <button onClick={() => handleEscalate(entry.id)} aria-label="Escalate"
                              className="p-2 rounded-lg bg-[#fef2f2] hover:bg-[#fee2e2] text-[#d94a4a] transition-colors duration-200"><ArrowUpCircle className="w-4 h-4" /></button>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </motion.div>

            {/* hourly mini-chart */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#c63a22]" />
                Activity — last 7 days
              </h3>
              <div className="flex items-end gap-1 h-24">
                {hourlyData.map(({ hour, count }) => {
                  const max = Math.max(...hourlyData.map((d) => d.count), 1);
                  return (
                    <div key={hour} className="flex-1 flex flex-col justify-end group relative" title={`${hour}:00 — ${count}`}>
                      <div
                        className={`rounded-t-sm transition-colors ${count > 0 ? "bg-[#c63a22]/70 group-hover:bg-[#c63a22]" : "bg-[#ececec]"}`}
                        style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-[#9ca3af] mt-1">
                <span>12AM</span><span>6AM</span><span>12PM</span><span>6PM</span><span>11PM</span>
              </div>
              {dailyData.length > 0 && (
                <p className="text-[11px] text-[#9ca3af] mt-2">{stats.today} today · peak hour {hourlyData.reduce((a, b) => (b.count > a.count ? b : a), { hour: 0, count: 0 }).hour}:00</p>
              )}
            </div>
          </div>

          {/* ── right: wellness, replies, actions ── */}
          <div className="space-y-6">
            <PatientMetricsCard metrics={primaryMetrics} log={log} vitals={primaryVitals} deviceName="Paired Device" />

            {/* predictive deterioration trajectory */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#c63a22]" />
                Deterioration Trajectory
                {trajectory && (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      trajectory.band === "imminent"
                        ? "bg-[#d94a4a] text-white"
                        : trajectory.band === "warning"
                        ? "bg-[#e8993e] text-white"
                        : trajectory.band === "watch"
                        ? "bg-[#fffbeb] text-[#e8993e] border border-[#fde68a]"
                        : "bg-[#ecfdf5] text-[#22a67e]"
                    }`}
                  >
                    {trajectory.band.toUpperCase()}
                  </span>
                )}
              </h3>
              {!trajectory || !trajectory.reasons.length ? (
                <p className="text-xs text-[#9ca3af]">
                  {trajectory
                    ? "All trends within safe range. Holt projection updated every 5s over the last ~30 min."
                    : "Collecting trend samples from camera metrics and wearable vitals…"}
                </p>
              ) : (
                <>
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className={`text-3xl font-extrabold ${bandRank(trajectory.band) >= 2 ? "text-[#d94a4a]" : "text-[#e8993e]"}`}>
                      {trajectory.score}
                    </span>
                    <span className="text-xs text-[#6e6e6e]">/ 100 · projected next 15 min</span>
                  </div>
                  <ul className="space-y-1">
                    {trajectory.reasons.map((r, i) => (
                      <li key={i} className="text-xs text-[#6e6e6e] flex gap-1.5">
                        <span className="text-[#c63a22]">▸</span> {r}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {/* two-way messaging */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <Send className="w-4 h-4 text-[#c63a22]" />
                Message Patient
              </h3>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {QUICK_REPLIES.map((q) => (
                  <button key={q} onClick={() => handleSendReply(q)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#eff6ff] text-[#3b82f6] hover:bg-[#dbeafe] transition-colors border border-[#bfdbfe]">
                    {q}
                  </button>
                ))}
                <button onClick={() => handleSendReply("[PAIN] Requesting pain level")}
                  title="Opens a 0–10 pain scale on the patient screen; the patient selects with gaze"
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#fef2f2] text-[#d94a4a] hover:bg-[#fee2e2] transition-colors border border-[#fecaca]">
                  🩺 Request pain level
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSendReply(); }}
                  placeholder="Type a message for the patient screen…"
                  aria-label="Message for patient"
                  className="input flex-1 text-sm"
                  maxLength={200}
                />
                <button onClick={startVoiceReply} aria-label="Voice input"
                  title="Speak your message"
                  className={`p-2.5 rounded-xl border transition-colors ${micActive ? "bg-[#fef2f2] border-[#fecaca] text-[#d94a4a]" : "bg-white border-[#ececec] text-[#6e6e6e] hover:text-[#c63a22]"}`}>
                  <Mic className={`w-4 h-4 ${micActive ? "animate-pulse" : ""}`} />
                </button>
                <button onClick={() => handleSendReply()} disabled={!replyText.trim()}
                  className="btn-primary px-4 py-2.5 text-sm disabled:opacity-40">Send</button>
              </div>
              <p className="text-[10px] text-[#9ca3af] mt-2">Messages appear full-screen on the patient device and are spoken aloud.</p>
            </div>

            {/* messages typed by a companion sitting with the patient */}
            <div className="card p-5">
              <button
                onClick={() => setUnseenMsgs(0)}
                className="w-full flex items-center gap-2 mb-3 text-left"
                title={unseenMsgs > 0 ? `${unseenMsgs} new message(s) — click to mark read` : undefined}
              >
                <Send className="w-4 h-4 text-[#22a67e]" />
                <h3 className="text-sm font-semibold text-[#1f1f1f] flex-1">From Patient Side</h3>
                {unseenMsgs > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-[#c63a22] text-white text-[10px] font-bold animate-pulse">
                    {unseenMsgs}
                  </span>
                )}
              </button>
              {patientMsgs.length === 0 ? (
                <p className="text-xs text-[#9ca3af]">
                  Notes typed by someone sitting with the patient appear here instantly.
                </p>
              ) : (
                <ul className="space-y-2 max-h-48 overflow-y-auto" role="log" aria-live="polite">
                  {patientMsgs.map((m) => (
                    <li key={m.id} className="rounded-xl bg-[#f0fdf4] border border-[#bbf7d0] px-3 py-2">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[#16855f]">{m.from}</span>
                        <span className="text-[10px] text-[#9ca3af]">{new Date(m.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-sm text-[#1f1f1f] break-words">{m.text}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <ClinicianActions entries={actionable} onAcknowledge={handleAcknowledge} onEscalate={handleEscalate} onResolve={handleResolve} />

            {/* automation audit trail */}
            {autoNotes.length > 0 && (
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-[#e8993e]" />
                  Automation Log
                </h3>
                <ul className="space-y-1.5">
                  {autoNotes.map((n, i) => (
                    <li key={i} className="text-xs text-[#6e6e6e]">{n}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* truthful system status card */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#c63a22]" />
                System Status
              </h3>
              <div className="space-y-2">
                {[
                  { label: "Transport", value: transport === "sse" ? "Server-Sent Events (push) + REST reconcile" : transport === "poll" ? "Adaptive polling" : transport === "offline" ? "Offline — queued" : "—", ok: status === "connected" },
                  { label: "Data store", value: driver === "redis" ? "Upstash Redis (cross-instance)" : driver === "memory" ? "In-memory (single instance)" : "—", ok: driver === "redis" },
                  { label: "Patient camera", value: remoteMetrics && Object.keys(remoteMetrics).length > 0 ? "Streaming metrics" : "No metrics yet", ok: Object.keys(remoteMetrics).length > 0 },
                  { label: "IoT wearable", value: primaryVitals ? `Connected · ${primaryVitals.deviceId}` : "Not paired (optional)", ok: !!primaryVitals },
                  { label: "Privacy", value: "Video never leaves the patient device", ok: true },
                ].map((row, i) => (
                  <div key={i} className="flex items-center justify-between text-xs gap-2">
                    <span className="text-[#6e6e6e] shrink-0">{row.label}</span>
                    <span className={`font-medium truncate ${row.ok ? "text-[#22a67e]" : "text-[#9ca3af]"}`}>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-[#c63a22]" />
                Escalation Rules (active)
              </h3>
              <div className="space-y-2">
                {ESCALATION_RULES.map((rule) => (
                  <div key={rule.type} className="flex items-center justify-between text-xs">
                    <span className="text-[#6e6e6e]">
                      {rule.type === "help_frequency" ? `${rule.threshold}+ HELP in ${Math.round(rule.windowMs / 1000)}s` :
                       rule.type === "low_alertness" ? `Alertness < ${rule.threshold}% for ${Math.round(rule.windowMs / 1000)}s` :
                       `Inactivity ≥ ${Math.round(rule.threshold / 1000)}s`}
                    </span>
                    <span className="badge-success px-2 py-0.5 rounded text-[10px] font-medium">Enforced</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}



