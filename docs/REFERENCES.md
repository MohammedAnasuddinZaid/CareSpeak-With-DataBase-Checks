# CareSpeak — References, Literature & Clinical Evidence Base

This document compiles all clinical guidelines, academic research papers, algorithmic methodologies, and web resources underpinning the CareSpeak assistive communication, triage, and monitoring architecture.

---

## 1. Clinical Guidelines & Scoring Systems

### National Early Warning Score (NEWS) 2
- **Citation:** Royal College of Physicians (RCP). *National Early Warning Score (NEWS) 2: Standardising the assessment of acute-illness severity in the NHS*. RCP, London, 2017.
- **Application in CareSpeak:** Implemented in full in `src/lib/news2.ts`. Provides the standardized physiological parameter scoring weights for respiratory rate, SpO₂ (Scale 1 & 2), systolic blood pressure, pulse, consciousness (ACVPU) and temperature, plus the +2 supplemental-oxygen weighting score. Aggregate bands are 1–4 (low), 5–6 (medium) and $\ge 7$ (high), each mapped to its published clinical response. A single parameter scoring 3 triggers review **regardless of the aggregate** (`RCP-NEWS2 §single-red`).
- **Safety properties:** a partially observed set is never reported as a low score — missing parameters are listed and the aggregate is labelled a floor, because observations that silently score zero are how track-and-trigger systems under-triage. SpO₂ Scale 2 is never inferred; it is a documented clinical decision (`RCP-NEWS2 §spo2-scale2`).
- **Extension:** `newsTrend()` reads successive aggregates as a series and flags deterioration *within* a low band (e.g. 1 → 3 over an hour), which a single snapshot cannot represent.

### Pain Assessment from Facial Action Units
- **Citation:** Prkachin, A. L. & Solomon, R. C. (2008). *Determining pain by facial expression*. Pain, 139(1–3), 249–260. — the PSPI action-unit set (AU 4, 6, 7, 9, 10, 43).
- **Citation:** Kappas, S. et al. ICU pain-expression work, identifying lips part (AU 25) and jaw drop (AU 26) as the strongest single indicators on real bedside footage, and reporting that the OpenFace FACS tool reaches only F1 0.42 in that setting.
- **Application in CareSpeak:** `src/lib/painSignals.ts`. Action units are measured as normalised FaceMesh geometry, then scored against **this patient's own learned neutral face** rather than absolute thresholds. The domain shift documented in the ICU literature is the reason: absolute thresholds misread permanently low brows, facial asymmetry and poor lighting as pain.
- **Safety properties:** output is decision support, never a pain scale. Every result carries its own caveats, including the reported lower accuracy for female and darker-skinned patients. A frame the camera cannot read returns `unassessable`, never `none`, so an unseen patient is never reported as comfortable. Closed eyes are treated as a *signal* (AU 43), not a data-quality failure. Findings are offered to the patient as a question rather than asserted to staff.

### NICE Clinical Guideline CG50
- **Citation:** National Institute for Health and Care Excellence (NICE). *Acutely ill adults in hospital: recognising and responding to deterioration*. NICE clinical guideline CG50, July 2007 (updated periodically).
- **Application in CareSpeak:** Governs monitoring frequency intervals (at least every 12 hours or increased frequency upon early-warning triggers) and mandate for immediate clinician review upon unplanned absence of patient communication (`NICE-CG50 §monitoring`, `NICE-CG50 §inactivity`).

---

## 2. Computer Vision & Assistive Communication (Gaze, Blinks & Gestures)

### MediaPipe: On-Device Perception Pipelines
- **Citation:** Lugaresi, C., Tang, J., Nash, H., McClanahan, C., Birgbauer, E., Guingamp, I., Price, M., Davies, N., Srinivasan, S., Stent, S., & Ward, D. (2019). *MediaPipe: A Framework for Building Perception Pipelines*. arXiv preprint arXiv:1906.08172; and Google AI (2020–2024) MediaPipe Tasks (FaceLandmarker & Hand Landmarker via WebAssembly).
- **Application in CareSpeak:** Powers 100% client-side, on-device tracking of 21 hand landmarks and 478 3D facial landmarks (including irises and eyelids) at ~30 FPS without uploading video streams to external cloud servers.

### Eye Aspect Ratio (EAR) & Gaze Classification
- **Citation:** Soukupová, T., & Čech, J. (2016). *Real-time eye blink detection using facial landmarks*. 21st Computer Vision Winter Workshop (CVWW).
- **Application in CareSpeak:** Used for calculating eye openness, blink detection, double-blink triggers for help requests, and left/right gaze direction mapping (`useEyeGesture.ts`, `eyeClassifier.ts`).

### Spontaneous Blink Rate & Fatigue / Neurological Assessment
- **Citation:** 
  - Stern, J. A., Boyer, D., & Schroeder, D. (1994). *The eye blink as a criterion of fatigue and cognitive state*. Human Factors, 36(2), 285–297.
  - Karson, C. N. (1983). *The eye blink, psychiatric conditions, and dopamine*. Biological Psychiatry, 18(3), 371–395.
- **Application in CareSpeak:** Curated baseline blink frequency (~10–30 blinks/min modal). Extreme deviations ($<6$ or $>40$/min abnormal; $<3$ or $>55$/min severe) are flagged as potential markers of fatigue, medication toxicity, or neurological distress (`CS-ADVISORY §blink-rate`).

---

## 3. Explainable AI & Additive Triage Risk Mathematics

### Shapley Values & Additive Model Interpretability
- **Citation:** Lundberg, S. M., & Lee, S.-I. (2017). *A Unified Approach to Interpreting Model Predictions*. Advances in Neural Information Processing Systems (NeurIPS 2017), 30.
- **Application in CareSpeak:** CareSpeak's triage risk score uses an additive attribution model satisfying exact Shapley value properties ($\sum \phi_i = \text{Score}_{\text{total}} - \text{Baseline}$). Every point of risk is explicitly attributed to a named clinical or behavioral factor with zero black-box approximation, rendered as a diverging contribution bar chart with direct citations (`RiskAttribution.tsx`, `risk.ts`).

---

## 4. Time-Series Forecasting & Trajectory Modeling

### Damped Trend Exponential Smoothing (Holt-Winters)
- **Citation:** 
  - Holt, C. C. (1957). *Forecasting trends and seasonals by exponentially weighted moving averages*. Office of Naval Research Memorandum No. 52.
  - Gardner, E. S., & McKenzie, E. L. (1985). *Forecasting trends in time series*. Management Science, 31(10), 1237–1246.
- **Application in CareSpeak:** Implements damped-trend exponential smoothing (`forecast.ts`) over historical risk scores and vital sign streams to project patient deterioration trajectories and predict early warning triggers before acute clinical decompensation occurs.

---

## 5. Offline-First Architecture & Cyber-Physical IoT Systems

### Offline-First Progressive Web Applications (PWA)
- **Citation:** W3C Candidate Recommendation / Working Drafts for Service Workers, Web App Manifest, Background Sync API, and IndexedDB Storage Standards.
- **Application in CareSpeak:** Ensures zero-data-loss operation in low-connectivity rural wards. Offline events queue in IndexedDB outbox tables and automatically flush via idempotent Server-Sent Events (SSE) and fetch sync pipelines upon reconnection.

### Low-Cost IoT Wearable Telemetry (ESP32 & MAX30102)
- **Citation:** Open hardware reference design using Espressif ESP32 Wi-Fi/BLE Microcontrollers and Maxim Integrated MAX30102 pulse oximetry sensors for continuous photoplethysmography (PPG) heart rate and SpO₂ monitoring at an estimated BOM cost under ₹1,100 per bed (`HARDWARE.md`, `firmware/carespeak_esp32.ino`).
