/**
 * Quick-access phrase board.
 *
 * The gesture engine could say YES/NO/HELP/WATER/PAUSE and nothing else. This
 * gives a patient who cannot form a gesture, or who has run out of them, a
 * vocabulary — and every tile speaks, logs and reaches the nurse through the
 * same path a camera gesture takes.
 *
 * Designed for the bedside, not a demo:
 *  - Large targets, because the users are the people least able to hit small ones
 *  - Tiles are keyboard operable and announce themselves to a screen reader
 *  - Nothing depends on the network: it speaks and logs locally, and the
 *    existing outbox replays to the nurse when the ward comes back
 *  - Optional gaze dwell, for a patient with no usable hand at all
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check, X, Hand, Heart, LogOut, HelpCircle, Droplets, Utensils, DoorOpen,
  UserRound, Stethoscope, Bed, Lightbulb, Sun, Fan, Zap, MapPin, Pill, Wind,
  RefreshCw, AlertTriangle, Thermometer, Smile, Frown, Ghost, BatteryLow,
  TrendingUp, Lock, DoorClosed, MessageSquare, HandHeart,
  AlertCircle, Volume2, Eye,
} from "lucide-react";
import {
  PHRASES,
  PHRASE_CATEGORIES,
  PHRASES_NEED_LINGUISTIC_REVIEW,
  phraseText,
  type PhraseCategory,
} from "@/lib/phrases";
import { voiceAlert } from "@/lib/tts";
import { addGestureLog } from "@/lib/gestureLog";
import {
  DEFAULT_DWELL_MS,
  DwellSelector,
  DWELL_PRESETS,
  type DwellPreset,
  type GazePoint,
} from "@/lib/dwell";
import type { GestureLogEntry, GestureType } from "@/types";

const ICONS: Record<string, typeof Check> = {
  Check, X, Hand, Heart, LogOut, HelpCircle, Droplets, Utensils, DoorOpen,
  UserRound, Stethoscope, Bed, Lightbulb, Sun, Fan, Zap, MapPin, Pill, Wind,
  RefreshCw, AlertTriangle, Thermometer, Smile, Frown, Ghost, BatteryLow,
  TrendingUp, Lock, DoorClosed, MessageSquare, HandHeart,
};

export interface PhraseBoardProps {
  sessionId?: string;
  /** `hand` for a tap, `eye` when a gaze dwell selected the tile. */
  modality?: GestureType;
  onBroadcast?: (entry: GestureLogEntry) => void;
  /**
   * Live gaze pointer from `useEyeGesture`. Supplied to enable dwell selection.
   * Read in a rAF loop rather than React state — it updates every camera frame.
   */
  gazeRef?: RefObject<GazePoint | null>;
  /** Dwell grid width. Fixed while dwell is on so the mapping is honest. */
  dwellColumns?: number;
}

export default function PhraseBoard({
  sessionId,
  modality = "hand",
  onBroadcast,
  gazeRef,
  dwellColumns = 3,
}: PhraseBoardProps) {
  const [active, setActive] = useState<PhraseCategory>("needs");
  const [lastSpoken, setLastSpoken] = useState<string | null>(null);
  const [dwellOn, setDwellOn] = useState(false);
  const [dwellPreset, setDwellPreset] = useState<DwellPreset>("normal");
  const [dwellIndex, setDwellIndex] = useState<number | null>(null);

  const phrases = useMemo(
    () => PHRASES.filter((p) => p.category === active),
    [active],
  );

  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sayRef = useRef<(id: string) => void>(() => {});

  /**
   * Speak locally first, then log. The patient must hear the word even if the
   * ward network is down — that is the whole promise of the bedside unit — and
   * the entry still reaches the nurse later through the outbox.
   */
  const say = useCallback(
    (id: string) => {
      const lang = voiceAlert.getLanguage();
      const text = phraseText(id, lang);
      if (!text) return;

      voiceAlert.speakDirect(text, lang);
      setLastSpoken(id);

      const entry = addGestureLog(id, text, 1, modality, lang, {
        sessionId,
        source: "manual",
      });
      onBroadcast?.(entry);
    },
    [modality, onBroadcast, sessionId],
  );

  // The rAF loop must not restart on every keystroke-level change to `say`.
  sayRef.current = say;

  /**
   * Dwell selection loop.
   *
   * Runs on its own rAF because the gaze ref updates at camera frame rate;
   * routing it through state would re-render the board 30x a second. Only the
   * highlighted tile is React state. The filling ring is written straight to a
   * CSS custom property on the tile, which is the one thing that genuinely
   * needs per-frame precision.
   */
  useEffect(() => {
    // Category change re-shapes the grid, so drop refs to unmounted tiles
    // rather than writing dwell progress into detached nodes.
    tileRefs.current.length = phrases.length;

    if (!dwellOn || !gazeRef) {
      setDwellIndex(null);
      tileRefs.current.forEach((el) => el?.style.setProperty("--dwell", "0"));
      return;
    }

    const columns = Math.max(1, dwellColumns);
    const rows = Math.max(1, Math.ceil(phrases.length / columns));
    const selector = new DwellSelector({
      columns,
      rows,
      dwellMs: DWELL_PRESETS[dwellPreset].dwellMs,
    });

    let raf = 0;
    let shown: number | null = null;

    const tick = () => {
      const now = performance.now();
      const fired = selector.update(gazeRef.current, now);
      if (fired !== null) {
        const phrase = phrases[fired];
        if (phrase) sayRef.current(phrase.id);
      }

      const idx = selector.target();
      if (idx !== shown) {
        if (shown !== null) {
          tileRefs.current[shown]?.style.setProperty("--dwell", "0");
        }
        shown = idx;
        setDwellIndex(idx);
      }
      if (idx !== null) {
        tileRefs.current[idx]?.style.setProperty(
          "--dwell",
          String(selector.progress(now)),
        );
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      tileRefs.current.forEach((el) => el?.style.setProperty("--dwell", "0"));
    };
  }, [dwellOn, gazeRef, dwellPreset, dwellColumns, phrases]);

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-bold text-[#1f1f1f] flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-[#c63a22]" /> Say It
        </h3>
        {lastSpoken && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium text-[#22a67e]"
            aria-live="polite"
          >
            <Volume2 className="w-3 h-3" />
            Spoke {phraseText(lastSpoken, voiceAlert.getLanguage())}
          </span>
        )}
      </div>
      <p className="text-xs text-[#6e6e6e] mb-4">
        {dwellOn
          ? "Look at a tile and hold. The bar fills, then it speaks."
          : "Tap what you need. It speaks out loud and reaches your nurse."}
      </p>

      {gazeRef && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => setDwellOn((v) => !v)}
            aria-pressed={dwellOn}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              dwellOn
                ? "bg-[#1f6f5c] text-white"
                : "bg-[#f5f3f0] text-[#6e6e6e] hover:bg-[#ececec]"
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            {dwellOn ? "Dwell on" : "Dwell off"}
          </button>

          {dwellOn && (
            <div className="flex items-center gap-1" role="group" aria-label="Dwell time">
              {(Object.keys(DWELL_PRESETS) as DwellPreset[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDwellPreset(k)}
                  aria-pressed={dwellPreset === k}
                  className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                    dwellPreset === k
                      ? "bg-[#1f6f5c] text-white"
                      : "bg-[#f5f3f0] text-[#6e6e6e] hover:bg-[#ececec]"
                  }`}
                >
                  {DWELL_PRESETS[k].label}
                </button>
              ))}
            </div>
          )}

          {dwellOn && (
            <span className="text-[10px] text-[#6e6e6e]">
              {DWELL_PRESETS[dwellPreset].dwellMs / 1000}s dwell
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mb-4" role="tablist" aria-label="Phrase categories">
        {PHRASE_CATEGORIES.map((c) => {
          const Icon = ICONS[c.icon] ?? MessageSquare;
          const on = c.id === active;
          return (
            <button
              key={c.id}
              role="tab"
              aria-selected={on}
              onClick={() => setActive(c.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                on
                  ? "bg-[#c63a22] text-white"
                  : "bg-[#f5f3f0] text-[#6e6e6e] hover:bg-[#ececec]"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {c.label}
            </button>
          );
        })}
      </div>

      <div
        className={`grid gap-2 ${dwellOn ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3"}`}
        role="tabpanel"
      >
        <AnimatePresence mode="popLayout">
          {phrases.map((p, i) => {
            const Icon = ICONS[p.icon] ?? MessageSquare;
            const text = phraseText(p.id, voiceAlert.getLanguage());
            const on = lastSpoken === p.id;
            const dwelled = dwellOn && dwellIndex === i;
            return (
              <motion.button
                key={p.id}
                ref={(el) => {
                  tileRefs.current[i] = el as HTMLButtonElement | null;
                }}
                layout
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ duration: 0.14 }}
                onClick={() => say(p.id)}
                aria-label={text}
                aria-current={dwelled ? "true" : undefined}
                style={{ ["--dwell" as string]: 0 }}
                className={`relative flex flex-col items-start gap-1.5 p-3 rounded-xl border text-left transition-colors min-h-[76px] overflow-hidden ${
                  dwelled
                    ? "border-[#1f6f5c] ring-2 ring-[#1f6f5c]"
                    : on
                      ? "border-[#c63a22] bg-[#c63a22]/8"
                      : p.urgent
                        ? "border-[#fecaca] bg-[#fef2f2] hover:bg-[#fee2e2]"
                        : "border-[#ececec] bg-white hover:bg-[#f5f3f0]"
                }`}
              >
                {/* Dwell ring: width is driven per-frame from the rAF loop. */}
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-0 h-1 bg-[#1f6f5c] transition-none"
                  style={{
                    width: "calc(var(--dwell, 0) * 100%)",
                    opacity: dwelled ? 1 : 0,
                  }}
                />
                <div className="flex items-center gap-2 w-full">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      p.urgent ? "text-[#d94a4a]" : "text-[#c63a22]"
                    }`}
                  />
                  {p.urgent && (
                    <AlertCircle className="w-3 h-3 text-[#d94a4a] ml-auto shrink-0" />
                  )}
                </div>
                <span className="text-xs font-semibold text-[#1f1f1f] leading-snug">
                  {text}
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>

      {PHRASES_NEED_LINGUISTIC_REVIEW && (
        <p className="mt-4 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#a08a6a]">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>
            Translations are machine-provided and not yet reviewed by a native
            speaker or speech-language pathologist. Do not rely on them for
            clinical communication until they have been checked.
          </span>
        </p>
      )}
    </div>
  );
}
