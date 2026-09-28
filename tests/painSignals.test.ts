/**
 * Pain and distress signals.
 *
 * The cases that carry the weight here are the safety ones. A detector that
 * says "no pain" because the camera could not see the patient is worse than no
 * detector at all, because it is a false negative with a confident voice. So
 * the unassessable paths are tested as carefully as the positive ones.
 */
import { describe, expect, it } from "vitest";
import {
  assessFaceQuality,
  assessPainSignals,
  nursePainNote,
  painPrompt,
  PainCalibrator,
} from "@/lib/painSignals";
import type { Point } from "@/types";

// MediaPipe indices used by the module, mirrored here so the tests read as
// geometry rather than magic numbers.
const I = {
  BROW_INNER_L: 105, BROW_INNER_R: 334, BROW_OUTER_L: 70, BROW_OUTER_R: 300,
  EYE_OUTER_L: 33, EYE_INNER_L: 133, EYE_OUTER_R: 362, EYE_INNER_R: 263,
  LID_TOP_L: 159, LID_BOTTOM_L: 145, LID_TOP_R: 386, LID_BOTTOM_R: 374,
  CHEEK_L: 205, CHEEK_R: 425, NOSE_ALA_L: 129, NOSE_ALA_R: 358,
  NOSE_TIP: 2, UPPER_LIP: 13, LOWER_LIP: 14, CHIN: 152,
} as const;

/** A neutral, frontal, correctly sized face. */
function neutralFace(): Point[] {
  const lm: Point[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

  // Eye geometry: centres at x 0.42 / 0.58, aperture giving EAR ~0.25.
  const set = (i: number, x: number, y: number) => { lm[i] = { x, y, z: 0 }; };

  set(I.EYE_OUTER_L, 0.40, 0.45); set(I.EYE_INNER_L, 0.44, 0.45);
  set(I.EYE_OUTER_R, 0.60, 0.45); set(I.EYE_INNER_R, 0.56, 0.45);
  set(I.LID_TOP_L, 0.42, 0.4425); set(I.LID_BOTTOM_L, 0.42, 0.4575);
  set(I.LID_TOP_R, 0.58, 0.4425); set(I.LID_BOTTOM_R, 0.58, 0.4575);

  // Brows above the eyes.
  set(I.BROW_INNER_L, 0.425, 0.41); set(I.BROW_OUTER_L, 0.395, 0.415);
  set(I.BROW_INNER_R, 0.575, 0.41); set(I.BROW_OUTER_R, 0.605, 0.415);

  set(I.CHEEK_L, 0.41, 0.49); set(I.CHEEK_R, 0.59, 0.49);
  set(I.NOSE_ALA_L, 0.485, 0.50); set(I.NOSE_ALA_R, 0.515, 0.50);
  set(I.NOSE_TIP, 0.5, 0.49);
  set(I.UPPER_LIP, 0.5, 0.53); set(I.LOWER_LIP, 0.5, 0.545);
  set(I.CHEEK_R, 0.59, 0.49);
  set(I.CHIN, 0.5, 0.58);
  return lm;
}

/** Move every brow down toward the eye. */
function lowerBrow(lm: Point[], amount = 0.012): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.BROW_INNER_L].y += amount;
  out[I.BROW_OUTER_L].y += amount;
  out[I.BROW_INNER_R].y += amount;
  out[I.BROW_OUTER_R].y += amount;
  return out;
}

/** Raise the cheeks toward the lower lids. */
function raiseCheek(lm: Point[], amount = 0.010): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.CHEEK_L].y -= amount;
  out[I.CHEEK_R].y -= amount;
  return out;
}

/** Widen the nose. */
function wrinkleNose(lm: Point[], amount = 0.008): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.NOSE_ALA_L].x -= amount;
  out[I.NOSE_ALA_R].x += amount;
  return out;
}

/** Push the upper lip up toward the nose. */
function raiseUpperLip(lm: Point[], amount = 0.010): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.UPPER_LIP].y -= amount;
  return out;
}

/** Close both eyes to a slit. */
function closeEyes(lm: Point[]): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.LID_TOP_L].y = 0.4550; out[I.LID_BOTTOM_L].y = 0.4558;
  out[I.LID_TOP_R].y = 0.4550; out[I.LID_BOTTOM_R].y = 0.4558;
  return out;
}

/** Drop the jaw. */
function dropJaw(lm: Point[], amount = 0.014): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.CHIN].y += amount;
  out[I.LOWER_LIP].y += amount / 2;
  return out;
}

/** Turn the head: displace the nose tip sideways. */
function turnHead(lm: Point[]): Point[] {
  const out = lm.map((p) => ({ ...p }));
  out[I.NOSE_TIP].x += 0.10;
  return out;
}

/** Shrink the face in frame. */
function shrinkFace(lm: Point[], scale = 0.25): Point[] {
  return lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * scale, y: 0.5 + (p.y - 0.5) * scale, z: 0 }));
}

/** Drive a calibrator to a known baseline. */
function calibrated(baseline: Point[] = neutralFace()): PainCalibrator {
  const c = new PainCalibrator();
  for (let i = 0; i < PainCalibrator.REQUIRED_FRAMES + 5; i += 1) c.observe(baseline);
  return c;
}

describe("assessFaceQuality", () => {
  it("passes a frontal, well-sized, eyes-open face", () => {
    const q = assessFaceQuality(neutralFace());
    expect(q.frontal).toBe(true);
    expect(q.closeEnough).toBe(true);
    expect(q.eyesVisible).toBe(true);
    expect(q.reasons).toHaveLength(0);
  });

  it("flags a turned head", () => {
    expect(assessFaceQuality(turnHead(neutralFace())).frontal).toBe(false);
  });

  it("flags a face too small in frame", () => {
    expect(assessFaceQuality(shrinkFace(neutralFace())).closeEnough).toBe(false);
  });

  it("flags closed eyes as unmeasurable for lid movement", () => {
    // Eyes closed is itself a pain signal (AU43), so it is not a data-quality
    // failure to notice. Noticing the eyes is not possible, however, is.
    const q = assessFaceQuality(closeEyes(neutralFace()));
    expect(q.eyesVisible).toBe(false);
    expect(q.reasons.join(" ")).toMatch(/eyes not visible/i);
  });
});

describe("calibration", () => {
  it("does not report before it has learned a neutral face", () => {
    const r = assessPainSignals(neutralFace(), new PainCalibrator());
    expect(r.band).toBe("unassessable");
    expect(r.confident).toBe(false);
    expect(r.summary).toMatch(/learning this patient/i);
  });

  it("reports progress while calibrating", () => {
    const c = new PainCalibrator();
    expect(c.progress).toBe(0);
    for (let i = 0; i < 20; i += 1) c.observe(neutralFace());
    expect(c.progress).toBeGreaterThan(0);
    expect(c.progress).toBeLessThan(1);
    expect(c.calibrated).toBe(false);
  });

  it("calibrates after enough good frames", () => {
    const c = calibrated();
    expect(c.calibrated).toBe(true);
    expect(c.progress).toBe(1);
  });

  it("ignores unusable frames while calibrating", () => {
    // Turned and tiny frames must not pollute the baseline.
    const c = new PainCalibrator();
    for (let i = 0; i < 30; i += 1) c.observe(turnHead(neutralFace()));
    expect(c.calibrated).toBe(false);
    expect(c.progress).toBe(0);
  });

  it("uses the median so one grimace does not become the baseline", () => {
    // 45 neutral frames and 5 grimaces inside a 50-frame window. A mean would be
    // dragged; the median must stay neutral.
    const c = new PainCalibrator();
    for (let i = 0; i < 45; i += 1) c.observe(neutralFace());
    for (let i = 0; i < 5; i += 1) c.observe(lowerBrow(neutralFace(), 0.03));
    for (let i = 0; i < 5; i += 1) c.observe(neutralFace());
    const b = c.value;
    const neutral = assessPainSignals(neutralFace(), c);
    expect(neutral.band).toBe("none");
    expect(b).not.toBeNull();
  });

  it("resets cleanly", () => {
    const c = calibrated();
    c.reset();
    expect(c.calibrated).toBe(false);
    expect(assessPainSignals(neutralFace(), c).band).toBe("unassessable");
  });
});

describe("assessPainSignals — the absence of a signal", () => {
  it("reports none for a face at its own neutral", () => {
    const r = assessPainSignals(neutralFace(), calibrated());
    expect(r.band).toBe("none");
    expect(r.confident).toBe(false);
    expect(r.pspi).toBe(0);
  });

  it("reports unassessable rather than none when the face is turned", () => {
    // The safety-critical case. A turned head must never become a reassuring
    // negative.
    const r = assessPainSignals(turnHead(neutralFace()), calibrated());
    expect(r.band).toBe("unassessable");
    expect(r.summary).toMatch(/cannot read expression/i);
    expect(painPrompt(r)).toBeNull();
    expect(nursePainNote(r)).toBeNull();
  });

  it("reports unassessable when the face is too small", () => {
    expect(assessPainSignals(shrinkFace(neutralFace()), calibrated()).band).toBe("unassessable");
  });

  it("never emits a pain prompt for a comfortable or unreadable face", () => {
    const c = calibrated();
    expect(painPrompt(assessPainSignals(neutralFace(), c))).toBeNull();
    expect(painPrompt(assessPainSignals(turnHead(neutralFace()), c))).toBeNull();
  });
});

describe("assessPainSignals — detecting pain", () => {
  it("flags a single brow lowerer as too weak to assert pain", () => {
    // One unit spiking on a single frame is noise, not a patient in pain.
    const r = assessPainSignals(lowerBrow(neutralFace()), calibrated());
    expect(r.confident).toBe(false);
    expect(r.band).toBe("none");
  });

  it("detects pain when several units move together", () => {
    let lm = lowerBrow(neutralFace(), 0.02);
    lm = raiseCheek(lm, 0.014);
    lm = wrinkleNose(lm, 0.012);
    lm = raiseUpperLip(lm, 0.014);
    const r = assessPainSignals(lm, calibrated());
    expect(r.confident).toBe(true);
    expect(["mild", "moderate", "severe"]).toContain(r.band);
    expect(r.summary).toMatch(/confirm with the patient/i);
  });

  it("reads brow lowerer as AU4 and raises its intensity as the brow drops", () => {
    const c = calibrated();
    const slight = assessPainSignals(lowerBrow(neutralFace(), 0.006), c);
    const strong = assessPainSignals(lowerBrow(neutralFace(), 0.030), c);
    const au4 = (r: typeof slight) => r.painUnits.find((u) => u.au === 4)!;
    expect(au4(strong).intensity).toBeGreaterThan(au4(slight).intensity);
    expect(au4(strong).delta).toBeGreaterThan(0); // lowered brow is positive
  });

  it("reads nose wrinkler as AU9 with a wider nose", () => {
    const r = assessPainSignals(wrinkleNose(neutralFace(), 0.012), calibrated());
    const au9 = r.painUnits.find((u) => u.au === 9)!;
    expect(au9.delta).toBeGreaterThan(0);
  });

  it("reads upper lip raiser as AU10 with a raised lip", () => {
    const r = assessPainSignals(raiseUpperLip(neutralFace(), 0.014), calibrated());
    const au10 = r.painUnits.find((u) => u.au === 10)!;
    expect(au10.delta).toBeGreaterThan(0);
  });

  it("treats closed eyes as AU43", () => {
    const r = assessPainSignals(closeEyes(neutralFace()), calibrated());
    const au43 = r.painUnits.find((u) => u.au === 43)!;
    expect(au43.present).toBe(true);
    expect(au43.intensity).toBeGreaterThan(0);
  });

  it("does not double-count closed eyes as a lid tightener", () => {
    // AU43 supersedes AU7; counting both would inflate the index on a signal
    // that is really one thing.
    const r = assessPainSignals(closeEyes(neutralFace()), calibrated());
    const au7 = r.painUnits.find((u) => u.au === 7)!;
    expect(au7.intensity).toBe(0);
  });

  it("separates a dropped jaw from a pain finding", () => {
    // Jaw drop is breathlessness, not pain. It must land in the distress set.
    const r = assessPainSignals(dropJaw(neutralFace(), 0.02), calibrated());
    expect(r.distress).toBeGreaterThan(0);
    const au26 = r.distressUnits.find((u) => u.au === 26)!;
    expect(au26.delta).toBeGreaterThan(0);
  });

  it("mentions breathlessness when distress is high but pain is not", () => {
    const r = assessPainSignals(dropJaw(neutralFace(), 0.025), calibrated());
    if (r.band === "none" && r.distress >= 5) {
      expect(r.summary).toMatch(/breathlessness/i);
    }
  });
});

describe("personalisation — the point of the design", () => {
  it("is not fooled by a patient whose brows normally sit low", () => {
    // Their resting face already looks like a permanent brow lowerer. An
    // absolute-threshold detector reads this as pain forever; a baseline-relative
    // one reads it as neutral, which is the correct answer.
    const lowBrows = lowerBrow(neutralFace(), 0.018);
    const c = calibrated(lowBrows);
    const r = assessPainSignals(lowBrows, c);
    expect(r.band).toBe("none");
  });

  it("is not fooled by a permanently narrowed eye aperture", () => {
    const squint = closeEyes(neutralFace());
    const c = calibrated(squint);
    // Fully closed eyes at rest still read as AU43, deliberately: eyes shut is
    // worth asking about whatever the baseline. But the index must not be
    // inflated by a lid tightener as well.
    const r = assessPainSignals(squint, c);
    const au7 = r.painUnits.find((u) => u.au === 7)!;
    expect(au7.intensity).toBe(0);
  });

  it("still detects a real change from a non-standard baseline", () => {
    const lowBrows = lowerBrow(neutralFace(), 0.018);
    const c = calibrated(lowBrows);
    let worse = raiseCheek(lowBrows, 0.016);
    worse = wrinkleNose(worse, 0.014);
    worse = raiseUpperLip(worse, 0.016);
    const r = assessPainSignals(worse, c);
    expect(r.pspi).toBeGreaterThan(0);
  });
});

describe("regression: eyes closed must not blind the detector", () => {
  it("still assesses a grimace when the eyes are shut", () => {
    // An earlier version treated closed eyes as a data-quality failure and
    // returned "unassessable". That made AU43 unreportable and blinded the
    // detector to exactly the patients least able to speak: eyes shut, jaw
    // clenched, brow down. Closed eyes are a signal, not a failed reading.
    let lm = closeEyes(neutralFace());
    lm = lowerBrow(lm, 0.02);
    lm = wrinkleNose(lm, 0.012);
    const r = assessPainSignals(lm, calibrated());
    expect(r.band).not.toBe("unassessable");
    expect(r.painUnits.find((u) => u.au === 43)!.present).toBe(true);
    expect(r.confident).toBe(true);
  });

  it("suppresses the lid tightener it cannot measure, without suppressing AU43", () => {
    const r = assessPainSignals(closeEyes(neutralFace()), calibrated());
    expect(r.painUnits.find((u) => u.au === 7)!.intensity).toBe(0);
    expect(r.painUnits.find((u) => u.au === 43)!.intensity).toBeGreaterThan(0);
  });
});

describe("output discipline", () => {
  it("always carries its caveats", () => {
    const c = calibrated();
    for (const r of [
      assessPainSignals(neutralFace(), c),
      assessPainSignals(turnHead(neutralFace()), c),
      assessPainSignals(lowerBrow(neutralFace(), 0.03), c),
    ]) {
      expect(r.caveats.length).toBeGreaterThan(0);
      expect(r.caveats.join(" ")).toMatch(/not a pain scale/i);
      expect(r.caveats.join(" ")).toMatch(/RCT/i);
      expect(r.caveats.join(" ")).toMatch(/female and darker-skinned/i);
    }
  });

  it("offers the patient a question, not a diagnosis", () => {
    let lm = lowerBrow(neutralFace(), 0.02);
    lm = raiseCheek(lm, 0.014);
    lm = wrinkleNose(lm, 0.012);
    const r = assessPainSignals(lm, calibrated());
    const prompt = painPrompt(r);
    expect(prompt).toMatch(/do you want to tell your nurse/i);
  });

  it("hedges the staff note", () => {
    let lm = lowerBrow(neutralFace(), 0.02);
    lm = raiseCheek(lm, 0.014);
    lm = wrinkleNose(lm, 0.012);
    const note = nursePainNote(assessPainSignals(lm, calibrated()));
    expect(note).toMatch(/^Possible/);
    expect(note).toMatch(/confirm with the patient/i);
  });

  it("keeps the PSPI index within its stated 0-30 range", () => {
    const extreme = closeEyes(lowerBrow(raiseCheek(wrinkleNose(raiseUpperLip(neutralFace(), 0.05), 0.05), 0.05), 0.05));
    const r = assessPainSignals(extreme, calibrated());
    expect(r.pspi).toBeGreaterThanOrEqual(0);
    expect(r.pspi).toBeLessThanOrEqual(30);
    expect(r.distress).toBeLessThanOrEqual(10);
  });
});
