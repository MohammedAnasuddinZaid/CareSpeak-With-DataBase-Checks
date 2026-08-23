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
export class IrisCalibrator {
  private bx = 0;
  private by = 0;
  private n = 0;

  update(raw: { x: number; y: number }): void {
    const k = this.n < 90 ? 0.12 : 0.006;
    this.bx += k * (raw.x - this.bx);
    this.by += k * (raw.y - this.by);
    this.n++;
  }

  get value(): { x: number; y: number } {
    return { x: this.bx, y: this.by };
  }

  get ready(): boolean {
    return this.n >= 45;
  }

  reset(): void {
    this.bx = 0;
    this.by = 0;
    this.n = 0;
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
  const GAZE_X_THRESHOLD = 0.05;
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
    return { gesture: "NO", confidence: Math.min(1, avgIrisX / CONF_SCALE), isBlinking: false };
  }
  if (avgIrisX < -GAZE_X_THRESHOLD) {
    return { gesture: "YES", confidence: Math.min(1, Math.abs(avgIrisX) / CONF_SCALE), isBlinking: false };
  }
  if (Math.abs(avgIrisY) > GAZE_Y_THRESHOLD) {
    return { gesture: "WATER", confidence: Math.min(1, Math.abs(avgIrisY) / CONF_SCALE), isBlinking: false };
  }

  return { gesture: null, confidence: 0, isBlinking: false };
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
  private readonly SMOOTHING_FRAMES = 12;
  private readonly HOLD_TIME_MS = 800;
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
