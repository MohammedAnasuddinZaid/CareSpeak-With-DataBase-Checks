"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, ArrowLeft, ArrowRight } from "lucide-react";

/**
 * Eye-gaze Pain Scale.
 *
 * A large 0-10 counter auto-cycles; the patient CONFIRMS with look-left
 * (their existing YES gesture) and CANCELS with an open mouth (WATER).
 * Look-right (NO) manually advances. Everything rides on the already-stable
 * gesture stream — this overlay adds zero changes to the vision pipeline,
 * and double-blink HELP still fires normally as an emergency escape hatch.
 */
export interface PainScaleState {
  active: boolean;
  value: number;
}

interface Props {
  state: PainScaleState;
  /** Latest stable gaze gesture from the eye pipeline ("YES" | "NO" | "WATER" | null). */
  gesture: string | null;
  onConfirm: (level: number) => void;
  onCancel: () => void;
  onChange: (next: PainScaleState) => void;
}

const CYCLE_MS = 1500;

export default function PainScaleOverlay({ state, gesture, onConfirm, onCancel, onChange }: Props) {
  const [locked, setLocked] = useState(false);
  const prevGesture = useRef<string | null>(null);

  // auto-cycle 0..10 while active and not locked
  useEffect(() => {
    if (!state.active || locked) return;
    const t = setInterval(() => {
      onChange({ active: true, value: (state.value + 1) % 11 });
    }, CYCLE_MS);
    return () => clearInterval(t);
  }, [state.active, state.value, locked, onChange]);

  // edge-detect gaze gestures into pain controls
  useEffect(() => {
    if (!state.active) {
      prevGesture.current = gesture;
      return;
    }
    if (!gesture || gesture === prevGesture.current) {
      prevGesture.current = gesture;
      return;
    }
    prevGesture.current = gesture;
    if (gesture === "NO") {
      // look right: manual step (also resets the auto-cycle clock via value change)
      onChange({ active: true, value: (state.value + 1) % 11 });
    } else if (gesture === "YES") {
      setLocked(true);
      onConfirm(state.value);
    } else if (gesture === "WATER") {
      onCancel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture, state.active]);

  const reset = () => {
    setLocked(false);
    onChange({ active: false, value: 0 });
  };

  return (
    <AnimatePresence>
      {state.active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[120] bg-[#1f1f1f]/95 flex flex-col items-center justify-center"
          role="dialog"
          aria-label="Pain level selection"
        >
          <p className="text-white/70 text-lg sm:text-xl mb-2">Blink twice for HELP anytime · this panel is extra</p>
          <p className="text-[#f06a4a] font-bold uppercase tracking-widest text-sm mb-4">How much pain? Select a number</p>
          <motion.div
            key={state.value}
            initial={{ scale: 0.92, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-[9rem] leading-none font-black text-white tabular-nums"
          >
            {state.value}
          </motion.div>
          <div className="text-white/50 text-sm mb-8">out of 10 · cycles automatically</div>

          {/* companion touch/mouse fallbacks */}
          {!locked && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => onChange({ active: true, value: (state.value + 10) % 11 })}
                aria-label="Previous number"
                className="w-14 h-14 rounded-2xl bg-white/10 hover:bg-white/20 text-white text-2xl transition-all"
              >
                <ArrowLeft className="w-6 h-6 mx-auto" />
              </button>
              <button
                onClick={() => {
                  setLocked(true);
                  onConfirm(state.value);
                }}
                aria-label="Confirm pain level"
                className="px-8 h-14 rounded-2xl bg-[#c63a22] hover:bg-[#a32e1a] text-white font-bold transition-all"
              >
                Confirm <Check className="inline w-5 h-5 ml-1 -mt-1" />
              </button>
              <button
                onClick={() => onChange({ active: true, value: (state.value + 1) % 11 })}
                aria-label="Next number"
                className="w-14 h-14 rounded-2xl bg-white/10 hover:bg-white/20 text-white text-2xl transition-all"
              >
                <ArrowRight className="w-6 h-6 mx-auto" />
              </button>
              <button
                onClick={() => {
                  onCancel();
                  reset();
                }}
                aria-label="Cancel pain check"
                className="ml-4 w-14 h-14 rounded-2xl bg-white/10 hover:bg-[#d94a4a] text-white transition-all"
              >
                <X className="w-6 h-6 mx-auto" />
              </button>
            </div>
          )}
          {locked && (
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="mt-8 text-[#22a67e] text-2xl font-bold">
              ✓ Sent to the nurse
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
