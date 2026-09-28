"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  FileText, Hand, Eye, Search, Trash2, Volume2, Download, Clock, Filter,
  CheckCircle, BarChart3, PieChart, TrendingUp, Activity, Sun, Sheet,
} from "lucide-react";
import { loadGestureLog, subscribeToGestureUpdates, clearGestureLog } from "@/lib/gestureLog";
import { voiceAlert } from "@/lib/tts";
import { toCsv, computeStats, dailyGestureCounts, hourlyDistribution, gestureDistribution, computeTrends } from "@/lib/analytics";
import { GestureLogEntry, GESTURE_COLORS, SupportedLanguage } from "@/types";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart as RePieChart, Pie, Cell, BarChart, Bar,
} from "recharts";

function groupByDate(log: GestureLogEntry[]): Record<string, GestureLogEntry[]> {
  const groups: Record<string, GestureLogEntry[]> = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const thisWeek = today - now.getDay() * 86400000;
  for (const entry of log) {
    let key: string;
    if (entry.timestamp >= today) key = "Today";
    else if (entry.timestamp >= yesterday) key = "Yesterday";
    else if (entry.timestamp >= thisWeek) key = "This Week";
    else key = "Older";
    (groups[key] ??= []).push(entry);
  }
  return groups;
}

const GROUP_ORDER = ["Today", "Yesterday", "This Week", "Older"];

export default function LogsPage() {
  const [log, setLog] = useState<GestureLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "hand" | "eye">("all");
  const [showClear, setShowClear] = useState(false);
  const [tab, setTab] = useState<"timeline" | "analytics">("timeline");
  const [chartDays, setChartDays] = useState(7);

  useEffect(() => {
    setLog(loadGestureLog());
    return subscribeToGestureUpdates({ onGesture: (e) => setLog((prev) => [e, ...prev]), onClear: () => setLog([]) });
  }, []);

  const stats = useMemo(() => computeStats(log), [log]);
  const trends = useMemo(() => computeTrends(log), [log]);
  const dailyData = useMemo(() => dailyGestureCounts(log, chartDays), [log, chartDays]);
  const hourlyData = useMemo(() => hourlyDistribution(log), [log]);
  const distData = useMemo(() => gestureDistribution(log, GESTURE_COLORS), [log]);

  const gestureTypes = useMemo(() => [...new Set(dailyData.map((d) => d.gesture))], [dailyData]);

  const dailyChartData = useMemo(() => {
    const dateMap = new Map<string, Record<string, number>>();
    const dateOrder: string[] = [];
    for (const entry of dailyData) {
      if (!dateMap.has(entry.date)) {
        dateMap.set(entry.date, {});
        dateOrder.push(entry.date);
      }
      const day = dateMap.get(entry.date)!;
      day[entry.gesture] = (day[entry.gesture] || 0) + entry.count;
    }
    return dateOrder.map((date) => ({ date, ...dateMap.get(date) }));
  }, [dailyData]);

  const filteredLog = useMemo(() => {
    let entries = log;
    if (search.trim()) {
      const q = search.toLowerCase();
      entries = entries.filter((e) => e.gesture.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
    }
    if (filter !== "all") entries = entries.filter((e) => e.type === filter);
    return entries;
  }, [log, search, filter]);

  const grouped = useMemo(() => groupByDate(filteredLog), [filteredLog]);

  const downloadFile = useCallback((content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportJson = useCallback(
    () => downloadFile(JSON.stringify(log, null, 2), `carespeak-gestures-${new Date().toISOString().slice(0, 10)}.json`, "application/json"),
    [log, downloadFile]
  );

  const handleExportCsv = useCallback(
    () => downloadFile(toCsv(log), `carespeak-gestures-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv"),
    [log, downloadFile]
  );

  const handleClear = useCallback(() => {
    clearGestureLog();
    setLog([]);
    setShowClear(false);
  }, []);

  function formatLogTime(ts: number): string {
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
                <FileText className="w-4 h-4" /> Gesture History
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Gesture Logs</h1>
              <p className="mt-2 text-[#6e6e6e]">Review, analyze and export every recorded gesture.</p>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={handleExportCsv} disabled={log.length === 0} className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm disabled:opacity-40">
                <Sheet className="w-4 h-4" /> CSV
              </button>
              <button onClick={handleExportJson} disabled={log.length === 0} className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm disabled:opacity-40">
                <Download className="w-4 h-4" /> JSON
              </button>
              <button onClick={() => setShowClear(true)} className="btn-danger flex items-center gap-2 px-4 py-2.5 text-sm">
                <Trash2 className="w-4 h-4" /> Clear
              </button>
            </div>
          </div>
        </motion.div>

        {showClear && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 rounded-2xl bg-[#fef2f2] border border-[#fecaca] flex items-center justify-between flex-wrap gap-3">
            <span className="text-[#d94a4a] text-sm">Clear all gesture history? This cannot be undone.</span>
            <div className="flex gap-2">
              <button onClick={handleClear} className="px-4 py-1.5 rounded-lg bg-[#d94a4a] hover:bg-[#b91c1c] text-white text-xs font-medium">Clear</button>
              <button onClick={() => setShowClear(false)} className="px-4 py-1.5 rounded-lg bg-[#f5f3f0] hover:bg-[#ececec] text-[#1f1f1f] text-xs font-medium">Cancel</button>
            </div>
          </motion.div>
        )}

        {/* stat cards */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "Total", value: stats.total },
            { label: "Today", value: stats.today },
            { label: "Unacknowledged", value: stats.unacknowledged, accent: stats.unacknowledged > 0 },
            { label: "Trend", value: `${trends.change > 0 ? "+" : ""}${trends.change}%`, accent: trends.direction !== "flat", icon: TrendingUp },
          ].map((stat, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="card p-4 text-center">
              <div className="text-[10px] text-[#6e6e6e] uppercase tracking-wider font-medium mb-1">{stat.label}</div>
              <div className={`text-2xl font-bold flex items-center justify-center gap-1 ${stat.accent ? "text-[#e8993e]" : "text-[#1f1f1f]"}`}>
                {stat.icon && trends.direction === "up" && <TrendingUp className="w-4 h-4 text-[#22a67e]" />}
                {stat.icon && trends.direction === "down" && <TrendingUp className="w-4 h-4 text-[#d94a4a] rotate-180" />}
                {stat.value}
              </div>
            </motion.div>
          ))}
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-[#ececec]">
          {(["timeline", "analytics"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
              className={`px-5 py-3 text-sm font-medium transition-colors border-b-2 -mb-[1px] ${tab === t ? "text-[#c63a22] border-[#c63a22]" : "text-[#6e6e6e] border-transparent hover:text-[#1f1f1f]"}`}>
              {t === "timeline" ? <Clock className="w-4 h-4 inline mr-1.5" /> : <BarChart3 className="w-4 h-4 inline mr-1.5" />}
              {t === "timeline" ? "Timeline" : "Analytics"}
            </button>
          ))}
        </div>

        {tab === "analytics" ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-[#1f1f1f] flex items-center gap-2"><Activity className="w-4 h-4 text-[#c63a22]" />Gestures Over Time</h3>
                  <div className="flex gap-1">
                    {[7, 14, 30].map((d) => (
                      <button key={d} onClick={() => setChartDays(d)} aria-pressed={chartDays === d}
                        className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${chartDays === d ? "bg-[#c63a22]/10 text-[#c63a22]" : "text-[#6e6e6e] hover:bg-[#f5f3f0]"}`}>{d}d</button>
                    ))}
                  </div>
                </div>
                {dailyChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={dailyChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ececec" />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6e6e6e" }} tickFormatter={(v) => String(v).slice(5)} />
                      <YAxis tick={{ fontSize: 11, fill: "#6e6e6e" }} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: "#fff", border: "1px solid #ececec", borderRadius: "12px", fontSize: "12px" }} />
                      {gestureTypes.map((g) => (
                        <Line key={g} type="monotone" dataKey={g} stroke={GESTURE_COLORS[g] ?? "#6e6e6e"} strokeWidth={2} dot={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-[250px] text-[#6e6e6e] text-sm">No data for selected period</div>
                )}
              </div>

              <div className="card p-6">
                <h3 className="text-sm font-bold text-[#1f1f1f] mb-4 flex items-center gap-2"><PieChart className="w-4 h-4 text-[#c63a22]" />Gesture Distribution</h3>
                {distData.length > 0 ? (
                  <div className="flex items-center gap-4 flex-wrap">
                    <ResponsiveContainer width="60%" height={220} minWidth={180}>
                      <RePieChart>
                        <Pie data={distData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                          {distData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip contentStyle={{ background: "#fff", border: "1px solid #ececec", borderRadius: "12px", fontSize: "12px" }} />
                      </RePieChart>
                    </ResponsiveContainer>
                    <div className="space-y-2 flex-1 min-w-[140px]">
                      {distData.map((entry) => (
                        <div key={entry.name} className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ background: entry.color }} />
                            <span className="font-medium text-[#1f1f1f]">{entry.name}</span>
                          </span>
                          <span className="text-[#6e6e6e]">{entry.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-[220px] text-[#6e6e6e] text-sm">No gestures recorded yet</div>
                )}
              </div>
            </div>

            <div className="card p-6">
              <h3 className="text-sm font-bold text-[#1f1f1f] mb-4 flex items-center gap-2"><Sun className="w-4 h-4 text-[#c63a22]" />Hourly Activity</h3>
              {hourlyData.some((h) => h.count > 0) ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={hourlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ececec" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "#6e6e6e" }} tickFormatter={(h) => `${String(h).padStart(2, "0")}:00`} />
                    <YAxis tick={{ fontSize: 11, fill: "#6e6e6e" }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "#fff", border: "1px solid #ececec", borderRadius: "12px", fontSize: "12px" }}
                      formatter={(value) => [value, "Gestures"]}
                      labelFormatter={(h) => `${String(h).padStart(2, "0")}:00`} />
                    <Bar dataKey="count" fill="#c63a22" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[180px] text-[#6e6e6e] text-sm">No activity data yet</div>
              )}
            </div>
          </motion.div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
              <div className="relative flex-1 max-w-md w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6e6e6e]" />
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search gestures..." aria-label="Search gestures" className="input w-full pl-9" />
              </div>
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-[#6e6e6e]" />
                {(["all", "hand", "eye"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-200 ${filter === f ? "bg-[#c63a22]/10 text-[#c63a22] border border-[#c63a22]/20" : "text-[#6e6e6e] hover:text-[#1f1f1f] border border-transparent"}`}>
                    {f === "all" ? "All" : f === "hand" ? "Hand" : "Eye"}
                  </button>
                ))}
              </div>
            </div>

            {filteredLog.length === 0 ? (
              <div className="card p-16 text-center">
                <Clock className="w-12 h-12 text-[#d5d5d5] mx-auto mb-4" />
                <p className="text-[#6e6e6e] font-medium">No gestures found</p>
                <p className="text-[#9ca3af] text-xs mt-1">{search ? "Try a different search term" : "Start using Hand or Eye mode to see gestures here"}</p>
              </div>
            ) : (
              <div className="space-y-8">
                {GROUP_ORDER.filter((g) => grouped[g]).map((group) => (
                  <div key={group}>
                    <h3 className="text-sm font-semibold text-[#1f1f1f] mb-3 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-[#c63a22]" />{group}
                      <span className="text-xs text-[#6e6e6e] font-normal">({grouped[group].length})</span>
                    </h3>
                    <div className="space-y-2">
                      {grouped[group].map((entry) => (
                        <motion.div key={entry.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="card p-4 flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-[#f5f3f0] flex items-center justify-center flex-shrink-0">
                            {entry.type === "eye" ? <Eye className="w-5 h-5 text-[#6e6e6e]" /> : entry.type === "system" ? <Activity className="w-5 h-5 text-[#6e6e6e]" /> : <Hand className="w-5 h-5 text-[#6e6e6e]" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`font-bold text-sm ${entry.gesture === "EMERGENCY" || entry.gesture === "NO" ? "text-[#d94a4a]" : entry.gesture === "YES" ? "text-[#22a67e]" : entry.gesture === "HELP" ? "text-[#e8993e]" : "text-[#1f1f1f]"}`}>{entry.gesture}</span>
                              <span className="px-2 py-0.5 rounded bg-[#f5f3f0] text-[#6e6e6e] text-xs">{entry.type}</span>
                              {entry.source && entry.source !== "camera" && <span className="px-2 py-0.5 rounded bg-[#eff6ff] text-[#3b82f6] text-xs">{entry.source}</span>}
                              {entry.acknowledged && <CheckCircle className="w-3.5 h-3.5 text-[#22a67e]" />}
                            </div>
                            <div className="text-xs text-[#6e6e6e] mt-0.5 truncate">{entry.description.replace(/^[^—]*—\s*/, "")}</div>
                            <div className="text-[10px] text-[#9ca3af] mt-0.5">
                              {formatLogTime(entry.timestamp)} · {Math.round(entry.confidence * 100)}% confidence
                            </div>
                          </div>
                          <button onClick={() => voiceAlert.replay(entry.gesture, entry.language as SupportedLanguage)}
                            aria-label="Replay spoken alert"
                            className="p-2 rounded-lg bg-[#f5f3f0] hover:bg-[#ececec] text-[#6e6e6e] transition-colors duration-200">
                            <Volume2 className="w-4 h-4" />
                          </button>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

