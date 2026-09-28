/**
 * Dwell selection.
 *
 * Every case here is a way a gaze board can hurt a patient who cannot correct
 * the system: selecting a phrase nobody asked for, repeating a phrase, or
 * ignoring a deliberate look. The rules are the product.
 */
import { describe, expect, it } from "vitest";
import {
  DwellSelector,
  DEFAULT_DWELL_MS,
  DWELL_PRESETS,
  gazeFromIrisOffset,
} from "@/lib/dwell";

const grid = (over: Partial<ConstructorParameters<typeof DwellSelector>[0]> = {}) =>
  new DwellSelector({ columns: 3, rows: 2, dwellMs: 1000, ...over });

describe("DwellSelector targeting", () => {
  it("maps the four corners of a 3x2 grid", () => {
    const d = grid();
    expect(d.indexFor({ x: 0.1, y: 0.1 })).toBe(0); // top-left
    expect(d.indexFor({ x: 0.9, y: 0.1 })).toBe(2); // top-right
    expect(d.indexFor({ x: 0.1, y: 0.9 })).toBe(3); // bottom-left
    expect(d.indexFor({ x: 0.9, y: 0.9 })).toBe(5); // bottom-right
  });

  it("has no target without a gaze", () => {
    expect(grid().indexFor(null)).toBeNull();
  });

  it("rejects off-grid and non-finite points", () => {
    const d = grid();
    expect(d.indexFor({ x: -0.1, y: 0.5 })).toBeNull();
    expect(d.indexFor({ x: 1.1, y: 0.5 })).toBeNull();
    expect(d.indexFor({ x: 0.5, y: -0.1 })).toBeNull();
    expect(d.indexFor({ x: NaN, y: 0.5 })).toBeNull();
    expect(d.indexFor({ x: 0.5, y: Infinity })).toBeNull();
  });

  it("clamps a slight edge overshoot to the outer cell", () => {
    // A gaze landing a hair past the edge still means the last column.
    const d = grid();
    expect(d.indexFor({ x: 0.999, y: 0.999 })).toBe(5);
    expect(d.indexFor({ x: 0.98, y: 0.999 })).toBe(5);
  });
});

describe("DwellSelector firing", () => {
  it("does not fire before the dwell time", () => {
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    expect(d.update(g, 0)).toBeNull();
    expect(d.update(g, 400)).toBeNull();
    expect(d.update(g, 999)).toBeNull();
    expect(d.update(g, 1000)).toBe(0);
  });

  it("resets the timer when the target moves", () => {
    // Sliding across the board must not carry accumulated time with it.
    const d = grid();
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.9, y: 0.1 };
    d.update(a, 0);
    d.update(a, 900);
    expect(d.update(b, 950)).toBeNull();
    expect(d.update(b, 1900)).toBeNull();
    expect(d.update(b, 1950)).toBe(2);
  });

  it("never fires twice within one fixation", () => {
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    expect(d.update(g, 0)).toBeNull();
    expect(d.update(g, 1000)).toBe(0);
    // Refractory plus the re-arm lock: every subsequent frame is silent.
    expect(d.update(g, 1500)).toBeNull();
    expect(d.update(g, 1999)).toBeNull();
    expect(d.update(g, 2100)).toBeNull();
  });

  it("cancels accumulation when the gaze is lost", () => {
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    d.update(g, 0);
    d.update(g, 900);
    expect(d.update(null, 950)).toBeNull();
    expect(d.target()).toBeNull();
    // Returning to the same tile starts over rather than resuming.
    expect(d.update(g, 1000)).toBeNull();
    expect(d.update(g, 1999)).toBeNull();
    expect(d.update(g, 2000)).toBe(0);
  });

  it("treats non-finite gaze as lost", () => {
    const d = grid();
    d.update({ x: 0.1, y: 0.1 }, 0);
    d.update({ x: NaN, y: 0.1 }, 900);
    expect(d.target()).toBeNull();
  });

  it("stays silent for a whole refractory window", () => {
    const d = grid({ refractoryMs: 500 });
    const g = { x: 0.1, y: 0.1 };
    d.update(g, 0);
    expect(d.update(g, 1000)).toBe(0);
    expect(d.blocked(1400)).toBe(true);
    expect(d.progress(1400)).toBe(0);
    expect(d.blocked(1500)).toBe(false);
  });

  it("does not re-fire while the gaze rests on the fired tile", () => {
    // The runaway-repeat case: a patient just looking at "I am in pain" must
    // not flood the ward with it once per dwell period.
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    d.update(g, 0);
    expect(d.update(g, 1000)).toBe(0);
    for (const t of [1500, 2000, 3000, 5000, 10000]) {
      expect(d.update(g, t)).toBeNull();
    }
    expect(d.progress(10000)).toBe(0);
  });

  it("re-arms only after the gaze leaves and returns", () => {
    const d = grid();
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.9, y: 0.1 };
    d.update(a, 0);
    expect(d.update(a, 1000)).toBe(0);

    // Looking elsewhere clears the lock, but must not fire that other tile
    // instantly either — it still needs its own dwell.
    expect(d.update(b, 1100)).toBeNull();
    expect(d.update(b, 2000)).toBeNull();
    expect(d.update(b, 2100)).toBe(2);

    // And the first tile is now selectable again.
    expect(d.update(a, 2200)).toBeNull();
    expect(d.update(a, 3200)).toBe(0);
  });

  it("does not accumulate during the refractory window", () => {
    const d = grid({ refractoryMs: 500 });
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.9, y: 0.1 };
    d.update(a, 0);
    d.update(a, 1000); // fires
    expect(d.blocked(1400)).toBe(true);
    expect(d.progress(1400)).toBe(0);
    expect(d.update(a, 1400)).toBeNull();
    // Leaving re-arms; the other tile still owes a full dwell.
    expect(d.update(b, 1500)).toBeNull();
    expect(d.update(b, 2499)).toBeNull();
    expect(d.update(b, 2500)).toBe(2);
  });

  it("can be reset and fully cancelled", () => {
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    d.update(g, 0);
    d.update(g, 900);
    d.reset(950);
    expect(d.target()).toBeNull();
    expect(d.progress(950)).toBe(0);

    d.update(g, 1000);
    d.cancel(1050);
    expect(d.update(g, 5000)).toBeNull();
  });

  it("reports progress only for the held target", () => {
    const d = grid();
    const g = { x: 0.1, y: 0.1 };
    expect(d.progress(0)).toBe(0);
    d.update(g, 0);
    expect(d.progress(250)).toBeCloseTo(0.25, 5);
    expect(d.progress(500)).toBeCloseTo(0.5, 5);
    expect(d.progress(5000)).toBe(1);
  });

  it("supports a single-cell grid without dividing by zero", () => {
    const d = new DwellSelector({ columns: 1, rows: 1, dwellMs: 100 });
    expect(d.update({ x: 0.5, y: 0.5 }, 0)).toBeNull();
    expect(d.update({ x: 0.5, y: 0.5 }, 100)).toBe(0);
  });

  it("refuses a nonsensical dwell time", () => {
    const d = new DwellSelector({ columns: 2, rows: 2, dwellMs: 0 });
    // A zero dwell would fire on the first frame; clamped to 1ms instead.
    const g = { x: 0.1, y: 0.1 };
    expect(d.update(g, 0)).toBeNull();
    expect(d.update(g, 1)).toBe(0);
  });
});

describe("dwell presets", () => {
  it("gets slower as the patient needs more time", () => {
    expect(DWELL_PRESETS.quick.dwellMs).toBeLessThan(DWELL_PRESETS.normal.dwellMs);
    expect(DWELL_PRESETS.normal.dwellMs).toBeLessThan(DWELL_PRESETS.steady.dwellMs);
  });

  it("defaults slower than the generic eye-tracking guidance", () => {
    // Generic guidance is ~500ms; patients with reduced ocular motility need
    // longer, and a wrong selection is worse than a slow one.
    expect(DEFAULT_DWELL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("gazeFromIrisOffset", () => {
  it("centres a neutral gaze", () => {
    const g = gazeFromIrisOffset(0, 0);
    expect(g.x).toBeCloseTo(0.5, 5);
    expect(g.y).toBeCloseTo(0.5, 5);
  });

  it("maps a full reach to the edge", () => {
    const g = gazeFromIrisOffset(0.22, -0.22, 0.22);
    expect(g.x).toBeCloseTo(1, 5);
    expect(g.y).toBeCloseTo(0, 5);
  });

  it("clamps an overshoot instead of leaving the board", () => {
    const g = gazeFromIrisOffset(5, 5, 0.22);
    expect(g.x).toBe(1);
    expect(g.y).toBe(1);
  });

  it("stays centred for a non-positive reach rather than exploding", () => {
    const g = gazeFromIrisOffset(0.5, 0.5, 0);
    expect(g.x).toBeCloseTo(0.5, 5);
    expect(g.y).toBeCloseTo(0.5, 5);
  });
});
