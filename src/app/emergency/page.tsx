"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Bell, Clock, ShieldCheck, StopCircle, CheckCircle2 } from "lucide-react";
import { voiceAlert } from "@/lib/tts";
import { getOrCreateSession } from "@/lib/session";
import { useLiveSync } from "@/hooks/useLiveSync";
import { addGestureLog } from "@/lib/gestureLog";

const COUNTDOWN_S = 10;

export default function EmergencyPage() {
  const sessionRef = useRef(getOrCreateSession());
  const sessionId = sessionRef.current.sessionId;
  const { sendAlert, status } = useLiveSync({ sessionId });

  const [activated, setActivated] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const [dispatched, setDispatched] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const handleActivate = useCallback(() => {
    clearTimer();
    const entry = addGestureLog(
      "EMERGENCY",
      "EMERGENCY \u2014 Medical assistance required immediately!",
      1,
      "hand",
      voiceAlert.getLanguage(),
      { sessionId, source: "manual" }
    );
    sendAlert(entry); // fans out to every nurse console + queued if offline
    setDispatched(true);
    voiceAlert.stop();
    for (let i = 0; i < 3; i++) setTimeout(() => voiceAlert.speak("EMERGENCY", "hand"), i * 1200);

    setActivated(true);
    setCountdown(COUNTDOWN_S);
    intervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearTimer();
          setActivated(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [sessionId, sendAlert]);

  const handleStop = useCallback(() => {
    clearTimer();
    setActivated(false);
    setCountdown(0);
    voiceAlert.stop();
  }, []);

  return (
    <div className="min-h-screen pt-20 pb-16 flex items-center justify-center">
      <div className="max-w-lg mx-auto px-4 text-center">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#fef2f2] border border-[#fecaca] text-[#d94a4a] text-sm font-medium mb-4">
            <Bell className="w-4 h-4" />
            Emergency Alert
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Emergency Assistance</h1>
          <p className="mt-2 text-[#6e6e6e]">
            Triggers a loud local alarm <strong>and</strong> pushes an EMERGENCY alert to every paired nurse console instantly.
          </p>
        </motion.div>

        <AnimatePresence mode="wait">
          {!activated ? (
            <motion.button
              key="activate"
              onClick={handleActivate}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              aria-label="Activate emergency alert"
              className="w-64 h-64 rounded-full bg-[#d94a4a] text-white font-bold text-2xl shadow-2xl shadow-[#d94a4a]/30 hover:shadow-[#d94a4a]/50 hover:scale-[1.02] active:scale-[0.98] transition-[box-shadow,transform] duration-200 flex flex-col items-center justify-center gap-3 alert-pulse mx-auto"
            >
              <AlertTriangle className="w-12 h-12" />
              <span>TAP FOR</span>
              <span>EMERGENCY</span>
            </motion.button>
          ) : (
            <motion.div key="active" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="flex flex-col items-center gap-6">
              <div className="w-64 h-64 rounded-full bg-[#d94a4a] text-white font-bold text-6xl shadow-2xl shadow-[#d94a4a]/30 animate-breathe flex items-center justify-center" role="status" aria-live="assertive">
                {countdown}
              </div>
              <div className="space-y-2">
                <p className="text-lg font-semibold text-[#d94a4a]">EMERGENCY ACTIVE</p>
                {dispatched && (
                  <p className={`text-sm flex items-center justify-center gap-1.5 ${
                    status === "connected" ? "text-[#22a67e]" : status === "denied" ? "text-[#d94a4a]" : "text-[#e8993e]"
                  }`}>
                    <CheckCircle2 className="w-4 h-4" />
                    {status === "connected"
                      ? "Sent to nurse console — they hear the alarm"
                      : status === "denied"
                        // Never promise delivery we cannot perform. A patient
                        // pressing this button and being told it "will send
                        // automatically" is the worst possible failure mode, so
                        // say plainly that the bed is not connected and give
                        // them the thing that still works.
                        ? "This bed is not connected to the nurse console. Use the call bell or alert a nurse directly — do not wait for this alert."
                        : "Offline — alert is queued and will send automatically"}
                  </p>
                )}
              </div>
              <button onClick={handleStop} className="btn-danger flex items-center gap-2 px-6 py-3 text-sm">
                <StopCircle className="w-4 h-4" />
                Stop Emergency
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Bell, title: "Local Alarm", desc: "Repeating siren + speech in your language" },
            { icon: Clock, title: "Auto-expires", desc: `Alarm stops after ${COUNTDOWN_S} seconds` },
            { icon: ShieldCheck, title: "Nurse Dispatch", desc: "Pushed to all paired clinician consoles" },
          ].map((item, i) => {
            const Icon = item.icon;
            return (
              <div key={i} className="card p-4 text-center">
                <Icon className="w-5 h-5 text-[#c63a22] mx-auto mb-2" />
                <h3 className="text-xs font-semibold text-[#1f1f1f] mb-1">{item.title}</h3>
                <p className="text-[10px] text-[#6e6e6e]">{item.desc}</p>
              </div>
            );
          })}
        </motion.div>
      </div>
    </div>
  );
}
