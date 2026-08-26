# CareSpeak — Giving Every Patient a Voice

**Assistive communication for patients who cannot speak or move easily.**
On-device computer vision turns any laptop webcam into a voice: hand gestures and
eye movements become spoken words, streamed instantly to a clinician dashboard —
with two-way messaging, live wellness analytics, automatic escalation, offline-first
syncing for low-connectivity wards, and a ₹1,100 IoT wearable for vitals & SOS.

> Built for **Smart India Hackathon 2026** · PWA · 100% on-device AI · 10 Indian languages

---

## What makes it different

| Dimension | Typical prototype | CareSpeak |
|---|---|---|
| Gesture AI | Cloud API (video uploaded) | **MediaPipe WASM fully on-device** — video never leaves the browser |
| Real-time sync | 1s polling | **Server-Sent Events push** with adaptive-poll fallback |
| Connectivity assumption | Always online | **Offline-first**: IndexedDB outbox + Background Sync auto-flush |
| Escalation | Manual only | **Rule engine auto-escalates** (HELP frequency / low alertness / inactivity) with audit log |
| Communication | One-way alerts | **Two-way**: nurse types or *speaks* a reply; patient sees full-screen banner + hears it |
| Languages | English only | **10 Indian languages** incl. Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi |
| Explainability | "AI says so" | **Exact Shapley attribution** — the triage score is additive, so every point is attributed to a named factor (φᵢ = componentᵢ − componentᵢbaseline, zero approximation) and rendered as a signed contribution chart |
| Clinical grounding | None | Every risk factor & escalation cites a **curated clinical reference corpus** (NEWS 2, NICE CG50) as `DOCID §section`, printed in the shift report |
| Hardware | None | **ESP32 wearable**: HR/SpO₂ vitals + physical SOS button wired into the same console |
| Clinical output | Nothing | **Auto-generated printable shift report** (`/report`) + CSV/JSON export |
| Ward scale | Single patient | **Ward view** (`/ward`), siren + system notifications, 60s no-ack escalation chain, gaze-driven pain scale, and a damped-Holt **deterioration trajectory** forecast |
| Pairing | Generic QR | **Unique per-bed QR**: every session bakes a cryptographic pairing token into its code, tracks each scanning device (IP + device + time) live on the patient screen and per-bed on the ward board, and can regenerate to invalidate old links |

## How the AI works (all client-side)

1. **Camera detects** — MediaPipe Hands tracks 21 landmarks/hand; FaceLandmarker
   tracks 478 face points including irises, via WebAssembly at ~30 FPS.
2. **Engine classifies** — transparent, explainable rule classifiers
   (finger-extension ratios, eye-aspect-ratio, iris offset) with temporal smoothing:
   majority vote over sliding windows + hold-time confidence ramping.
3. **System speaks** — Web Speech Synthesis announces the need in the chosen language;
   every event is logged, scored (risk engine) and pushed to clinicians.

Gestures:

| Hand | Meaning | Eye | Meaning |
|---|---|---|---|
| Thumbs up | YES | Look left | YES |
| Thumbs down | NO | Look right | NO |
| Index+pinky extended | HELP | Double blink | HELP |
| Both palms open (or one palm held 2s) | WATER | Open mouth | WATER |
| Hold open palm 5s | PAUSE clutch | Close eyes 5s | PAUSE clutch |

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Open `/hand-mode` in Chrome → allow camera → make gestures.
Scan the on-screen QR from a phone to open the nurse dashboard.

Optional production hardening (`​.env.local`):

```
UPSTASH_REDIS_REST_URL=...      # cross-instance storage on serverless
UPSTASH_REDIS_REST_TOKEN=...
CARESPEAK_DEVICE_TOKEN=my-secret  # must match firmware DEVICE_TOKEN
```

Without env vars everything still works locally (in-memory store, open IoT endpoint).

```bash
npm test           # unit tests: classifiers, escalation & risk engines
npm run build      # production build
```

## Screens

| Route | Purpose |
|---|---|
| `/` | Product landing page |
| `/hand-mode` | Patient gesture console — hand tracking + TTS |
| `/eye-mode` | Patient gesture console — gaze/blink/mouth tracking |
| `/nurse-view` | Clinician console: live alerts, risk ring, charts, replies, escalation log, IoT vitals |
| `/ward` | **Multi-patient ward overview** — every active session as a risk-banded tile on one screen |
| `/cctv` | Point any IP/phone camera at the patient for remote detection |
| `/logs` | History, analytics dashboard, CSV/JSON export |
| `/report` | Print-ready clinical shift summary (Ctrl+P → PDF) |
| `/emergency` | One-tap emergency that pages every paired console |

## Architecture

See `docs/HARDWARE.md` for the cyber-physical diagram, ESP32 wiring table,
BOM, LoRa/GSM rural variants and the 90-second judge demo script.
See `docs/REFERENCES.md` for the complete bibliography of clinical guidelines (NEWS2, NICE CG50), computer vision papers (MediaPipe, EAR), Shapley attribution math, and forecasting literature.

```
Patient browser ──gesture events──▶ /api/sync ◀──ESP32 wearable── vitals/SOS
        │  MediaPipe WASM                │
        │  (video stays local)           ├── Upstash Redis driver (optional prod)
        ▼                                ▼
Web Speech TTS                    /api/stream (SSE push)
                                         │
                              Nurse console (live alerts,
                              risk score, replies, report)
```

## Engineering quality

- **TypeScript strict** across the codebase; validated API payloads (server-side sanitizers, clinical-range clamps, NaN rejection).
- **Unit tests** for the hand classifier, eye smoother, escalation rules, risk engine + Shapley invariant, store concurrency guarantees and forecast maths (`npm test`).
- **Explainable triage**: additive risk model ⇒ exact closed-form Shapley values (test-asserted `Σφᵢ === score`); "Why this score?" diverging-bar chart with per-factor clinical citations.
- **Clinical audit trail**: every automated decision (auto-escalation, escalation chain, trajectory alerts) persisted, replayed in the printable shift report and exportable to formula-safe CSV.
- **Exactly-once delivery**: SSE `Last-Event-ID` resume + per-connection dedupe, monotonic server-time cursors (same-ms bursts can't be skipped), lifecycle-preserving idempotent writes — a duplicate POST can never erase a nurse's acknowledgement.
- **Security**: CSP + hardened headers, session-scoped data isolation, crypto-random session IDs and per-bed pairing tokens, scan-log access requires the QR's token, optional shared-token device auth, formula-injection-safe CSV export.
- **Accessibility**: aria-live gesture announcements, labeled controls, keyboard-friendly nav.
- **Resilience**: error boundary around the app, SW keeps AI models offline-capable, outbox guarantees delivery across reconnects, ESP32 firmware retries undelivered SOS events until the server confirms.
- **Efficiency**: ~30 FPS inference cap (halves CPU/battery vs naive 60 FPS), hidden-tab inference + polling suspension, adaptive SSE cadence that actually decays when idle, idle-time model prefetch so "Start Camera" is instant.

## License

MIT — see `LICENSE`.
