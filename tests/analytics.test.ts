import { describe, it, expect } from "vitest";
import { toCsv, dailyGestureCounts } from "../src/lib/analytics";
import { GestureLogEntry } from "../src/types";

function mk(partial: Partial<GestureLogEntry> = {}): GestureLogEntry {
  return {
    id: "x1",
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: Date.now(),
    language: "en-US",
    ...partial,
  };
}

describe("analytics hardening", () => {
  it("CSV neutralizes spreadsheet formula injection", () => {
    const rows = toCsv([mk({ id: "=HYPERLINK(\"http://evil\")" })]);
    expect(rows).toContain("'=HYPERLINK");
  });

  it("dailyGestureCounts buckets by LOCAL day (evening events stay on today)", () => {
    // 23:30 local time today
    const d = new Date();
    d.setHours(23, 30, 0, 0);
    const eveningToday = dailyGestureCounts([mk({ timestamp: d.getTime() })], 7);
    const localKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    // UTC bucketing assigned this to tomorrow for UTC+X users
    expect(eveningToday.some((r) => r.date === localKey)).toBe(true);
  });
});
