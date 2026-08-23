import { GESTURE_COLORS } from "@/types";

export const TYPE_CONFIG: Record<string, string> = {
  hand: "text-[#22a67e]",
  eye: "text-[#3b82f6]",
  system: "text-[#6e6e6e]",
};

export const GESTURE_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  YES: { bg: "gesture-yes", text: "text-[#22a67e]", label: "Confirm" },
  NO: { bg: "gesture-no", text: "text-[#d94a4a]", label: "Refuse" },
  HELP: { bg: "gesture-help", text: "text-[#e8993e]", label: "Assistance" },
  HELLO: { bg: "bg-[#eff6ff]", text: "text-[#3b82f6]", label: "Greeting" },
  WATER: { bg: "gesture-water", text: "text-[#3b82f6]", label: "Water/Food" },
  EMERGENCY: { bg: "gesture-emergency", text: "text-[#dc2626]", label: "Emergency" },
  SYSTEM: { bg: "badge-neutral", text: "text-[#6e6e6e]", label: "Auto" },
};

export const CHART_COLORS = GESTURE_COLORS;

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diffMin = Math.floor((now - ts) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function stripGesturePrefix(description: string): string {
  return description.replace(/^[^—]*—\s*/, "");
}
