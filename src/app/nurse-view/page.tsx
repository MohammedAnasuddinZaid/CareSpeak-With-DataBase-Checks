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
import { GestureLogEntry, ESCALATION_RULES } from "@/types";
import { getSession, setSessionId } from "@/lib/session";
import { useLiveSync } from "@/hooks/useLiveSync";
import { evaluateEscalations } from "@/lib/escalation";
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
  }, []);

  const { status, transport, remoteMetrics, vitals, sendAction, sendReply } = useLiveSync({
    sessionId: sessionInput,
    enabled: paired,
    onAlert: handleAlert,
  });

  /* ── pairing (QR auto-pair via ?session=) ── */
  useEffect(() => {
    const existing = getSession();
    if (existing?.sessionId) {
      setSessionInput(existing.sessionId);
      setPaired(true);
      return;
    }
    const urlSession = new URLSearchParams(window.location.search).get("session");
    if (urlSession && urlSession.length >= 3) {
      const id = urlSession.toUpperCase();
      setSessionId(id);
      setSessionInput(id);
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

  useEffect(() => {
    const logRefCurrent = () => logRef.current;
    const evaluate = () => {
      const snapshot = logRefCurrent();
      const decisions = evaluateEscalations(snapshot, primaryMetrics, Date.now());
      if (decisions.length === 0) return;
      const byId = new Map(decisions.map((d) => [d.entryId, d]));

      // pure state transition
      setLog((prevLog) => {
        let changed = false;
        const next = prevLog.map((e) => {
          const d = byId.get(e.id);
          if (!d || e.escalated || e.resolved) return e;
          changed = true;
          return { ...e, escalated: true, escalatedBy: "system" as const, escalatedRule: d.rule, escalatedAt: Date.now() };
        });
        return changed ? next : prevLog;
      });

      // side effects outside the updater
      for (const e of snapshot) {
        const d = byId.get(e.id);
        if (!d || e.escalated || e.resolved) continue;
        sendAction({
          type: "escalate",
          entryId: e.id,
          timestamp: Date.now(),
          actor: "CareSpeak Engine",
          bySystem: true,
        });
        setAutoNotes((notes) =>
          [`${new Date().toLocaleTimeString()} · Auto-escalated ${e.gesture} — ${d.reason}`, ...notes].slice(0, 6)
        );
      }
    };
    const t = setInterval(evaluate, 10000);
    return () => clearInterval(t);
  }, [primaryMetrics, sendAction]);

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
  const statusColor =
    status === "connected" ? "bg-[#22a67e]" : status === "reconnecting" ? "bg-[#e8993e]" : "bg-[#d94a4a]";
  const statusText =
    status === "connected"
      ? `Live · ${transport.toUpperCase()}`
      : status === "reconnecting"
      ? "Reconnecting..."
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
            <a href="/report" target="_blank" rel="noreferrer" className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm">
              <FileText className="w-4 h-4" />
              Shift Report
            </a>
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
                onChange={(e) => setSessionInput(e.target.value.toUpperCase().slice(0, 12))}
                placeholder="Enter Session ID (e.g., ABC123)"
                aria-label="Session ID"
                className="input flex-1 font-mono tracking-widest uppercase"
                maxLength={12}
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
          </div>
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
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
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
                        className={`flex items-center gap-4 px-6 py-4 transition-all duration-200 ${
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
                              className="p-2 rounded-lg bg-[#ecfdf5] hover:bg-[#d1fae5] text-[#22a67e] transition-all duration-200"><CheckCircle className="w-4 h-4" /></button>
                          )}
                          {entry.acknowledged && !entry.escalated && !entry.resolved && (
                            <button onClick={() => handleEscalate(entry.id)} aria-label="Escalate"
                              className="p-2 rounded-lg bg-[#fef2f2] hover:bg-[#fee2e2] text-[#d94a4a] transition-all duration-200"><ArrowUpCircle className="w-4 h-4" /></button>
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
                        className={`rounded-t-sm transition-all ${count > 0 ? "bg-[#c63a22]/70 group-hover:bg-[#c63a22]" : "bg-[#ececec]"}`}
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

            {/* two-way messaging */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                <Send className="w-4 h-4 text-[#c63a22]" />
                Message Patient
              </h3>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {QUICK_REPLIES.map((q) => (
                  <button key={q} onClick={() => handleSendReply(q)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#eff6ff] text-[#3b82f6] hover:bg-[#dbeafe] transition-all border border-[#bfdbfe]">
                    {q}
                  </button>
                ))}
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
                  className={`p-2.5 rounded-xl border transition-all ${micActive ? "bg-[#fef2f2] border-[#fecaca] text-[#d94a4a]" : "bg-white border-[#ececec] text-[#6e6e6e] hover:text-[#c63a22]"}`}>
                  <Mic className={`w-4 h-4 ${micActive ? "animate-pulse" : ""}`} />
                </button>
                <button onClick={() => handleSendReply()} disabled={!replyText.trim()}
                  className="btn-primary px-4 py-2.5 text-sm disabled:opacity-40">Send</button>
              </div>
              <p className="text-[10px] text-[#9ca3af] mt-2">Messages appear full-screen on the patient device and are spoken aloud.</p>
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
                  { label: "Transport", value: transport === "sse" ? "Server-Sent Events (push)" : transport === "poll" ? "Adaptive polling" : transport === "offline" ? "Offline — queued" : "—", ok: status === "connected" },
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



