"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { classifyEyeGesture, EyeGestureSmoother, IrisCalibrator, computeAvgIrisOffset } from "@/lib/eyeClassifier";
import { voiceAlert } from "@/lib/tts";
import { addGestureLog } from "@/lib/gestureLog";
import { EyeGesture, EYE_GESTURE_MAP, PatientMetrics, Point } from "@/types";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

const CLUTCH_CLOSE_MS = 5000;
const RESTING_WINDOW_MS = 10000;
const RESTING_THRESHOLD = 5;
const RESTING_COOLDOWN_MS = 20000;

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function eyeAspectRatio(lm: Point[], cl: number, cr: number, top: number, bottom: number): number {
  const w = dist(lm[cl], lm[cr]);
  const h = dist(lm[top], lm[bottom]);
  return w < 1e-6 ? 1 : h / w;
}

export interface UseEyeGestureOptions {
  onGesture?: (gesture: string, description: string, confidence: number) => void;
}

export function useEyeGesture({ onGesture }: UseEyeGestureOptions = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const creatingRef = useRef(false);
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const smootherRef = useRef(new EyeGestureSmoother());
  const calibratorRef = useRef(new IrisCalibrator());
  const lastLoggedGesture = useRef<string | null>(null);
  const restState = useRef({ transitions: 0, windowStart: 0, cooldownUntil: 0 });
  const pauseState = useRef({ paused: false, closeStart: 0 });
  const lastFpsTime = useRef(0);
  const frameCount = useRef(0);

  // Mutable values read inside the render loop — keeps the loop closure stable
  // (fixes the stale-closure bug where `confidence` was frozen at 0 forever).
  const liveRef = useRef({ confidence: 0, gesture: null as EyeGesture });

  const metricsRef = useRef({
    earValues: [] as number[],
    blinkRateWindow: [] as number[],
    closureStart: 0,
    lastMetricsBroadcast: 0,
    prevLandmarks: null as Point[] | null,
    movementAccum: 0,
    movementSamples: 0,
  });

  const [gesture, setGesture] = useState<EyeGesture>(null);
  const [confidence, setConfidence] = useState(0);
  const [fps, setFps] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const faceDetectedRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const [patientMetrics, setPatientMetrics] = useState<PatientMetrics>({});

  function computePatientMetrics() {
    const m = metricsRef.current;
    const now = Date.now();
    const recentEar = m.earValues.slice(-150);
    const avgEar = recentEar.length > 0 ? recentEar.reduce((a, b) => a + b, 0) / recentEar.length : 0.3;
    m.blinkRateWindow = m.blinkRateWindow.filter((t) => now - t < 60000);
    const blinkRate = m.blinkRateWindow.length;
    const alertnessScore = Math.min(100, Math.max(0, (avgEar / 0.35) * 100));
    const eyeClosureDuration = m.closureStart > 0 ? now - m.closureStart : 0;
    const movementActivity =
      m.movementSamples > 0 ? Math.min(1, m.movementAccum / m.movementSamples / 0.01) : 0.5;
    m.movementAccum = 0;
    m.movementSamples = 0;
    return {
      blinkRate,
      alertnessScore: Math.round(alertnessScore),
      eyeClosureDuration,
      movementActivity: Math.round(movementActivity * 100) / 100,
    };
  }

  /** Model is created lazily on first camera start — saves ~8MB download for
   *  visitors who only browse the landing/dashboard pages. */
  const ensureLandmarker = useCallback(async (): Promise<boolean> => {
    if (landmarkerRef.current) return true;
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setBooting(true);
    try {
      const wasm = await FilesetResolver.forVisionTasks(WASM_URL);
      const landmarker = await FaceLandmarker.createFromOptions(wasm, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      landmarkerRef.current = landmarker;
      setModelReady(true);
      return true;
    } catch {
      setError("Failed to load the face tracking model. Check your internet connection once — after that it works offline.");
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

    // FPS meter
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

    const hasFace = !!(result.faceLandmarks && result.faceLandmarks.length > 0);
    if (hasFace !== faceDetectedRef.current) {
      faceDetectedRef.current = hasFace;
      setFaceDetected(hasFace); // change-only update: no per-frame re-renders
    }

    let raw = null;
    let faceLm: Point[] | null = null;
    if (hasFace) {
      faceLm = result.faceLandmarks[0].map((lm) => ({ x: lm.x, y: lm.y, z: lm.z ?? 0 }));
      // Calibrate the neutral-gaze baseline from plausible-neutral frames only
      calibratorRef.current.update(computeAvgIrisOffset(faceLm, true));
      raw = classifyEyeGesture(faceLm, { mirrored: true, baseline: calibratorRef.current.value });
    }

    // ── wellness metrics ──
    if (hasFace && faceLm) {
      const m = metricsRef.current;
      const avgEAR = (
        eyeAspectRatio(faceLm, 33, 133, 159, 145) +
        eyeAspectRatio(faceLm, 362, 263, 386, 374)
      ) / 2;
      m.earValues.push(avgEAR);
      if (m.earValues.length > 300) m.earValues.splice(0, m.earValues.length - 300);

      const now = Date.now();
      if (avgEAR < 0.22) {
        if (m.closureStart === 0) m.closureStart = now;
      } else if (m.closureStart > 0) {
        if (now - m.closureStart < 500) m.blinkRateWindow.push(now);
        m.closureStart = 0;
      }

      if (m.prevLandmarks) {
        let totalMovement = 0;
        const n = Math.min(faceLm.length, m.prevLandmarks.length);
        for (let i = 0; i < n; i++) totalMovement += dist(faceLm[i], m.prevLandmarks[i]);
        m.movementAccum += totalMovement / n;
        m.movementSamples++;
      }
      m.prevLandmarks = faceLm.map((p) => ({ x: p.x, y: p.y, z: p.z }));

      if (now - m.lastMetricsBroadcast > 1000) {
        setPatientMetrics(computePatientMetrics());
        m.lastMetricsBroadcast = now;
      }
    }

    const smoothed = smootherRef.current.push(raw);
    liveRef.current.gesture = smoothed.gesture;
    liveRef.current.confidence = smoothed.confidence;

    // Throttled state sync (max ~10Hz instead of 30-60Hz)
    setGesture((prev) => (prev === smoothed.gesture ? prev : smoothed.gesture));
    setConfidence((prev) => (Math.abs(prev - smoothed.confidence) > 0.02 ? smoothed.confidence : prev));

    // Clutch pause: eyes closed 5s
    if (hasFace && raw === null && faceLm && smoothed.gesture === null) {
      const now = Date.now();
      if (pauseState.current.closeStart === 0) pauseState.current.closeStart = now;
      if (!pauseState.current.paused && now - pauseState.current.closeStart >= CLUTCH_CLOSE_MS) {
        pauseState.current.paused = true;
        setIsPaused(true);
      }
    } else if (raw !== null || smoothed.gesture !== null) {
      pauseState.current.closeStart = 0;
      if (pauseState.current.paused) {
        pauseState.current.paused = false;
        setIsPaused(false);
      }
    }

    if (!pauseState.current.paused) {
      const threshold = Date.now() < restState.current.cooldownUntil ? 0.85 : 0.7;
      if (smoothed.gesture && smoothed.confidence > threshold) {
        const entry = EYE_GESTURE_MAP[smoothed.gesture];
        if (entry && smoothed.gesture !== lastLoggedGesture.current) {
          lastLoggedGesture.current = smoothed.gesture;
          voiceAlert.speak(smoothed.gesture, "eye");
          if (onGesture) onGesture(smoothed.gesture, entry.description, smoothed.confidence);
          else addGestureLog(smoothed.gesture, entry.description, smoothed.confidence, "eye", voiceAlert.getLanguage());
        }
      }

      // Resting-state auto-cooldown
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

    drawOverlay(video, faceLm ?? null, !!hasFace);
    animRef.current = requestAnimationFrame(processFrames);
  }, [onGesture]);

  function drawOverlay(video: HTMLVideoElement, faceLm: Point[] | null, hasFace: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
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
      ctx.fillText("Keep eyes open to resume", w / 2, h / 2 + 28);
      return;
    }

    if (!faceLm || !hasFace) return;
    const conf = Math.max(0.3, liveRef.current.confidence);

    ctx.strokeStyle = "rgba(34,197,94,0.5)";
    ctx.lineWidth = 1.5;
    const drawPath = (indices: number[]) => {
      ctx.beginPath();
      ctx.moveTo(faceLm[indices[0]].x * w, faceLm[indices[0]].y * h);
      for (let i = 1; i < indices.length; i++) ctx.lineTo(faceLm[indices[i]].x * w, faceLm[indices[i]].y * h);
      ctx.stroke();
    };
    drawPath([33,246,161,160,159,158,157,173,133,155,154,153,145,144,163,7,33]);
    drawPath([362,398,384,385,386,387,388,466,263,249,390,373,374,380,381,382,362]);
    ctx.strokeStyle = `rgba(59,130,246,${Math.min(0.9, 0.35 + conf * 0.5)})`;
    drawPath([468,469,470,471,468]);
    drawPath([473,474,475,476,473]);

    ctx.fillStyle = `rgba(34,197,94,${conf})`;
    for (let i = 0; i < faceLm.length; i += 3) {
      ctx.beginPath();
      ctx.arc(faceLm[i].x * w, faceLm[i].y * h, 1.5, 0, 2 * Math.PI);
      ctx.fill();
    }
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
    faceDetectedRef.current = false;
    setFaceDetected(false);
    setIsPaused(false);
    setPatientMetrics({});
    smootherRef.current.reset();
    calibratorRef.current.reset();
    restState.current = { transitions: 0, windowStart: 0, cooldownUntil: 0 };
    pauseState.current = { paused: false, closeStart: 0 };
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
    modelReady,
    loading: booting,
    error,
    cameraOn,
    faceDetected,
    isPaused,
    patientMetrics,
    startCamera,
    stopCamera,
  };
}
