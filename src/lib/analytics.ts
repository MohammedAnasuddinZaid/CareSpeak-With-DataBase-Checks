import { GestureLogEntry } from "@/types";

export interface LogStats {
  total: number;
  today: number;
  unacknowledged: number;
  escalated: number;
  byGesture: Record<string, number>;
  byType: Record<string, number>;
}

export function computeStats(entries: GestureLogEntry[], now = Date.now()): LogStats {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const byGesture: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let today = 0;
  let unacknowledged = 0;
  let escalated = 0;
  for (const e of entries) {
    byGesture[e.gesture] = (byGesture[e.gesture] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.timestamp >= todayStart) today++;
    if (!e.acknowledged) unacknowledged++;
    if (e.escalated && !e.resolved) escalated++;
  }
  return { total: entries.length, today, unacknowledged, escalated, byGesture, byType };
}

/** Local-midnight day key — UTC bucketing assigned evening events to the wrong
 *  day for every UTC+X user (i.e. all of India), contradicting the "Today"
 *  stat computed on local midnight right next to it. */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dailyGestureCounts(
  entries: GestureLogEntry[],
  days: number,
  now = Date.now()
): { date: string; count: number; gesture: string }[] {
  const cutoff = now - days * 86400000;
  const map = new Map<string, { date: string; count: number; gesture: string }>();
  for (const e of entries) {
    if (e.timestamp < cutoff) continue;
    const dateStr = localDateKey(e.timestamp);
    const key = `${dateStr}_${e.gesture}`;
    const found = map.get(key);
    if (found) found.count++;
    else map.set(key, { date: dateStr, count: 1, gesture: e.gesture });
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function hourlyDistribution(entries: GestureLogEntry[]): { hour: number; count: number }[] {
  const hours = new Array(24).fill(0);
  for (const e of entries) hours[new Date(e.timestamp).getHours()]++;
  return hours.map((count, hour) => ({ hour, count }));
}

export function gestureDistribution(
  entries: GestureLogEntry[],
  colors: Record<string, string>
): { name: string; value: number; color: string }[] {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.gesture] = (counts[e.gesture] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value, color: colors[name] ?? "#6e6e6e" }));
}

export function computeTrends(entries: GestureLogEntry[], now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const yesterdayStart = todayStart - 86400000;
  const today = entries.filter((e) => e.timestamp >= todayStart).length;
  const yesterday = entries.filter((e) => e.timestamp >= yesterdayStart && e.timestamp < todayStart).length;
  let change = 0;
  let direction: "up" | "down" | "flat" = "flat";
  if (yesterday > 0) {
    change = Math.round(((today - yesterday) / yesterday) * 100);
    direction = change > 5 ? "up" : change < -5 ? "down" : "flat";
  }
  return { total: entries.length, today, change, direction };
}

/** Neutralize spreadsheet formula injection: a cell beginning with =,+,-,@
 *  would execute as a formula when the CSV is opened in Excel. */
function csvSafe(v: unknown): string {
  const s = String(v);
  return /^[=+@-]/.test(s) ? `'${s}` : s;
}

export function toCsv(entries: GestureLogEntry[]): string {
  const header = ["id", "timestamp", "iso_time", "gesture", "type", "confidence", "language", "source", "acknowledged", "escalated", "resolved"];
  const rows = entries.map((e) =>
    [
      e.id,
      e.timestamp,
      new Date(e.timestamp).toISOString(),
      e.gesture,
      e.type,
      (Math.round(e.confidence * 100) / 100).toFixed(2),
      e.language,
      e.source ?? "camera",
      e.acknowledged ? "yes" : "no",
      e.escalated ? "yes" : "no",
      e.resolved ? "yes" : "no",
    ]
      .map((v) => `"${csvSafe(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}
