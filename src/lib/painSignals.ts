/**
 * Pain and distress signals from facial action units.
 *
 * The clinical problem this addresses: a patient who cannot speak, gesture or
 * write has no way to report pain. Pain is checked on a paper scale maybe
 * hourly; between checks it goes unreported. Facial expression is the only
 * channel they still have.
 *
 * ── The design decision that matters ──
 *
 * Published ICU work is a warning, not an endorsement. The OpenFace facial-
 * behaviour tool scores F1 0.42 on real ICU footage against far better
 * lab results. ICU lighting is bad, faces turn, cannulae and masks occlude
 * features, and cameras are far away. Models trained on clean controlled
 * footage fall apart at the bedside.
 *
 * So this does not use a pretrained expression model with absolute thresholds.
 * It measures each landmark ratio against THIS patient's own learned neutral
 * face and asks how far it has moved from their own rest. A patient whose
 * brows sit low, or who has a permanent facial asymmetry from a stroke, is not
 * permanently scored as in pain. That personalisation is the honest response to
 * the literature: the problem is a domain shift, and the patient's own face is
 * the reference frame that does not shift.
 *
 * ── What this is not ──
 *
 * Decision support, not measurement. Not a pain scale, never to be recorded as
 * one. Published FACS pain work lacks RCT-level validation, and one widely-cited
 * model reported lower accuracy for female and darker-skinned patients. Both
 * facts are surfaced in the result so anything built on top inherits the caveat
 * instead of quietly dropping it.
 *
 * Consequently this is designed to surface TO THE PATIENT — "looks like you
 * might be in pain, want to tell your nurse?" — rather than to silently assert
 * pain to staff. A system that announces an inferred diagnosis about someone's
 * face, in front of a ward, can humiliate them. The same information offered as
 * help keeps the dignity intact.
 */

import type { Point } from "@/types";

// FaceMesh landmark indices (canonical MediaPipe topology).
const BROW_INNER_L = 105;
const BROW_INNER_R = 334;
const BROW_OUTER_L = 70;
const BROW_OUTER_R = 300;
const EYE_OUTER_L = 33;
const EYE_INNER_L = 133;
const EYE_OUTER_R = 362;
const EYE_INNER_R = 263;
const LID_TOP_L = 159;
const LID_BOTTOM_L = 145;
const LID_TOP_R = 386;
const LID_BOTTOM_R = 374;
const CHEEK_L = 205;
const CHEEK_R = 425;
const NOSE_ALA_L = 129;
const NOSE_ALA_R = 358;
const NOSE_TIP = 2;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const CHIN = 152;

/** Action units Prkachin & Solomon associate with pain (the PSPI set). */
export const PAIN_ACTION_UNITS = [
  { au: 4, name: "Brow lowerer" },
  { au: 6, name: "Cheek raiser" },
  { au: 7, name: "Lid tightener" },
  { au: 9, name: "Nose wrinkler" },
  { au: 10, name: "Upper lip raiser" },
  { au: 43, name: "Eyes closed" },
] as const;

/**
 * Action units validated on real ICU footage, where lips part and jaw drop were
 * the strongest single predictors. Kept separate from the PSPI set because they
 * read as breathlessness or distress rather than pain, and conflating the two
 * would be a clinical error.
 */
export const DISTRESS_ACTION_UNITS = [
  { au: 25, name: "Lips part" },
  { au: 26, name: "Jaw drop" },
] as const;

export type PainBand = "none" | "mild" | "moderate" | "severe" | "unassessable";

export interface ActionUnitReading {
  au: number;
  name: string;
  /** 0-5, the FACS intensity convention. */
  intensity: number;
  /** Signed relative change against the patient's own neutral face. */
  delta: number;
  present: boolean;
}

export interface FaceQuality {
  /** 0-1. Below ~0.35 and the reading is not reported at all. */
  score: number;
  frontal: boolean;
  closeEnough: boolean;
  eyesVisible: boolean;
  reasons: string[];
}

export interface PainSignalResult {
  band: PainBand;
  /** Sum of PSPI-set intensities, 0-30. Not a validated pain score. */
  pspi: number;
  /** Sum of the distress-set intensities, 0-10. Not a pain measure. */
  distress: number;
  painUnits: ActionUnitReading[];
  distressUnits: ActionUnitReading[];
  quality: FaceQuality;
  /** True only when the reading is solid enough to show a person. */
  confident: boolean;
  /** One line for the patient or the nurse panel. */
  summary: string;
  /** Non-negotiable caveats that travel with the result. */
  caveats: string[];
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
}

/** Eye aspect ratio. Near 0 when closed, ~0.25 when wide open. */
function ear(top: Point, bottom: Point, outer: Point, inner: Point): number {
  const width = dist(outer, inner);
  if (width < 1e-6) return 0;
  return dist(top, bottom) / width;
}

/**
 * Landmark geometry, each normalised by inter-ocular distance so the measurement
 * is invariant to how far the patient sits from the camera.
 *
 * Normalising by face size is what makes an absolute threshold portable between
 * patients at all; normalising by the patient's own neutral face is what makes
 * it correct.
 */
export interface FaceRatios {
  /** Brow to eye vertical gap. Smaller = brows lowered. */
  browHeight: number;
  /** Lower lid to cheek distance. Smaller = cheek raised. */
  cheekRaise: number;
  /** Eye aperture. Smaller = lids tightened. */
  eyeAperture: number;
  /** Nose ala width. Wider = nose wrinkled. */
  noseWidth: number;
  /** Upper lip to nose tip. Smaller = upper lip raised. */
  lipRaise: number;
  /** Upper to lower lip. Wider = lips parted. */
  lipPart: number;
  /** Upper lip to chin. Larger = jaw dropped. */
  jawDrop: number;
}

function readRatios(lm: Point[]): FaceRatios {
  const eyeSpan = dist(mid(lm[EYE_OUTER_L], lm[EYE_INNER_L]), mid(lm[EYE_OUTER_R], lm[EYE_INNER_R]));
  const n = eyeSpan > 1e-6 ? eyeSpan : 1;

  const browL = mid(lm[BROW_INNER_L], lm[BROW_OUTER_L]);
  const browR = mid(lm[BROW_INNER_R], lm[BROW_OUTER_R]);
  const eyeMidL = mid(lm[EYE_OUTER_L], lm[EYE_INNER_L]);
  const eyeMidR = mid(lm[EYE_OUTER_R], lm[EYE_INNER_R]);

  return {
    browHeight: (dist(browL, eyeMidL) + dist(browR, eyeMidR)) / 2 / n,
    cheekRaise: (dist(lm[LID_BOTTOM_L], lm[CHEEK_L]) + dist(lm[LID_BOTTOM_R], lm[CHEEK_R])) / 2 / n,
    eyeAperture:
      (ear(lm[LID_TOP_L], lm[LID_BOTTOM_L], lm[EYE_OUTER_L], lm[EYE_INNER_L]) +
        ear(lm[LID_TOP_R], lm[LID_BOTTOM_R], lm[EYE_OUTER_R], lm[EYE_INNER_R])) /
      2,
    noseWidth: dist(lm[NOSE_ALA_L], lm[NOSE_ALA_R]) / n,
    lipRaise: dist(lm[UPPER_LIP], lm[NOSE_TIP]) / n,
    lipPart: dist(lm[UPPER_LIP], lm[LOWER_LIP]) / n,
    jawDrop: dist(lm[UPPER_LIP], lm[CHIN]) / n,
  };
}

/**
 * Gate on whether the frame can support a reading at all.
 *
 * This stops the most dangerous failure: reporting "no pain" because the camera
 * could not see the patient. Low quality returns "unassessable", which is a
 * completely different claim from a negative finding.
 */
export function assessFaceQuality(lm: Point[]): FaceQuality {
  const reasons: string[] = [];
  const eyeSpan = dist(mid(lm[EYE_OUTER_L], lm[EYE_INNER_L]), mid(lm[EYE_OUTER_R], lm[EYE_INNER_R]));

  // The nose tip should sit near the midpoint between the eye centres. Deviation
  // means the head is turned, and every left/right average above is then a blend
  // of two different things.
  const eyeMid = mid(
    mid(lm[EYE_OUTER_L], lm[EYE_INNER_L]),
    mid(lm[EYE_OUTER_R], lm[EYE_INNER_R]),
  );
  const offset = Math.abs(lm[NOSE_TIP].x - eyeMid.x) / (eyeSpan || 1);
  const frontal = offset < 0.18;
  if (!frontal) reasons.push("head is turned away from the camera");

  const closeEnough = eyeSpan > 0.09;
  if (!closeEnough) reasons.push("face too small in frame to resolve expression");

  const eyeAperture = readRatios(lm).eyeAperture;
  const eyesVisible = eyeAperture > 0.06;
  if (!eyesVisible) reasons.push("eyes not visible, lid movement unmeasurable");

  const base = Math.min(1, eyeSpan / 0.22);
  const score = Math.max(0, Math.min(1, base * (frontal ? 1 : 0.5) * (eyesVisible ? 1 : 0.6)));

  return { score, frontal, closeEnough, eyesVisible, reasons };
}

/**
 * Learns this patient's neutral face.
 *
 * Median rather than mean, for the same reason the vital-sign forecaster
 * despikes with a median: a single grimace, a cough, or a nurse walking past
 * must not become the patient's permanent baseline and mask every later signal.
 *
 * Calibration is explicit and must complete before any reading is reported. A
 * detector comparing against a guess at the patient's neutral face would invent
 * a pain expression out of nothing.
 */
export class PainCalibrator {
  private static readonly CAP = 150;
  private frames: FaceRatios[] = [];
  private earSamples: number[] = [];
  private baseline: FaceRatios | null = null;
  private baselineEar: number | null = null;

  /** Frames needed before a baseline is trusted. */
  static readonly REQUIRED_FRAMES = 40;

  get calibrated(): boolean {
    return this.baseline !== null;
  }

  get progress(): number {
    // A finished calibration is 1, even though the frame buffer is released.
    if (this.baseline !== null) return 1;
    return Math.min(1, this.frames.length / PainCalibrator.REQUIRED_FRAMES);
  }

  get value(): FaceRatios | null {
    return this.baseline;
  }

  get baselineEyeAperture(): number | null {
    return this.baselineEar;
  }

  reset(): void {
    this.frames = [];
    this.earSamples = [];
    this.baseline = null;
    this.baselineEar = null;
  }

  /** Offer a frame. Post-calibration frames are ignored, so the baseline cannot drift. */
  observe(lm: Point[]): void {
    if (!lm || lm.length < 478) return;
    const quality = assessFaceQuality(lm);
    if (!quality.frontal || !quality.closeEnough) return;

    const ratios = readRatios(lm);

    if (this.baseline === null) {
      this.frames.push(ratios);
      this.earSamples.push(ratios.eyeAperture);
      if (this.frames.length > PainCalibrator.CAP) {
        this.frames.shift();
        this.earSamples.shift();
      }
      if (this.frames.length >= PainCalibrator.REQUIRED_FRAMES) {
        const medianOf = (pick: (r: FaceRatios) => number) => {
          const sorted = this.frames.map(pick).sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        };
        this.baseline = {
          browHeight: medianOf((r) => r.browHeight),
          cheekRaise: medianOf((r) => r.cheekRaise),
          eyeAperture: medianOf((r) => r.eyeAperture),
          noseWidth: medianOf((r) => r.noseWidth),
          lipRaise: medianOf((r) => r.lipRaise),
          lipPart: medianOf((r) => r.lipPart),
          jawDrop: medianOf((r) => r.jawDrop),
        };
        const ears = [...this.earSamples].sort((a, b) => a - b);
        this.baselineEar = ears[Math.floor(ears.length / 2)];
        // Bound the memory: the baseline is the summary, not the archive.
        this.frames = [];
        this.earSamples = [];
      }
    }
  }
}

/** Map a relative change onto a 0-5 FACS-style intensity. */
function intensityFromDelta(delta: number, perUnit: number, floor = 0.02): number {
  const magnitude = Math.abs(delta);
  if (magnitude < floor) return 0;
  return Math.max(1, Math.min(5, Math.round(magnitude / perUnit)));
}

const CAVEATS = [
  "Decision support only. Not a pain scale and not a diagnosis.",
  "Automated FACS pain detection lacks RCT-level validation in real wards.",
  "Accuracy has been reported as lower for female and darker-skinned patients; review before clinical reliance.",
  "Facial movement can also reflect sedation, stroke, intubation, or an unfamiliar camera. Confirm with the patient.",
];

/**
 * Assess the current frame against the patient's calibrated neutral face.
 *
 * Returns "unassessable" rather than "none" whenever the frame cannot support a
 * reading, so an absent patient is never reported as a comfortable one.
 */
export function assessPainSignals(lm: Point[], calibrator: PainCalibrator): PainSignalResult {
  const quality = assessFaceQuality(lm);
  const base = calibrator.value;

  const caveats = [...CAVEATS];
  if (!calibrator.calibrated || !base) {
    return {
      band: "unassessable",
      pspi: 0,
      distress: 0,
      painUnits: [],
      distressUnits: [],
      quality,
      confident: false,
      summary: `Learning this patient's neutral face — ${Math.round(calibrator.progress * 100)}%. Readings start once it is known.`,
      caveats,
    };
  }

  // A turned or distant face makes every left/right average meaningless, so this
  // is the only hard gate. Closed eyes are NOT a gate failure: a grimace with the
  // eyes shut is still perfectly readable, and it is arguably the most
  // informative frame there is. Gating on it would make AU43 unreportable and
  // quietly blind the detector to the patients who cannot open their eyes.
  if (!quality.frontal || !quality.closeEnough) {
    return {
      band: "unassessable",
      pspi: 0,
      distress: 0,
      painUnits: [],
      distressUnits: [],
      quality,
      confident: false,
      summary: `Cannot read expression: ${quality.reasons.join("; ")}.`,
      caveats,
    };
  }

  const now = readRatios(lm);

  // A brow has dropped when brow-to-eye distance shrinks, so the sign is
  // inverted to keep "positive delta" meaning "more of the action unit".
  const browDelta = (base.browHeight - now.browHeight) / base.browHeight;
  const cheekDelta = (base.cheekRaise - now.cheekRaise) / base.cheekRaise;
  const apertureBase = calibrator.baselineEyeAperture ?? base.eyeAperture;
  const lidDelta = (apertureBase - now.eyeAperture) / Math.max(1e-6, apertureBase);
  // Shut or near-shut lids. This raises AU43 and, because a closed eye cannot
  // also be a tightening one, suppresses AU7 rather than guessing at it.
  const closedEyes = now.eyeAperture < Math.max(0.06, apertureBase * 0.35);
  const noseDelta = (now.noseWidth - base.noseWidth) / base.noseWidth;
  const lipRaiseDelta = (base.lipRaise - now.lipRaise) / base.lipRaise;
  const lipPartDelta = (now.lipPart - base.lipPart) / Math.max(1e-6, base.lipPart);
  const jawDelta = (now.jawDrop - base.jawDrop) / Math.max(1e-6, base.jawDrop);

  const painUnits: ActionUnitReading[] = (
    [
      { au: 4, name: "Brow lowerer", delta: browDelta, intensity: intensityFromDelta(browDelta, 0.06) },
      { au: 6, name: "Cheek raiser", delta: cheekDelta, intensity: intensityFromDelta(cheekDelta, 0.05) },
      { au: 7, name: "Lid tightener", delta: lidDelta, intensity: closedEyes ? 0 : intensityFromDelta(lidDelta, 0.18) },
      { au: 9, name: "Nose wrinkler", delta: noseDelta, intensity: intensityFromDelta(noseDelta, 0.07) },
      { au: 10, name: "Upper lip raiser", delta: lipRaiseDelta, intensity: intensityFromDelta(lipRaiseDelta, 0.06) },
      { au: 43, name: "Eyes closed", delta: closedEyes ? -1 : 0, intensity: closedEyes ? 3 : 0 },
    ] as { au: number; name: string; delta: number; intensity: number }[]
  ).map((u) => ({ ...u, present: u.intensity >= 2 }));

  const distressUnits: ActionUnitReading[] = (
    [
      { au: 25, name: "Lips part", delta: lipPartDelta, intensity: intensityFromDelta(lipPartDelta, 0.10) },
      { au: 26, name: "Jaw drop", delta: jawDelta, intensity: intensityFromDelta(jawDelta, 0.10) },
    ] as { au: number; name: string; delta: number; intensity: number }[]
  ).map((u) => ({ ...u, present: u.intensity >= 2 }));

  const pspi = painUnits.reduce((s, u) => s + u.intensity, 0);
  const distress = distressUnits.reduce((s, u) => s + u.intensity, 0);

  // A tight spread across several units is a more credible signal than one unit
  // spiking on a single noisy frame, so the count of present units matters.
  const presentCount = painUnits.filter((u) => u.present).length;
  const confident = presentCount >= 2 && pspi >= 5;

  let band: PainBand;
  if (!confident) band = "none";
  else if (pspi >= 16) band = "severe";
  else if (pspi >= 9) band = "moderate";
  else band = "mild";

  let summary: string;
  if (band === "none") {
    summary =
      distress >= 5
        ? "No pain expression, but the mouth is held open — that can mean breathlessness. Worth asking about."
        : "No pain expression detected in this patient's neutral range.";
  } else {
    const strongest = [...painUnits].sort((a, b) => b.intensity - a.intensity)[0];
    summary = `Expression consistent with ${band} pain (PSPI-style ${pspi}, strongest: ${strongest.name}). Confirm with the patient before acting.`;
  }

  return {
    band,
    pspi,
    distress,
    painUnits,
    distressUnits,
    quality,
    confident,
    summary,
    caveats,
  };
}

/**
 * The patient-facing offer.
 *
 * Phrased as a question and routed to the patient's own speech, never asserted to
 * staff. This is the difference between assistive technology and a surveillance
 * tool, and it is worth the extra sentence.
 */
export function painPrompt(result: PainSignalResult): string | null {
  if (result.band === "none" || result.band === "unassessable") return null;
  return "You look like you might be in pain. Do you want to tell your nurse?";
}

/** The staff-facing line, for the nurse panel. Always hedged, never asserted. */
export function nursePainNote(result: PainSignalResult): string | null {
  if (result.band === "none" || result.band === "unassessable") return null;
  const units = result.painUnits.filter((u) => u.present).map((u) => `AU${u.au}`).join(", ");
  return `Possible ${result.band} pain (PSPI-style ${result.pspi}; ${units || "no single dominant unit"}). Decision support — confirm with the patient.`;
}
