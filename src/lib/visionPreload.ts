/**
 * Idle-time prefetch of the MediaPipe WASM runtime + model weights.
 *
 * The heavy assets (~4-8 MB) are immutable and CDN-hosted; the service worker
 * caches them cache-first forever. Fetching them during browser idle time means
 * "Start Camera" goes from a multi-second download to near-instant on first use
 * — critical when a nurse hands a bedside laptop to a patient who cannot wait.
 *
 * Respects Save-Data / slow connections and never competes with an active
 * session (the landmarker itself reuses the same HTTP cache).
 */

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODELS = {
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  eye: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
} as const;

export type VisionKind = keyof typeof MODELS;

const done = new Set<VisionKind>();

function connectionAllowsPrefetch(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /^(slow-2g|2g)$/.test(conn.effectiveType)) return false;
  return true;
}

function scheduleIdle(fn: () => void): void {
  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === "function") ric(fn, { timeout: 4000 });
  else setTimeout(fn, 2500);
}

export function preloadVisionAssets(kind: VisionKind): void {
  if (typeof window === "undefined" || done.has(kind) || !connectionAllowsPrefetch()) return;
  done.add(kind);

  scheduleIdle(async () => {
    try {
      // 1) WASM loader graph (several small files) — resolves via HTTP cache later.
      const { FilesetResolver } = await import("@mediapipe/tasks-vision");
      await FilesetResolver.forVisionTasks(WASM_URL);
    } catch {
      // Offline or CDN hiccup — the SW cache will serve it once fetched for real.
    }
    try {
      // 2) Model weights — a plain fetch lets the service worker store them.
      await fetch(MODELS[kind], { mode: "cors", cache: "force-cache" });
    } catch {}
  });
}
