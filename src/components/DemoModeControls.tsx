"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Beaker, Eye, Hand, ThumbsUp, ThumbsDown, HelpCircle, Droplets, Play, Square } from "lucide-react";

interface DemoModeControlsProps {
  onSimulateGesture: (gesture: string) => void;
  gestureType: "hand" | "eye";
}

const GESTURE_BUTTONS = [
  { gesture: "YES", icon: ThumbsUp, label: "Yes", color: "text-[#22a67e] bg-[#ecfdf5] hover:bg-[#d1fae5]" },
  { gesture: "NO", icon: ThumbsDown, label: "No", color: "text-[#d94a4a] bg-[#fef2f2] hover:bg-[#fee2e2]" },
  { gesture: "HELP", icon: HelpCircle, label: "Help", color: "text-[#e8993e] bg-[#fffbeb] hover:bg-[#fef3c7]" },
  { gesture: "WATER", icon: Droplets, label: "Water", color: "text-[#3b82f6] bg-[#eff6ff] hover:bg-[#dbeafe]" },
];

/** Scripted closed-loop scenario for judges — exercises the FULL pipeline:
 *  gestures → TTS → sync → server → nurse console → auto-escalation rules.
 *  Timeline (ms) is deliberately paced so each stage is visible on the nurse
 *  screen while it happens. */
const SCENARIO: { at: number; gesture: string; caption: string }[] = [
  { at: 0, gesture: "WATER", caption: "Patient asks for water — spoken aloud + streamed to the nurse" },
  { at: 2500, gesture: "YES", caption: "Patient answers YES to a question" },
  { at: 5000, gesture: "HELP", caption: "HELP call #1 — watch it appear on the nurse console" },
  { at: 7000, gesture: "HELP", caption: "HELP call #2" },
  { at: 9000, gesture: "HELP", caption: "HELP call #3 — triggers the help-frequency AUTO-ESCALATION rule!" },
  { at: 13000, gesture: "EMERGENCY", caption: "EMERGENCY — siren arms, tab flashes, escalation chain armed" },
];
const SCENARIO_END_MS = 15500;

export default function DemoModeControls({ onSimulateGesture, gestureType }: DemoModeControlsProps) {
  const [active, setActive] = useState(false);
  const [scenarioStep, setScenarioStep] = useState<number | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  };

  useEffect(() => () => clearTimers(), []);

  const runScenario = () => {
    clearTimers();
    setScenarioStep(0);
    for (const step of SCENARIO) {
      timersRef.current.push(
        setTimeout(() => {
          onSimulateGesture(step.gesture);
          setScenarioStep(SCENARIO.indexOf(step) + 1);
        }, step.at)
      );
    }
    timersRef.current.push(setTimeout(() => setScenarioStep(null), SCENARIO_END_MS));
  };

  const stopScenario = () => {
    clearTimers();
    setScenarioStep(null);
  };

  const running = scenarioStep !== null;
  const currentCaption =
    running && scenarioStep > 0
      ? SCENARIO[Math.min(scenarioStep - 1, SCENARIO.length - 1)].caption
      : running
      ? "Starting scripted scenario…"
      : "";

  return (
    <div>
      <button
        onClick={() => setActive(!active)}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
          active
            ? "bg-[#c63a22]/10 text-[#c63a22] border border-[#c63a22]/20"
            : "btn-secondary"
        }`}
      >
        <Beaker className={`w-4 h-4 ${active ? "animate-breathe" : ""}`} />
        {active ? "Demo Mode Active" : "Demo Mode"}
      </button>
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 overflow-hidden"
          >
            <div className="bg-white rounded-xl border border-[#ececec] p-3">
              <div className="flex items-center gap-2 mb-3">
                {gestureType === "hand" ? (
                  <Hand className="w-4 h-4 text-[#c63a22]" />
                ) : (
                  <Eye className="w-4 h-4 text-[#22a67e]" />
                )}
                <span className="text-xs text-[#6e6e6e]">
                  Simulate {gestureType === "hand" ? "hand" : "eye"} gestures
                </span>
              </div>

              {/* ── one-click judge scenario ── */}
              <button
                onClick={running ? stopScenario : runScenario}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors mb-3 ${
                  running
                    ? "bg-[#fef2f2] text-[#d94a4a] border border-[#fecaca]"
                    : "bg-[#c63a22] text-white hover:bg-[#a83220]"
                }`}
              >
                {running ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {running ? "Stop scenario" : "▶ Run closed-loop scenario (15s)"}
              </button>
              {running && currentCaption && (
                <motion.p
                  key={scenarioStep}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs text-[#c63a22] font-medium mb-3 text-center"
                  role="status"
                  aria-live="polite"
                >
                  {currentCaption}
                </motion.p>
              )}

              <div className="grid grid-cols-2 gap-2">
                {GESTURE_BUTTONS.map((btn) => {
                  const Icon = btn.icon;
                  return (
                    <button
                      key={btn.gesture}
                      onClick={() => onSimulateGesture(btn.gesture)}
                      disabled={running}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-40 ${btn.color}`}
                    >
                      <Icon className="w-4 h-4" />
                      {btn.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-[#9ca3af] mt-2 text-center">
                Gestures logged, synced, and displayed on nurse dashboard in real time
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
