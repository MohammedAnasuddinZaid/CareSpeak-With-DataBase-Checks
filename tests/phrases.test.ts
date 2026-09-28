/**
 * Phrase board catalogue invariants.
 *
 * These are the properties that silently break the feature if violated. A blank
 * translation produces a tile that selects and says nothing; a missing
 * allowlist entry produces a phrase that reaches the patient but not the
 * nurse; an oversized id is rejected by the column. None of those fail loudly.
 */
import { describe, expect, it } from "vitest";
import {
  PHRASES,
  PHRASE_CATEGORIES,
  PHRASE_GESTURE_NAMES,
  SERVER_GESTURE_NAMES,
  phraseById,
  phrasesInCategory,
  phraseText,
} from "@/lib/phrases";
import type { SupportedLanguage } from "@/types";

const LANGUAGES: SupportedLanguage[] = [
  "en-US", "hi-IN", "bn-IN", "ta-IN", "te-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN",
];

/** `gestures.gesture` is VARCHAR(32) in 001_core_schema.sql. */
const MAX_GESTURE_NAME = 32;

describe("phrase catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = PHRASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("translates every phrase into every supported language", () => {
    for (const p of PHRASES) {
      for (const lang of LANGUAGES) {
        expect(phraseText(p.id, lang), `${p.id}/${lang}`).toBe(p.text[lang]);
        expect(p.text[lang].trim(), `${p.id}/${lang} is blank`).not.toBe("");
      }
    }
  });

  it("keeps every id inside the gesture column width", () => {
    for (const p of PHRASES) {
      expect(p.id.length, p.id).toBeLessThanOrEqual(MAX_GESTURE_NAME);
      expect(p.id, p.id).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("puts every phrase in a declared category", () => {
    const declared = new Set(PHRASE_CATEGORIES.map((c) => c.id));
    for (const p of PHRASES) {
      expect(declared.has(p.category), p.id).toBe(true);
    }
  });

  it("gives every category at least one phrase", () => {
    // Otherwise a tab renders an empty grid and looks like a broken board.
    for (const c of PHRASE_CATEGORIES) {
      expect(phrasesInCategory(c.id).length, c.id).toBeGreaterThan(0);
    }
  });

  it("names every phrase id for the server allowlist", () => {
    for (const p of PHRASES) {
      expect(PHRASE_GESTURE_NAMES.has(p.id), p.id).toBe(true);
      expect(SERVER_GESTURE_NAMES.has(p.id), p.id).toBe(true);
    }
  });

  it("still accepts the original camera gestures", () => {
    for (const g of ["YES", "NO", "HELP", "WATER", "HELLO", "EMERGENCY", "SYSTEM"]) {
      expect(SERVER_GESTURE_NAMES.has(g), g).toBe(true);
    }
  });

  it("never reuses HELP or EMERGENCY as a phrase id", () => {
    // help_frequency escalation counts entries whose gesture is exactly "HELP".
    // A board tile reusing that name would let a patient inflate an escalation
    // count without ever asking for help.
    for (const p of PHRASES) {
      expect(p.id).not.toBe("HELP");
      expect(p.id).not.toBe("EMERGENCY");
    }
  });

  it("marks distress phrases urgent", () => {
    const urgent = PHRASES.filter((p) => p.urgent).map((p) => p.id);
    expect(urgent).toContain("IN_PAIN");
    expect(urgent).toContain("NEED_NURSE");
    expect(urgent).toContain("NEED_PRIVACY");
  });

  it("covers needs, medical and privacy vocabularies", () => {
    // The three things a gesture board genuinely cannot express.
    for (const id of ["NEED_WATER", "IN_PAIN", "WHERE_IS_PAIN", "NEED_PRIVACY", "STOP_NO"]) {
      expect(PHRASES.some((p) => p.id === id), id).toBe(true);
    }
  });
});

describe("phraseText", () => {
  it("returns the requested language", () => {
    expect(phraseText("NEED_WATER", "ta-IN")).toBe(PHRASES.find((p) => p.id === "NEED_WATER")!.text["ta-IN"]);
  });

  it("falls back to English rather than returning nothing", () => {
    // The failure this prevents: a tile that selects successfully and is silent.
    expect(phraseText("NEED_WATER", "ja-JP")).toBe("I need water");
    expect(phraseText("NEED_WATER", "")).toBe("I need water");
  });

  it("falls back to English when a translation is blank", () => {
    const phrase = phraseById("NEED_WATER")!;
    const original = phrase.text["ta-IN"];
    phrase.text["ta-IN"] = "   ";
    try {
      expect(phraseText("NEED_WATER", "ta-IN")).toBe("I need water");
    } finally {
      phrase.text["ta-IN"] = original;
    }
  });

  it("returns an empty string for an unknown id", () => {
    expect(phraseText("NOT_A_PHRASE", "en-US")).toBe("");
  });
});
