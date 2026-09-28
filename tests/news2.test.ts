/**
 * NEWS2.
 *
 * These are transcribed from the published Royal College of Physicians chart,
 * so the tests are transcription tests: if a threshold is wrong, a nurse acts on
 * a number that does not mean what they think it means. Each case below cites
 * the band it belongs to.
 *
 * The cases that are not transcription matter just as much: a single red score
 * must escalate regardless of the aggregate, and a partial observation set must
 * never read as reassuring.
 */
import { describe, expect, it } from "vitest";
import {
  computeNews2,
  news2Band,
  news2Summary,
  news2Response,
  newsTrend,
  scoreConsciousness,
  scorePulse,
  scoreRespiratoryRate,
  scoreSpO2Scale1,
  scoreSpO2Scale2,
  scoreSystolicBp,
  scoreTemperature,
  type News2Result,
} from "@/lib/news2";
import { citationPassage, formatCitation } from "@/lib/clinicalBasis";

describe("respiratory rate", () => {
  it("scores the published bands", () => {
    expect(scoreRespiratoryRate(4)).toBe(3); // ≤8
    expect(scoreRespiratoryRate(9)).toBe(1);
    expect(scoreRespiratoryRate(11)).toBe(1);
    expect(scoreRespiratoryRate(12)).toBe(0);
    expect(scoreRespiratoryRate(20)).toBe(0);
    expect(scoreRespiratoryRate(21)).toBe(2);
    expect(scoreRespiratoryRate(24)).toBe(2);
    expect(scoreRespiratoryRate(25)).toBe(3);
  });
});

describe("SpO2", () => {
  it("scores Scale 1", () => {
    expect(scoreSpO2Scale1(85)).toBe(3); // ≤91
    expect(scoreSpO2Scale1(92)).toBe(2);
    expect(scoreSpO2Scale1(94)).toBe(1);
    expect(scoreSpO2Scale1(97)).toBe(0);
  });

  it("does not flag a COPD target range on Scale 2", () => {
    // The reason Scale 2 exists. Scoring this patient as hypoxaemic would
    // generate a constant false alarm on someone who is deliberately low.
    expect(scoreSpO2Scale2(90, false)).toBe(0);
    expect(scoreSpO2Scale2(95, false)).toBe(0);
  });

  it("scores 90% as hypoxaemia on Scale 1 but not on Scale 2", () => {
    expect(scoreSpO2Scale1(90)).toBe(3);
    expect(scoreSpO2Scale2(90, false)).toBe(0);
  });

  it("scores oxygen delivery on Scale 2", () => {
    expect(scoreSpO2Scale2(93, true)).toBe(1);
    expect(scoreSpO2Scale2(95, true)).toBe(2);
    expect(scoreSpO2Scale2(98, true)).toBe(3);
  });
});

describe("systolic blood pressure", () => {
  it("scores the published bands", () => {
    expect(scoreSystolicBp(85)).toBe(3);
    expect(scoreSystolicBp(95)).toBe(2);
    expect(scoreSystolicBp(105)).toBe(1);
    expect(scoreSystolicBp(120)).toBe(0);
    expect(scoreSystolicBp(230)).toBe(3);
  });
});

describe("pulse", () => {
  it("scores the published bands", () => {
    expect(scorePulse(35)).toBe(3);
    expect(scorePulse(45)).toBe(1);
    expect(scorePulse(70)).toBe(0);
    expect(scorePulse(100)).toBe(1);
    expect(scorePulse(120)).toBe(2);
    expect(scorePulse(140)).toBe(3);
  });
});

describe("consciousness", () => {
  it("scores alert as 0 and everything worse as 3", () => {
    expect(scoreConsciousness("alert")).toBe(0);
    // New confusion scores the same as unresponsiveness, by design.
    expect(scoreConsciousness("confusion")).toBe(3);
    expect(scoreConsciousness("voice")).toBe(3);
    expect(scoreConsciousness("unresponsive")).toBe(3);
  });

  it("maps a low alertness proxy to a non-alert score", () => {
    expect(scoreConsciousness(95)).toBe(0);
    expect(scoreConsciousness(20)).toBe(3);
  });
});

describe("temperature", () => {
  it("scores the published bands", () => {
    expect(scoreTemperature(34.5)).toBe(3);
    expect(scoreTemperature(35.5)).toBe(1);
    expect(scoreTemperature(37)).toBe(0);
    expect(scoreTemperature(38.5)).toBe(1);
    expect(scoreTemperature(40)).toBe(2);
  });
});

describe("bands and responses", () => {
  it("maps aggregates to the published bands", () => {
    expect(news2Band(0)).toBe("low");
    expect(news2Band(4)).toBe("low");
    expect(news2Band(5)).toBe("medium");
    expect(news2Band(6)).toBe("medium");
    expect(news2Band(7)).toBe("high");
    expect(news2Band(20)).toBe("high");
  });

  it("gives a distinct response per band", () => {
    const responses = new Set([
      news2Response("low"),
      news2Response("medium"),
      news2Response("high"),
    ]);
    expect(responses.size).toBe(3);
    expect(news2Response("high")).toMatch(/critical care/i);
  });
});

/** A full, normal observation set. */
const healthy = {
  respiratoryRate: 16,
  spo2: 98,
  systolicBp: 120,
  pulse: 70,
  consciousness: "alert" as const,
  temperature: 36.8,
};

describe("computeNews2", () => {
  it("scores a well patient at zero", () => {
    const r = computeNews2(healthy);
    expect(r.total).toBe(0);
    expect(r.band).toBe("low");
    expect(r.complete).toBe(true);
    expect(r.hasSingleRedScore).toBe(false);
  });

  it("sums the aggregate", () => {
    const r = computeNews2({
      respiratoryRate: 26,
      spo2: 90,
      systolicBp: 88,
      pulse: 120,
      consciousness: "confusion",
      temperature: 40,
    });
    expect(r.total).toBe(3 + 3 + 3 + 2 + 3 + 2);
    expect(r.band).toBe("high");
  });

  it("adds the oxygen weighting score", () => {
    const without = computeNews2(healthy);
    const withO2 = computeNews2({ ...healthy, supplementalOxygen: true });
    expect(withO2.total).toBe(without.total + 2);
  });

  it("flags a single red score with a low aggregate", () => {
    // The case that makes single-parameter escalation non-negotiable: a total
    // of 3 looks unremarkable, and is not.
    const r = computeNews2({ ...healthy, spo2: 89 });
    expect(r.total).toBe(3);
    expect(r.band).toBe("low");
    expect(r.hasSingleRedScore).toBe(true);
    expect(r.redParameter).toBe("spo2");
    expect(news2Summary(r)).toMatch(/single red score/i);
  });

  it("does not treat the oxygen uplift as a red score", () => {
    const r = computeNews2({ ...healthy, supplementalOxygen: true });
    expect(r.total).toBe(2);
    expect(r.hasSingleRedScore).toBe(false);
  });

  it("never reports a partial set as complete or reassuring", () => {
    // Missing observations that silently score zero is how track-and-trigger
    // systems under-triage a patient nobody looked at.
    const r = computeNews2({ spo2: 97, pulse: 70 });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(
      expect.arrayContaining(["respiratoryRate", "systolicBp", "consciousness", "temperature"]),
    );
    expect(news2Summary(r)).toMatch(/incomplete/i);
    expect(news2Summary(r)).toMatch(/floor/i);
  });

  it("lists every parameter exactly once when complete", () => {
    const r = computeNews2({ ...healthy, supplementalOxygen: true });
    const names = r.parameters.map((p) => p.parameter);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("supplementalOxygen");
  });

  it("cites a source for every scored parameter", () => {
    const r = computeNews2(healthy);
    for (const p of r.parameters) {
      expect(p.citation.docId).toBe("RCP-NEWS2");
    }
  });

  it("only cites sections that actually exist in the corpus", () => {
    // The corpus is the traceability claim of this app. A section key that
    // silently stops resolving is a broken citation that still looks valid on
    // screen, so it is worth asserting at the point of generation.
    const cited = [
      computeNews2({ ...healthy, supplementalOxygen: true }),
      computeNews2({ ...healthy, spo2Scale2: true }),
    ].flatMap((r) => [r.citation, ...r.parameters.map((p) => p.citation)]);

    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) {
      expect(formatCitation(c)).not.toContain("missing");
      expect(citationPassage(c).length).toBeGreaterThan(20);
    }
  });

  it("ignores non-finite readings rather than scoring them", () => {
    const r = computeNews2({ ...healthy, spo2: NaN });
    expect(r.complete).toBe(false);
    expect(r.missing).toContain("spo2");
  });
});

/** Helper: a complete result with a given aggregate, for trend tests. */
const withTotal = (total: number): News2Result => {
  const r = computeNews2(healthy);
  return { ...r, total, band: news2Band(total) };
};

describe("newsTrend", () => {
  it("calls a two-point rise a deterioration inside the low band", () => {
    // The signal a static score structurally cannot show.
    const t = newsTrend(withTotal(3), withTotal(1));
    expect(t.trend).toBe("rising");
    expect(t.delta).toBe(2);
    expect(t.deterioratingWithinBand).toBe(true);
    expect(t.explanation).toMatch(/direction is the signal/i);
  });

  it("does not raise the in-band flag when the band itself changes", () => {
    const t = newsTrend(withTotal(6), withTotal(4));
    expect(t.trend).toBe("rising");
    expect(t.deterioratingWithinBand).toBe(false);
  });

  it("treats a one-point wobble as stable", () => {
    expect(newsTrend(withTotal(3), withTotal(2)).trend).toBe("stable");
    expect(newsTrend(withTotal(2), withTotal(3)).trend).toBe("stable");
  });

  it("recognises improvement", () => {
    expect(newsTrend(withTotal(1), withTotal(5)).trend).toBe("falling");
  });

  it("refuses to build a trend on incomplete observations", () => {
    const partial = computeNews2({ spo2: 97 });
    const t = newsTrend(partial, withTotal(2));
    expect(t.trend).toBe("insufficient");
  });

  it("refuses a trend with no comparison point", () => {
    expect(newsTrend(withTotal(3), null).trend).toBe("insufficient");
  });
});
