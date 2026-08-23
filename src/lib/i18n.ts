import { SupportedLanguage } from "@/types";

export type UIKey =
  | "appName"
  | "handMode"
  | "eyeMode"
  | "cctv"
  | "nurse"
  | "logs"
  | "report"
  | "about"
  | "emergency"
  | "startCamera"
  | "stopCamera"
  | "cameraPermissionHint"
  | "loadingModel"
  | "downloadingWasm"
  | "waitingGesture"
  | "gestureDetected"
  | "confidenceLabel"
  | "faceDetected"
  | "noFace"
  | "noHand"
  | "handsDetected"
  | "paused"
  | "voiceAlertsActive"
  | "replayLastAlert"
  | "gestureGuide"
  | "demoMode"
  | "demoModeActive"
  | "sessionShare"
  | "copyUrl"
  | "copied"
  | "live"
  | "reconnecting"
  | "disconnected"
  | "nurseReplyTitle"
  | "sendMessage"
  | "onMyWay"
  | "pleaseWait"
  | "doctorNotified"
  | "acknowledge"
  | "escalate"
  | "resolve"
  | "pending"
  | "autoEscalated";

type Dict = Record<UIKey, string>;

const en: Dict = {
  appName: "CareSpeak",
  handMode: "Hand Mode",
  eyeMode: "Eye Mode",
  cctv: "CCTV",
  nurse: "Nurse",
  logs: "Logs",
  report: "Report",
  about: "About",
  emergency: "Emergency",
  startCamera: "Start Camera",
  stopCamera: "Stop Camera",
  cameraPermissionHint: "Chrome will ask for camera permission",
  loadingModel: "Loading tracking model...",
  downloadingWasm: "Downloading AI model (cached for offline use)",
  waitingGesture: "Waiting for gesture...",
  gestureDetected: "Gesture detected",
  confidenceLabel: "confidence",
  faceDetected: "Face detected — tracking eyes",
  noFace: "No face in view",
  noHand: "No hand detected",
  handsDetected: "hand(s) detected",
  paused: "PAUSED",
  voiceAlertsActive: "Voice alerts active",
  replayLastAlert: "Replay Last Alert",
  gestureGuide: "Gesture Guide",
  demoMode: "Demo Mode",
  demoModeActive: "Demo Mode Active",
  sessionShare: "Session ID — share with nurse",
  copyUrl: "Copy Dashboard URL",
  copied: "Copied!",
  live: "Live",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
  nurseReplyTitle: "Message from nurse",
  sendMessage: "Send",
  onMyWay: "On my way",
  pleaseWait: "Please wait",
  doctorNotified: "Doctor notified",
  acknowledge: "Acknowledge",
  escalate: "Escalate",
  resolve: "Resolve",
  pending: "pending",
  autoEscalated: "AUTO-ESCALATED",
};

const hi: Partial<Dict> = {
  handMode: "\u0939\u093e\u0925 \u092e\u094b\u0921",
  eyeMode: "\u0906\u0901\u0916 \u092e\u094b\u0921",
  nurse: "\u0928\u0930\u094d\u0938",
  logs: "\u0932\u0949\u0917\u094d\u0938",
  report: "\u0930\u093f\u092a\u094b\u0930\u094d\u091f",
  emergency: "\u0906\u092a\u093e\u0924\u0915\u093e\u0932",
  startCamera: "\u0915\u0948\u092e\u0930\u093e \u091a\u0932\u093e\u090f\u0901",
  stopCamera: "\u0915\u0948\u092e\u0930\u093e \u092c\u0902\u0926 \u0915\u0930\u0947\u0902",
  loadingModel: "\u092e\u0949\u0921\u0932 \u0932\u094b\u0921 \u0939\u094b \u0930\u0939\u093e \u0939\u0948...",
  waitingGesture: "\u0907\u0936\u093e\u0930\u0947 \u0915\u0940 \u092a\u094d\u0930\u0924\u0940\u0915\u094d\u0937\u093e \u092e\u0947\u0902...",
  gestureDetected: "\u0907\u0936\u093e\u0930\u093e \u092a\u0939\u091a\u093e\u0928\u093e \u0917\u092f\u093e",
  confidenceLabel: "\u0935\u093f\u0936\u094d\u0935\u093e\u0938\u0924\u093e",
  faceDetected: "\u091a\u0947\u0939\u0930\u093e \u092e\u093f\u0932\u093e \u2014 \u0906\u0901\u0916\u094b\u0902 \u092a\u0930 \u0928\u091c\u093c\u0930",
  noFace: "\u0915\u094b\u0908 \u091a\u0947\u0939\u0930\u093e \u0928\u0939\u0940\u0902",
  paused: "\u0930\u0941\u0915\u093e \u0939\u0941\u0906",
  voiceAlertsActive: "\u0935\u0949\u092f\u0938 \u0905\u0932\u0930\u094d\u091f \u0938\u0915\u094d\u0930\u093f\u092f",
  replayLastAlert: "\u0906\u0916\u093f\u0930\u0940 \u0905\u0932\u0930\u094d\u091f \u0926\u094b\u092c\u093e\u0930\u093e",
  gestureGuide: "\u0907\u0936\u093e\u0930\u093e \u0917\u093e\u0807\u0921",
  live: "\u0932\u093e\u0907\u0935",
  reconnecting: "\u092b\u093f\u0930 \u091c\u0941\u095c \u0930\u0939\u0947 \u0939\u0948\u0902...",
  disconnected: "\u0921\u093f\u0938\u094d\u0915\u0928\u0947\u0915\u094d\u091f\u0947\u0902\u091f",
  onMyWay: "\u092e\u0948\u0902 \u0906 \u0930\u0939\u093e \u0939\u0942\u0901",
  pleaseWait: "\u0915\u0943\u092a\u092f\u093e \u092a\u094d\u0930\u0924\u0940\u0915\u094d\u0937\u093e \u0915\u0930\u0947\u0902",
  doctorNotified: "\u0921\u0949\u0915\u094d\u091f\u0930 \u0915\u094b \u0938\u0942\u091a\u093f\u0924 \u0915\u093f\u092f\u093e",
  acknowledge: "\u0938\u094d\u0935\u0940\u0915\u093e\u0930 \u0915\u0930\u0947\u0902",
  escalate: "\u090f\u0938\u094d\u0915\u0932\u0947\u091f \u0915\u0930\u0947\u0902",
  resolve: "\u0939\u0932 \u0915\u0930\u0947\u0902",
};

const DICTS: Partial<Record<SupportedLanguage, Partial<Dict>>> = { "en-US": en, "hi-IN": hi };
export const I18N_LANGUAGES = Object.keys(DICTS) as SupportedLanguage[];

export function t(lang: SupportedLanguage | string, key: UIKey): string {
  const dict = DICTS[(lang as SupportedLanguage)] ?? en;
  return dict[key] ?? en[key];
}
