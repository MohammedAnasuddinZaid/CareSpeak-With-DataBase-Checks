"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { classifyHandGesture, HandGestureSmoother, isOpenPalm, areFingersSpread } from "@/lib/handClassifier";
import { voiceAlert } from "@/lib/tts";
import { addGestureLog } from "@/lib/gestureLog";
import { HandData, HandGesture, HAND_GESTURE_MAP, PatientMetrics, Point } from "@/types";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

const FINGER_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6"];
const FINGER_INDICES = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],[5,6],[6,7],[7,8],[9,10],[10,11],[11,12],[13,14],[14,15],[15,16],
  [17,18],[18,19],[19,20],[0,5],[5,9],[9,13],[13,17],[0,17],
];

const CLUTCH_OPEN_MS = 5000;
const PALM_HOLD_WATER_MS = 2000;
const RESTING_WINDOW_MS = 10000;
const RESTING_THRESHOLD = 5;
const RESTING_COOLDOWN_MS = 20000;

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export interface UseHandGestureOptions {
  onGesture?: (gesture: string, description: string, confidence: number) => void;
}

export function useHandGesture({ onGesture }: UseHandGestureOptions = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const creatingRef = useRef(false);
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const smootherRef = useRef(new HandGestureSmoother());
  const lastLoggedGesture = useRef<string | null>(null);
  const restState = useRef({ transitions: 0, windowStart: 0, cooldownUntil: 0 });
  const pauseState = useRef({ paused: false, palmOpenStart: 0 });
  const waterHold = useRef({ start: 0, fired: false });
  const lastFpsTime = useRef(0);
  const frameCount = useRef(0);
  const liveRef = useRef({ confidence: 0, gesture: null as HandGesture });
  const metricsRef = useRef({
    prevLandmarks: null as Point[] | null,
    movementAccum: 0,
    movementSamples: 0,
    lastMetricsBroadcast: 0,
  });

  const [gesture, setGesture] = useState<HandGesture>(null);
  const [confidence, setConfidence] = useState(0);
  const [fps, setFps] = useState(0);
  const [numHands, setNumHands] = useState(0);
  const numHandsRef = useRef(0);
  const [modelReady, setModelReady] = useState(false);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedReason, setPausedReason] = useState<string | null>(null);
  const [patientMetrics, setPatientMetrics] = useState<PatientMetrics>({});

  function computeMetrics() {
    const m = metricsRef.current;
    const movementActivity =
      m.movementSamples > 0 ? Math.min(1, m.movementAccum / m.movementSamples / 0.005) : 0.5;
    m.movementAccum = 0;
    m.movementSamples = 0;
    return { movementActivity: Math.round(movementActivity * 100) / 100 };
  }

  const ensureLandmarker = useCallback(async (): Promise<boolean> => {
    if (landmarkerRef.current) return true;
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setBooting(true);
    try {
      const wasm = await FilesetResolver.forVisionTasks(WASM_URL);
      const landmarker = await HandLandmarker.createFromOptions(wasm, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.7,
        minTrackingConfidence: 0.5,
      });
      landmarkerRef.current = landmarker;
      setModelReady(true);
      return true;
    } catch {
      setError("Failed to load the hand tracking model. Check your connection once — after that it works offline.");
      return false;
    } finally {
      creatingRef.current = false;
      setBooting(false);
    }
  }, []);

  const processFrames = useCallback(() => {
    if (!runningRef.current || !videoRef.current || !landmarkerRef.current) return;
    const video = videoRef.current;
    if (video.readyState < 2 || video.videoWidth === 0) {
      animRef.current = requestAnimationFrame(processFrames);
      return;
    }

    frameCount.current++;
    const nowTs = performance.now();
    if (nowTs - lastFpsTime.current >= 1000) {
      setFps(frameCount.current);
      frameCount.current = 0;
      lastFpsTime.current = nowTs;
    }

    let result;
    try {
      result = landmarkerRef.current.detectForVideo(video, performance.now());
    } catch {
      animRef.current = requestAnimationFrame(processFrames);
      return;
    }

    const hands: HandData[] = [];
    if (result.landmarks) {
      for (let i = 0; i < result.landmarks.length; i++) {
        hands.push({
          landmarks: result.landmarks[i].map((lm) => ({ x: lm.x, y: lm.y, z: lm.z ?? 0 })),
          handedness:
            (result.handednesses?.[i]?.[0]?.categoryName as "Left" | "Right") ?? "Left",
        });
      }
    }
    if (hands.length !== numHandsRef.current) {
      numHandsRef.current = hands.length;
      setNumHands(hands.length);
    }

    if (hands.length > 0) {
      const m = metricsRef.current;
      const lm0 = hands[0].landmarks;
      if (m.prevLandmarks && lm0.length === m.prevLandmarks.length) {
        let totalMovement = 0;
        for (let i = 0; i < lm0.length; i++) totalMovement += dist(lm0[i], m.prevLandmarks[i]);
        m.movementAccum += totalMovement / lm0.length;
        m.movementSamples++;
      }
      m.prevLandmarks = lm0.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const now = Date.now();
      if (now - m.lastMetricsBroadcast > 1000) {
        setPatientMetrics(computeMetrics());
        m.lastMetricsBroadcast = now;
      }
    }

    // Clutch pause: wide open palm held 5s
    const palmWideOpen =
      hands.length > 0 && isOpenPalm(hands[0].landmarks) && areFingersSpread(hands[0].landmarks);
    const nowMs = Date.now();
    if (palmWideOpen) {
      if (pauseState.current.palmOpenStart === 0) pauseState.current.palmOpenStart = nowMs;
      if (!pauseState.current.paused && nowMs - pauseState.current.palmOpenStart >= CLUTCH_OPEN_MS) {
        pauseState.current.paused = true;
        setIsPaused(true);
        setPausedReason("Palm held open — tracking paused");
      }
    } else {
      pauseState.current.palmOpenStart = 0;
      if (pauseState.current.paused) {
        pauseState.current.paused = false;
        setIsPaused(false);
        setPausedReason(null);
      }
    }

    if (!pauseState.current.paused) {
      let raw = classifyHandGesture(hands);

      // Accessibility: one-handed WATER — single spread palm held 2s
      if (hands.length === 1 && palmWideOpen) {
        if (waterHold.current.start === 0) waterHold.current.start = nowMs;
        if (!waterHold.current.fired && nowMs - waterHold.current.start >= PALM_HOLD_WATER_MS) {
          waterHold.current.fired = true;
          raw = { gesture: "WATER", confidence: 0.75 };
        }
      } else {
        waterHold.current = { start: 0, fired: false };
      }

      const smoothed = smootherRef.current.push(raw);
      liveRef.current.gesture = smoothed.gesture;
      liveRef.current.confidence = smoothed.confidence;

      setGesture((prev) => (prev === smoothed.gesture ? prev : smoothed.gesture));
      setConfidence((prev) =>
        Math.abs(prev - smoothed.confidence) > 0.02 ? smoothed.confidence : prev
      );

      const threshold = Date.now() < restState.current.cooldownUntil ? 0.85 : 0.7;
      if (smoothed.gesture && smoothed.confidence > threshold) {
        const entry = HAND_GESTURE_MAP[smoothed.gesture];
        if (entry) {
          voiceAlert.speak(smoothed.gesture, "hand");
          if (smoothed.gesture !== lastLoggedGesture.current) {
            lastLoggedGesture.current = smoothed.gesture;
            if (onGesture) onGesture(smoothed.gesture, entry.description, smoothed.confidence);
            else addGestureLog(smoothed.gesture, entry.description, smoothed.confidence, "hand", voiceAlert.getLanguage());
          }
        }
      }

      const rs = restState.current;
      if (smoothed.gesture && smoothed.confidence > 0.5) {
        const now = Date.now();
        if (now - rs.windowStart > RESTING_WINDOW_MS) {
          rs.transitions = 0;
          rs.windowStart = now;
        }
        rs.transitions++;
        if (rs.transitions >= RESTING_THRESHOLD) {
          rs.cooldownUntil = now + RESTING_COOLDOWN_MS;
          rs.transitions = 0;
        }
      }
    }

    drawOverlay(video, hands);
    animRef.current = requestAnimationFrame(processFrames);
  }, [onGesture]);

  function drawOverlay(video: HTMLVideoElement, hands: HandData[]) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1); // mirror to match the flipped video element
    ctx.drawImage(video, 0, 0);

    if (pauseState.current.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(251,191,36,0.95)";
      ctx.font = "bold 44px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", w / 2, h / 2 - 20);
      ctx.font = "15px Inter, sans-serif";
      ctx.fillStyle = "rgba(226,232,240,0.85)";
      ctx.fillText("Relax your hand to resume", w / 2, h / 2 + 28);
      ctx.restore();
      return;
    }

    const conf = Math.max(0.3, liveRef.current.confidence);
    for (const hand of hands) {
      const lm = hand.landmarks;
      ctx.strokeStyle = "rgba(59,130,246,0.6)";
      ctx.lineWidth = 2;
      for (const [i, j] of CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(lm[i].x * w, lm[i].y * h);
        ctx.lineTo(lm[j].x * w, lm[j].y * h);
        ctx.stroke();
      }
      for (let fi = 0; fi < FINGER_INDICES.length; fi++) {
        ctx.fillStyle = FINGER_COLORS[fi % FINGER_COLORS.length];
        ctx.globalAlpha = conf;
        for (const idx of FINGER_INDICES[fi]) {
          ctx.beginPath();
          ctx.arc(lm[idx].x * w, lm[idx].y * h, 5, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  const startCamera = useCallback(async () => {
    setError(null);
    const ok = await ensureLandmarker();
    if (!ok) return;
    const video = videoRef.current;
    if (!video) {
      setError("Camera panel is not ready — please refresh the page and try again.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
      });
      video.srcObject = stream;
      streamRef.current = stream;
      await video.play();
      setCameraOn(true);
      if (!runningRef.current) {
        runningRef.current = true;
        animRef.current = requestAnimationFrame(processFrames);
      }
    } catch (e) {
      const name = (e as DOMException)?.name ?? "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setError("Camera permission denied. Click the camera icon in the address bar, allow access, then press Start Camera again.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setError("No camera found. Connect a webcam (or enable it in device settings) and try again.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setError("Camera is busy. Close other apps using it (Zoom / Meet / Teams / another tab), then try again.");
      } else {
        setError("Could not start the camera. Use Chrome or Edge over localhost/HTTPS, allow camera access, and retry.");
      }
    }
  }, [ensureLandmarker, processFrames]);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setGesture(null);
    setConfidence(0);
    numHandsRef.current = 0;
    setNumHands(0);
    setIsPaused(false);
    setPausedReason(null);
    setPatientMetrics({});
    smootherRef.current.reset();
    restState.current = { transitions: 0, windowStart: 0, cooldownUntil: 0 };
    pauseState.current = { paused: false, palmOpenStart: 0 };
    waterHold.current = { start: 0, fired: false };
    lastLoggedGesture.current = null;
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      try {
        landmarkerRef.current?.close();
      } catch {}
      landmarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    videoRef,
    canvasRef,
    gesture,
    confidence,
    fps,
    numHands,
    modelReady,
    loading: booting,
    error,
    cameraOn,
    isPaused,
    pausedReason,
    patientMetrics,
    startCamera,
    stopCamera,
  };
}


