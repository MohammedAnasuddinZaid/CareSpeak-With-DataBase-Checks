"use client";

import { Suspense, useCallback, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, Wifi, WifiOff, Eye, Hand, Maximize2, Play, Smartphone, HelpCircle, X, Signal, RefreshCw, MessageCircle } from "lucide-react";
import { useCctvFeed } from "@/hooks/useCctvFeed";
import { useLiveSync } from "@/hooks/useLiveSync";
import { getOrCreateSession } from "@/lib/session";
import { linkStatusLabel } from "@/lib/networkSync";
import type { GestureLogEntry } from "@/types";

const EXAMPLES = [
  { app: "IP Webcam (Android)", url: "http://192.168.1.100:8080/video", icon: Smartphone, note: "Replace 192.168.1.100 with your phone's IP" },
  { app: "DroidCam (WiFi)", url: "http://192.168.1.100:4747/video", icon: Smartphone, note: "Replace with DroidCam's shown IP address" },
  { app: "Generic MJPEG Camera", url: "http://camera-ip:8080/video/mjpeg", icon: Camera, note: "For Hikvision, Dahua, and other IP cameras" },
];

function testConnection(url: string): Promise<{ ok: boolean; message: string }> {
  return fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" })
    .then(() => ({ ok: true, message: "Camera reachable" }))
    .catch((err) => ({ ok: false, message: `Cannot reach camera: ${err?.message ?? "unknown error"}` }));
}

function CctvSetup({ onStart }: { onStart: (url: string, mode: "hand" | "eye") => void }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"hand" | "eye">("hand");
  const [showHelp, setShowHelp] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleTest = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestResult(await testConnection(url.trim()));
    setTesting(false);
  };

  return (
    <div className="min-h-screen bg-[#f9f7f5] flex items-center justify-center p-4 pt-24">
      <div className="w-full max-w-lg">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-[#c63a22]/10 flex items-center justify-center mx-auto mb-4">
            <Camera className="w-8 h-8 text-[#c63a22]" />
          </div>
          <h1 className="text-3xl font-bold text-[#1f1f1f]">CCTV Monitoring</h1>
          <p className="text-[#6e6e6e] mt-2 text-sm">Connect any IP camera or phone camera for remote patient monitoring</p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="card p-6 space-y-5">
          <div>
            <label className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-3 block">Detection Mode</label>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setMode("hand")} aria-pressed={mode === "hand"}
                className={`p-4 rounded-xl border-2 transition-colors duration-200 text-center ${mode === "hand" ? "border-[#c63a22] bg-[#c63a22]/5" : "border-[#ececec] hover:border-[#d5d5d5]"}`}>
                <Hand className={`w-6 h-6 mx-auto mb-1 ${mode === "hand" ? "text-[#c63a22]" : "text-[#6e6e6e]"}`} />
                <div className={`text-sm font-bold ${mode === "hand" ? "text-[#c63a22]" : "text-[#1f1f1f]"}`}>Hand Mode</div>
                <div className="text-xs text-[#6e6e6e] mt-0.5">Thumbs up/down, HELP, WATER</div>
              </button>
              <button onClick={() => setMode("eye")} aria-pressed={mode === "eye"}
                className={`p-4 rounded-xl border-2 transition-colors duration-200 text-center ${mode === "eye" ? "border-[#22a67e] bg-[#22a67e]/5" : "border-[#ececec] hover:border-[#d5d5d5]"}`}>
                <Eye className={`w-6 h-6 mx-auto mb-1 ${mode === "eye" ? "text-[#22a67e]" : "text-[#6e6e6e]"}`} />
                <div className={`text-sm font-bold ${mode === "eye" ? "text-[#22a67e]" : "text-[#1f1f1f]"}`}>Eye Mode</div>
                <div className="text-xs text-[#6e6e6e] mt-0.5">Gaze, blink, mouth gestures</div>
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-3 block">Camera Stream URL</label>
            <div className="relative">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.100:8080/video"
                aria-label="Camera stream URL" className="input w-full pr-10 font-mono text-sm" />
              {url && (
                <button onClick={() => setUrl("")} aria-label="Clear URL"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6e6e6e] hover:text-[#1f1f1f]"><X className="w-4 h-4" /></button>
              )}
            </div>
          </div>

          {testResult && (
            <div role="status" className={`p-3 rounded-xl text-xs flex items-center gap-2 ${testResult.ok ? "bg-[#ecfdf5] border border-[#a7f3d0] text-[#22a67e]" : "bg-[#fef2f2] border border-[#fecaca] text-[#d94a4a]"}`}>
              <Signal className="w-4 h-4" />{testResult.message}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={handleTest} disabled={!url.trim() || testing}
              className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-colors border ${url.trim() && !testing ? "border-[#ececec] text-[#6e6e6e] hover:bg-[#f5f3f0]" : "border-[#f5f3f0] text-[#d5d5d5] cursor-not-allowed"}`}>
              <RefreshCw className={`w-4 h-4 ${testing ? "animate-spin" : ""}`} /> Test
            </button>
            <button onClick={() => onStart(url.trim(), mode)} disabled={!url.trim()}
              className={`flex-1 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-[color,background-color,box-shadow,transform] duration-200 ${url.trim() ? "bg-[#c63a22] text-white shadow-lg shadow-[#c63a22]/25 hover:shadow-xl hover:translate-y-[-1px]" : "bg-[#f5f3f0] text-[#6e6e6e] cursor-not-allowed"}`}>
              <Play className="w-4 h-4" /> Start Monitoring
            </button>
          </div>

          <div className="text-center">
            <button onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}
              className="inline-flex items-center gap-1.5 text-xs text-[#6e6e6e] hover:text-[#c63a22] transition-colors">
              <HelpCircle className="w-3.5 h-3.5" />{showHelp ? "Hide examples" : "Show example URLs"}
            </button>
          </div>
        </motion.div>

        <AnimatePresence>
          {showHelp && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-4">
              <div className="card p-5 space-y-3">
                <h3 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest">Example Stream URLs</h3>
                {EXAMPLES.map((ex, i) => {
                  const Icon = ex.icon;
                  return (
                    <div key={i} className="p-3 rounded-xl bg-[#f5f3f0] border border-[#ececec]">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Icon className="w-4 h-4 text-[#c63a22]" />
                        <span className="text-sm font-bold text-[#1f1f1f]">{ex.app}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-white px-2 py-1 rounded border border-[#ececec] font-mono text-[#6e6e6e] flex-1 truncate">{ex.url}</code>
                        <button onClick={() => setUrl(ex.url)} className="text-xs text-[#c63a22] hover:underline flex-shrink-0">Use</button>
                      </div>
                      <p className="text-xs text-[#6e6e6e] mt-1">{ex.note}</p>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-8 card p-5">
          <h3 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-3">Quick Start Guide</h3>
          <div className="space-y-2 text-sm text-[#6e6e6e]">
            {[
              { step: "1", text: 'Install "IP Webcam" (free) on an Android phone' },
              { step: "2", text: "Open the app and tap START SERVER" },
              { step: "3", text: "Note the IP shown (e.g. 192.168.1.5:8080)" },
              { step: "4", text: "Paste http://THAT-IP:8080/video above and start" },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-[#c63a22]/10 text-[#c63a22] text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{item.step}</span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function CctvMonitor({ feedUrl, mode: initialMode }: { feedUrl: string; mode: "hand" | "eye" }) {
  const sessionRef = useRef(getOrCreateSession());
  const sessionId = sessionRef.current.sessionId;
  const [detectionMode, setDetectionMode] = useState<"hand" | "eye">(initialMode);
  void setDetectionMode; // mode switching kept for future in-monitor toggle

  const { sendAlert, status, transport, latestReply } = useLiveSync({ sessionId });

  // useCctvFeed persists + speaks the gesture internally; we fan it out here.
  const onGesture = useCallback((entry: GestureLogEntry) => sendAlert(entry), [sendAlert]);

  const {
    videoRef, imgRef, canvasRef, gesture, confidence,
    loading, error, feedReady, streamType, patientMetrics, fps,
  } = useCctvFeed({ feedUrl, mode: initialMode, sessionId, onGesture });

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => undefined).catch(() => {});
    } else {
      document.exitFullscreen().then(() => undefined).catch(() => {});
    }
  };

  const isMJPEG = streamType === "mjpeg";

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-[#c63a22]" />
            <span className="text-sm font-semibold">CareSpeak CCTV</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/60 uppercase tracking-wider">{detectionMode === "hand" ? "Hand" : "Eye"}</span>
          {feedReady ? (
            <span className="flex items-center gap-1 text-xs text-[#22a67e]">
              <Wifi className="w-3 h-3" /> Live{fps > 0 && <span className="text-white/40 ml-1">{fps} fps</span>}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-[#e8993e]"><WifiOff className="w-3 h-3" /> Connecting</span>
          )}
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          <button onClick={toggleFullscreen} aria-label="Toggle fullscreen"
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="fixed inset-0">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black z-30">
            <div className="text-center">
              <div className="w-12 h-12 border-2 border-[#c63a22] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-white text-sm font-medium">Loading {detectionMode === "hand" ? "hand" : "face"} tracking model...</p>
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black z-30">
            <div className="text-center max-w-md px-6">
              <div className="w-16 h-16 rounded-full bg-[#c63a22]/20 flex items-center justify-center mx-auto mb-4"><WifiOff className="w-8 h-8 text-[#c63a22]" /></div>
              <p className="text-white font-medium mb-2">Stream Error</p>
              <p className="text-white/50 text-sm mb-4">{error}</p>
              <p className="text-white/30 text-xs">URL: <span className="font-mono">{feedUrl}</span></p>
            </div>
          </div>
        )}

        {!isMJPEG && (
          <video ref={videoRef} className={`absolute inset-0 w-full h-full object-contain ${detectionMode === "hand" ? "scale-x-[-1]" : ""}`} playsInline muted />
        )}
        {isMJPEG && (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={imgRef} src={feedUrl} alt="CCTV feed" crossOrigin="anonymous" className="absolute inset-0 w-full h-full object-contain" />
        )}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain" aria-hidden />
      </div>

      {feedReady && gesture && confidence > 0.5 && (
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
          role="status" aria-live="assertive"
          className="fixed bottom-[15%] left-1/2 -translate-x-1/2 z-40 text-center">
          <div className="px-10 py-5 rounded-3xl bg-black/70 backdrop-blur-xl border border-white/10">
            <div className="text-7xl sm:text-8xl font-extrabold gradient-text mb-2">{gesture}</div>
            <div className="mt-3 w-48 mx-auto bg-white/10 rounded-full h-1.5 overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(confidence * 100, 100)}%` }}
                className="h-full rounded-full bg-gradient-to-r from-[#c63a22] to-[#f06a4a]" />
            </div>
          </div>
        </motion.div>
      )}

      {latestReply && (
        <div role="status" aria-live="assertive"
          className="fixed top-16 left-1/2 -translate-x-1/2 z-40 px-6 py-3 rounded-2xl bg-[#22a67e] text-white text-lg font-bold shadow-2xl flex items-center gap-2 max-w-[90vw]">
          <MessageCircle className="w-5 h-5 shrink-0" />
          <span className="truncate">{latestReply.text}</span>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 z-50 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex items-center justify-between text-xs text-white/50">
          <span className="font-mono text-white/30 truncate max-w-[200px]">{feedUrl}</span>
          <div className="flex items-center gap-3">
            {patientMetrics.movementActivity !== undefined && <span>Motion {Math.round((patientMetrics.movementActivity ?? 0) * 100)}%</span>}
            {fps > 0 && <span>{fps} FPS</span>}
            <span className={status === "connected" ? "text-[#22a67e]" : status === "denied" ? "text-[#e8993e]" : "text-white/40"}>
              {linkStatusLabel(status, transport)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}


function CctvContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const qsFeed = searchParams.get("feed");
  const qsMode = searchParams.get("mode") === "eye" ? ("eye" as const) : ("hand" as const);
  const [started, setStarted] = useState(!!qsFeed);

  const handleStart = (url: string, mode: "hand" | "eye") => {
    router.replace(`/cctv?feed=${encodeURIComponent(url)}&mode=${mode}`);
    setStarted(true);
  };

  if (!started) return <CctvSetup onStart={handleStart} />;
  return <CctvMonitor feedUrl={qsFeed || ""} mode={qsMode} />;
}

export default function CctvPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#f9f7f5] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#c63a22] border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <CctvContent />
    </Suspense>
  );
}


