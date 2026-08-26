"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Scale, ChevronDown, BookOpen } from "lucide-react";
import { RiskAssessment } from "@/lib/risk";
import { citationPassage } from "@/lib/clinicalBasis";

/**
 * "Why this score?" — exact signed contribution chart.
 *
 * The risk model is additive, so each bar IS the closed-form Shapley value of
 * that factor: φᵢ = componentᵢ(observed) − componentᵢ(healthy baseline).
 * Every factor carries its clinical citation (docId §section) so the nurse can
 * defend the number to a senior clinician — decision-support, not a black box.
 */
export default function RiskAttribution({ risk }: { risk: RiskAssessment }) {
  const [open, setOpen] = useState(false);
  const maxAbs = useMemo(
    () => Math.max(1, ...risk.attribution.map((a) => Math.abs(a.phi))),
    [risk.attribution]
  );

  if (risk.attribution.length === 0) {
    return (
      <p className="text-xs text-[#22a67e] mt-2 flex items-center gap-1">
        <Scale className="w-3 h-3" /> All factors at healthy baseline — nothing driving the score.
      </p>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#ececec]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between text-left group"
      >
        <span className="text-xs font-semibold text-[#6e6e6e] uppercase tracking-wider flex items-center gap-1.5">
          <Scale className="w-3.5 h-3.5 text-[#c63a22]" />
          Why this score? — exact factor attribution
        </span>
        <ChevronDown className={`w-4 h-4 text-[#9ca3af] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-2.5" role="list" aria-label="Risk factor contributions">
              {risk.attribution.map((a) => {
                const pct = (Math.abs(a.phi) / maxAbs) * 100;
                return (
                  <div key={a.key} role="listitem">
                    <div className="flex items-baseline justify-between gap-2 mb-0.5">
                      <span className="text-xs font-medium text-[#1f1f1f] truncate">{a.label}</span>
                      <span
                        className={`text-xs font-bold shrink-0 ${a.phi >= 0 ? "text-[#d94a4a]" : "text-[#22a67e]"}`}
                      >
                        {a.phi >= 0 ? "+" : ""}
                        {Math.round(a.phi)}
                      </span>
                    </div>
                    {/* signed diverging bars around a zero axis */}
                    <div className="relative h-2 rounded bg-[#f5f3f0]" title={a.detail}>
                      <div className="absolute inset-y-0 left-1/2 w-px bg-[#d5d5d5]" aria-hidden />
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct / 2}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                        className={`absolute inset-y-0 rounded ${a.phi >= 0 ? "left-1/2 bg-[#d94a4a]/80" : "right-1/2 bg-[#22a67e]/80"}`}
                      />
                    </div>
                    <div className="flex items-start gap-1 mt-0.5">
                      {a.citation && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] text-[#6e6e6e]"
                          title={citationPassage(a.citation)}
                        >
                          <BookOpen className="w-3 h-3 shrink-0 text-[#c63a22]/70" />
                          <span className="font-mono">{a.citation.docId} §{a.citation.section}</span>
                        </span>
                      )}
                      <span className="text-[10px] text-[#9ca3af] truncate">{a.detail}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-[#9ca3af] mt-3 leading-relaxed">
              Additive score ⇒ φᵢ = componentᵢ(patient) − componentᵢ(healthy baseline) is the EXACT
              Shapley value — no approximation, no black box. Citations are curated clinical
              reference summaries; verify against source guidance before clinical use.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
