"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Eye, Activity, BarChart3, Clock, AlertTriangle, HeartPulse } from "lucide-react";
import { DeviceVitals, PatientMetrics } from "@/types";
import { computeRisk } from "@/lib/risk";
import { GestureLogEntry } from "@/types";
import RiskAttribution from "@/components/RiskAttribution";

interface PatientMetricsCardProps {
  metrics: PatientMetrics | null;
  deviceName?: string;
  /** recent entries — used by the risk engine */
  log?: GestureLogEntry[];
  /** ESP32 / wearable vitals from /api/ingest */
  vitals?: DeviceVitals | null;
}

const RISK_COLORS: Record<string, string> = {
  low: "#22a67e",
  moderate: "#e8993e",
  high: "#d94a4a",
  critical: "#dc2626",
};

export default function PatientMetricsCard({ metrics, deviceName = "Patient Device", log = [], vitals }: PatientMetricsCardProps) {
  // Risk includes NEWS2-style vital parameters whenever the wearable streams;
  // camera-only deployments fall back to eye-derived wellness factors.
  const risk = useMemo(
    () =>
      computeRisk(
        metrics,
        log,
        Date.now(),
        vitals ? { heartRate: vitals.heartRate, spo2: vitals.spo2 } : null
      ),
    [metrics, log, vitals?.heartRate, vitals?.spo2]
  );
  const riskColor = RISK_COLORS[risk.band];
  const staleVitals = vitals ? Date.now() - vitals.receivedAt > 30000 : false;

  if (!metrics) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#c63a22]" />
          Patient Wellness
        </h3>
        <div className="flex items-center justify-center h-24 text-[#6e6e6e] text-sm">
          Waiting for metrics...
        </div>
      </div>
    );
  }

  const metricsList = [
    { label: "Blink Rate", value: metrics.blinkRate != null ? `${metrics.blinkRate.toFixed(1)}/min` : "—", icon: Eye, color: "text-[#22a67e]", bg: "bg-[#ecfdf5]" },
    { label: "Alertness", value: metrics.alertnessScore != null ? `${Math.round(metrics.alertnessScore)}%` : "—", icon: BarChart3, color: metrics.alertnessScore != null && metrics.alertnessScore < 25 ? "text-[#d94a4a]" : "text-[#22a67e]", bg: metrics.alertnessScore != null && metrics.alertnessScore < 25 ? "bg-[#fef2f2]" : "bg-[#ecfdf5]" },
    { label: "Eye Closure", value: metrics.eyeClosureDuration != null ? `${(metrics.eyeClosureDuration / 1000).toFixed(1)}s` : "—", icon: Clock, color: "text-[#e8993e]", bg: "bg-[#fffbeb]" },
    { label: "Movement", value: metrics.movementActivity != null ? `${Math.round(metrics.movementActivity * 100)}%` : "—", icon: Activity, color: "text-[#3b82f6]", bg: "bg-[#eff6ff]" },
  ];

  const isLowAlertness = metrics.alertnessScore != null && metrics.alertnessScore < 25;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[#1f1f1f] flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#c63a22]" />
          Patient Wellness
        </h3>
        <span className="text-[10px] text-[#6e6e6e]">{deviceName}</span>
      </div>

      {/* ── Live risk score ring ── */}
      <div className="mb-4 p-4 rounded-2xl bg-[#f9f7f5] border border-[#ececec] flex items-center gap-4">
        <div
          className="relative w-20 h-20 rounded-full shrink-0 grid place-items-center"
          style={{
            background: `conic-gradient(${riskColor} ${risk.score * 3.6}deg, #ececec ${risk.score * 3.6}deg)`,
          }}
          role="meter"
          aria-valuenow={risk.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Risk score ${risk.score} out of 100 (${risk.band})`}
        >
          <div className="absolute inset-[6px] rounded-full bg-white grid place-items-center">
            <span className="text-xl font-extrabold" style={{ color: riskColor }}>{risk.score}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#6e6e6e] mb-1">
            Risk score · <span style={{ color: riskColor }} className="capitalize">{risk.band}</span>
          </p>
          {risk.factors.length === 0 ? (
            <p className="text-xs text-[#22a67e]">All indicators normal</p>
          ) : (
            <ul className="space-y-1">
              {risk.factors.slice(0, 3).map((f, i) => (
                <li key={i} className="text-xs text-[#6e6e6e] truncate">
                  • {f.label} <span className="text-[#9ca3af]">(+{f.weight})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── exact factor attribution (why this score?) ── */}
      <RiskAttribution risk={risk} />

      {/* ── IoT wearable vitals ── */}
      {vitals && (
        <div
          className={`mb-4 p-3 rounded-xl border flex items-center gap-3 ${
            staleVitals ? "bg-[#f5f5f5] border-[#e5e5e5] opacity-60" : "bg-[#fdf4f0] border-[#f8c9b7]"
          }`}
          title={staleVitals ? "No vitals received in the last 30s" : "Live data from wearable device"}
        >
          <HeartPulse className="w-5 h-5 text-[#c63a22] shrink-0" />
          <div className="flex gap-4 text-xs min-w-0 overflow-x-auto">
            {vitals.heartRate != null && (
              <span><strong className="text-sm">{Math.round(vitals.heartRate)}</strong> bpm</span>
            )}
            {vitals.spo2 != null && (
              <span><strong className="text-sm">{Math.round(vitals.spo2)}</strong>% SpO₂</span>
            )}
            {vitals.temperature != null && (
              <span><strong className="text-sm">{vitals.temperature.toFixed(1)}</strong>°C</span>
            )}
            {vitals.batteryPct != null && (
              <span className="text-[#9ca3af]">🔋 {Math.round(vitals.batteryPct)}%</span>
            )}
          </div>
          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${staleVitals ? "badge-neutral" : "badge-success"}`}>
            {staleVitals ? "STALE" : "LIVE"}
          </span>
        </div>
      )}

      {isLowAlertness && (
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          className="mb-3 p-2 rounded-lg bg-[#fef2f2] border border-[#fecaca] flex items-center gap-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-[#d94a4a] shrink-0" />
          <span className="text-xs text-[#d94a4a]">Low alertness detected</span>
        </motion.div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {metricsList.map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.label} className={`rounded-xl ${m.bg} p-3`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon className={`w-3.5 h-3.5 ${m.color}`} />
                <span className="text-[10px] text-[#6e6e6e] uppercase tracking-wider">{m.label}</span>
              </div>
              <p className={`text-lg font-bold ${m.color}`}>{m.value}</p>
            </div>
          );
        })}
      </div>

      {metrics.lastSeen && (
        <p className="text-[10px] text-[#9ca3af] mt-3 text-right">
          Last updated: {new Date(metrics.lastSeen).toLocaleTimeString()}
        </p>
      )}
    </motion.div>
  );
}
