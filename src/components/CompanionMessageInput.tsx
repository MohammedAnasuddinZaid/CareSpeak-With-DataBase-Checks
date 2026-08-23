"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Keyboard, Send, Check } from "lucide-react";

/**
 * Companion input: a relative/attendant sitting beside the patient can type a
 * note that appears instantly on the nurse console — the reverse direction of
 * the nurse reply banner. Silent locally (no TTS) by design.
 */
export default function CompanionMessageInput({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const [sentFlash, setSentFlash] = useState(false);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    setSentFlash(true);
    setTimeout(() => setSentFlash(false), 2500);
  };

  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center gap-2 mb-2.5">
        <Keyboard className="w-4 h-4 text-[#c63a22]" />
        <span className="text-xs font-semibold text-[#1f1f1f]">
          With the patient? Send a note to the nurse
        </span>
      </div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Type here… e.g. “Patient seems sleepy”"
          aria-label="Note for the nurse"
          maxLength={200}
          className="input flex-1 text-sm"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          aria-label="Send note to nurse"
          className="btn-primary px-4 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <AnimatePresence>
        {sentFlash && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="status"
            className="mt-2 text-xs font-medium text-[#22a67e] flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" /> Sent to the nurse console
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
