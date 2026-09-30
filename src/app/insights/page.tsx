"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CheckCircle,
  ClipboardList,
  Clock,
  Gauge,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
  Zap,
} from "lucide-react";
import { claimConsoleToken } from "@/lib/session";
import {
  fmtMs,
  fmtRate,
  type BottleneckNote,
  type BottleneckReport,
} from "@/lib/bottlenecks";
import type { ShiftPoint } from "@/lib/operations";

type NoteSeverity = BottleneckNote["severity"];

const SEVERITY_STYLE: Record<NoteSeverity, { chip: string; dot: string }> = {
  high: { chip: "badge-danger", dot: "bg-[#d92d20]" },
  medium: { chip: "badge-warning", dot: "bg-[#d97706]" },
  low: { chip: "badge-neutral", dot: "bg-[#94a3b8]" },
};

interface SessionInsightPayload {
  ok: boolean;
  error?: string;
  scope: "session";
  session: string;
  serverTime: number;
  lastActivityMs: number | null;
  report: BottleneckReport;
}

interface WardBedPayload {
  session: string;
  bed: string | null;
  patient: string | null;
  lastActivityMs: number | null;
  stalled: boolean;
  report: BottleneckReport;
}

interface WardInsightPayload {
  ok: boolean;
  error?: string;
  scope: "ward";
  serverTime: number;
  occupancy: { activeSessions: number; stalledBeds: number };
  overall: BottleneckReport;
  perSession: WardBedPayload[];
  shiftTrend: ShiftPoint[];
}

async function fetchJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card p-4 border border-[#e6e6e6]">
      <div className="text-[10px] uppercase tracking-wider font-bold mb-1 text-[#6e6e6e]">{label}</div>
      <div className={`text-2xl font-extrabold ${accent ? "text-[#c63a22]" : "text-[#1f1f1f]"}`}>{value}</div>
      {sub && <div className="text-xs text-[#6e6e6e] mt-1">{sub}</div>}
    </div>
  );
}

function Funnel({ report }: { report: BottleneckReport }) {
  const { raised, acknowledged, escalated, resolved } = report.funnel;
  const max = Math.max(1, raised);
  const stages: { label: string; n: number; bar: string }[] = [
    { label: "Raised", n: raised, bar: "bg-[#1f1f1f]" },
    { label: "Acknowledged", n: acknowledged, bar: "bg-[#c63a22]" },
    { label: "Escalated", n: escalated, bar: "bg-[#d97706]" },
    { label: "Resolved", n: resolved, bar: "bg-[#15803d]" },
  ];
  return (
    <div className="space-y-2">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-xs text-[#6e6e6e]">{s.label}</div>
          <div className="flex-1 h-3 rounded-full bg-[#f3f3f3] overflow-hidden">
            <div
              className={`h-full rounded-full ${s.bar} transition-all duration-500`}
              style={{ width: `${(s.n / max) * 100}%` }}
            />
          </div>
          <div className="w-10 shrink-0 text-right text-sm font-bold text-[#1f1f1f]">{s.n}</div>
        </div>
      ))}
    </div>
  );
}

function NotesList({ notes }: { notes: BottleneckNote[] }) {
  if (notes.length === 0) {
    return (
      <div className="text-sm text-[#6e6e6e] flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-[#15803d]" /> No bottleneck currently flagged.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="flex items-start gap-3 text-sm">
          <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${SEVERITY_STYLE[n.severity].dot}`} />
          <div>
            <div className="font-semibold text-[#1f1f1f]">{n.title}</div>
            <div className="text-[#6e6e6e]">{n.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HourBars({ report }: { report: BottleneckReport }) {
  const max = Math.max(1, ...report.hourLatency.map((h) => h.avgAckMs ?? 0));
  if (report.hourLatency.length === 0) {
    return <div className="text-sm text-[#6e6e6e]">No acknowledged requests to break down by hour yet.</div>;
  }
  return (
    <div className="flex items-end gap-1 h-24">
      {report.hourLatency.map((h) => (
        <div key={h.hour} className="group relative flex-1 flex flex-col items-center justify-end h-full" title={`${h.label} · ${h.count} requests · avg ${fmtMs(h.avgAckMs)}`}>
          <div className="absolute -top-6 hidden group-hover:block text-[10px] bg-[#1f1f1f] text-white px-1.5 py-0.5 rounded whitespace-nowrap">
            {fmtMs(h.avgAckMs)}
          </div>
          <div
            className="w-full max-w-6 rounded-t bg-[#c63a22]/70 hover:bg-[#c63a22] transition-colors"
            style={{ height: `${Math.max(4, ((h.avgAckMs ?? 0) / max) * 96)}px` }}
          />
        </div>
      ))}
    </div>
  );
}

function ShiftTrend({ points }: { points: ShiftPoint[] }) {
  if (points.length === 0) {
    return <div className="text-sm text-[#6e6e6e]">No acknowledged requests in the last 7 days to plot by shift yet.</div>;
  }
  const max = Math.max(1, ...points.map((p) => p.medianMs ?? 0));
  return (
    <div className="space-y-2">
      {points.map((p) => {
        const worse = p.changePct !== null && p.changePct > 0;
        return (
          <div key={p.startMs} className="flex items-center gap-3">
            <div className="w-28 shrink-0 text-xs text-[#6e6e6e]">
              {p.day} · {p.slot}
            </div>
            <div className="flex-1 h-3 rounded-full bg-[#f3f3f3] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#c63a22] transition-all duration-500"
                style={{ width: `${((p.medianMs ?? 0) / max) * 100}%` }}
              />
            </div>
            <div className="w-20 shrink-0 text-right text-sm font-bold text-[#1f1f1f]">{fmtMs(p.medianMs)}</div>
            <div className="w-14 shrink-0 text-right text-xs">
              {p.changePct === null ? (
                <span className="text-[#b0b0b0]">—</span>
              ) : worse ? (
                <span className="text-[#d92d20]">▲ {Math.round(p.changePct)}%</span>
              ) : (
                <span className="text-[#15803d]">▼ {Math.round(-p.changePct)}%</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReportCards({ report }: { report: BottleneckReport }) {
  const openNow = report.funnel.raised - report.funnel.acknowledged;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Median time-to-ack" value={fmtMs(report.ack.medianMs)} sub={`${report.ack.n} acked · p90 ${fmtMs(report.ack.p90Ms)}`} accent={report.ack.medianMs !== null && report.ack.medianMs > 180_000} />
        <Kpi label="Unanswered now" value={String(openNow)} sub="Raised − acknowledged" accent={openNow > 0} />
        <Kpi label="Ack rate" value={fmtRate(report.funnel.ackRate)} sub={`${report.funnel.escalated} escalated`} />
        <Kpi label="Resolved" value={fmtRate(report.funnel.resolveRate)} sub={`${report.funnel.resolved} closed`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="card p-5 border border-[#e6e6e6]">
          <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
            <Gauge className="w-4 h-4 text-[#c63a22]" /> Response funnel
          </div>
          <Funnel report={report} />
        </div>
        <div className="card p-5 border border-[#e6e6e6]">
          <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
            <Clock className="w-4 h-4 text-[#c63a22]" /> Time-to-ack by hour
          </div>
          <HourBars report={report} />
        </div>
      </div>

      {report.notes.length > 0 && (
        <div className="card p-5 border border-[#e6e6e6] mt-4">
          <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
            <AlertTriangle className="w-4 h-4 text-[#c63a22]" /> Flagged bottlenecks
          </div>
          <NotesList notes={report.notes} />
        </div>
      )}

      {report.perGesture.length > 0 && (
        <div className="card p-5 border border-[#e6e6e6] mt-4 overflow-x-auto">
          <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
            <TrendingUp className="w-4 h-4 text-[#c63a22]" /> By request type
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-[#6e6e6e] border-b border-[#eee]">
                <th className="py-2">Request</th>
                <th className="py-2">Count</th>
                <th className="py-2">Ack rate</th>
                <th className="py-2">Avg ack</th>
                <th className="py-2">Unanswered</th>
              </tr>
            </thead>
            <tbody>
              {report.perGesture.map((g) => (
                <tr key={g.gesture} className="border-b border-[#f5f5f5]">
                  <td className="py-2 font-semibold text-[#1f1f1f]">
                    {g.gesture}
                    {g.highAcuity > 0 && <span className="badge-danger ml-2 text-[10px]">critical</span>}
                  </td>
                  <td className="py-2 text-[#6e6e6e]">{g.count}</td>
                  <td className="py-2 text-[#6e6e6e]">{fmtRate(g.ackRate)}</td>
                  <td className="py-2 text-[#6e6e6e]">{fmtMs(g.avgAckMs)}</td>
                  <td className="py-2 text-[#6e6e6e]">{g.unansweredNow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SampleWarning({ report }: { report: BottleneckReport }) {
  if (report.dataSufficient) return null;
  if (report.funnel.raised === 0) return null;
  return (
    <div className="badge-warning inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full">
      <Clock className="w-3.5 h-3.5" />
      Fewer than 5 requests so far — numbers are still forming and trends may not be meaningful yet.
    </div>
  );
}

export default function InsightsPage() {
  const [mode, setMode] = useState<"session" | "ward">("session");
  const [sessionInput, setSessionInput] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInsightPayload | null>(null);
  const [ward, setWard] = useState<WardInsightPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authGap, setAuthGap] = useState<null | { status: number; message: string }>(null);

  const codeFromQuery = useMemo(() => {
    if (typeof window === "undefined") return null;
    const c = new URLSearchParams(window.location.search).get("session");
    if (!c) return null;
    const norm = c.trim().toUpperCase();
    return /^[A-Z0-9_-]{3,32}$/.test(norm) ? norm : null;
  }, []);

  const loadSession = useCallback(async (code: string) => {
    setLoading(true);
    setError(null);
    setAuthGap(null);
    await claimConsoleToken(code).catch(() => null);
    const { status, body } = await fetchJson<SessionInsightPayload>(`/api/insights?session=${encodeURIComponent(code)}`);
    setLoading(false);
    if (status === 401 || status === 403) {
      setAuthGap({ status, message: status === 401 ? "Sign in to view this bed's care flow." : "You are not assigned to this patient." });
      return;
    }
    if (status !== 200 || !body?.ok) {
      setError(body?.error ?? "Could not load care-flow analysis.");
      return;
    }
    setSession(body);
  }, []);

  const loadWard = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAuthGap(null);
    const { status, body } = await fetchJson<WardInsightPayload>("/api/insights");
    setLoading(false);
    if (status === 401 || status === 403) {
      setAuthGap({ status, message: status === 401 ? "Sign in to view ward-wide analysis." : "Your role cannot view ward-wide analysis." });
      return;
    }
    if (status !== 200 || !body?.ok) {
      setError(body?.error ?? "Could not load ward analysis.");
      return;
    }
    setWard(body);
  }, []);

  useEffect(() => {
    if (codeFromQuery) {
      setSessionInput(codeFromQuery);
      setActiveCode(codeFromQuery);
      void loadSession(codeFromQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFromQuery]);

  useEffect(() => {
    if (mode !== "session" || !activeCode) return;
    const id = setInterval(() => void loadSession(activeCode), 10_000);
    return () => clearInterval(id);
  }, [mode, activeCode, loadSession]);

  useEffect(() => {
    if (mode !== "ward") return;
    const id = setInterval(() => void loadWard(), 15_000);
    return () => clearInterval(id);
  }, [mode, loadWard]);

  const startSession = () => {
    const norm = sessionInput.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(norm)) {
      setError("Enter a valid bed code (3–32 characters: A–Z, 0–9, _ or -).");
      return;
    }
    setMode("session");
    setActiveCode(norm);
    setWard(null);
    void loadSession(norm);
  };

  const showWard = () => {
    setMode("ward");
    setSession(null);
    setWard(null);
    void loadWard();
  };

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
              <Activity className="w-4 h-4" />
              Care Flow &amp; Bottleneck Analysis
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">How long did the patient wait?</h1>
            <p className="mt-2 text-[#6e6e6e] max-w-xl">
              PNH1 — the journey from raise to resolve, measured from the persisted alert lifecycle so the delay is a number, not a feeling.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={startSession} className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2">
              <BedDouble className="w-4 h-4" /> This bed
            </button>
            <button onClick={showWard} className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2">
              <Zap className="w-4 h-4" /> Ward-wide
            </button>
            <a href="/operations" className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2">
              <ClipboardList className="w-4 h-4" /> Operations
            </a>
            {mode === "session" && (
              <button onClick={() => activeCode && void loadSession(activeCode)} className="btn-primary px-4 py-2.5 text-sm flex items-center gap-2">
                <RefreshCw className="w-4 h-4" /> Refresh
              </button>
            )}
          </div>
        </motion.div>

        <div className="card p-5 border border-[#e6e6e6] mb-6">
          <div className="relative max-w-sm mb-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6e6e6e]" />
            <input
              type="text"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && startSession()}
              placeholder="Bed code (e.g. BED-0421)…"
              aria-label="Bed code"
              className="input w-full pl-9 font-mono uppercase tracking-widest"
            />
          </div>
          <p className="text-xs text-[#6e6e6e]">
            Scan a bed&apos;s QR code or type its code. Use <span className="font-mono">?session=CODE</span> to open straight into that bed.
          </p>
        </div>

        {loading && !session && !ward && !error && !authGap && (
          <div className="card p-10 text-center text-sm text-[#6e6e6e] border border-[#e6e6e6]">Analysing the care flow…</div>
        )}

        {error && (
          <div className="card p-6 border border-[#e8993e]/40 bg-[#fffbeb] text-sm text-[#1f1f1f] mb-6">{error}</div>
        )}

        {authGap && (
          <div className="card p-8 text-center border border-[#e8993e]/40 bg-[#fffbeb]">
            <ShieldAlert className="w-8 h-8 mx-auto mb-3 text-[#c77a1f]" />
            <h2 className="text-lg font-semibold text-[#1f1f1f] mb-1">{authGap.message}</h2>
            <p className="text-sm text-[#6e6e6e] max-w-md mx-auto mb-5">
              {authGap.status === 401
                ? "This view reads patient health information, so it is limited to clinical accounts; the empty state is the policy, not a bug."
                : "Epidemic of empty pages solved by honest access control."}
            </p>
            {authGap.status === 401 && (
              <a href="/login?next=%2Finsights" className="btn-primary px-5 py-2.5 text-sm inline-flex items-center gap-2">
                Sign in <ArrowRight className="w-4 h-4" />
              </a>
            )}
          </div>
        )}

        {mode === "session" && session && session.report && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="badge-neutral text-xs">Bed</span>
              <span className="font-mono font-bold text-[#1f1f1f]">{activeCode ?? session.session}</span>
              {session.lastActivityMs !== null && (
                <span className="text-xs text-[#6e6e6e]">Last request {new Date(session.lastActivityMs).toLocaleTimeString()}</span>
              )}
              <SampleWarning report={session.report} />
            </div>
            <ReportCards report={session.report} />
          </motion.div>
        )}

        {mode === "ward" && ward && ward.overall && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Kpi label="Active beds" value={String(ward.occupancy.activeSessions)} sub="Live console sessions" />
              <Kpi label="Stalled beds" value={String(ward.occupancy.stalledBeds)} sub="No activity in 30 min" accent={ward.occupancy.stalledBeds > 0} />
              <Kpi label="Requests / 72h" value={String(ward.overall.funnel.raised)} sub="Across the ward" />
              <Kpi label="Median time-to-ack" value={fmtMs(ward.overall.ack.medianMs)} sub={`${ward.overall.funnel.acknowledged} acked`} />
            </div>
            <ReportCards report={ward.overall} />

            {ward.shiftTrend.length > 0 && (
              <div className="card p-5 border border-[#e6e6e6] mt-4">
                <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
                  <TrendingUp className="w-4 h-4 text-[#c63a22]" /> Time-to-ack by shift · last 7 days
                </div>
                <div className="mb-2 text-xs text-[#6e6e6e]">Median time-to-ack per 8-hour shift; ▲ means the ward slowed down, ▼ means it got faster.</div>
                <ShiftTrend points={ward.shiftTrend} />
              </div>
            )}

            {ward.perSession.length > 0 && (
              <div className="card p-5 border border-[#e6e6e6] mt-4 overflow-x-auto">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f]">
                    <BedDouble className="w-4 h-4 text-[#c63a22]" /> Per-bed bottlenecks
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[#6e6e6e] border-b border-[#eee]">
                      <th className="py-2">Bed</th>
                      <th className="py-2">Patient</th>
                      <th className="py-2">Requests</th>
                      <th className="py-2">Median ack</th>
                      <th className="py-2">Unanswered</th>
                      <th className="py-2">Flags</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ward.perSession.map((b) => (
                      <tr key={b.session} className="border-b border-[#f5f5f5]">
                        <td className="py-2 font-mono font-bold text-[#1f1f1f]">{b.bed ?? b.session}</td>
                        <td className="py-2 text-[#6e6e6e]">{b.patient ?? "—"}</td>
                        <td className="py-2 text-[#6e6e6e]">{b.report.funnel.raised}</td>
                        <td className="py-2 text-[#6e6e6e]">{fmtMs(b.report.ack.medianMs)}</td>
                        <td className="py-2 text-[#6e6e6e]">{Math.max(0, b.report.funnel.raised - b.report.funnel.acknowledged)}</td>
                        <td className="py-2">
                          {b.stalled && <span className="badge-neutral mr-1 text-[10px]">stalled</span>}
                          {b.report.notes.some((n) => n.kind === "critical_open") && (
                            <span className="badge-danger text-[10px]">critical</span>
                          )}
                          {b.report.notes.some((n) => n.kind === "stuck_escalated") && (
                            <span className="badge-warning text-[10px]">stuck</span>
                          )}
                        </td>
                        <td className="py-2">
                          <a
                            href={`/insights?session=${encodeURIComponent(b.session)}`}
                            className="inline-flex items-center gap-1 text-[#c63a22] font-semibold hover:underline"
                          >
                            Open <ArrowRight className="w-3.5 h-3.5" />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}