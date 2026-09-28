/*
 * ─────────────────────────────────────────────────────────────────
 *  CareSpeak Wearable — ESP32 patient-side unit (SIH 2026)
 * ─────────────────────────────────────────────────────────────────
 *
 *  Bill of materials (~₹1,100 total):
 *    - ESP32 DevKit V1 .................. ₹350
 *    - MAX30105 heart-rate/SpO2 sensor ... ₹150
 *    - Push button (SOS) + buzzer ....... ₹40
 *    - 0.96" SSD1306 OLED (optional) ... ₹200
 *    - 18650 cell + TP4056 charger ...... ₹180
 *    - Jumper wires / strap / enclosure . ₹180
 *
 *  Wiring:
 *    MAX30105 : VIN->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22
 *    SOS btn  : GPIO27 -> GND (internal pull-up)
 *    Buzzer   : GPIO25 (active buzzer)
 *
 *  Behavior:
 *    - Streams HR/SpO2/battery/RSSI as JSON to POST /api/ingest every 15s.
 *    - SOS press -> immediate EMERGENCY fan-out on every nurse dashboard,
 *      plus a local buzzer alarm until acknowledged.
 *    - For no-WiFi wards see docs/HARDWARE.md (LoRa / GSM variants).
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include "MAX30105.h"      // SparkFun MAX3010x library
#include "heartRate.h"

// ── Configuration ────────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Your CareSpeak deployment, e.g. http://192.168.1.5:3000 or https://carespeak.vercel.app
const char* SERVER_URL   = "http://192.168.1.5:3000/api/ingest";
const char* SESSION_ID   = "ABC123";            // session shown on the patient screen
const char* DEVICE_ID    = "esp32_ward4_bed12";
const char* DEVICE_TOKEN = "";                  // must match CARESPEAK_DEVICE_TOKEN env ("" = demo mode)

#define PIN_SOS_BUTTON 27                       // wired to GND, uses internal pull-up
#define PIN_BUZZER     25

// ── State ────────────────────────────────────────────────────────
MAX30105 particleSensor;

const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;

unsigned long lastPost = 0;
const unsigned long POST_INTERVAL_MS = 15000;

unsigned long lastDebounce = 0;
bool sosActive = false;
unsigned long sosLatchedAt = 0;   // one-shot SOS: posted once, latched for vitals flag
bool sosPending = false;          // SOS dispatch not yet confirmed by the server
unsigned long lastSosRetry = 0;
const unsigned long SOS_RETRY_MS = 4000;   // retry backoff for undelivered emergencies

// ── Optional SpO2 estimate ────────────────────────────────────────
// The MAX30105 drives a red and an IR LED. Oxygenation changes how much red
// light is absorbed relative to IR, so the ratio of the two gives an estimate
// of SpO2 using the datasheet's fit:
//
//     R       = (AC_red / DC_red) / (AC_ir / DC_ir)
//     SpO2    = 45.06 * R^2 - 30.354 * R + 94.845
//
// DC is the slow average (what the tissue absorbs overall); AC is the
// pulsatile swing on top of it (what the heartbeat modulates).
//
// This is an ESTIMATE, not a measurement. Real accuracy depends on the sensor
// batch, finger placement, ambient light and skin tone, and no consumer-grade
// MAX30105 should be read as a diagnostic oximeter. It is therefore OFF by
// default: a plausible-but-wrong SpO2 sitting in a nurse's dashboard can mask
// hypoxia, which is a worse failure than a metric that is simply absent.
// Set to true only after checking it against a reference oximeter on real
// fingers, and only publish readings that pass the stability gate below.
const bool ENABLE_SPO2_ESTIMATE = false;

const int SPO2_WINDOW      = 64;    // samples used to extract AC (peak-to-trough)
const int SPO2_HISTORY     = 5;     // median filter length on finished readings
const int SPO2_WARMUP_SAMPLES = 32; // ignore this many samples while DC settles

float irDc = 0, redDc = 0;
float irWin[SPO2_WINDOW], redWin[SPO2_WINDOW];
float irMin = 0, irMax = 0, redMin = 0, redMax = 0;
int  spo2Idx = 0, spo2Count = 0, spo2Total = 0;
float spo2Hist[SPO2_HISTORY];
int  spo2HistCount = 0;
float spo2Published = 0;

// ════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  pinMode(PIN_SOS_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30105 not found — check wiring");
  } else {
    particleSensor.setup();
    particleSensor.setPulseAmplitudeRed(0x0A);
  }

  wifiConnect();
}

void loop() {
  if (sosActive && millis() - sosLatchedAt > 60000UL) {
    sosActive = false;                             // auto-clear latch after 60s
    digitalWrite(PIN_BUZZER, LOW);
  }

  readHeartRate();
  updateSpO2();
  pollSosButton();

  // A lost EMERGENCY is unacceptable: if the SOS POST failed (Wi-Fi blip,
  // server restart), retry with backoff until the server confirms delivery.
  if (sosPending && millis() - lastSosRetry >= SOS_RETRY_MS) {
    Serial.println("!! SOS undelivered — retrying dispatch");
    postEvent("sos");
  }

  if (millis() - lastPost >= POST_INTERVAL_MS) {
    lastPost = millis();
    postVitals();                                  // vitals always flow; SOS state rides along as a flag
  }

  if (sosActive && millis() - sosLatchedAt < 30000UL) {
    alarmPattern();                                // beep for max 30s, never re-posts the SOS event
  }
}
// ════════════════════════════════════════════════════════════════
void wifiConnect() {
  Serial.printf("Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED
      ? "\nWiFi connected: " + WiFi.localIP().toString()
      : "\nWiFi FAILED — will retry on next post");
}

void ensureWifi() {
  if (WiFi.status() != WL_CONNECTED) wifiConnect();
}

void readHeartRate() {
  long irValue = particleSensor.getIR();
  if (!checkForBeat(irValue)) return;

  long delta = millis() - lastBeat;
  lastBeat = millis();
  beatsPerMinute = 60 / (delta / 1000.0);

  if (beatsPerMinute > 20 && beatsPerMinute < 255) {
    rates[rateSpot++] = (byte)beatsPerMinute;
    rateSpot %= RATE_SIZE;
    beatAvg = 0;
    for (byte x = 0; x < RATE_SIZE; x++) beatAvg += rates[x];
    beatAvg /= RATE_SIZE;
  }
  if (irValue < 50000) { beatsPerMinute = 0; beatAvg = 0; } // finger removed
}

// Fold one IR/red sample into the SpO2 estimator and update the published
// value. Cheap enough to run every loop pass; the window logic does the
// filtering rather than the sample rate.
void updateSpO2() {
  if (!ENABLE_SPO2_ESTIMATE) return;

  float ir = (float)particleSensor.getIR();
  float red = (float)particleSensor.getRed();
  if (ir < 50000 || red < 50000) {          // no finger / ambient light floor
    spo2Count = 0; spo2Idx = 0; spo2HistCount = 0;
    spo2Published = 0;
    return;
  }

  // DC: slow exponential average. α is small so a single spike cannot move it.
  if (spo2Total == 0) { irDc = ir; redDc = red; }
  else { irDc += (ir - irDc) * 0.02f; redDc += (red - redDc) * 0.02f; }
  spo2Total++;

  // AC: peak-to-trough of the detrended signal over the window.
  if (spo2Count == 0) { irMin = irMax = ir; redMin = redMax = red; }
  else {
    if (ir < irMin) irMin = ir;
    if (ir > irMax) irMax = ir;
    if (red < redMin) redMin = red;
    if (red > redMax) redMax = red;
  }
  irWin[spo2Idx] = ir;
  redWin[spo2Idx] = red;
  spo2Idx = (spo2Idx + 1) % SPO2_WINDOW;
  if (spo2Count < SPO2_WINDOW) spo2Count++;

  if (spo2Total < SPO2_WARMUP_SAMPLES || spo2Count < SPO2_WINDOW) return;

  float acIr  = irMax  - irMin;
  float acRed = redMax - redMin;
  if (acIr <= 0 || acRed <= 0) return;

  float r = (acRed / redDc) / (acIr / irDc);
  float spo2 = 45.06f * r * r - 30.354f * r + 94.845f;
  if (spo2 < 50 || spo2 > 100) return;      // implausible: sensor not on a finger

  // Median of the last few readings. A raw optical estimate is jumpy enough
  // that a single frame could swing the dashboard by 10%.
  spo2Hist[spo2HistCount < SPO2_HISTORY ? spo2HistCount++ : SPO2_HISTORY - 1] = spo2;
  if (spo2HistCount < SPO2_HISTORY) return;

  float sorted[SPO2_HISTORY];
  for (int i = 0; i < SPO2_HISTORY; i++) sorted[i] = spo2Hist[i];
  for (int i = 1; i < SPO2_HISTORY; i++) {
    float key = sorted[i];
    int j = i - 1;
    while (j >= 0 && sorted[j] > key) { sorted[j + 1] = sorted[j]; j--; }
    sorted[j + 1] = key;
  }
  float med = sorted[SPO2_HISTORY / 2];
  float spread = sorted[SPO2_HISTORY - 1] - sorted[0];

  // Stability gate: only publish once the reading has settled. An unstable
  // window means motion or a poor contact, and a moving estimate is not a
  // measurement.
  if (spread > 4.0f) return;
  spo2Published = med;
}

void pollSosButton() {
  static bool lastState = HIGH;
  bool current = digitalRead(PIN_SOS_BUTTON);
  if (current == LOW && lastState == HIGH && millis() - lastDebounce > 400) {
    lastDebounce = millis();
    sosActive = true;
    sosLatchedAt = millis();
    Serial.println("!! SOS PRESSED — dispatching EMERGENCY");
    postEvent("sos");                              // posted once per press; retried if unconfirmed
    lastPost = millis();
  }
  lastState = current;
}

void alarmPattern() {
  static unsigned long t = 0;
  if (millis() - t > 600) {
    t = millis();
    digitalWrite(PIN_BUZZER, !digitalRead(PIN_BUZZER));
  }
}

void postVitals() {
  ensureWifi();
  HTTPClient http;
  http.begin(SERVER_URL);
  http.setTimeout(5000);
  if (String(DEVICE_TOKEN).length() > 0) http.addHeader("x-device-token", DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");

  int batteryPct = readBatteryPercent();
  String body = "{";
  body += "\"session\":\"" + String(SESSION_ID) + "\",";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"type\":\"vitals\",";
  if (beatAvg > 0) body += "\"heartRate\":" + String(beatAvg) + ",";
  // Only sent when the estimator produced a stable, in-range reading; an
  // unstable or absent value is omitted rather than guessed.
  if (spo2Published > 0) body += "\"spo2\":" + String((int)(spo2Published + 0.5f)) + ",";
  body += "\"sosActive\":" + String(sosActive ? "true" : "false") + ",";
  if (batteryPct >= 0) body += "\"batteryPct\":" + String(batteryPct) + ",";
  body += "\"rssi\":" + String(WiFi.RSSI());
  body += "}";

  int code = http.POST(body);
  Serial.printf("POST vitals -> %d (%s)\n", code, body.c_str());
  http.end();
}

void postEvent(const char* type) {
  ensureWifi();
  HTTPClient http;
  http.begin(SERVER_URL);
  http.setTimeout(5000);
  if (String(DEVICE_TOKEN).length() > 0) http.addHeader("x-device-token", DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"session\":\"" + String(SESSION_ID) + "\",";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"type\":\"" + String(type) + "\"}";

  int code = http.POST(body);
  Serial.printf("POST %s -> %d\n", type, code);
  http.end();

  // Delivery tracking: only an HTTP 2xx counts as delivered. Anything else
  // arms the retry loop in loop() so the emergency is never silently lost.
  if (String(type) == "sos") {
    bool ok = code >= 200 && code < 300;
    sosPending = !ok;
    lastSosRetry = millis();
    if (!ok) Serial.println("!! SOS dispatch FAILED — will retry");
  }
}

int readBatteryPercent() {
  // Wire an ADC divider to GPIO34 and map 3.0-4.2 V -> 0-100% here.
  // Returning -1 means "no sensor" — postVitals() omits the field so the
  // dashboard shows "unknown" instead of a false full battery.
  return -1;}

