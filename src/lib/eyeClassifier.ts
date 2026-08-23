import { EyeGesture, Point } from "@/types";

const LEFT_EYE_CORNERS = [33, 133];
const RIGHT_EYE_CORNERS = [362, 263];
const LEFT_EYE_TOP_BOTTOM = [159, 145];
const RIGHT_EYE_TOP_BOTTOM = [386, 374];
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const NOSE_BRIDGE = 168;
const CHIN = 152;

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function eyeAspectRatio(landmarks: Point[], cornerL: number, cornerR: number, top: number, bottom: number): number {
  const eyeWidth = dist(landmarks[cornerL], landmarks[cornerR]);
  const eyeHeight = dist(landmarks[top], landmarks[bottom]);
  if (eyeWidth < 1e-6) return 1;
  return eyeHeight / eyeWidth;
}

function irisOffset(landmarks: Point[], cornerL: number, cornerR: number, iris: number): { x: number; y: number } {
  const eyeCenter = {
    x: (landmarks[cornerL].x + landmarks[cornerR].x) / 2,
    y: (landmarks[cornerL].y + landmarks[cornerR].y) / 2,
  };
  const eyeWidth = dist(landmarks[cornerL], landmarks[cornerR]);
  if (eyeWidth < 1e-6) return { x: 0, y: 0 };
  return {
    x: (landmarks[iris].x - eyeCenter.x) / eyeWidth,
    y: (landmarks[iris].y - eyeCenter.y) / eyeWidth,
  };
}

function mouthOpenness(landmarks: Point[]): number {
  return dist(landmarks[UPPER_LIP], landmarks[LOWER_LIP]) / dist(landmarks[NOSE_BRIDGE], landmarks[CHIN]);
}

export interface EyeClassifyOptions {
  /**
   * true when the displayed feed is mirrored (patient self-view webcam).
   * Un-mirrored CCTV feeds must flip the gaze sign or YES/NO invert.
   */
  mirrored?: boolean;
  /** Rolling neutral-gaze estimate subtracted before thresholds (per user/camera). */
  baseline?: { x: number; y: number };
}

export interface EyeClassifierResult {
  gesture: EyeGesture;
  confidence: number;
  isBlinking: boolean;
  /** Post-baseline iris offsets (normalized) enabling downstream hysteresis. */
  dx?: number;
  dy?: number;
}

/** Average normalized iris offset for both eyes. */
export function computeAvgIrisOffset(faceLandmarks: Point[], mirrored = true): { x: number; y: number } {
  let leftIrisOff = irisOffset(faceLandmarks, LEFT_EYE_CORNERS[0], LEFT_EYE_CORNERS[1], LEFT_IRIS);
  let rightIrisOff = irisOffset(faceLandmarks, RIGHT_EYE_CORNERS[0], RIGHT_EYE_CORNERS[1], RIGHT_IRIS);
  if (!mirrored) {
    leftIrisOff = { ...leftIrisOff, x: -leftIrisOff.x };
    rightIrisOff = { ...rightIrisOff, x: -rightIrisOff.x };
  }
  return { x: (leftIrisOff.x + rightIrisOff.x) / 2, y: (leftIrisOff.y + rightIrisOff.y) / 2 };
}

/**
 * Rolling neutral-gaze estimate (EMA). Eyelid geometry gives every person a
 * different "straight ahead" iris offset — without calibration the vertical
 * bias alone can exceed thresholds and masquerade as WATER forever.
 * Fast lock-on (~3s), then slow drift to track lighting/pose changes.
 */
/**
 * Robust neutral-gaze estimator. Keeps a rolling window of neutral samples and
 * uses MEDIAN + MAD (median absolute deviation) instead of a mean-EMA:
 *   - median is immune to blink-recovery glitch frames dragging the estimate
 *   - MAD gives a per-user noise-floor sigma used for adaptive thresholds
 * Bootstrap: the first ~45 accepted frames ignore the (unreliable) gesture
 * label; afterwards ONLY frames classified as neutral are learned, so a
 * sustained deliberate gaze can never drag the baseline mid-hold.
 */
export class IrisCalibrator {
  private static readonly CAP = 140;
  private xs: number[] = [];
  private ys: number[] = [];
  private bx = 0;
  private by = 0;
  private sx = 0.008;
  private sy = 0.008;
  private n = 0;
  private warm = false;

  updateGated(
    raw: { x: number; y: number },
    ctx: { isBlinking: boolean; activeGesture: string | null }
  ): void {
    if (ctx.isBlinking) return;
    if (this.warm && ctx.activeGesture) return;
    this.xs.push(raw.x);
    this.ys.push(raw.y);
    if (this.xs.length > IrisCalibrator.CAP) {
      this.xs.shift();
      this.ys.shift();
    }
    this.n++;
    if (this.n % 4 === 0 || !this.warm) this.recompute();
    if (!this.warm && this.n >= 45) this.warm = true;
  }

  private recompute(): void {
    const med = (a: number[]): number => {
      const s = [...a].sort((p, q) => p - q);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    this.bx = med(this.xs);
    this.by = med(this.ys);
    const madx = med(this.xs.map((v) => Math.abs(v - this.bx)));
    const mady = med(this.ys.map((v) => Math.abs(v - this.by)));
    // 1.4826 makes MAD comparable to standard deviation under normality
    this.sx = Math.max(0.004, 1.4826 * madx);
    this.sy = Math.max(0.004, 1.4826 * mady);
  }

  get value(): { x: number; y: number } {
    return { x: this.bx, y: this.by };
  }

  /** Robust spread (sigma-like) per axis for adaptive thresholds. */
  get spread(): { sx: number; sy: number } {
    return { sx: this.sx, sy: this.sy };
  }

  get ready(): boolean {
    return this.warm;
  }

  reset(): void {
    this.xs = [];
    this.ys = [];
    this.bx = 0;
    this.by = 0;
    this.sx = 0.008;
    this.sy = 0.008;
    this.n = 0;
    this.warm = false;
  }
}

export function classifyEyeGesture(faceLandmarks: Point[], opts: EyeClassifyOptions = {}): EyeClassifierResult | null {
  if (!faceLandmarks || faceLandmarks.length < 478) return null;
  const mirrored = opts.mirrored ?? true;

  const leftEAR = eyeAspectRatio(faceLandmarks, LEFT_EYE_CORNERS[0], LEFT_EYE_CORNERS[1], LEFT_EYE_TOP_BOTTOM[0], LEFT_EYE_TOP_BOTTOM[1]);
  const rightEAR = eyeAspectRatio(faceLandmarks, RIGHT_EYE_CORNERS[0], RIGHT_EYE_CORNERS[1], RIGHT_EYE_TOP_BOTTOM[0], RIGHT_EYE_TOP_BOTTOM[1]);
  const avgEAR = (leftEAR + rightEAR) / 2;

  const raw = computeAvgIrisOffset(faceLandmarks, mirrored);
  const base = opts.baseline ?? { x: 0, y: 0 };
  const avgIrisX = raw.x - base.x;
  const avgIrisY = raw.y - base.y;

  const mouthOpen = mouthOpenness(faceLandmarks);

  const BLINK_CLOSE_THRESHOLD = 0.22;
  const GAZE_X_THRESHOLD = 0.04;
  const GAZE_Y_THRESHOLD = 0.05;
  const MOUTH_THRESHOLD = 0.11;
  /** iris offset magnitude that maps to full confidence (moderate looks pass 0.7) */
  const CONF_SCALE = 0.12;

  if (avgEAR < BLINK_CLOSE_THRESHOLD) {
    return { gesture: null, confidence: 0, isBlinking: true };
  }

  if (mouthOpen > MOUTH_THRESHOLD) {
    return { gesture: "WATER", confidence: Math.min(1, mouthOpen * 10), isBlinking: false };
  }

  if (avgIrisX > GAZE_X_THRESHOLD) {
    // Screen-relative: patient looks toward screen-left => YES
    return { gesture: "NO", confidence: Math.min(1, avgIrisX / CONF_SCALE), isBlinking: false, dx: avgIrisX, dy: avgIrisY };
  }
  if (avgIrisX < -GAZE_X_THRESHOLD) {
    return { gesture: "YES", confidence: Math.min(1, Math.abs(avgIrisX) / CONF_SCALE), isBlinking: false, dx: avgIrisX, dy: avgIrisY };
  }
  if (Math.abs(avgIrisY) > GAZE_Y_THRESHOLD) {
    return { gesture: "WATER", confidence: Math.min(1, Math.abs(avgIrisY) / CONF_SCALE), isBlinking: false, dx: avgIrisX, dy: avgIrisY };
  }

  return { gesture: null, confidence: 0, isBlinking: false, dx: avgIrisX, dy: avgIrisY };
}

type GazeDir = "YES" | "NO" | "WATER";

/**
 * Schmitt-trigger stabilizer for gaze direction, hardened against every
 * real-world eye-tracking failure mode:
 *
 *  1. ADAPTIVE BANDS   — enter/exit thresholds scale with the user's measured
 *     jitter (MAD-sigma from IrisCalibrator), so a twitchy camera needs a
 *     bigger deliberate look and a steady one needs only a small one.
 *  2. GLITCH GUARD     — an inter-frame jump larger than physically possible
 *     for smooth eye motion is a landmark spike; the frame is discarded.
 *  3. SWITCH DEBOUNCE  — stealing a held direction requires full-strength
 *     counter evidence on TWO consecutive frames (kills single-frame spikes).
 *  4. RECOVERY REFRACTORY — for ~130ms after eyes reopen, gaze results are
 *     suppressed because iris landmarks are unreliable during re-opening.
 *  5. MOUTH PASSTHROUGH — WATER from an open mouth carries no offsets and is
 *     never treated as gaze.
 */
export class GazeStabilizer {
  private active: GazeDir | null = null;
  private pending: GazeDir | null = null;
  private pendingCount = 0;
  private lastRaw: { x: number; y: number } | null = null;
  private glitchStreak = 0;
  private refractoryUntil = 0;
  private enterX = 0.055;
  private enterY = 0.055;
  private readonly exitFactor = 0.55;

  /** Feed the calibrator's robust spread to self-tune the bands per user. */
  tune(spread: { sx: number; sy: number }): void {
    const cap = (v: number): number => Math.min(v, 0.025);
    this.enterX = Math.max(0.05, 3.2 * cap(spread.sx) + 0.015);
    this.enterY = Math.max(0.055, 3.2 * cap(spread.sy) + 0.015);
  }

  /** Eyes just reopened — suppress gaze classification briefly. */
  markRecovery(now: number = Date.now()): void {
    this.refractoryUntil = now + 130;
  }

  filter(r: EyeClassifierResult | null, now: number = Date.now()): EyeClassifierResult | null {
    if (!r || r.isBlinking) return r;
    const g = r.gesture;
    const dx = r.dx ?? 0;
    const dy = r.dy ?? 0;

    // 2) Glitch guard: saccades move < ~0.25 normalized units between frames.
    // A single outlier frame is dropped while KEEPING the last-good reference;
    // only a sustained jump (2+ consecutive far frames) is treated as genuine
    // movement — otherwise one spike would poison the next frame too.
    if (this.lastRaw) {
      const jump = Math.hypot(dx - this.lastRaw.x, dy - this.lastRaw.y);
      if (jump > 0.28 && this.glitchStreak < 1) {
        this.glitchStreak++;
        return { ...r, gesture: null };
      }
    }
    this.glitchStreak = 0;
    this.lastRaw = { x: dx, y: dy };

    const exitX = this.enterX * this.exitFactor;
    const exitY = this.enterY * this.exitFactor;

    // 5) mouth-driven WATER (no offsets) passes straight through.
    const isMouthWater = g === "WATER" && Math.abs(dx) < exitX && Math.abs(dy) < exitY;

    if (!g || g === "HELP" || isMouthWater) {
      // Neutral frame — release a held direction once its offset truly relaxes.
      if (this.active) {
        const mag = this.active === "WATER" ? Math.abs(dy) : Math.abs(dx);
        if (mag < (this.active === "WATER" ? exitY : exitX)) this.active = null;
      }
      return r;
    }

    // 4) post-blink refractory: readings are still settling.
    if (now < this.refractoryUntil) return { ...r, gesture: null };

    const dir = g as GazeDir;
    const mag = dir === "WATER" ? Math.abs(dy) : Math.abs(dx);
    const enter = dir === "WATER" ? this.enterY : this.enterX;

    if (this.active) {
      const activeMag = this.active === "WATER" ? Math.abs(dy) : Math.abs(dx);
      const activeExit = this.active === "WATER" ? exitY : exitX;

      if (activeMag < activeExit) {
        // Held direction genuinely relaxed.
        this.active = null;
        this.pending = null;
        this.pendingCount = 0;
      } else {
        if (dir !== this.active) {
          // 3) debounce: a different direction must insist twice.
          if (dir === this.pending) this.pendingCount++;
          else {
            this.pending = dir;
            this.pendingCount = 1;
          }
          if (mag >= enter && this.pendingCount >= 2) {
            this.active = dir;
            this.pending = null;
            this.pendingCount = 0;
            return { ...r, gesture: this.active };
          }
          return { ...r, gesture: this.active }; // keep holding through noise
        }
        this.pending = null;
        this.pendingCount = 0;
        return { ...r, gesture: this.active };
      }
    }

    if (mag >= enter) {
      this.active = dir;
      this.pending = null;
      this.pendingCount = 0;
      return r;
    }
    return { ...r, gesture: null }; // weak flicker must not enter the vote
  }

  reset(): void {
    this.active = null;
    this.pending = null;
    this.pendingCount = 0;
    this.lastRaw = null;
    this.glitchStreak = 0;
    this.refractoryUntil = 0;
  }
}

export class EyeGestureSmoother {
  private gazeBuffer: EyeClassifierResult[] = [];
  private blinkStartTime = 0;
  private blinkCount = 0;
  private lastBlinkEndTime = 0;
  private stableGesture: EyeGesture = null;
  private stableConf = 0;
  /** per-instance blink hysteresis — was previously module-global and leaked between smoothers */
  private blinkHysteresisActive = false;
  private readonly DOUBLE_BLINK_WINDOW = 700;
  private readonly SMOOTHING_FRAMES = 9;
  private readonly HOLD_TIME_MS = 430;
  private readonly BLINK_COOLDOWN = 2000;
  private readonly HELP_LOCK_MS = 2000;
  private gazeStartTime = 0;
  private helpLockUntil = 0;

  private adjustedConfidence(): { gesture: EyeGesture; confidence: number } {
    if (Date.now() < this.helpLockUntil && this.stableGesture === "HELP") {
      return { gesture: "HELP", confidence: 0.85 };
    }
    const holdTime = Date.now() - this.gazeStartTime;
    const holdMultiplier = Math.min(1, holdTime / this.HOLD_TIME_MS);
    return { gesture: this.stableGesture, confidence: Math.min(this.stableConf * holdMultiplier, 1) };
  }

  push(result: EyeClassifierResult | null): { gesture: EyeGesture; confidence: number } {
    const now = Date.now();
    if (!result) return this.adjustedConfidence();

    if (result.isBlinking) {
      this.blinkHysteresisActive = true;
      if (this.blinkStartTime === 0) this.blinkStartTime = now;
      if (now - this.lastBlinkEndTime > this.BLINK_COOLDOWN) this.blinkCount = 0;
      return this.adjustedConfidence();
    }

    this.blinkHysteresisActive = false;

    if (this.blinkStartTime > 0) {
      const blinkDuration = now - this.blinkStartTime;
      this.blinkStartTime = 0;

      if (blinkDuration < 100) return this.adjustedConfidence();

      if (this.lastBlinkEndTime > 0 && now - this.lastBlinkEndTime < this.DOUBLE_BLINK_WINDOW) {
        this.blinkCount++;
      } else {
        this.blinkCount = 1;
      }
      this.lastBlinkEndTime = now;

      if (this.blinkCount >= 2) {
        this.helpLockUntil = now + this.HELP_LOCK_MS;
        this.stableGesture = "HELP";
        this.stableConf = 0.85;
        this.gazeStartTime = now;
        this.blinkCount = 0;
        this.gazeBuffer = [];
        return this.adjustedConfidence();
      }
    }

    if (result.gesture !== null) {
      this.gazeBuffer.push(result);
      if (this.gazeBuffer.length > this.SMOOTHING_FRAMES) this.gazeBuffer.shift();

      const counts = new Map<string, { count: number; confs: number[] }>();
      for (const item of this.gazeBuffer) {
        const key = item.gesture ?? "__none__";
        if (!counts.has(key)) counts.set(key, { count: 0, confs: [] });
        const entry = counts.get(key)!;
        entry.count++;
        entry.confs.push(item.confidence);
      }

      let bestKey = "__none__";
      let bestCount = 0;
      for (const [key, val] of counts) {
        if (val.count > bestCount) {
          bestCount = val.count;
          bestKey = key;
        }
      }

      if (bestKey !== "__none__" && bestCount >= Math.ceil(this.SMOOTHING_FRAMES * 0.75)) {
        const entry = counts.get(bestKey)!;
        const newGesture = bestKey === "__none__" ? null : (bestKey as EyeGesture);
        const newConf = entry.confs.reduce((a, b) => a + b, 0) / entry.confs.length;
        if (newGesture !== this.stableGesture) this.gazeStartTime = now;
        this.stableGesture = newGesture;
        this.stableConf = newConf;
      }
    } else if (
      this.gazeBuffer.length > 0 &&
      this.gazeBuffer[this.gazeBuffer.length - 1].gesture === null
    ) {
      this.gazeBuffer.push(result);
      if (this.gazeBuffer.length > this.SMOOTHING_FRAMES) this.gazeBuffer.shift();
    }

    return this.adjustedConfidence();
  }

  reset() {
    this.gazeBuffer = [];
    this.blinkStartTime = 0;
    this.blinkCount = 0;
    this.lastBlinkEndTime = 0;
    this.stableGesture = null;
    this.stableConf = 0;
    this.gazeStartTime = 0;
    this.helpLockUntil = 0;
    this.blinkHysteresisActive = false;
  }
}
