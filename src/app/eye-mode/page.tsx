"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Eye, RotateCcw, Camera, StopCircle, Pause, ArrowLeft, ArrowRight,
  HelpCircle, Droplets, Sparkles, Activity, Fingerprint, Volume2,
} from "lucide-react";
import { useEyeGesture } from "@/hooks/useEyeGesture";
import { EYE_GESTURE_MAP } from "@/types";
import { voiceAlert } from "@/lib/tts";
import { getOrCreateSession } from "@/lib/session";
import { useLiveSync } from "@/hooks/useLiveSync";
import { addGestureLog } from "@/lib/gestureLog";
import QRPairingDisplay from "@/components/QRPairingDisplay";
import CompanionMessageInput from "@/components/CompanionMessageInput";
import DemoModeControls from "@/components/DemoModeControls";
import PatientMetricsCard from "@/components/PatientMetricsCard";
import NurseReplyBanner from "@/components/NurseReplyBanner";
import PainScaleOverlay from "@/components/PainScaleOverlay";

const GESTURE_GUIDE = [
  { label: "YES", desc: "Look Left", icon: ArrowLeft },
  { label: "NO", desc: "Look Right", icon: ArrowRight },
  { label: "HELP", desc: "Double Blink (fast)", icon: HelpCircle },
  { label: "WATER", desc: "Open Mouth", icon: Droplets },
  { label: "PAUSE", desc: "Close eyes 5s to pause", icon: Pause, pause: true },
];

export default function EyeModePage() {
  const sessionRef = useRef(getOrCreateSession());
  const sessionId = sessionRef.current.sessionId;

  const { sendAlert, sendReply, sendPatientMetrics, status, transport, latestReply } = useLiveSync({ sessionId });

  const sendCompanionNote = useCallback(
    (text: string) => {
      sendReply(text, "Companion");
    },
    [sendReply]
  );

  const broadcast = useCallback(
    (gesture: string, description: string, confidence: number) => {
      const entry = addGestureLog(gesture, description, confidence, "eye", voiceAlert.getLanguage(), { sessionId });
      sendAlert(entry);
    },
    [sessionId, sendAlert]
  );

  const {
    videoRef, canvasRef, gesture, confidence, loading, error, cameraOn,
    faceDetected, isPaused, patientMetrics, startCamera, stopCamera,
  } = useEyeGesture({ onGesture: broadcast });

  /* ── pain scale (gaze-driven; rides the existing gesture stream untouched) ── */
  const [pain, setPain] = useState({ active: false, value: 0 });
  const painReqConsumed = useRef<string | null>(null);
  useEffect(() => {
    if (latestReply?.text === "[PAIN]" && latestReply.id !== painReqConsumed.current) {
      painReqConsumed.current = latestReply.id;
      setPain({ active: true, value: 0 });
    }
  }, [latestReply]);

  const handlePainConfirm = useCallback(
    (level: number) => {
      voiceAlert.speakDirect(`Pain level ${level} out of ten. The nurse has been informed.`);
      sendReply(`🩸 PAIN LEVEL: ${level}/10`, "Patient");
      setTimeout(() => setPain({ active: false, value: 0 }), 1200);
    },
    [sendReply]
  );
  const handlePainCancel = useCallback(() => {
    voiceAlert.speakDirect("Pain check closed.");
    setPain({ active: false, value: 0 });
  }, []);

  const latestMetrics = useRef(patientMetrics);
  latestMetrics.current = patientMetrics;
  const metricsSender = useRef(sendPatientMetrics);
  metricsSender.current = sendPatientMetrics;
  useEffect(() => {
    if (!cameraOn) return;
    const t = setInterval(() => {
      if (Object.keys(latestMetrics.current).length > 0) metricsSender.current(latestMetrics.current);
    }, 3000);
    return () => clearInterval(t);
  }, [cameraOn]);

  const simulate = useCallback(
    (g: string) => {
      const entry = EYE_GESTURE_MAP[g];
      if (entry) {
        voiceAlert.speak(g, "eye");
        broadcast(g, entry.description, 1);
      }
    },
    [broadcast]
  );

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
                <Eye className="w-4 h-4" />
                Eye Gesture Mode
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-[#1f1f1f] tracking-tight">Eye Tracking Dashboard</h1>
              <p className="mt-2 text-[#6e6e6e]">
                Look left/right, blink twice for HELP, or open your mouth — no hand movement needed.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <DemoModeControls onSimulateGesture={simulate} gestureType="eye" />
              <button
                onClick={() => setPain({ active: true, value: 0 })}
                disabled={!cameraOn}
                title="Gaze-driven pain scale (works best with camera on)"
                className="btn-secondary px-4 py-2.5 text-sm disabled:opacity-40"
              >
                🩺 Pain check
              </button>
              {cameraOn && (
                <button onClick={stopCamera} className="btn-danger flex items-center gap-2 px-4 py-2.5 text-sm">
                  <StopCircle className="w-4 h-4" /> Stop Camera
                </button>
              )}
            </div>
          </div>
        </motion.div>

        <QRPairingDisplay sessionId={sessionId} compact />
        <CompanionMessageInput onSend={sendCompanionNote} />
        <NurseReplyBanner reply={latestReply?.text?.startsWith("[PAIN]") ? null : latestReply} />
        <PainScaleOverlay
          state={pain}
          gesture={cameraOn ? gesture : null}
          onConfirm={handlePainConfirm}
          onCancel={handlePainCancel}
          onChange={setPain}
        />

        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              role="alert"
              className="mb-6 p-4 rounded-2xl bg-[#fef2f2] border border-[#fecaca] text-[#d94a4a] text-sm">{error}</motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isPaused && cameraOn && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              className="mb-6 p-4 rounded-2xl bg-[#fffbeb] border border-[#fde68a] text-[#e8993e] text-sm font-medium flex items-center gap-2">
              <Pause className="w-4 h-4" /> System PAUSED — open your eyes to resume
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="relative overflow-hidden rounded-3xl aspect-[4/3] card p-1">
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/90 z-20 rounded-3xl">
                  <div className="text-center">
                    <div className="w-10 h-10 border-2 border-[#c63a22] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-[#1f1f1f] text-sm font-medium">Loading face tracking model...</p>
                    <p className="text-[#6e6e6e] text-xs mt-1">Cached after first load — works offline</p>
                  </div>
                </div>
              )}
              <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover scale-x-[-1]" playsInline muted />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover" aria-hidden />

              {!cameraOn && !loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/90 z-10 rounded-3xl">
                  <div className="text-center max-w-xs">
                    <div className="w-20 h-20 rounded-full border-2 border-dashed border-[#c63a22]/30 flex items-center justify-center mx-auto mb-6">
                      <Camera className="w-8 h-8 text-[#c63a22]/40" />
                    </div>
                    <button onClick={startCamera} className="btn-primary px-8 py-4 text-lg shadow-lg">Start Camera</button>
                    <p className="mt-4 text-[#6e6e6e] text-xs">Chrome will ask for camera permission. Video never leaves your device.</p>
                  </div>
                </div>
              )}

              {cameraOn && (
                <div className="absolute top-4 left-4 px-3 py-1.5 rounded-xl bg-white/90 backdrop-blur-sm text-[#1f1f1f] text-xs font-medium flex items-center gap-2 shadow-sm">
                  <span className={`w-2 h-2 rounded-full ${isPaused ? "status-idle" : faceDetected ? "status-online" : "status-offline"}`} aria-hidden />
                  {isPaused ? "PAUSED" : faceDetected ? "Face detected" : "No face in view"}
                </div>
              )}
              {cameraOn && (
                <div className={`absolute top-4 right-4 px-3 py-1.5 rounded-xl text-xs font-medium shadow-sm ${status === "connected" ? "bg-[#ecfdf5]/95 text-[#22a67e]" : "bg-white/90 text-[#9ca3af]"}`}>
                  {status === "connected" ? `Nurse link · ${transport.toUpperCase()}` : "Nurse link offline"}
                </div>
              )}
            </div>

            <PatientMetricsCard metrics={cameraOn ? patientMetrics : null} deviceName="Eye Camera" log={[]} />
          </div>

          <div className="space-y-6">
            <AnimatePresence mode="wait">
              {isPaused ? (
                <motion.div key="paused" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="card p-8 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-[#fffbeb] flex items-center justify-center mx-auto mb-4">
                    <Pause className="w-8 h-8 text-[#e8993e]" />
                  </div>
                  <div className="text-2xl font-bold text-[#e8993e] mb-1">PAUSED</div>
                  <div className="text-sm text-[#6e6e6e]">Open your eyes to resume</div>
                </motion.div>
              ) : gesture && confidence > 0.5 ? (
                <motion.div key="result" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                  className="card p-8 text-center" role="status" aria-live="polite">
                  <div className="text-6xl font-extrabold gradient-text mb-2">{gesture}</div>
                  <div className="text-sm text-[#6e6e6e] mb-6">{EYE_GESTURE_MAP[gesture]?.description}</div>
                  <div className="w-full bg-[#f5f3f0] rounded-full h-2.5 overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(confidence * 100, 100)}%` }}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                      className="h-full rounded-full" style={{ background: "linear-gradient(135deg,#22a67e,#34d399)" }} />
                  </div>
                  <div className="mt-2 text-xs font-medium text-[#6e6e6e]">{Math.round(confidence * 100)}% confidence</div>
                  <div className="mt-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#22a67e]/10 text-[#22a67e] text-xs font-medium border border-[#22a67e]/20">
                    <Sparkles className="w-3 h-3" /> Gesture detected
                  </div>
                </motion.div>
              ) : (
                <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card p-8 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-[#f5f3f0] flex items-center justify-center mx-auto mb-4">
                    <Fingerprint className="w-8 h-8 text-[#6e6e6e]" />
                  </div>
                  <p className="text-[#1f1f1f] font-medium">Waiting for eye gesture...</p>
                  <p className="text-[#6e6e6e] text-xs mt-1">Move your eyes or blink to communicate</p>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="card p-6">
              <h3 className="text-sm font-bold text-[#1f1f1f] mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#c63a22]" /> Eye Gesture Guide
              </h3>
              <div className="space-y-2">
                {GESTURE_GUIDE.map((g) => {
                  const Icon = g.icon;
                  const isActive = gesture === g.label && !g.pause;
                  const isPauseItem = g.pause;
                  return (
                    <div key={g.label}
                      className={`flex items-center justify-between p-2.5 rounded-xl transition-all duration-200 ${
                        isPauseItem
                          ? isPaused ? "bg-[#fffbeb] border border-[#fde68a]" : "hover:bg-[#f5f3f0] border border-transparent"
                          : isActive ? "bg-[#22a67e]/5 border border-[#22a67e]/15" : "hover:bg-[#f5f3f0] border border-transparent"
                      }`}>
                      <div className="flex items-center gap-2.5">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isActive || (isPauseItem && isPaused) ? "bg-[#22a67e]" : "bg-[#c63a22]"}`}>
                          <Icon className="w-4 h-4 text-white" />
                        </div>
                        <span className={`font-bold text-sm ${isActive || (isPauseItem && isPaused) ? "text-[#22a67e]" : "text-[#1f1f1f]"}`}>{g.label}</span>
                      </div>
                      <span className="text-[#6e6e6e] text-xs text-right max-w-[55%]">{g.desc}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <button onClick={() => gesture && voiceAlert.speak(gesture, "eye")} disabled={!gesture}
              aria-label="Replay last alert"
              className={`w-full py-3.5 rounded-2xl transition-all duration-200 text-sm font-medium flex items-center justify-center gap-2 ${
                gesture ? "card hover:bg-[#f5f3f0] text-[#1f1f1f]" : "bg-[#f5f3f0] text-[#6e6e6e] border border-[#ececec] cursor-not-allowed"
              }`}>
              <RotateCcw className="w-4 h-4" /> Replay Last Alert <Volume2 className="w-4 h-4 opacity-50" />
            </button>
          </div>

        </div>

      </div>
    </div>
  );
}

