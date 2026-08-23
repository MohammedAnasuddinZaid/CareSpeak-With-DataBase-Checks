# CareSpeak Hardware / IoT Integration Guide

CareSpeak is a **cyber-physical system**: browser-based AI on the patient device + a
low-cost ESP32 wearable that streams vitals and physical SOS calls into the same
clinician console. Total hardware cost per bed: **≈ ₹1,100**.

---

## Architecture

```
┌──────────────────────────┐        Wi-Fi (HTTP/JSON)         ┌─────────────────────┐
│  PATIENT DEVICE          │                                  │  CARESPEAK BACKEND  │
│  Laptop / tablet webcam  │── gesture events ──────────────▶ │  /api/sync (REST)   │
│  MediaPipe on-device AI  │                                  │  /api/stream (SSE)  │
│  TTS voice output        │                                  │  /api/ingest (IoT)  │
└──────────────────────────┘                                  └──────────┬──────────┘
                                                              │ SSE push   ▲ POST vitals/SOS
┌──────────────────────────┐                                  ▼            │
│  NURSE CONSOLE           │◀══ live alerts, risk scores ═════╝   ┌────────┴──────────┐
│  Dashboard + replies     │                                      │  ESP32 WEARABLE    │
│  Voice/text messaging    │                                      │  MAX30102 HR/SpO2  │
└──────────────────────────┘                                      │  SOS btn + buzzer  │
                                                                  └───────────────────┘
```

**Why HTTP instead of MQTT?** Zero extra broker infrastructure — the wearable talks
straight to the deployed app with plain JSON. The `/api/ingest` endpoint is a drop-in
MQTT replacement for demo scale; an EMQX/Mosquitto bridge can be added later without
touching the dashboard (the bridge would simply POST to the same endpoint).

---

## Bill of Materials (per bed)

| Component | Purpose | Est. price (₹) |
|---|---|---|
| ESP32 DevKit V1 | MCU with Wi-Fi | 350 |
| MAX30102 pulse/SpO₂ module | Heart rate + oxygen | 150 |
| Push button (SOS) | Physical emergency call | 10 |
| Active buzzer | Local alarm feedback | 30 |
| SSD1306 0.96" OLED *(optional)* | Shows session ID + HR | 200 |
| 18650 cell + TP4056 | Portable power | 180 |
| Strap + enclosure + wires | Wearable assembly | 180 |
| **Total** | | **≈ ₹1,100** |

## Wiring

| MAX30102 | ESP32 | Notes |
|---|---|---|
| VIN | 3V3 | |
| GND | GND | common ground with buzzer |
| SDA | GPIO 21 | default I2C |
| SCL | GPIO 22 | default I2C |

| Other | ESP32 | Notes |
|---|---|---|
| SOS button | GPIO 27 → GND | `INPUT_PULLUP`, debounce in firmware |
| Buzzer (+) | GPIO 25 | active buzzer; passive works too (tone) |

## Firmware

`firmware/carespeak_esp32.ino` — Arduino IDE / PlatformIO:

1. Install **SparkFun MAX3010x** library (Library Manager).
2. Edit the config block: WiFi SSID/password, `SERVER_URL`, `SESSION_ID`
   (must match the session shown on the patient's screen).
3. Flash at 115200 baud. Open Serial Monitor to watch posts.

### Security
Set `CARESPEAK_DEVICE_TOKEN` in your backend environment (`.env.local` or Vercel env)
and put the same token in `DEVICE_TOKEN` in the firmware. Requests without the
matching `x-device-token` header are rejected with 401. Unset = open demo mode so
judges can flash-and-test instantly.

---

## Rural / no-WiFi variant (roadmap)

| Link | Hardware | How it maps to this codebase |
|---|---|---|
| **LoRa** (433/868 MHz) | SX1278 module ₹250 ×2 (node + gateway) | Node sends compact SOS/vitals packet; Raspberry Pi gateway POSTs to `/api/ingest`. Firmware change only — backend untouched. |
| **GSM/GPRS** | SIM800L ₹220 | Replace HTTPClient transport with AT-command TCP to the same URL. Ideal for ambulance use-cases. |
| **Bluetooth LE** | Built into ESP32 | Phone in ward acts as bridge (Web Bluetooth or companion app posting to `/api/ingest`). |

The offline-first outbox on the dashboard already handles intermittent backhaul:
alerts queue in IndexedDB and flush automatically when connectivity returns.

## Demo script for judges (90 seconds)

1. Patient laptop opens Hand Mode → QR pairing shown.
2. Scan QR with phone → nurse console goes "Live · SSE" green.
3. Make thumbs-up → patient laptop speaks "Yes", nurse console flashes alert.
4. Press the **physical SOS button** on the ESP32 → buzzer beeps locally,
   EMERGENCY appears on nurse console marked *wearable*, vitals card shows live BPM.
5. Nurse taps quick-reply "On my way" → full-screen banner + speech on patient laptop.
6. Turn off WiFi on the patient device → make gestures → reconnect → alerts flush
   automatically (offline-first proof).
7. Open `/report` → print-ready clinical shift summary.
