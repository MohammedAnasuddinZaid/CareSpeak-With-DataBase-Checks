"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, ArrowLeft, FileText, CloudDownload } from "lucide-react";
import { loadGestureLog } from "@/lib/gestureLog";
import { computeStats, hourlyDistribution, toCsv } from "@/lib/analytics";
import { loadAuditLog, auditToCsv, type AuditEvent } from "@/lib/auditTrail";
import { citationPassage } from "@/lib/clinicalBasis";
import { GestureLogEntry } from "@/types";
import { getSession } from "@/lib/session";

/** Server entries carry a single `status` field; map it onto the boolean
 *  lifecycle flags the rest of the client expects. */
function entryFromStored(s: GestureLogEntry & { status?: string }): GestureLogEntry {
  const status = s.status ?? "none";
  return {
    ...s,
    acknowledged: s.acknowledged || status === "acknowledge" || status === "resolve",
    escalated: s.escalated || status === "escalate",
    resolved: s.resolved || status === "resolve",
    resolvedAt: status === "resolve" ? s.resolvedAt ?? (s.serverTime ?? s.timestamp) : s.resolvedAt,
  };
}

export default function ReportPage() {
  const [log, setLog] = useState<GestureLogEntry[]>([]);
  const [patientName, setPatientName] = useState("");
  const [ward, setWard] = useState("");
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Local history first (instant paint), then merge authoritative server
    // history so a nurse printing from ANY paired device gets the full shift.
    setLog(loadGestureLog());
    setAudit(loadAuditLog());
    try {
      const saved = localStorage.getItem("carespeak_report_meta");
      if (saved) {
        const meta = JSON.parse(saved) as { patientName?: string; ward?: string };
        setPatientName(meta.patientName ?? "");
        setWard(meta.ward ?? "");
      }
    } catch {}

    const session = getSession()?.sessionId;
    if (!session) return;
    let cancelled = false;
    fetch(`/api/sync?session=${encodeURIComponent(session)}&since=0`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { entries?: (GestureLogEntry & { status?: string })[] } | null) => {
        if (cancelled || !data?.entries?.length) return;
        const serverEntries = data.entries.map(entryFromStored);
        setSyncedCount(serverEntries.length);
        setLog((prevLocal) => {
          const byId = new Map<string, GestureLogEntry>();
          for (const e of prevLocal) byId.set(e.id, e); // local first…
          for (const e of serverEntries) byId.set(e.id, e); // …server wins (authoritative)
          const merged = [...byId.values()].sort(
            (a, b) => b.timestamp - a.timestamp
          );
          return merged;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => computeStats(log), [log]);
  const hourly = useMemo(() => hourlyDistribution(log), [log]);
  const peakHour = hourly.reduce((a, b) => (b.count > a.count ? b : a), { hour: 0, count: 0 });
  const helpCount = stats.byGesture["HELP"] ?? 0;
  const emergencyCount = stats.byGesture["EMERGENCY"] ?? 0;
  const escalatedCount = log.filter((e) => e.escalated).length;
  const avgResponseS =
    log.filter((e) => e.acknowledgedAt).length > 0
      ? Math.round(
          log.filter((e) => e.acknowledgedAt).reduce((acc, e) => acc + ((e.acknowledgedAt ?? 0) - e.timestamp), 0) /
            log.filter((e) => e.acknowledgedAt).length /
            1000
        )
      : null;

  const saveMeta = () => {
    try {
      localStorage.setItem("carespeak_report_meta", JSON.stringify({ patientName, ward }));
    } catch {}
  };

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between mb-8 no-print">
          <a href="/nurse-view" className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm"><ArrowLeft className="w-4 h-4" />Back</a>
          <button onClick={() => window.print()} className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm"><Printer className="w-4 h-4" />Print / Save PDF</button>
        </div>

        <div ref={printRef} className="card p-8 sm:p-10 print-card">
          <header className="border-b border-[#ececec] pb-6 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h1 className="text-2xl font-bold text-[#1f1f1f] flex items-center gap-2">
                <FileText className="w-6 h-6 text-[#c63a22]" />CareSpeak Clinical Summary
              </h1>
              <span className="text-xs text-[#9ca3af]">Generated {new Date().toLocaleString()}</span>
            </div>
            <p className="text-xs text-[#6e6e6e] mt-1">Auto-generated communication &amp; alert record for the current session.</p>
            {syncedCount != null && (
              <p className="text-[11px] text-[#22a67e] mt-1 flex items-center gap-1">
                <CloudDownload className="w-3 h-3" /> {syncedCount} events synced from the CareSpeak server (full shift, any device)
              </p>
            )}
          </header>

          <section className="grid grid-cols-2 gap-4 mb-6 no-print">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#6e6e6e]">Patient name / ID</span>
              <input value={patientName} onChange={(e) => setPatientName(e.target.value)} onBlur={saveMeta}
                placeholder="Enter patient name" className="input w-full mt-1" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#6e6e6e]">Ward / Room</span>
              <input value={ward} onChange={(e) => setWard(e.target.value)} onBlur={saveMeta}
                placeholder="e.g., ICU-04" className="input w-full mt-1" />
            </label>
          </section>
          {(patientName || ward) && (
            <p className="hidden print:block text-sm mb-4"><strong>Patient:</strong> {patientName || "—"} · <strong>Ward:</strong> {ward || "—"}</p>
          )}

          <section className="mb-8">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[#6e6e6e] mb-3">Session Overview</h2>
            <table className="w-full text-sm border-collapse">
              <tbody>
                {[
                  ["Total gestures recorded", String(stats.total)],
                  ["Gestures today", String(stats.today)],
                  ["HELP calls", String(helpCount)],
                  ["EMERGENCY alerts", String(emergencyCount)],
                  ["Escalations (auto + manual)", String(escalatedCount)],
                  ["Unacknowledged at time of report", String(stats.unacknowledged)],
                  ["Median nurse response", avgResponseS != null ? `~${avgResponseS}s` : "No acknowledgements yet"],
                  ["Peak activity hour", peakHour.count > 0 ? `${peakHour.hour}:00 (${peakHour.count} gestures)` : "—"],
                ].map(([k, v]) => (
                  <tr key={k} className="border-b border-[#f0f0f0]">
                    <td className="py-2 text-[#6e6e6e]">{k}</td>
                    <td className="py-2 text-right font-semibold text-[#1f1f1f]">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="mb-8">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[#6e6e6e] mb-3">Hourly Distribution (today&apos;s session)</h2>
            <div className="flex items-end gap-1 h-24">
              {hourly.map(({ hour, count }) => {
                const max = Math.max(...hourly.map((d) => d.count), 1);
                return (
                  <div key={hour} className="flex-1 flex flex-col justify-end" title={`${hour}:00 — ${count}`}>
                    <div className={`rounded-t-sm ${count > 0 ? "bg-[#c63a22]/70" : "bg-[#ececec]"}`} style={{ height: `${Math.max(4, (count / max) * 100)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-[#9ca3af] mt-1">
              <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-bold uppercase tracking-widest text-[#6e6e6e] mb-3">Recent Events ({Math.min(log.length, 25)} latest)</h2>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b-2 border-[#ececec] text-left text-[#6e6e6e] uppercase tracking-wider text-[10px]">
                  <th className="py-2 pr-2">Time</th><th className="pr-2">Gesture</th><th className="pr-2">Type</th><th className="pr-2">Conf.</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 25).map((e) => (
                  <tr key={e.id} className="border-b border-[#f0f0f0]">
                    <td className="py-1.5 pr-2">{new Date(e.timestamp).toLocaleTimeString()}</td>
                    <td className="pr-2 font-semibold">{e.gesture}</td>
                    <td className="pr-2">{e.type}{e.source === "iot" ? " (wearable)" : ""}</td>
                    <td className="pr-2">{Math.round(e.confidence * 100)}%</td>
                    <td>{e.resolved ? "Resolved" : e.escalated ? "Escalated" : e.acknowledged ? "Acknowledged" : "Pending"}</td>
                  </tr>
                ))}
                {log.length === 0 && (
                  <tr><td colSpan={5} className="py-4 text-center text-[#9ca3af]">No events recorded in this session.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {/* ── automation audit trail: replayable record of every engine decision ── */}
          <section className="mt-8">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[#6e6e6e] mb-3">
              Automation Audit Trail ({audit.length} engine decisions)
            </h2>
            {audit.length === 0 ? (
              <p className="text-xs text-[#9ca3af]">No automated decisions recorded in this shift.</p>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b-2 border-[#ececec] text-left text-[#6e6e6e] uppercase tracking-wider text-[10px]">
                    <th className="py-2 pr-2">Time</th><th className="pr-2">Decision</th><th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.slice(0, 40).map((e) => (
                    <tr key={e.id} className="border-b border-[#f0f0f0] align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</td>
                      <td className="pr-2 font-semibold whitespace-nowrap">{kindLabel(e.kind)}</td>
                      <td>
                        {e.detail}
                        {e.citation && (
                          <span className="block text-[10px] text-[#6e6e6e] mt-0.5">
                            Basis — {citationPassage(e.citation)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[10px] text-[#9ca3af] mt-2">
              Clinical basis citations reference curated summaries of published guidance (NEWS 2, NICE CG50);
              verify against source guidance before clinical use.
            </p>
          </section>

          <footer className="mt-8 pt-4 border-t border-[#ececec] text-[10px] text-[#9ca3af] flex items-center justify-between">
            <span>CareSpeak — on-device assistive communication. All processing local; only gesture metadata is shared.</span>
            <span>Page 1 of 1</span>
          </footer>
        </div>

        <button
          onClick={() => downloadCsv(log)}
          className="no-print mt-4 btn-secondary w-full py-3 text-sm flex items-center justify-center gap-2"
        >
          Download raw data (CSV)
        </button>
        {audit.length > 0 && (
          <button
            onClick={downloadAuditCsv}
            className="no-print mt-2 btn-secondary w-full py-3 text-sm flex items-center justify-center gap-2"
          >
            Download automation audit trail (CSV)
          </button>
        )}
      </div>

      <style jsx global>{`
        @media print {
          body { background: white; }
          .no-print { display: none !important; }
          nav, footer { display: none !important; }
          .print-card { box-shadow: none !important; border: none !important; }
          main { padding-top: 0 !important; }
        }
      `}</style>
    </div>
  );
}

function kindLabel(kind: AuditEvent["kind"]): string {
  return {
    auto_escalate: "Auto-escalation",
    escalation_chain: "Escalation chain",
    trajectory_alert: "Trajectory alert",
    alarm_state: "Alarm state",
    pairing_scan: "QR pairing",
  }[kind];
}

function downloadAuditCsv() {
  const blob = new Blob([auditToCsv(loadAuditLog())], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `carespeak-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(log: GestureLogEntry[]) {
  const blob = new Blob([toCsv(log)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `carespeak-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
