"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BedDouble, RefreshCw, Activity, ArrowUpRight, HeartPulse } from "lucide-react";
import { formatRelativeTime } from "@/components/uiConstants";

interface WardRow {
  session: string;
  lastSeen: number;
  lastGesture: string | null;
  lastAt: number | null;
  unacknowledged: number;
  escalated: number;
  today: number;
  alertness: number | null;
  movement: number | null;
  heartRate: number | null;
  spo2: number | null;
  sosActive: boolean;
}

type Band = "critical" | "warning" | "active" | "idle";

function bandOf(r: WardRow): Band {
  if (r.sosActive || r.escalated > 0) return "critical";
  const hrBad = r.heartRate != null && (r.heartRate < 50 || r.heartRate > 120);
  const spo2Bad = r.spo2 != null && r.spo2 < 92;
  const sleepy = r.alertness != null && r.alertness < 25;
  if (r.unacknowledged > 0 || hrBad || spo2Bad || sleepy) return "warning";
  if (Date.now() - r.lastSeen < 5 * 60 * 1000) return "active";
  return "idle";
}

const BAND_STYLE: Record<Band, { ring: string; chip: string; label: string }> = {
  critical: { ring: "border-[#d94a4a] bg-[#fef2f2]", chip: "bg-[#d94a4a] text-white", label: "CRITICAL" },
  warning: { ring: "border-[#e8993e] bg-[#fffbeb]", chip: "bg-[#e8993e] text-white", label: "NEEDS REVIEW" },
  active: { ring: "border-[#22a67e]/40 bg-white", chip: "bg-[#22a67e] text-white", label: "STABLE" },
  idle: { ring: "border-[#ececec] bg-white", chip: "bg-[#f5f3f0] text-[#6e6e6e]", label: "IDLE" },
};

export default function WardPage() {
  const [rows, setRows] = useState<WardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ward", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions?: WardRow[] };
        setRows(data.sessions ?? []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 2500);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const counts = { critical: 0, warning: 0, active: 0, idle: 0 } as Record<Band, number>;
  for (const r of rows) counts[bandOf(r)]++;

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
              <BedDouble className="w-4 h-4" />
              Ward Overview
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Every Patient. One Screen.</h1>
            <p className="mt-2 text-[#6e6e6e] max-w-xl">
              Live status of every CareSpeak session in this facility — risk-banded and sorted so the nurse walks to the right bed first.
            </p>
          </div>
          <button onClick={() => void load()} className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </motion.div>

        {/* summary strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {(
            [
              ["critical", "Critical", counts.critical],
              ["warning", "Needs review", counts.warning],
              ["active", "Stable", counts.active],
              ["idle", "Idle / offline", counts.idle],
            ] as [Band, string, number][]
          ).map(([band, label, n]) => (
            <div key={band} className={`card p-4 border ${BAND_STYLE[band].ring}`}>
              <div className="text-[10px] uppercase tracking-wider font-bold mb-1 text-[#6e6e6e]">{label}</div>
              <div className="text-2xl font-extrabold text-[#1f1f1f]">{n}</div>
            </div>
          ))}
        </div>

        {loading ? (
          <div className="card p-12 text-center text-sm text-[#6e6e6e]">Loading ward…</div>
        ) : rows.length === 0 ? (
          <div className="card p-16 text-center">
            <Activity className="w-10 h-10 text-[#d5d5d5] mx-auto mb-4" />
            <p className="font-medium text-[#1f1f1f]">No active patients yet</p>
            <p className="text-xs text-[#9ca3af] mt-1">
              Sessions appear here automatically the moment any device sends a gesture or vitals.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {rows.map((r) => {
              const band = bandOf(r);
              const st = BAND_STYLE[band];
              return (
                <motion.a
                  key={r.session}
                  href={`/nurse-view?session=${r.session}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-3xl border ${st.ring} p-5 block transition-all hover:shadow-lg hover:-translate-y-0.5`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-lg font-black tracking-[0.18em] text-[#1f1f1f] font-mono">{r.session}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${st.chip}`}>{st.label}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-3 min-h-[28px]">
                    <span className={`text-xl font-extrabold ${r.lastGesture === "EMERGENCY" || r.lastGesture === "HELP" ? "text-[#d94a4a]" : "text-[#1f1f1f]"}`}>
                      {r.lastGesture ?? "—"}
                    </span>
                    <span className="text-xs text-[#9ca3af]">
                      {r.lastAt ? formatRelativeTime(r.lastAt, now) : "no events yet"}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-center mb-3">
                    {[
                      ["HR", r.heartRate != null ? String(r.heartRate) : "—"],
                      ["SpO₂", r.spo2 != null ? String(r.spo2) : "—"],
                      ["Alert%", r.alertness != null ? String(Math.round(r.alertness)) : "—"],
                      ["Today", String(r.today)],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-[#fafaf9] py-1.5">
                        <div className="text-[9px] uppercase text-[#9ca3af] font-bold">{k}</div>
                        <div className="text-sm font-bold text-[#1f1f1f]">{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-[#6e6e6e]">
                    <span className="flex items-center gap-1">
                      {r.unacknowledged + r.escalated > 0 ? (
                        <>
                          <HeartPulse className="w-3 h-3 text-[#d94a4a]" />
                          {r.unacknowledged + r.escalated} pending
                        </>
                      ) : (
                        <>All clear</>
                      )}
                    </span>
                    <span className="flex items-center gap-0.5 font-semibold text-[#c63a22]">
                      Console <ArrowUpRight className="w-3 h-3" />
                    </span>
                  </div>
                </motion.a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
