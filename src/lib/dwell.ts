/**
 * Dwell selection for gaze pointing.
 *
 * A patient with no usable hands cannot tap a phrase board, so the target is
 * chosen by resting their gaze on it. That creates a failure mode touch input
 * does not have: simply looking *near* a control can activate it, and a gaze
 * that drifts across the board will otherwise fire everything it passes over.
 *
 * The rules that make this usable are all here, and all deliberate:
 *
 *  1. DWELL RESETS WHEN THE TARGET MOVES. The single most important rule. If
 *     the timer carried across tiles, sliding your gaze across the board would
 *     select everything in its path.
 *  2. REFRACTORY AND RE-ARM AFTER A SELECT. Otherwise one long fixation
 *     straddling two adjacent tiles fires both — and worse, a patient simply
 *     resting their gaze on a tile would re-send that phrase forever, which on
 *     a ward board means flooding the nurse with the same sentence. After
 *     firing, the gaze must LEAVE the tile and dwell on it again.
 *  3. NO GAZE, NO ACCUMULATION. Losing the face cancels progress entirely
 *     rather than leaving a timer that resumes later against a stale target.
 *  4. PROGRESS IS EXTERNAL. `progress()` exists so the UI can show the ring
 *     filling. A dwell timer the patient cannot see is indistinguishable from
 *     a broken board.
 *
 * This is a pointer, not a precision device: webcam iris offsets are coarse, so
 * a grid is the right granularity. A dedicated eye tracker (Tobii and similar)
 * is the upgrade path for finer targets.
 */

export interface DwellGrid {
  /** Number of columns in the selectable grid. */
  columns: number;
  /** Number of rows in the selectable grid. */
  rows: number;
}

export interface DwellSelectorOptions extends DwellGrid {
  /** Time a target must be held before it fires. */
  dwellMs: number;
  /** Dead time after a selection, during which nothing can fire. */
  refractoryMs?: number;
}

/**
 * Dwell defaults tuned for the bedside.
 *
 * AAC guidance puts the general eye-tracking sweet spot near 500ms, but also
 * notes that patients with reduced ocular motility struggle to move between
 * targets fast enough to avoid errors at short dwells, and that eyes fatigue.
 * The default is therefore deliberately slower than the generic figure; a
 * mis-selection is worse than a slow one.
 */
export const DWELL_PRESETS = {
  quick: { label: "Quick", dwellMs: 700 },
  normal: { label: "Normal", dwellMs: 1200 },
  steady: { label: "Steady", dwellMs: 1800 },
} as const;

export type DwellPreset = keyof typeof DWELL_PRESETS;

export const DEFAULT_DWELL_MS = DWELL_PRESETS.normal.dwellMs;

export interface GazePoint {
  /** Normalised 0..1 across the selectable area, already mirrored. */
  x: number;
  y: number;
}

export class DwellSelector {
  private readonly columns: number;
  private readonly rows: number;
  private readonly dwellMs: number;
  private readonly refractoryMs: number;

  private current: number | null = null;
  private heldSince = 0;
  private blockedUntil = 0;
  /** Tile that just fired; the gaze must move off it before it can re-arm. */
  private latched: number | null = null;

  constructor(opts: DwellSelectorOptions) {
    this.columns = Math.max(1, Math.floor(opts.columns));
    this.rows = Math.max(1, Math.floor(opts.rows));
    this.dwellMs = Math.max(1, opts.dwellMs);
    this.refractoryMs = Math.max(0, opts.refractoryMs ?? opts.dwellMs);
  }

  /** The index the pointer is over, or null when nothing is selected. */
  target(): number | null {
    return this.current;
  }

  /** 0..1 through the current hold. Drives the visible ring. */
  progress(now: number): number {
    if (this.current === null) return 0;
    if (this.latched !== null) return 0;
    if (now < this.blockedUntil) return 0;
    const held = now - this.heldSince;
    return Math.max(0, Math.min(1, held / this.dwellMs));
  }

  /** True while a selection is impossible because of the refractory window. */
  blocked(now: number): boolean {
    return now < this.blockedUntil;
  }

  /** Grid index for a normalised gaze point, or null when off-grid. */
  indexFor(gaze: GazePoint | null): number | null {
    if (!gaze) return null;
    if (!Number.isFinite(gaze.x) || !Number.isFinite(gaze.y)) return null;
    if (gaze.x < 0 || gaze.x > 1 || gaze.y < 0 || gaze.y > 1) return null;

    // Clamp rather than reject a half-pixel of edge overshoot: a gaze that
    // lands a few percent past the edge still means the outer column.
    const col = Math.min(this.columns - 1, Math.floor(gaze.x * this.columns));
    const row = Math.min(this.rows - 1, Math.floor(gaze.y * this.rows));
    return row * this.columns + col;
  }

  /**
   * Advance the selector. Returns the index that fired on this call, else null.
   */
  update(gaze: GazePoint | null, now: number): number | null {
    const next = this.indexFor(gaze);

    // Rule 3 — losing the gaze cancels rather than pausing.
    if (next === null) {
      this.current = null;
      this.heldSince = now;
      return null;
    }

    // Rule 2 — a tile that just fired stays silent until the gaze leaves it,
    // so a patient resting on a phrase cannot spam it over and over.
    if (this.latched !== null) {
      if (next === this.latched) {
        this.current = next;
        this.heldSince = now;
        return null;
      }
      this.latched = null;
    }

    // Rule 1 — the timer belongs to a target, never to the pointer's history.
    if (next !== this.current) {
      this.current = next;
      this.heldSince = now;
      return null;
    }

    if (this.blocked(now)) return null;
    if (now - this.heldSince < this.dwellMs) return null;

    // Fire once, then lock: refractory time plus a requirement to look away.
    this.blockedUntil = now + this.refractoryMs;
    this.heldSince = now;
    this.latched = this.current;
    return this.current;
  }

  /** Forget the current target and any pending timer, keeping the re-arm lock. */
  reset(now: number): void {
    this.current = null;
    this.heldSince = now;
  }

  /** Full stop — clears the refractory window and the re-arm lock. */
  cancel(now: number): void {
    this.reset(now);
    this.blockedUntil = now;
    this.latched = null;
  }
}

/**
 * Map a calibrated iris offset onto a normalised point.
 *
 * The classifier produces an offset normalised by eye width, not a screen
 * coordinate, so the reach has to be chosen. `reach` is the offset that maps
 * to the edge of the selectable area; it is empirical and depends on how far
 * the camera is from the patient, which is why it is a parameter.
 *
 * Input is expected already mirrored, so +x is the patient's screen-right.
 */
export function gazeFromIrisOffset(
  dx: number,
  dy: number,
  reach = 0.22,
): GazePoint {
  if (reach <= 0) return { x: 0.5, y: 0.5 };
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp01(0.5 + dx / (2 * reach)),
    y: clamp01(0.5 + dy / (2 * reach)),
  };
}
