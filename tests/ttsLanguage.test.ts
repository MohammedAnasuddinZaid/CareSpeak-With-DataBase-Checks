/**
 * Language resolution and profile adoption.
 *
 * The behaviour worth protecting is the precedence rule: a patient's stored
 * preference wins by default, but a deliberate in-app pick always wins over
 * it. Getting that backwards either strands a patient in the wrong language
 * forever, or silently overrides someone who chose deliberately.
 */
import { describe, expect, it } from "vitest";
import { resolveProfileLanguage } from "@/lib/tts";

describe("resolveProfileLanguage", () => {
  it("passes through an exact supported tag", () => {
    expect(resolveProfileLanguage("ta-IN")).toBe("ta-IN");
    expect(resolveProfileLanguage("ml-IN")).toBe("ml-IN");
  });

  it("accepts underscore spellings a database may hold", () => {
    expect(resolveProfileLanguage("te_IN")).toBe("te-IN");
  });

  it("tolerates surrounding whitespace and casing differences", () => {
    expect(resolveProfileLanguage("  hi-IN  ")).toBe("hi-IN");
  });

  it("falls back to the base language for a regional variant", () => {
    // A profile saved on a device defaulting to en-GB must still get English,
    // not silence.
    expect(resolveProfileLanguage("en-GB")).toBe("en-US");
    expect(resolveProfileLanguage("ta-LK")).toBe("ta-IN");
  });

  it("accepts a bare language code", () => {
    expect(resolveProfileLanguage("kn")).toBe("kn-IN");
  });

  it("refuses to guess an unsupported language", () => {
    // Speaking the wrong script is worse than staying quiet.
    expect(resolveProfileLanguage("ja-JP")).toBeNull();
    expect(resolveProfileLanguage("sw-KE")).toBeNull();
  });

  it("returns null for empty or missing input", () => {
    expect(resolveProfileLanguage(null)).toBeNull();
    expect(resolveProfileLanguage(undefined)).toBeNull();
    expect(resolveProfileLanguage("")).toBeNull();
    expect(resolveProfileLanguage("   ")).toBeNull();
  });
});

describe("profile language adoption", () => {
  // No DOM stubs on purpose: `setLanguage(..., { silent: true })` returns before
  // any speech or voice lookup, and `notifyUiLanguageChanged` only walks an
  // in-memory listener list. The singleton holds its config in memory, so the
  // precedence rule is fully exercisable in the node environment.

  it("adopts the profile language when none was chosen explicitly", async () => {
    const { voiceAlert } = await import("@/lib/tts");
    voiceAlert.resetGesture();
    // Force the derived state.
    voiceAlert.setLanguage("en-US", { explicit: false, silent: true });

    expect(voiceAlert.applyProfileLanguage("ta-IN")).toBe(true);
    expect(voiceAlert.getLanguage()).toBe("ta-IN");
  });

  it("never overrides a deliberate UI choice", async () => {
    const { voiceAlert } = await import("@/lib/tts");
    voiceAlert.setLanguage("en-US", { explicit: true, silent: true });

    expect(voiceAlert.applyProfileLanguage("ta-IN")).toBe(false);
    expect(voiceAlert.getLanguage()).toBe("en-US");
  });

  it("is a no-op when the profile language is already active", async () => {
    const { voiceAlert } = await import("@/lib/tts");
    voiceAlert.setLanguage("ta-IN", { explicit: false, silent: true });

    expect(voiceAlert.applyProfileLanguage("ta-IN")).toBe(false);
  });

  it("ignores staff, who carry no patient profile", async () => {
    const { voiceAlert } = await import("@/lib/tts");
    voiceAlert.setLanguage("en-US", { explicit: false, silent: true });

    expect(voiceAlert.applyProfileLanguage(null)).toBe(false);
    expect(voiceAlert.getLanguage()).toBe("en-US");
  });

  it("marks a UI pick as explicit so later syncs cannot override it", async () => {
    const { voiceAlert } = await import("@/lib/tts");
    voiceAlert.setLanguage("hi-IN", { explicit: true, silent: true });
    expect(voiceAlert.applyProfileLanguage("ta-IN")).toBe(false);
    expect(voiceAlert.getLanguage()).toBe("hi-IN");
  });
});
