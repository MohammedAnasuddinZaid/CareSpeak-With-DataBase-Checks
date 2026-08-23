"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { NurseReply, SupportedLanguage } from "@/types";
import { voiceAlert } from "@/lib/tts";

const VISIBLE_MS = 20000;
const LANGS: readonly string[] = [
  "en-US", "hi-IN", "bn-IN", "ta-IN", "te-IN",
  "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN",
];

/** Full-screen banner for nurse->patient messages. Speaks the text once and auto-dismisses. */
export default function NurseReplyBanner({ reply }: { reply: NurseReply | null }) {
  const [visible, setVisible] = useState(false);
  const spokenId = useRef<string | null>(null);

  useEffect(() => {
    if (!reply || reply.text.startsWith("[PAIN]")) return; // pain requests render as their own overlay
    setVisible(true);
    if (spokenId.current !== reply.id) {
      spokenId.current = reply.id;
      const lang = LANGS.includes(reply.lang) ? (reply.lang as SupportedLanguage) : undefined;
      voiceAlert.speakDirect(reply.text, lang);
    }
    const t = setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [reply]);

  if (reply?.text.startsWith("[PAIN]")) return null;

  return (
    <AnimatePresence>
      {reply && visible && (
        <motion.div
          key={reply.id}
          role="status"
          aria-live="assertive"
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 60 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[90] w-[min(92vw,560px)]"
        >
          <div className="rounded-3xl bg-gradient-to-br from-[#22a67e] to-[#16855f] text-white p-6 shadow-2xl shadow-[#22a67e]/30">
            <div className="flex items-center gap-2 mb-3">
              <MessageCircle className="w-5 h-5" />
              <span className="text-xs font-semibold uppercase tracking-widest opacity-80">
                Message from {reply.from || "Nurse"}
              </span>
            </div>
            <p className="text-2xl sm:text-3xl font-bold leading-snug">{reply.text}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
