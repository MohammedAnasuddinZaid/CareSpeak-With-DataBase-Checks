"use client";

import React, { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BedDouble,
  CheckCircle,
  ClipboardList,
  Clock,
  Pill,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
  UserCheck,
} from "lucide-react";
import { fmtMs, fmtRate } from "@/lib/bottlenecks";
import type { MarBoard, RepositioningWatch, RoundingBoard, StaffSla } from "@/lib/operations";

interface OpsPayload {
  ok: boolean;
  error?: string;
  scope: "ward";
  serverTime: number;
  selfOnly: boolean;
  slaTargetMs: number;
  scoreboard: StaffSla[];
  rounding: RoundingBoard;
  mar: MarBoard;
  repositioning: RepositioningWatch;
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

function Scoreboard({ rows, selfOnly }: { rows: StaffSla[]; selfOnly: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-[#6e6e6e] flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-[#15803d]" /> No acknowledged alerts in the last 7 days to score yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-[#6e6e6e] border-b border-[#eee]">
            <th className="py-2">Staff</th>
            <th className="py-2">Responses</th>
            <th className="py-2">Median ack</th>
            <th className="py-2">p90 ack</th>
            <th className="py-2">On SLA</th>
            <th className="py-2">Over SLA</th>
            <th className="py-2">Escalated</th>
            <th className="py-2">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.staffId} className="border-b border-[#f5f5f5]">
              <td className="py-2 font-semibold text-[#1f1f1f]">
                {r.name}
                {r.dataSufficient && r.slaRate !== null && r.slaRate < 0.66 && (
                  <span className="badge-danger ml-2 text-[10px]">behind</span>
                )}
                {!r.dataSufficient && <span className="badge-neutral ml-2 text-[10px]">thin data</span>}
              </td>
              <td className="py-2 text-[#6e6e6e]">{r.acked}</td>
              <td className="py-2 font-semibold text-[#1f1f1f]">{fmtMs(r.medianMs)}</td>
              <td className="py-2 text-[#6e6e6e]">{fmtMs(r.p90Ms)}</td>
              <td className="py-2 text-[#6e6e6e]">{fmtRate(r.slaRate)}</td>
              <td className="py-2 text-[#6e6e6e]">{r.overSla}</td>
              <td className="py-2 text-[#6e6e6e]">{r.escalated}</td>
              <td className="py-2 text-[#6e6e6e]">{r.resolved}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selfOnly && (
        <div className="mt-3 text-xs text-[#6e6e6e]">
          You can see your own response record; only admins see the full ward comparison.
        </div>
      )}
    </div>
  );
}

function RoundingBoardView({ board }: { board: RoundingBoard }) {
  if (board.byKind.length === 0) {
    return <div className="text-sm text-[#6e6e6e]">No scheduled care tasks in view today.</div>;
  }
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[#6e6e6e] border-b border-[#eee]">
              <th className="py-2">Kind</th>
              <th className="py-2">Scheduled</th>
              <th className="py-2">Done</th>
              <th className="py-2">On time</th>
              <th className="py-2">Overdue</th>
              <th className="py-2">On-time rate</th>
            </tr>
          </thead>
          <tbody>
            {board.byKind.map((k) => (
              <tr key={k.kind} className="border-b border-[#f5f5f5]">
                <td className="py-2 font-semibold text-[#1f1f1f] capitalize">
                  {k.kind}
                  {k.overdue > 0 && <span className="badge-danger ml-2 text-[10px]">{k.overdue} overdue</span>}
                </td>
                <td className="py-2 text-[#6e6e6e]">{k.scheduled}</td>
                <td className="py-2 text-[#6e6e6e]">{k.done}</td>
                <td className="py-2 text-[#6e6e6e]">{k.onTime}</td>
                <td className="py-2 text-[#6e6e6e]">{k.overdue}</td>
                <td className="py-2 text-[#6e6e6e]">{fmtRate(k.onTimeRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {board.overdue.length > 0 && (
        <div className="rounded-lg bg-[#fffbeb] border border-[#e8993e]/40 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-3">
            <Clock className="w-4 h-4 text-[#d97706]" /> Overdue right now
          </div>
          <ul className="space-y-1.5 text-sm">
            {board.overdue.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[#1f1f1f]">
                <span className="capitalize font-semibold">{t.kind}</span>
                {t.bedCode && <span className="font-mono text-[#6e6e6e]">{t.bedCode}</span>}
                {t.patient && <span className="text-[#6e6e6e]">· {t.patient}</span>}
                {t.title && <span className="text-[#6e6e6e]">· {t.title}</span>}
                <span className="ml-auto text-[#d97706] font-semibold">due {fmtMs(t.overdueMs)} ago</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MarView({ mar }: { mar: MarBoard }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <Kpi label="Doses today" value={String(mar.scheduled)} />
      <Kpi label="Given" value={String(mar.given)} sub={`${mar.missed} missed · ${mar.held} held · ${mar.refused} refused`} />
      <Kpi
        label="Adherence"
        value={fmtRate(mar.adherenceRate)}
        accent={mar.adherenceRate !== null && mar.adherenceRate < 0.9}
      />
    </div>
  );
}

function RepositioningView({ watch }: { watch: RepositioningWatch }) {
  if (watch.items.length === 0) {
    return (
      <div className="text-sm text-[#6e6e6e] flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-[#15803d]" /> No open inactivity, fall or bed-exit alerts right now.
      </div>
    );
  }
  return (
    <ul className="space-y-2 text-sm">
      {watch.items.map((w) => (
        <li key={w.id} className="flex items-center gap-3">
          <span className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${w.repositioningDue ? "bg-[#d92d20]" : "bg-[#d97706]"}`} />
          <div className="min-w-0">
            <div className="font-semibold text-[#1f1f1f] capitalize">
              {w.kind.replace("_", " ")}
              {w.repositioningDue && <span className="badge-danger ml-2 text-[10px]">reposition now</span>}
              {!w.repositioningDue && <span className="badge-warning ml-2 text-[10px]">watch</span>}
            </div>
            <div className="text-[#6e6e6e] truncate">
              {w.bedCode ? <span className="font-mono">{w.bedCode}</span> : w.session && <span className="font-mono">{w.session}</span>}
              {w.patient && <> · {w.patient}</>} · {w.title ?? w.kind}
            </div>
          </div>
          <span className="ml-auto shrink-0 font-bold text-[#1f1f1f]">{fmtMs(w.ageMs)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function OperationsPage() {
  const [data, setData] = useState<OpsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authGap, setAuthGap] = useState<null | { status: number; message: string }>(null);

  const load = useCallback(async () => {
    setError(null);
    setAuthGap(null);
    const { status, body } = await fetchJson<OpsPayload>("/api/operations");
    if (status === 401 || status === 403) {
      setAuthGap({ status, message: status === 401 ? "Sign in to view the operations command." : "Your role cannot view ward operations." });
      return;
    }
    if (status !== 200 || !body?.ok) {
      setError(body?.error ?? "Could not load the operations command.");
      return;
    }
    setData(body);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
              <ClipboardList className="w-4 h-4" />
              Operations Command
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Did the ward actually do the work?</h1>
            <p className="mt-2 text-[#6e6e6e] max-w-2xl">
              Closed-loop accountability drawn from the audit columns the database already writes: who acked alarms in time,
              whether today&apos;s repositioning rounds are happening, whether doses are being given, and which beds need a
              nurse walked to them now.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/insights" className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2">
              <Activity className="w-4 h-4" /> Care Flow
            </a>
            <button onClick={() => void load()} className="btn-primary px-4 py-2.5 text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
        </motion.div>

        {error && (
          <div className="card p-6 border border-[#e8993e]/40 bg-[#fffbeb] text-sm text-[#1f1f1f] mb-6">{error}</div>
        )}

        {authGap && (
          <div className="card p-8 text-center border border-[#e8993e]/40 bg-[#fffbeb]">
            <ShieldAlert className="w-8 h-8 mx-auto mb-3 text-[#c77a1f]" />
            <h2 className="text-lg font-semibold text-[#1f1f1f] mb-1">{authGap.message}</h2>
            <p className="text-sm text-[#6e6e6e] max-w-md mx-auto mb-5">
              This view reads attributed clinical actions, so it is limited to clinical accounts.
            </p>
            {authGap.status === 401 && (
              <a href="/login?next=%2Foperations" className="btn-primary px-5 py-2.5 text-sm inline-flex items-center gap-2">
                Sign in <ArrowRight className="w-4 h-4" />
              </a>
            )}
          </div>
        )}

        {!data && !error && !authGap && (
          <div className="card p-10 text-center text-sm text-[#6e6e6e] border border-[#e6e6e6]">Reading the ward…</div>
        )}

        {data && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Response SLA" value={fmtRate(data.scoreboard.reduce((r, s) => r + (s.slaRate ?? 0), 0) / Math.max(1, data.scoreboard.length))} sub={`${data.scoreboard.length} staff scored in 7d`} />
              <Kpi label="Positioning overdue" value={String(data.rounding.byKind.find((k) => k.kind === "positioning")?.overdue ?? 0)} sub="Tasks needing a nurse now" accent={(data.rounding.byKind.find((k) => k.kind === "positioning")?.overdue ?? 0) > 0} />
              <Kpi label="Repositioning watch" value={String(data.repositioning.dueCount)} sub="Inactivity/fall alerts > 2h" accent={data.repositioning.dueCount > 0} />
              <Kpi label="MAR adherence" value={fmtRate(data.mar.adherenceRate)} sub="Doses given vs scheduled" accent={data.mar.adherenceRate !== null && data.mar.adherenceRate < 0.9} />
            </div>

            <div className="card p-5 border border-[#e6e6e6]">
              <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
                <UserCheck className="w-4 h-4 text-[#c63a22]" /> Staff response scoreboard
                {data.selfOnly && <span className="badge-neutral ml-auto text-[10px]">your record</span>}
              </div>
              <Scoreboard rows={data.scoreboard} selfOnly={data.selfOnly} />
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="card p-5 border border-[#e6e6e6]">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f]">
                    <BedDouble className="w-4 h-4 text-[#c63a22]" /> Rounding &amp; repositioning
                  </div>
                  <span className="text-xs text-[#6e6e6e]">on-time {fmtRate(data.rounding.overallOnTimeRate)}</span>
                </div>
                <RoundingBoardView board={data.rounding} />
              </div>

              <div className="card p-5 border border-[#e6e6e6]">
                <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
                  <Pill className="w-4 h-4 text-[#c63a22]" /> Medication today
                </div>
                <MarView mar={data.mar} />
              </div>
            </div>

            <div className="card p-5 border border-[#e6e6e6]">
              <div className="flex items-center gap-2 text-sm font-bold text-[#1f1f1f] mb-4">
                <Clock className="w-4 h-4 text-[#c63a22]" /> Repositioning watch
              </div>
              <RepositioningView watch={data.repositioning} />
              <div className="mt-4 border-t border-[#eee] pt-4 space-y-1.5 text-xs text-[#6e6e6e]">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-[#15803d]" />
                  Hourly rounding cuts call-light use by ~54% and falls by ~57% (systematic review, PMC4656540; Meade 2006).
                </div>
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-[#15803d]" />
                  Reposition every 2–4 hours for patients at pressure-injury risk (RNAO best-practice guideline 2.0; NICE QS89).
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}