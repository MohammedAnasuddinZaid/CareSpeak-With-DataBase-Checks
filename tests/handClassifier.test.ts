import { describe, it, expect } from "vitest";
import {
  classifyHandGesture,
  HandGestureSmoother,
  isOpenPalm,
  isFist,
  areFingersSpread,
} from "../src/lib/handClassifier";
import type { HandData, Point } from "../src/types";

function pt(x: number, y: number): Point {
  return { x, y, z: 0 };
}

/**
 * Synthetic 21-point hand matching the classifier's actual geometry:
 *  - finger ext flag 1 -> tipDist/pipDist ≈ 2.8 (extended)
 *  - finger ext flag 0 -> ratio ≈ 0.5 (curled)
 *  - thumb flags control extension + vertical direction
 */
function makeHand(opts: {
  index?: number; middle?: number; ring?: number; pinky?: number;
  thumbUp?: boolean; thumbDown?: boolean; spread?: boolean;
}): HandData {
  const {
    index = 0, middle = 0, ring = 0, pinky = 0,
    thumbUp = false, thumbDown = false, spread = false,
  } = opts;
  const lm: Point[] = new Array(21).fill(null).map(() => pt(0, 0));

  // Wrist + MCP anchors (image coords: y grows downward)
  lm[0] = pt(0.5, 1.0);
  lm[2] = pt(0.45, 0.78); // thumb MCP
  lm[3] = pt(0.44, 0.75); // thumb IP
  lm[5] = pt(0.47, 0.70);
  lm[9] = pt(0.50, 0.68);
  lm[13] = pt(0.53, 0.70);
  lm[17] = pt(0.56, 0.72);

  const fingerTip = (mcpIdx: number, pipIdx: number, tipIdx: number, ext: number) => {
    const mcp = lm[mcpIdx];
    if (ext === 1) {
      lm[pipIdx] = pt(mcp.x, mcp.y - 0.05);
      lm[tipIdx] = pt(mcp.x, mcp.y - 0.14);
    } else {
      lm[pipIdx] = pt(mcp.x, mcp.y - 0.06);
      lm[tipIdx] = pt(mcp.x, mcp.y - 0.03);
    }
  };
  fingerTip(5, 6, 8, index);
  fingerTip(9, 10, 12, middle);
  fingerTip(13, 14, 16, ring);
  fingerTip(17, 18, 20, pinky);

  if (thumbUp) {
    lm[4] = pt(0.45, 0.60); // far above thumb MCP
  } else if (thumbDown) {
    lm[4] = pt(0.45, 0.95); // below thumb MCP
  } else {
    lm[4] = pt(0.443, 0.762); // tucked close to IP -> NOT extended
  }

  if (spread) {
    lm[8] = pt(lm[5].x - 0.04, lm[8].y);
    lm[12] = pt(lm[9].x + 0.01, lm[12].y);
    lm[16] = pt(lm[13].x + 0.06, lm[16].y);
    lm[20] = pt(lm[17].x + 0.11, lm[20].y);
  }

  return { landmarks: lm, handedness: "Right" };
}

describe("handClassifier", () => {
  it("detects thumbs-up as YES", () => {
    const r = classifyHandGesture([makeHand({ thumbUp: true })]);
    expect(r?.gesture).toBe("YES");
  });

  it("detects thumbs-down as NO", () => {
    const r = classifyHandGesture([makeHand({ thumbDown: true })]);
    expect(r?.gesture).toBe("NO");
  });

  it("detects index+pinky as HELP", () => {
    const r = classifyHandGesture([makeHand({ index: 1, pinky: 1 })]);
    expect(r?.gesture).toBe("HELP");
  });

  it("returns null for a fist", () => {
    expect(classifyHandGesture([makeHand({})])).toBeNull();
  });

  it("classifies both-hands-open as WATER", () => {
    const open = makeHand({ index: 1, middle: 1, ring: 1, pinky: 1, spread: true });
    expect(areFingersSpread(open.landmarks)).toBe(true);
    const r = classifyHandGesture([open, { ...open, handedness: "Left" }]);
    expect(r?.gesture).toBe("WATER");
  });

  it("palm helpers behave", () => {
    const open = makeHand({ index: 1, middle: 1, ring: 1, pinky: 1, thumbUp: true, spread: true });
    expect(isOpenPalm(open.landmarks)).toBe(true);
    expect(isFist(makeHand({}).landmarks)).toBe(true);
    expect(isOpenPalm(makeHand({}).landmarks)).toBe(false);
  });

  it("smoother requires majority before committing a gesture", () => {
    const s = new HandGestureSmoother();
    for (let i = 0; i < 6; i++) s.push({ gesture: null, confidence: 0 });
    const out = s.push({ gesture: "HELP", confidence: 0.9 });
    expect(out.gesture).not.toBe("HELP");
  });
});
