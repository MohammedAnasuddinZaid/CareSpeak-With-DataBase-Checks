/**
 * Curated clinical reference corpus — CareSpeak's answer to "why should a
 * nurse trust these numbers?"
 *
 * Every risk factor, trajectory threshold and escalation reason carries a
 * citation into this corpus (`id §section`), the same pattern regulators
 * expect from clinical decision-support tools. Like any decision-support
 * system, these are CURATED SUMMARIES of published guidance thresholds, not
 * verbatim legislation/guideline text — swap in a licensed guideline service
 * for production.
 */

export interface ClinicalReference {
  /** stable citation id, e.g. "RCP-NEWS2" */
  docId: string;
  title: string;
  publisher: string;
  year: number;
  sections: Record<string, string>;
}

export const CLINICAL_CORPUS: ClinicalReference[] = [
  {
    docId: "RCP-NEWS2",
    title: "National Early Warning Score (NEWS) 2",
    publisher: "Royal College of Physicians",
    year: 2017,
    sections: {
      "hr": "Heart rate parameter: ≤40 or >130 bpm aggregates the maximum score; 41–50 / 91–110 / 111–130 score 1–2. Sustained deviation from the patient's baseline warrants clinical review.",
      "spo2-scale1": "SpO₂ (Scale 1) parameter: ≤91% scores 3; 92–93% scores 2; 94–95% scores 1. Hypoxaemia is one of the strongest deterioration signals.",
      "response": "Escalation threshold: aggregate score ≥5 (NEW SCORE 2+) is 'emergent' — urgent review and continuous monitoring; 3–4 prompts clinician review.",
    },
  },
  {
    docId: "CS-ADVISORY",
    title: "CareSpeak clinical advisory parameters",
    publisher: "CareSpeak monitoring engine",
    year: 2026,
    sections: {
      "blink-rate": "Spontaneous blink rate outside ~10–30/min is associated with fatigue, medication effects and neurological impairment (literature range ≈ 12–20/min modal). CareSpeak flags <6 or >40/min as abnormal, <3 or >55/min as severe.",
      "alertness": "Eye-based alertness surrogate: sustained eyelid-opening reduction correlates with drowsiness (Karolinska EPWORTH-style observation scales). Alertness index <25% sustained ≥30s triggers review.",
      "movement": "Prolonged motor stillness in a bed-bound patient can precede decompensation; agitation may indicate pain/distress/hypoxia. Both extremes are scored.",
      "help-frequency": "Repeated assistance calls within a short window are a validated proxy for unmet care needs; ≥3 calls/10 min indicates escalating distress even when vitals look stable.",
    },
  },
  {
    docId: "NICE-CG50",
    title: "Acutely ill adults in hospital: recognising and responding to deterioration",
    publisher: "NICE clinical guideline CG50",
    year: 2007,
    sections: {
      "monitoring": "Physiological observations should be monitored at least every 12 hours unless indicated more frequently; patients triggering an early-warning threshold require increased monitoring frequency and documented escalation.",
      "inactivity": "Unplanned absence of expected observations/communication from a monitored patient must prompt immediate review rather than assumption of stability.",
    },
  },
];

const CORPUS_INDEX = new Map<string, ClinicalReference>(
  CLINICAL_CORPUS.map((d) => [d.docId, d])
);

/** A citation rendered as `DOCID §section`. */
export interface Citation {
  docId: string;
  section: string;
}

/** Human-readable citation line, e.g. `RCP-NEWS2 §hr — National Early Warning Score (NEWS) 2`. */
export function formatCitation(c: Citation): string {
  const doc = CORPUS_INDEX.get(c.docId);
  if (!doc) return `${c.docId} §${c.section}`;
  const text = doc.sections[c.section] ?? "";
  return text ? `${doc.docId} §${c.section}` : `${doc.title}`;
}

/** Full passage text for tooltips / report appendix. */
export function citationPassage(c: Citation): string {
  const doc = CORPUS_INDEX.get(c.docId);
  if (!doc) return "";
  return `${doc.title} (${doc.publisher}, ${doc.year}) §${c.section}: ${doc.sections[c.section] ?? ""}`;
}
