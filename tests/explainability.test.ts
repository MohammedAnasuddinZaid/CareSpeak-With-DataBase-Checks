import { describe, it, expect } from "vitest";
import { computeRisk } from "../src/lib/risk";
import { auditToCsv, type AuditEvent } from "../src/lib/auditTrail";
import { formatCitation, citationPassage } from "../src/lib/clinicalBasis";
import { GestureLogEntry } from "../src/types";

function entry(partial: Partial<GestureLogEntry> = {}): GestureLogEntry {
  return {
    id: Math.random().toString(36).slice(2),
    gesture: "HELP",
    description: "",
    confidence: 0.9,
    type: "hand",
    timestamp: Date.now(),
    language: "en-US",
    ...partial,
  };
}

describe("exact Shapley attribution (additive risk model)", () => {
  it("baseValue + Σφᵢ === score (the SHAP efficiency invariant)", () => {
    const now = Date.now();
    const r = computeRisk(
      { alertnessScore: 15, blinkRate: 2 },
      [
        entry({ gesture: "EMERGENCY", timestamp: now - 1000 }),
        entry({ gesture: "HELP", timestamp: now - 20000 }),
      ],
      now,
      { heartRate: 140, spo2: 90 }
    );
    const sumPhi = r.attribution.reduce((acc, a) => acc + a.phi, 0);
    expect(r.baseValue + sumPhi).toBeCloseTo(r.score, 5);
    expect(r.attribution.length).toBeGreaterThanOrEqual(4);
    expect(r.band).toBe("critical");
  });

  it("healthy inputs produce zero score AND zero attribution", () => {
    const r = computeRisk(
      { alertnessScore: 85, blinkRate: 15, movementActivity: 0.3 },
      [],
      Date.now(),
      { heartRate: 75, spo2: 97 }
    );
    expect(r.score).toBe(0);
    expect(r.attribution).toHaveLength(0);
  });

  it("NEWS2 vital bands drive the score even with no camera metrics", () => {
    const r = computeRisk(null, [], Date.now(), { heartRate: 135, spo2: 89 });
    expect(r.factors.some((f) => f.key === "hr")).toBe(true);
    expect(r.factors.some((f) => f.key === "spo2")).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(50);
  });

  it("every factor carries a clinical citation", () => {
    const now = Date.now();
    const r = computeRisk({ alertnessScore: 10 }, [entry({})], now);
    for (const f of r.factors) expect(f.citation).toBeDefined();
  });
});

describe("clinical citation corpus", () => {
  it("renders citations as DOCID §section with passage text", () => {
    const c = { docId: "RCP-NEWS2", section: "pulse" } as const;
    expect(formatCitation(c)).toBe("RCP-NEWS2 §pulse");
    expect(citationPassage(c)).toContain("Pulse");
  });

  it("flags a missing section instead of silently dropping the pointer", () => {
    // A broken citation that renders as a clean citation is worse than no
    // citation: it claims traceability the app does not actually have.
    expect(formatCitation({ docId: "RCP-NEWS2", section: "no-such-section" })).toContain(
      "section missing",
    );
  });

  it("every section the risk engine cites actually resolves", () => {
    for (const f of computeRisk({ alertnessScore: 10 }, [entry({})], Date.now()).factors) {
      expect(f.citation).toBeDefined();
      expect(formatCitation(f.citation!)).not.toContain("missing");
    }
  });

  it("unknown citations degrade gracefully", () => {
    expect(formatCitation({ docId: "NOPE", section: "x" })).toBe("NOPE §x (source not indexed)");
    expect(citationPassage({ docId: "NOPE", section: "x" })).toBe("");
  });
});

describe("automation audit trail", () => {
  it("CSV export is formula-injection safe and includes citation basis", () => {
    const events: AuditEvent[] = [
      {
        id: "=cmd|'/c calc'!A1",
        at: Date.now(),
        kind: "auto_escalate",
        detail: "+injected",
        sessionId: "AB12CD",
        citation: { docId: "NICE-CG50", section: "monitoring" },
      },
    ];
    const csv = auditToCsv(events);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+injected");
    expect(csv).toContain("NICE-CG50");
    expect(csv).toContain("Physiological observations");
  });

  it("kind labels are human-readable", () => {
    const csv = auditToCsv([{ id: "a", at: Date.now(), kind: "escalation_chain", detail: "d" }]);
    expect(csv).toContain("Escalation chain");
  });
});
