export type Handedness = "Left" | "Right";

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface HandData {
  landmarks: Point[];
  handedness: Handedness;
  worldLandmarks?: Point[];
}

export type GestureName = "YES" | "NO" | "HELP" | "WATER" | "HELLO" | "EMERGENCY" | "SYSTEM";

export type HandGesture = "YES" | "NO" | "HELP" | "WATER" | null;

export type EyeGesture = "YES" | "NO" | "HELP" | "WATER" | null;

export type GestureType = "hand" | "eye" | "system";

export type AlertSource = "camera" | "demo" | "iot" | "manual";

export interface GestureResult<T> {
  gesture: T;
  confidence: number;
  timestamp: number;
}

export interface PatientMetrics {
  blinkRate?: number;
  alertnessScore?: number;
  eyeClosureDuration?: number;
  movementActivity?: number;
  lastSeen?: string;
}

/** Vitals streamed from an ESP32 / wearable via POST /api/ingest */
export interface DeviceVitals {
  deviceId: string;
  heartRate?: number;
  spo2?: number;
  temperature?: number;
  sosActive?: boolean;
  batteryPct?: number;
  rssi?: number;
  receivedAt: number;
}

/** Nurse -> patient message rendered as a full-screen banner + spoken aloud */
export interface NurseReply {
  id: string;
  text: string;
  lang: string;
  from: string;
  timestamp: number;
}

export type EntryStatus = "none" | "acknowledge" | "escalate" | "resolve";

export interface GestureLogEntry {
  id: string;
  gesture: string;
  description: string;
  confidence: number;
  type: GestureType;
  timestamp: number;
  /** authoritative receive time assigned by the server (ms epoch) */
  serverTime?: number;
  language: string;
  source?: AlertSource;
  acknowledged?: boolean;
  acknowledgedAt?: number;
  escalated?: boolean;
  escalatedBy?: "staff" | "system";
  escalatedRule?: string;
  escalatedAt?: number;
  resolved?: boolean;
  resolvedAt?: number;
  patientMetrics?: PatientMetrics;
  sessionId?: string;
}

export interface AlertAction {
  type: "acknowledge" | "escalate" | "resolve";
  entryId: string;
  timestamp: number;
  actor?: string;
  bySystem?: boolean;
}

export type SyncMessage =
  | { kind: "new_gesture"; entry: GestureLogEntry; sessionId?: string }
  | { kind: "action"; action: AlertAction; sessionId?: string }
  | { kind: "reply"; reply: NurseReply; sessionId?: string }
  | { kind: "clear"; sessionId?: string };

export interface SessionInfo {
  sessionId: string;
  deviceId: string;
  createdAt: number;
  label?: string;
}

export interface SystemDiagnostics {
  brightness: number;
  trackingStable: boolean;
  fps: number;
  message: string | null;
}

export interface TTSConfig {
  enabled: boolean;
  rate: number;
  pitch: number;
  volume: number;
  voiceURI?: string;
  language: SupportedLanguage;
}

export interface EscalationRule {
  type: "help_frequency" | "low_alertness" | "prolonged_inactivity";
  threshold: number;
  windowMs: number;
}

export type SupportedLanguage =
  | "en-US"
  | "hi-IN"
  | "bn-IN"
  | "ta-IN"
  | "te-IN"
  | "mr-IN"
  | "gu-IN"
  | "kn-IN"
  | "ml-IN"
  | "pa-IN";

export const SUPPORTED_LANGUAGES: Record<SupportedLanguage, { label: string; native: string }> = {
  "en-US": { label: "English", native: "English" },
  "hi-IN": { label: "Hindi", native: "\u0939\u093f\u0928\u094d\u0926\u0940" },
  "bn-IN": { label: "Bengali", native: "\u09ac\u09be\u0982\u09b2\u09be" },
  "ta-IN": { label: "Tamil", native: "\u0ba4\u0bae\u0bbf\u0bb4\u0bcd" },
  "te-IN": { label: "Telugu", native: "\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41" },
  "mr-IN": { label: "Marathi", native: "\u092e\u0930\u093e\u0920\u0940" },
  "gu-IN": { label: "Gujarati", native: "\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0" },
  "kn-IN": { label: "Kannada", native: "\u0c95\u0ca8\u0ccd\u0ca8\u0ca1" },
  "ml-IN": { label: "Malayalam", native: "\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02" },
  "pa-IN": { label: "Punjabi", native: "\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40" },
};

export const LANGUAGE_DESCRIPTIONS: Record<SupportedLanguage, Record<string, string>> = {
  "en-US": {
    YES: "Yes \u2014 Patient confirms",
    NO: "No \u2014 Patient refuses",
    HELP: "Help \u2014 Patient needs immediate assistance",
    HELLO: "Hello \u2014 Patient is greeting you",
    WATER: "Water/Food \u2014 Patient needs water or food",
    EMERGENCY: "EMERGENCY \u2014 Medical assistance required immediately!",
    SYSTEM: "Auto-escalation raised by CareSpeak monitoring engine",
  },
  "hi-IN": {
    YES: "\u0939\u093e\u0901 \u2014 \u0930\u094b\u0917\u0940 \u0938\u0939\u092e\u0924 \u0939\u0948\u0902",
    NO: "\u0928\u0939\u0940\u0902 \u2014 \u0930\u094b\u0917\u0940 \u0905\u0938\u0939\u092e\u0924 \u0939\u0948\u0902",
    HELP: "\u092e\u0926\u0926 \u2014 \u0930\u094b\u0917\u0940 \u0915\u094b \u0924\u0941\u0930\u0902\u0924 \u092e\u0926\u0926 \u091a\u093e\u0939\u093f\u090f",
    HELLO: "\u0928\u092e\u0938\u094d\u0924\u0947 \u2014 \u0930\u094b\u0917\u0940 \u0905\u092d\u093f\u0935\u093e\u0926\u0928 \u0915\u0930 \u0930\u0939\u0947 \u0939\u0948\u0902",
    WATER: "\u092a\u093e\u0928\u0940/\u092d\u094b\u091c\u0928 \u2014 \u0930\u094b\u0917\u0940 \u0915\u094b \u092a\u093e\u0928\u0940 \u092f\u093e \u092d\u094b\u091c\u0928 \u091a\u093e\u0939\u093f\u090f",
    EMERGENCY: "\u0906\u092a\u093e\u0924\u0915\u093e\u0932 \u2014 \u0924\u0941\u0930\u0902\u0924 \u091a\u093f\u0915\u093f\u0924\u094d\u0938\u093e \u0938\u0939\u093e\u092f\u0924\u093e \u091a\u093e\u0939\u093f\u090f!",
    SYSTEM: "\u0928\u093f\u0917\u0930\u093e\u0928\u0940 \u0907\u0902\u091c\u0928 \u0928\u0947 \u0938\u094d\u0935\u0924\u0903 \u090f\u0938\u094d\u0915\u0932\u0947\u0936\u0928 \u091c\u093e\u0930\u0940 \u0915\u093f\u092f\u093e",
  },
  "bn-IN": {
    YES: "\u09b9\u09cd\u09af\u09be\u0981 \u2014 \u09b0\u09cb\u0997\u09c0 \u09b8\u09ae\u09cd\u09ae\u09a4",
    NO: "\u09a8\u09be \u2014 \u09b0\u09cb\u0997\u09c0 \u0985\u09b8\u09ae\u09cd\u09ae\u09a4",
    HELP: "\u09b8\u09be\u09b9\u09be\u09af\u09cd\u09af \u2014 \u09b0\u09cb\u0997\u09c0\u09b0 \u09a4\u09be\u09ce\u09cd\u09b7\u09a3\u09bf\u0995 \u09b8\u09be\u09b9\u09be\u09af\u09cd\u09af \u09a6\u09b0\u0995\u09be\u09b0",
    HELLO: "\u09a8\u09ae\u09b8\u09cd\u0995\u09be\u09b0 \u2014 \u09b0\u09cb\u0997\u09c0 \u0985\u09ad\u09bf\u09ac\u09be\u09a6\u09a8 \u099c\u09be\u09a8\u09be\u099a\u09cd\u099b\u09c7\u09a8",
    WATER: "\u099c\u09b2/\u0996\u09be\u09ac\u09be\u09b0 \u2014 \u09b0\u09cb\u0997\u09c0\u09b0 \u099c\u09b2 \u09ac\u09be \u0996\u09be\u09ac\u09be\u09b0 \u09a6\u09b0\u0995\u09be\u09b0",
    EMERGENCY: "\u099c\u09b0\u09c1\u09b0\u09bf \u2014 \u09a4\u09be\u09ce\u09cd\u09b7\u09a3\u09bf\u0995 \u099a\u09bf\u0995\u09bf\u09ce\u09b8\u09be \u09b8\u09b9\u09be\u09af\u09cd\u09af \u09aa\u09cd\u09b0\u09df\u09cb\u099c\u09a8!",
    SYSTEM: "\u09aa\u09b0\u09cd\u09af\u09ac\u09c7\u0995\u09cd\u09b7\u09a3 \u0987\u099e\u09cd\u099c\u09bf\u09a8 \u09b8\u09cd\u09ac\u09af\u09bc\u0982\u0995\u09cd\u09b0\u09bf\u09df\u09ad\u09be\u09ac\u09c7 \u098f\u09b8\u09cd\u0995\u09be\u09b2\u09c7\u09b6\u09a8 \u0995\u09b0\u09c7\u099b\u09c7",
  },
  "ta-IN": {
    YES: "\u0b86\u0bae\u0bcd \u2014 \u0ba8\u0bcb\u0baf\u0bbe\u0bb3\u0bbf \u0b92\u0baa\u0bcd\u0baa\u0bc1\u0b95\u0bbf\u0bb1\u0bbe\u0bb0\u0bcd",
    NO: "\u0b87\u0bb2\u0bcd\u0bb2\u0bc8 \u2014 \u0ba8\u0bcb\u0baf\u0bbe\u0bb3\u0bbf \u0bae\u0bb1\u0bc1\u0b95\u0bcd\u0b95\u0bbf\u0bb1\u0bbe\u0bb0\u0bcd",
    HELP: "\u0b89\u0ba4\u0bb5\u0bbf \u2014 \u0ba8\u0bcb\u0baf\u0bbe\u0bb3\u0bbf\u0b95\u0bcd\u0b95\u0bc1 \u0b89\u0b9f\u0ba9\u0b9f\u0bbf \u0b89\u0ba4\u0bb5\u0bbf \u0ba4\u0bc7\u0bb5\u0bc8",
    HELLO: "\u0bb5\u0ba3\u0b95\u0bcd\u0b95\u0bae\u0bcd \u2014 \u0ba8\u0bcb\u0baf\u0bbe\u0bb3\u0bbf \u0bb5\u0ba3\u0b95\u0bcd\u0b95\u0bae\u0bcd \u0b9a\u0bca\u0bb2\u0bcd\u0b95\u0bbf\u0bb1\u0bbe\u0bb0\u0bcd",
    WATER: "\u0ba4\u0ba3\u0bcd\u0ba3\u0bc0\u0bb0\u0bcd/\u0b89\u0ba3\u0bb5\u0bc1 \u2014 \u0ba8\u0bcb\u0baf\u0bbe\u0bb3\u0bbf\u0b95\u0bcd\u0b95\u0bc1 \u0ba4\u0bc7\u0bb5\u0bc8",
    EMERGENCY: "\u0b85\u0bb5\u0b9a\u0bb0\u0bae\u0bcd \u2014 \u0b89\u0b9f\u0ba9\u0b9f\u0bbf \u0bae\u0bb0\u0bc1\u0ba4\u0bcd\u0ba4\u0bc1\u0bb5 \u0b89\u0ba4\u0bb5\u0bbf \u0ba4\u0bc7\u0bb5\u0bc8!",
    SYSTEM: "\u0b95\u0ba3\u0b95\u0bcd\u0b95\u0bc1 \u0b85\u0ba4\u0bbf\u0bb0\u0b9f\u0bbf \u0b8e\u0bb4\u0bbf\u0bb5\u0bc7\u0bb7\u0ba9\u0bcd \u0b9a\u0bc6\u0baf\u0bcd\u0ba4\u0ba4\u0bc1",
  },
  "te-IN": {
    YES: "\u0c05\u0c35\u0c41\u0c28\u0c41 \u2014 \u0c30\u0c4b\u0c17\u0c3f \u0c05\u0c02\u0c17\u0c40\u0c15\u0c30\u0c3f\u0c38\u0c4d\u0c24\u0c41\u0c28\u0c4d\u0c28\u0c3e\u0c30\u0c41",
    NO: "\u0c15\u0c3e\u0c26\u0c41 \u2014 \u0c30\u0c4b\u0c17\u0c3f \u0c24\u0c3f\u0c30\u0c38\u0c4d\u0c15\u0c30\u0c3f\u0c38\u0c4d\u0c24\u0c41\u0c28\u0c4d\u0c28\u0c3e\u0c30\u0c41",
    HELP: "\u0c38\u0c39\u0c3e\u0c2f\u0c02 \u2014 \u0c30\u0c4b\u0c17\u0c3f\u0c15\u0c3f \u0c24\u0c15\u0c4d\u0c37\u0c23 \u0c38\u0c39\u0c3e\u0c2f\u0c02 \u0c15\u0c3e\u0c35\u0c3e\u0c32\u0c3f",
    HELLO: "\u0c28\u0c2e\u0c38\u0c4d\u0c15\u0c3e\u0c30\u0c02 \u2014 \u0c30\u0c4b\u0c17\u0c3f \u0c05\u0c2d\u0c3f\u0c35\u0c3e\u0c26\u0c28 \u0c1a\u0c46\u0c38\u0c4d\u0c24\u0c41\u0c28\u0c4d\u0c28\u0c3e\u0c30\u0c41",
    WATER: "\u0c28\u0c40\u0c33\u0c4d\u0c33\u0c41/\u0c2d\u0c4b\u0c1c\u0c28\u0c02 \u2014 \u0c30\u0c4b\u0c17\u0c3f\u0c15\u0c3f \u0c15\u0c3e\u0c35\u0c3e\u0c32\u0c3f",
    EMERGENCY: "\u0c05\u0c24\u0c4d\u0c2f\u0c35\u0c38\u0c30\u0c02 \u2014 \u0c35\u0c46\u0c02\u0c1f\u0c28\u0c47 \u0c35\u0c48\u0c26\u0c4d\u0c2f \u0c38\u0c39\u0c3e\u0c2f\u0c02 \u0c15\u0c3e\u0c35\u0c3e\u0c32\u0c3f!",
    SYSTEM: "\u0c2e\u0c3e\u0c28\u0c3f\u0c1f\u0c30\u0c3f\u0c02\u0c17\u0c4d \u0c0e\u0c02\u0c1c\u0c3f\u0c28\u0c4d \u0c38\u0c4d\u0c35\u0c2f\u0c02\u0c17\u0c3e \u0c0e\u0c38\u0c4d\u0c15\u0c32\u0c47\u0c36\u0c28\u0c4d \u0c1a\u0c47\u0c38\u0c3f\u0c02\u0c26\u0c3f",
  },
  "mr-IN": {
    YES: "\u0939\u094b\u092f \u2014 \u0930\u0941\u0917\u094d\u0923 \u0938\u0939\u092e\u0924 \u0906\u0939\u0947\u0924",
    NO: "\u0928\u093e\u0939\u0940 \u2014 \u0930\u0941\u0917\u094d\u0923 \u0905\u0938\u0939\u092e\u0924 \u0906\u0939\u0947\u0924",
    HELP: "\u092e\u0926\u0924 \u2014 \u0930\u0941\u0917\u094d\u0923\u093e\u0932\u093e \u0924\u093e\u0924\u0921\u0940\u091a\u0940 \u092e\u0926\u0924 \u0939\u0935\u0940 \u0906\u0939\u0947",
    HELLO: "\u0928\u092e\u0938\u094d\u0915\u093e\u0930 \u2014 \u0930\u0941\u0917\u094d\u0923 \u0905\u092d\u093f\u0935\u093e\u0926\u0928 \u0915\u0930\u0924 \u0906\u0939\u0947\u0924",
    WATER: "\u092a\u093e\u0923\u0940/\u091c\u0947\u0935\u0923 \u2014 \u0930\u0941\u0917\u094d\u0923\u093e\u0932\u093e \u0939\u0935\u0902 \u0906\u0939\u0947",
    EMERGENCY: "\u0906\u092a\u0924\u094d\u0915\u093e\u0932\u0940\u0928 \u2014 \u0924\u093e\u0924\u0921\u0940\u0928\u0947 \u0935\u0948\u0926\u094d\u092f\u0915\u0940\u092f \u092e\u0926\u0924 \u0939\u0935\u0940!",
    SYSTEM: "\u0928\u093f\u0928\u093f\u0905\u0928\u094d\u0924\u094d\u0930\u0923 \u092f\u0902\u0924\u094d\u0930\u093e\u0928\u0947 \u0938\u094d\u0935\u092f\u0902\u0903 \u0938\u094d\u0915\u0947\u0932\u0928 \u0915\u0947\u0932\u0947",
  },
  "gu-IN": {
    YES: "\u0ab9\u0abe \u2014 \u0aa6\u0ab0\u0acd\u0aa6\u0ac0 \u0ab8\u0a82\u0aae\u0aa4 \u0a9b\u0ac7",
    NO: "\u0aa8\u0abe \u2014 \u0aa6\u0ab0\u0acd\u0aa6\u0ac0 \u0a85\u0ab8\u0a82\u0aae\u0aa4 \u0a9b\u0ac7",
    HELP: "\u0aae\u0aa6\u0aa6 \u2014 \u0aa6\u0ab0\u0acd\u0aa6\u0ac0\u0aa8\u0ac7 \u0aa4\u0abe\u0aa4\u0acd\u0a95\u0abe\u0ab2\u0abf\u0a95 \u0aae\u0aa6\u0aa6 \u0a9c\u0acb\u0a88\u0a8f",
    HELLO: "\u0aa8\u0aae\u0ab8\u0acd\u0aa4\u0ac7 \u2014 \u0aa6\u0ab0\u0acd\u0aa6\u0ac0 \u0a85\u0aad\u0abf\u0ab5\u0abe\u0aa6\u0aa8 \u0a95\u0ab0\u0ac7 \u0a9b\u0ac7",
    WATER: "\u0aaa\u0abe\u0aa3\u0ac0/\u0a96\u0acb\u0ab0\u0abe\u0a95 \u2014 \u0aa6\u0ab0\u0acd\u0aa6\u0ac0\u0aa8\u0ac7 \u0a9c\u0acb\u0a88\u0a8f",
    EMERGENCY: "\u0a87\u0aae\u0ab0\u0a9c\u0aa8\u0acd\u0ab8\u0ac0 \u2014 \u0aa4\u0abe\u0aa4\u0acd\u0a95\u0abe\u0ab2\u0abf\u0a95 \u0aa4\u0aac\u0ac0\u0aac\u0ac0 \u0aae\u0aa6\u0aa6 \u0a9c\u0acb\u0a88\u0a8f!",
    SYSTEM: "\u0aa8\u0abf\u0aa4\u0ab0\u0abe\u0aa3 \u0a8f\u0a9f\u0aa8\u0ac7 \u0ab8\u0acd\u0ab5\u0aaf\u0a82 \u0a8f\u0ab8\u0acd\u0a95\u0ab2\u0ac7\u0ab6\u0aa8 \u0a95\u0ab0\u0acd\u0aaf\u0ac1\u0a82",
  },
  "kn-IN": {
    YES: "\u0cb9\u0ccc\u0ca6\u0cc1 \u2014 \u0cb0\u0ccb\u0c97\u0cbf \u0c92\u0caa\u0ccd\u0caa\u0cc1\u0ca4\u0ccd\u0ca4\u0cbf\u0ca6\u0ccd\u0ca6\u0cbe\u0cb0\u0cc6",
    NO: "\u0c87\u0cb2\u0ccd\u0cb2 \u2014 \u0cb0\u0ccb\u0c97\u0cbf \u0ca8\u0cbf\u0cb0\u0cbe\u0c95\u0cb0\u0cbf\u0cb8\u0cc1\u0ca4\u0ccd\u0ca4\u0cbf\u0ca6\u0ccd\u0ca6\u0cbe\u0cb0\u0cc6",
    HELP: "\u0cb8\u0cb9\u0cbe\u0caf \u2014 \u0cb0\u0ccb\u0c97\u0cbf\u0c97\u0cc6 \u0ca4\u0c95\u0ccd\u0cb7\u0ca3 \u0cb8\u0cb9\u0cbe\u0caf \u0cac\u0cc7\u0c95\u0cc1",
    HELLO: "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0 \u2014 \u0cb0\u0ccb\u0c97\u0cbf \u0cb5\u0a82\u0ca6\u0cbf\u0cb8\u0cc1\u0ca4\u0ccd\u0ca4\u0cbf\u0ca6\u0ccd\u0ca6\u0cbe\u0cb0\u0cc6",
    WATER: "\u0ca8\u0cc0\u0cb0\u0cc1/\u0c8a\u0c9f \u2014 \u0cb0\u0ccb\u0c97\u0cbf\u0c97\u0cc6 \u0cac\u0cc7\u0c95\u0cc1",
    EMERGENCY: "\u0ca4\u0cc1\u0cb0\u0ccd\u0ca4\u0cc1 \u2014 \u0ca4\u0c95\u0ccd\u0cb7\u0ca3 \u0cb5\u0cc8\u0ca6\u0ccd\u0caf\u0c95\u0cc0\u0caf \u0cb8\u0cb9\u0cbe\u0caf \u0cac\u0cc7\u0c95\u0cc1!",
    SYSTEM: "\u0cae\u0ac7\u0cb2\u0cb5\u0cbf\u0c9a\u0cbe\u0cb0 \u0c8e\u0c82\u0c9c\u0cbf\u0ca8\u0ccd \u0cb8\u0ccd\u0cb5\u0caf\u0c82\u0c97\u0ca4\u0cb5\u0cbe\u0c97\u0cbf \u0c8e\u0cb2\u0cbf\u0caf\u0cc7\u0c9f\u0ccd \u0cae\u0cbe\u0ca1\u0cbf\u0ca6\u0cc6",
  },
  "ml-IN": {
    YES: "\u0d05\u0d24\u0d46 \u2014 \u0d30\u0d4b\u0d17\u0d3f \u0d38\u0d2e\u0d4d\u0d2e\u0d24\u0d3f\u0d15\u0d4d\u0d15\u0d41\u0d28\u0d4d\u0d28\u0d41",
    NO: "\u0d35\u0d47\u0d23\u0d4d\u0d1f \u2014 \u0d30\u0d4b\u0d17\u0d3f \u0d28\u0d3f\u0d30\u0d38\u0d3f\u0d15\u0d4d\u0d15\u0d41\u0d28\u0d4d\u0d28\u0d41",
    HELP: "\u0d38\u0d39\u0d3e\u0d2f\u0d02 \u2014 \u0d30\u0d4b\u0d17\u0d3f\u0d15\u0d4d\u0d15\u0d4d \u0d09\u0d1f\u0d28\u0d46 \u0d38\u0d39\u0d3e\u0d2f\u0d02 \u0d35\u0d47\u0d23\u0d02",
    HELLO: "\u0d28\u0d2e\u0d38\u0d4d\u0d15\u0d3e\u0d30\u0d02 \u2014 \u0d30\u0d4b\u0d17\u0d3f \u0d06\u0d36\u0d02\u0d38\u0d3f\u0d15\u0d4d\u0d15\u0d41\u0d28\u0d4d\u0d28\u0d41",
    WATER: "\u0d35\u0d46\u0d33\u0d4d\u0d33\u0d02/\u0d2d\u0d15\u0d37\u0d23\u0d02 \u2014 \u0d30\u0d4b\u0d17\u0d3f\u0d15\u0d4d\u0d15\u0d4d \u0d35\u0d47\u0d23\u0d02",
    EMERGENCY: "\u0d05\u0d24\u0d4d\u0d2f\u0d3e\u0d39\u0d3f\u0d24\u0d02 \u2014 \u0d09\u0d1f\u0d28\u0d46 \u0d35\u0d48\u0d26\u0d4d\u0d2f\u0d38\u0d39\u0d3e\u0d2f\u0d02 \u0d35\u0d47\u0d23\u0d02!",
    SYSTEM: "\u0d28\u0d3f\u0d30\u0d40\u0d15\u0d4d\u0d37\u0d23 \u0d0e\u0d19\u0d4d\u0d19\u0d3f\u0d7b \u0d38\u0d4d\u0d35\u0d2f\u0d2e\u0d3e\u0d2f\u0d3f \u0d0e\u0d38\u0d4d\u200c\u0d15\u0d32\u0d47\u0d37\u0d7b \u0d1a\u0d46\u0d2f\u0d4d\u0d24\u0d41",
  },
  "pa-IN": {
    YES: "\u0a39\u0a3e\u0a02 \u2014 \u0a2e\u0a30\u0a40\u0a1c\u0a3c \u0a38\u0a39\u0a3f\u0a2e\u0a24 \u0a39\u0a48",
    NO: "\u0a28\u0a39\u0a40\u0a02 \u2014 \u0a2e\u0a30\u0a40\u0a1c\u0a3c \u0a05\u0a38\u0a39\u0a3f\u0a2e\u0a24 \u0a39\u0a48",
    HELP: "\u0a2e\u0a26\u0a26 \u2014 \u0a2e\u0a30\u0a40\u0a1c\u0a3c \u0a28\u0a42\u0a70 \u0a24\u0a41\u0a30\u0a70\u0a24 \u0a2e\u0a26\u0a26 \u0a1a\u0a3e\u0a39\u0a40\u0a26\u0a40 \u0a39\u0a48",
    HELLO: "\u0a38\u0a24 \u0a38\u0a4d\u0a30\u0a40 \u0a05\u0a15\u0a3e\u0a32 \u2014 \u0a2e\u0a30\u0a40\u0a1c\u0a3c \u0a39\u0a47\u0a32\u0a4b \u0a15\u0a30 \u0a30\u0a3f\u0a39\u0a3e \u0a39\u0a48",
    WATER: "\u0a2a\u0a3e\u0a23\u0a40/\u0a16\u0a3e\u0a23\u0a3e \u2014 \u0a2e\u0a30\u0a40\u0a1c\u0a3c \u0a28\u0a42\u0a70 \u0a1a\u0a3e\u0a39\u0a40\u0a26\u0a40 \u0a39\u0a48",
    EMERGENCY: "\u0a10\u0a2e\u0a30\u0a1c\u0a48\u0a02\u0a38\u0a40 \u2014 \u0a24\u0a41\u0a30\u0a70\u0a24 \u0a21\u0a3e\u0a15\u0a1f\u0a30\u0a40 \u0a2e\u0a26\u0a26 \u0a1a\u0a3e\u0a39\u0a40\u0a26\u0a40 \u0a39\u0a48!",
    SYSTEM: "\u0a28\u0a3f\u0a17\u0a30\u0a3e\u0a28\u0a40 \u0a07\u0a70\u0a1c\u0a3f\u0a28 \u0a28\u0a47 \u0a38\u0a41\u0a71\u0a08 \u0a10\u0a38\u0a15\u0a32\u0a47\u0a36\u0a28 \u0a15\u0a40\u0a24\u0a3e",
  },
};

export const GESTURE_NAMES: GestureName[] = ["YES", "NO", "HELP", "WATER", "HELLO", "EMERGENCY"];

export const HAND_GESTURE_MAP: Record<string, { label: string; description: string }> = {
  YES: { label: "YES", description: LANGUAGE_DESCRIPTIONS["en-US"].YES },
  NO: { label: "NO", description: LANGUAGE_DESCRIPTIONS["en-US"].NO },
  HELP: { label: "HELP", description: LANGUAGE_DESCRIPTIONS["en-US"].HELP },
  WATER: { label: "WATER", description: LANGUAGE_DESCRIPTIONS["en-US"].WATER },
};

export const EYE_GESTURE_MAP: Record<string, { label: string; description: string }> = {
  YES: { label: "YES", description: LANGUAGE_DESCRIPTIONS["en-US"].YES },
  NO: { label: "NO", description: LANGUAGE_DESCRIPTIONS["en-US"].NO },
  HELP: { label: "HELP", description: LANGUAGE_DESCRIPTIONS["en-US"].HELP },
  WATER: { label: "WATER", description: LANGUAGE_DESCRIPTIONS["en-US"].WATER },
};

export const ALERT_SOUNDS: Record<string, { frequency: number; duration: number; type: OscillatorType }> = {
  YES: { frequency: 880, duration: 150, type: "sine" },
  NO: { frequency: 440, duration: 200, type: "square" },
  HELP: { frequency: 660, duration: 300, type: "sawtooth" },
  HELLO: { frequency: 1100, duration: 100, type: "sine" },
  WATER: { frequency: 550, duration: 250, type: "triangle" },
  EMERGENCY: { frequency: 330, duration: 500, type: "sawtooth" },
};

export const ESCALATION_RULES: EscalationRule[] = [
  { type: "help_frequency", threshold: 3, windowMs: 120000 },
  { type: "low_alertness", threshold: 25, windowMs: 30000 },
  { type: "prolonged_inactivity", threshold: 60000, windowMs: 60000 },
];

export const GESTURE_COLORS: Record<string, string> = {
  YES: "#22a67e",
  NO: "#d94a4a",
  HELP: "#e8993e",
  WATER: "#3b82f6",
  EMERGENCY: "#dc2626",
  HELLO: "#8b5cf6",
  SYSTEM: "#6e6e6e",
};
