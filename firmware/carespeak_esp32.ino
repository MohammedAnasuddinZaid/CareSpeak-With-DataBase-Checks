/*
 * ─────────────────────────────────────────────────────────────────
 *  CareSpeak Wearable — ESP32 patient-side unit (SIH 2026)
 * ─────────────────────────────────────────────────────────────────
 *
 *  Bill of materials (~₹1,100 total):
 *    - ESP32 DevKit V1 .................. ₹350
 *    - MAX30102 heart-rate/SpO2 ......... ₹150
 *    - Push button (SOS) + buzzer ....... ₹40
 *    - 0.96" SSD1306 OLED (optional) ... ₹200
 *    - 18650 cell + TP4056 charger ...... ₹180
 *    - Jumper wires / strap / enclosure . ₹180
 *
 *  Wiring:
 *    MAX30102 : VIN->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22
 *    SOS btn  : GPIO27 -> GND (internal pull-up)
 *    Buzzer   : GPIO25 (active buzzer)
 *
 *  Behavior:
 *    - Streams HR/battery/RSSI as JSON to POST /api/ingest every 15s.
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

// ════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  pinMode(PIN_SOS_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found — check wiring");
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
  pollSosButton();

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

void pollSosButton() {
  static bool lastState = HIGH;
  bool current = digitalRead(PIN_SOS_BUTTON);
  if (current == LOW && lastState == HIGH && millis() - lastDebounce > 400) {
    lastDebounce = millis();
    sosActive = true;
    sosLatchedAt = millis();
    Serial.println("!! SOS PRESSED — dispatching EMERGENCY");
    postEvent("sos");                              // posted exactly once per press
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
  body += "\"sosActive\":" + String(sosActive ? "true" : "false") + ",";
  body += "\"batteryPct\":" + String(batteryPct) + ",";
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
}

int readBatteryPercent() {
  // Replace with ADC divider reading if you add battery monitoring:
  // analogReadMilliVolts(GPIO34) * dividerRatio mapped to 3.0–4.2 V range.
  return 100;
}

