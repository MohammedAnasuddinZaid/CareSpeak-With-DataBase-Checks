"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { HandLandmarker, FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { classifyHandGesture, HandGestureSmoother } from "@/lib/handClassifier";
import { classifyEyeGesture, EyeGestureSmoother } from "@/lib/eyeClassifier";
import { voiceAlert } from "@/lib/tts";
import { addGestureLog } from "@/lib/gestureLog";
import { GestureLogEntry, PatientMetrics, Point } from "@/types";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

const FINGER_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6"];
const FINGER_INDICES = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const HAND_CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],[5,6],[6,7],[7,8],[9,10],[10,11],[11,12],[13,14],[14,15],[15,16],
  [17,18],[18,19],[19,20],[0,5],[5,9],[9,13],[13,17],[0,17],
];

export type CctvMode = "hand" | "eye";
export type StreamType = "mjpeg" | "video" | "unknown";

function detectStreamType(url: string): StreamType {
  const path = url.toLowerCase();
  if (path.includes(".m3u8")) return "video";
  if (path.includes("/video") || path.includes("/mjpeg") || path.includes("/stream") || path.endsWith(".mjpeg")) {
    return "mjpeg";
  }
  return "unknown";
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export interface UseCctvFeedOptions {
  feedUrl: string;
  mode: CctvMode;
  sessionId?: string;
  /** Receives the fully-built log entry so callers can fan it out via NetworkSync. */
  onGesture?: (entry: GestureLogEntry) => void;
}

interface LandmarkerResultLike {
  landmarks?: { x: number; y: number; z?: number }[][];
  faceLandmarks?: { x: number; y: number; z?: number }[][];
  handednesses?: { categoryName: string }[][];
  handedness?: { categoryName: string }[][];
}

export function useCctvFeed({ feedUrl, mode, sessionId, onGesture }: UseCctvFeedOptions) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<HandLandmarker | FaceLandmarker | null>(null);
  const creatingRef = useRef(false);
  const animRef = useRef<number>(0);
  const runningRef = useRef(false);
  const handSmootherRef = useRef(new HandGestureSmoother());
  const eyeSmootherRef = useRef(new EyeGestureSmoother());
  const lastLoggedGesture = useRef<string | null>(null);
  const lastFpsTime = useRef(0);
  const frameCount = useRef(0);
  const liveRef = useRef({ confidence: 0 });
  const metricsRef = useRef({
    prevLandmarks: null as Point[] | null,
    movementAccum: 0,
    movementSamples: 0,
    lastMetricsTime: 0,
  });

  const [gesture, setGesture] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedReady, setFeedReady] = useState(false);
  const feedReadyRef = useRef(false);
  const [streamType, setStreamType] = useState<StreamType>("unknown");
  const [patientMetrics, setPatientMetrics] = useState<PatientMetrics>({});
  const [fps, setFps] = useState(0);

  function computeMetrics() {
    const m = metricsRef.current;
    m.movementAccum = 0;
    m.movementSamples = 0;
  }

  const init = useCallback(async () => {
    try {
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
        landmarkerRef.current = null;
      }
      const wasm = await FilesetResolver.forVisionTasks(WASM_URL);
      if (mode === "hand") {
        landmarkerRef.current = await HandLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5,
        });
      } else {
        landmarkerRef.current = await FaceLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: FACE_MODEL_URL },
          runningMode: "VIDEO",
          minFaceDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      }
      setLoading(false);
    } catch {
      setError("Failed to load vision model. Check internet connection.");
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function getSourceCanvas(w: number, h: number): HTMLCanvasElement | null {
    if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
    const oc = offscreenRef.current;
    if (oc.width !== w || oc.height !== h) {
      oc.width = w;
      oc.height = h;
    }
    return oc;
  }

  /** Runs detection on any drawable source and returns normalized landmark groups. */
  function detect(
    source: HTMLVideoElement | HTMLCanvasElement,
    w: number,
    h: number
  ): LandmarkerResultLike | null {
    void w;
    void h;
    const landmarker = landmarkerRef.current;
    if (!landmarker) return null;
    try {
      return landmarker.detectForVideo(source as unknown as HTMLVideoElement, performance.now()) as LandmarkerResultLike;
    } catch {
      return null;
    }
  }

  function updateDetection(rawResult: LandmarkerResultLike | null, w: number, h: number, mirrored: boolean) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !rawResult) return;

    // Normalize landmarks into Point[][] regardless of model type
    const groups: Point[][] = [];
    if (rawResult.landmarks) {
      for (const arr of rawResult.landmarks)
        groups.push(arr.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })));
    } else if (rawResult.faceLandmarks) {
      for (const arr of rawResult.faceLandmarks)
        groups.push(arr.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })));
    }

    // Movement metrics
    const m = metricsRef.current;
    if (groups.length > 0 && m.prevLandmarks && groups[0].length === m.prevLandmarks.length) {
      let total = 0;
      for (let i = 0; i < groups[0].length; i++) total += dist(groups[0][i], m.prevLandmarks[i]);
      m.movementAccum += total / groups[0].length;
      m.movementSamples++;
    }
    m.prevLandmarks = groups.length > 0 ? groups[0].map((p) => ({ ...p })) : null;
    if (Date.now() - m.lastMetricsTime > 2000 && m.movementSamples > 0) {
      setPatientMetrics({
        movementActivity: Math.round(Math.min(1, m.movementAccum / m.movementSamples / 0.005) * 100) / 100,
      });
      computeMetrics();
      m.lastMetricsTime = Date.now();
    }

    if (mode === "hand" && groups.length > 0) {
      const hands = groups.map((lm, i) => ({
        landmarks: lm,
        handedness:
          ((rawResult.handednesses ?? rawResult.handedness)?.[i]?.[0]?.categoryName as "Left" | "Right") ??
          "Left",
      }));
      const smoothed = handSmootherRef.current.push(classifyHandGesture(hands));
      liveRef.current.confidence = smoothed.confidence;
      setGesture((prev) => (prev === smoothed.gesture ? prev : smoothed.gesture));
      setConfidence((prev) => (Math.abs(prev - smoothed.confidence) > 0.02 ? smoothed.confidence : prev));

      if (smoothed.gesture && smoothed.confidence > 0.7 && smoothed.gesture !== lastLoggedGesture.current) {
        lastLoggedGesture.current = smoothed.gesture;
        const desc =
          ({
            YES: "Yes — Patient confirms",
            NO: "No — Patient refuses",
            HELP: "Help — Patient needs immediate assistance",
            WATER: "Water/Food — Patient needs water or food",
          } as Record<string, string>)[smoothed.gesture] ?? smoothed.gesture;
        voiceAlert.speak(smoothed.gesture, "hand");
        const logged = addGestureLog(smoothed.gesture, desc, smoothed.confidence, "hand", voiceAlert.getLanguage(), sessionId ? { sessionId } : {});
        onGesture?.(logged);
      }

      for (const lmArr of groups) {
        ctx.strokeStyle = "rgba(59,130,246,0.6)";
        ctx.lineWidth = 2;
        for (const [i, j] of HAND_CONNECTIONS) {
          ctx.beginPath();
          ctx.moveTo(lmArr[i].x * w, lmArr[i].y * h);
          ctx.lineTo(lmArr[j].x * w, lmArr[j].y * h);
          ctx.stroke();
        }
        for (let fi = 0; fi < FINGER_INDICES.length; fi++) {
          ctx.fillStyle = FINGER_COLORS[fi];
          ctx.globalAlpha = Math.max(0.3, liveRef.current.confidence);
          for (const idx of FINGER_INDICES[fi]) {
            ctx.beginPath();
            ctx.arc(lmArr[idx].x * w, lmArr[idx].y * h, 4, 0, 2 * Math.PI);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    if (mode === "eye" && groups.length > 0) {
      // Mirror-normalize so gaze mapping matches the patient self-view convention.
      const face = mirrored ? groups[0] : groups[0].map((p) => ({ ...p, x: 1 - p.x }));
      const smoothed = eyeSmootherRef.current.push(classifyEyeGesture(face, { mirrored: true }));
      liveRef.current.confidence = smoothed.confidence;
      setGesture((prev) => (prev === smoothed.gesture ? prev : smoothed.gesture));
      setConfidence((prev) => (Math.abs(prev - smoothed.confidence) > 0.02 ? smoothed.confidence : prev));

      if (smoothed.gesture && smoothed.confidence > 0.7 && smoothed.gesture !== lastLoggedGesture.current) {
        lastLoggedGesture.current = smoothed.gesture;
        const desc =
          ({
            YES: "Yes — Patient confirms",
            NO: "No — Patient refuses",
            HELP: "Help — Patient needs immediate assistance",
            WATER: "Water/Food — Patient needs water or food",
          } as Record<string, string>)[smoothed.gesture] ?? smoothed.gesture;
        voiceAlert.speak(smoothed.gesture, "eye");
        const logged = addGestureLog(smoothed.gesture, desc, smoothed.confidence, "eye", voiceAlert.getLanguage(), sessionId ? { sessionId } : {});
        onGesture?.(logged);
      }

      const faceLms = groups[0];
      ctx.strokeStyle = "rgba(34,166,126,0.5)";
      ctx.lineWidth = 1;
      const conns: [number, number][] = [
        [33,133],[362,263],[61,291],[159,145],[386,374],
      ];
      for (const [i, j] of conns) {
        ctx.beginPath();
        ctx.moveTo(faceLms[i].x * w, faceLms[i].y * h);
        ctx.lineTo(faceLms[j].x * w, faceLms[j].y * h);
        ctx.stroke();
      }
    }
  }

  function loopMJPEG() {
    if (!runningRef.current) return;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !landmarkerRef.current || !img.complete || img.naturalWidth === 0) {
      animRef.current = requestAnimationFrame(loopMJPEG);
      return;
    }
    frameCount.current++;
    const now = performance.now();
    if (now - lastFpsTime.current >= 1000) {
      setFps(frameCount.current);
      frameCount.current = 0;
      lastFpsTime.current = now;
    }
    const w = img.naturalWidth || 640;
    const h = img.naturalHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      animRef.current = requestAnimationFrame(loopMJPEG);
      return;
    }
    // Draw un-mirrored MJPEG frame; eye mode re-mirrors landmarks internally.
    ctx.drawImage(img, 0, 0, w, h);
    const oc = getSourceCanvas(w, h);
    if (!oc) {
      animRef.current = requestAnimationFrame(loopMJPEG);
      return;
    }
    const octx = oc.getContext("2d");
    if (octx) {
      octx.drawImage(img, 0, 0, w, h);
      updateDetection(detect(oc, w, h), w, h, false);
    }
    animRef.current = requestAnimationFrame(loopMJPEG);
  }

  function loopVideo() {
    if (!runningRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !landmarkerRef.current || !canvas || video.readyState < 2) {
      animRef.current = requestAnimationFrame(loopVideo);
      return;
    }
    frameCount.current++;
    const now = performance.now();
    if (now - lastFpsTime.current >= 1000) {
      setFps(frameCount.current);
      frameCount.current = 0;
      lastFpsTime.current = now;
    }
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      animRef.current = requestAnimationFrame(loopVideo);
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    updateDetection(detect(video, w, h), w, h, false);
    animRef.current = requestAnimationFrame(loopVideo);
  }

  useEffect(() => {
    void init();
  }, [init]);

  // Start the correct pipeline once the model is ready and the feed element exists.
  useEffect(() => {
    if (loading || !landmarkerRef.current || !feedUrl) return;
    const detected = detectStreamType(feedUrl);
    setStreamType(detected);
    feedReadyRef.current = false;
    setFeedReady(false);

    runningRef.current = true;
    if (detected === "mjpeg") {
      const img = imgRef.current;
      if (!img) return;
      const onOk = () => {
        if (feedReadyRef.current) return;
        feedReadyRef.current = true;
        setFeedReady(true);
        setError(null);
        animRef.current = requestAnimationFrame(loopMJPEG);
      };
      const onErr = () =>
        setError(`Cannot load camera stream at ${feedUrl}. Check the URL and that the camera is powered on.`);
      img.addEventListener("load", onOk, { once: true });
      img.addEventListener("error", onErr, { once: true });
      img.src = feedUrl;
      return () => {
        runningRef.current = false;
        cancelAnimationFrame(animRef.current);
        img.removeEventListener("load", onOk);
        img.removeEventListener("error", onErr);
        img.src = "";
      };
    }

    const video = videoRef.current;
    if (!video) return;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.src = feedUrl;
    const onMeta = () => {
      video
        .play()
        .then(() => {
          feedReadyRef.current = true;
          setFeedReady(true);
          setError(null);
          animRef.current = requestAnimationFrame(loopVideo);
        })
        .catch(() => setError("Failed to play the stream. The URL may not be a valid video feed."));
    };
    const onErr = () =>
      setError("Stream failed or blocked by CORS. For IP cameras prefer an MJPEG URL like http://ip:port/video.");
    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.addEventListener("error", onErr, { once: true });
    const timeout = setTimeout(() => {
      if (!feedReadyRef.current) setError("Could not load the stream within 15s. Is the URL a valid camera feed?");
    }, 15000);

    return () => {
      runningRef.current = false;
      cancelAnimationFrame(animRef.current);
      clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, feedUrl]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      cancelAnimationFrame(animRef.current);
      try {
        landmarkerRef.current?.close();
      } catch {}
      landmarkerRef.current = null;
    };
  }, []);

  return {
    videoRef,
    imgRef,
    canvasRef,
    gesture,
    confidence,
    loading,
    error,
    feedReady,
    streamType,
    patientMetrics,
    fps,
  };
}


