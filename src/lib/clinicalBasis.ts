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
      "resp-rate": "Respiratory rate: ≤8 or ≥25 scores 3; 21–24 scores 2; 9–11 scores 1; 12–20 scores 0. A raised rate signals acute illness, pain, sepsis or metabolic disturbance; a low rate suggests CNS depression.",
      "spo2-scale1": "SpO₂ Scale 1 (default): ≤91% scores 3; 92–93% scores 2; 94–95% scores 1; ≥96% scores 0. Hypoxaemia is one of the strongest deterioration signals.",
      "spo2-scale2": "SpO₂ Scale 2, for confirmed hypercapnic respiratory failure with a prescribed target of 88–92% (usually COPD). On air: 88–92% or ≥93% scores 0, below target scores 1–3. On oxygen: 93–94% scores 1, 95–96% scores 2, ≥97% scores 3. The decision to use Scale 2 is made by a competent clinical decision maker and must be documented — it is never inferred.",
      "systolic-bp": "Systolic blood pressure: ≤90 or ≥220 scores 3; 91–100 scores 2; 101–110 scores 1; 111–219 scores 0.",
      "pulse": "Pulse: ≤40 or ≥131 bpm scores 3; 41–50 and 91–110 score 1; 111–130 scores 2; 51–90 scores 0. Sustained deviation from the patient's own baseline warrants review even when the absolute value scores 0.",
      "consciousness": "Consciousness (ACVPU): Alert scores 0. New confusion, response to voice, response to pressure, or unresponsive all score 3. NEWS2 scores new confusion as 3 because new disorientation or delirium is a marker of acute deterioration, and should prompt a 4AT assessment.",
      "temperature": "Temperature: ≤35.0 °C scores 3; 35.1–36.0 °C scores 1; 36.1–38.0 °C scores 0; 38.1–39.0 °C scores 1; ≥39.1 °C scores 2. Both pyrexia and hypothermia are included: the extremes are sensitive markers of sepsis and physiological disturbance.",
      "oxygen-uplift": "A weighting score of 2 is added for any patient requiring supplemental oxygen (mask or nasal cannula) to maintain their prescribed saturation range. The device, delivery method and rate in L/min should be documented alongside the score.",
      "thresholds": "Aggregate score determines the clinical response: 1–4 is low risk (ward nurse assessment); 5–6 is medium risk (urgent ward-based review); ≥7 is high risk (emergency assessment by the critical care team). An aggregate of 0 needs no more than routine 12-hourly observation.",
      "single-red": "A single parameter scoring 3 — a 'red' score on the NEWS2 chart — is unusual in isolation and warrants urgent clinician review *regardless of the aggregate*. A patient can score 3 overall with one red parameter and still require escalation.",
      "response": "The triggers and thresholds must not be altered. Any deviation from the standard escalation response must be clearly communicated in the clinical record and documented in the nursing notes.",
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

/**
 * Human-readable citation line, e.g. `RCP-NEWS2 §pulse — National Early Warning Score (NEWS) 2`.
 *
 * An unknown section is surfaced rather than quietly smoothed into the bare
 * document title. A citation that silently degrades still looks like a
 * citation on screen, so a broken pointer would go unnoticed while claiming a
 * traceability this app is supposed to provide.
 */
export function formatCitation(c: Citation): string {
  const doc = CORPUS_INDEX.get(c.docId);
  if (!doc) return `${c.docId} §${c.section} (source not indexed)`;
  const text = doc.sections[c.section];
  if (text) return `${doc.docId} §${c.section}`;
  return `${doc.docId} §${c.section} (section missing)`;
}

/** Full passage text for tooltips / report appendix. */
export function citationPassage(c: Citation): string {
  const doc = CORPUS_INDEX.get(c.docId);
  if (!doc) return "";
  return `${doc.title} (${doc.publisher}, ${doc.year}) §${c.section}: ${doc.sections[c.section] ?? ""}`;
}
