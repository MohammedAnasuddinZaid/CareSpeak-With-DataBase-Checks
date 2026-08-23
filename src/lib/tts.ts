import { SupportedLanguage, LANGUAGE_DESCRIPTIONS, GestureType, TTSConfig } from "@/types";
import { playAlertSound } from "./alertSounds";

const LANG_KEY = "carespeak_language";
const CONFIG_KEY = "carespeak_tts_config";

const DEFAULT_CONFIG: TTSConfig = {
  enabled: true,
  rate: 0.85,
  pitch: 1.0,
  volume: 1.0,
  language: "en-US",
};

const GREETINGS: Record<SupportedLanguage, string> = {
  "en-US": "Hello, this is CareSpeak. How can I help you?",
  "hi-IN": "\u0928\u092e\u0938\u094d\u0924\u0947, \u092f\u0939 \u0915\u0947\u092f\u0930\u0938\u094d\u092a\u0940\u0915 \u0939\u0948\u0964 \u092e\u0948\u0902 \u0906\u092a\u0915\u0940 \u0915\u0948\u0938\u0947 \u092e\u0926\u0926 \u0915\u0930 \u0938\u0915\u0924\u093e \u0939\u0942\u0901?",
  "bn-IN": "\u09a8\u09ae\u09b8\u09cd\u0995\u09be\u09b0, \u098f\u099f\u09bf \u0995\u09c7\u09af\u09bc\u09be\u09b0\u09b8\u09cd\u09aa\u09c0\u0995\u0964 \u0986\u09ae\u09bf \u0995\u09c0\u09ad\u09be\u09ac\u09c7 \u09b8\u09be\u09b9\u09be\u09af\u09cd\u09af \u0995\u09b0\u09a4\u09c7 \u09aa\u09be\u09b0\u09bf?",
  "ta-IN": "\u0bb5\u0ba3\u0b95\u0bcd\u0b95\u0bae\u0bcd, \u0b87\u0ba4\u0bc1 \u0b95\u0bc7\u0bb0\u0bcd\u0bb8\u0bcd\u0baa\u0bc0\u0b95\u0bcd. \u0ba8\u0bbe\u0ba9\u0bcd \u0b89\u0b99\u0bcd\u0b95\u0bb3\u0bc1\u0b95\u0bcd\u0b95\u0bc1 \u0b8e\u0baa\u0bcd\u0baa\u0b9f\u0bbf \u0b89\u0ba4\u0bb5 \u0bae\u0bc1\u0b9f\u0bbf\u0baf\u0bc1\u0bae\u0bcd?",
  "te-IN": "\u0c28\u0c2e\u0c38\u0c4d\u0c15\u0c3e\u0c30\u0c02, \u0c07\u0c26\u0c3f \u0c15\u0c47\u0c30\u0c4d\u200c\u0c38\u0c4d\u0c2a\u0c40\u0c15\u0c4d. \u0c28\u0c47\u0c28\u0c41 \u0c2e\u0c40\u0c15\u0c41 \u0c0e\u0c32\u0c3e \u0c38\u0c39\u0c3e\u0c2f\u0c02 \u0c1a\u0c47\u0c2f\u0c17\u0c32\u0c28\u0c41?",
  "mr-IN": "\u0928\u092e\u0938\u094d\u0915\u093e\u0930, \u0939\u0947 \u0915\u0947\u0905\u0930\u0938\u094d\u092a\u0940\u0915 \u0906\u0939\u0947. \u092e\u0940 \u0924\u0941\u092e\u091a\u0940 \u0915\u0936\u0940 \u092e\u0926\u0924 \u0915\u0930\u0942 \u0936\u0915\u0924\u094b?",
  "gu-IN": "\u0aa8\u0aae\u0ab8\u0acd\u0aa4\u0ac7, \u0a86 \u0a95\u0ac7\u0ab0\u0ab8\u0acd\u0aaa\u0ac0\u0a95 \u0a9b\u0ac7. \u0ab9\u0ac1\u0a82 \u0aa4\u0aae\u0a28\u0ac7 \u0a95\u0ac7\u0ab5\u0ac0 \u0ab0\u0ac0\u0aa4\u0ac7 \u0aae\u0aa6\u0aa6 \u0a95\u0ab0\u0ac0 \u0ab6\u0a95\u0ac1\u0a82?",
  "kn-IN": "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0, \u0c87\u0ca6\u0cc1 \u0c95\u0cc7\u0cb0\u0cb8\u0ccd\u0caa\u0cc0\u0c95\u0ccd. \u0ca8\u0cbe\u0ca8\u0cc1 \u0ca8\u0cbf\u0cae\u0c97\u0cc6 \u0cb9\u0cc7\u0c97\u0cc6 \u0cb8\u0cb9\u0cbe\u0caf \u0cae\u0cbe\u0ca1\u0cac\u0cb2\u0ccd\u0cb2\u0cbf?",
  "ml-IN": "\u0d28\u0d2e\u0d38\u0d4d\u0d15\u0d3e\u0d30\u0d02, \u0d07\u0d24\u0d4d \u0d15\u0d47\u0d2f\u0d30\u0d4d\u200d\u0d38\u0d4d\u0d2a\u0d40\u0d15\u0d4d \u0d06\u0d23\u0d4d. \u0d0e\u0d19\u0d4d\u0d19\u0d28\u0d46 \u0d38\u0d39\u0d3e\u0d2f\u0d3f\u0d15\u0d4d\u0d15\u0d3e\u0d02?",
  "pa-IN": "\u0a38\u0a24 \u0a38\u0a4d\u0a30\u0a40 \u0a05\u0a15\u0a3e\u0a32, \u0a07\u0a39 \u0a15\u0a47\u0a05\u0a30-\u0a38\u0a2a\u0a40\u0a15 \u0a39\u0a48\u0964 \u0a2e\u0a48\u0a02 \u0a24\u0a41\u0a38\u0a40\u0a02 \u0a28\u0a42\u0a70 \u0a15\u0a3f\u0a35\u0a47\u0a02 \u0a2e\u0a26\u0a26 \u0a15\u0a30 \u0a38\u0a15\u0a26\u0a3e \u0a39\u0a3e\u0a02?",
};

function isSupported(v: string): v is SupportedLanguage {
  return v in GREETINGS;
}

export function getSavedLanguage(): SupportedLanguage {
  if (typeof window === "undefined") return "en-US";
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && isSupported(saved)) return saved;
  } catch {}
  return "en-US";
}

export function saveLanguage(lang: SupportedLanguage): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {}
}

export function loadTTSConfig(): TTSConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<TTSConfig>) };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveTTSConfig(cfg: TTSConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {}
}

export function getDescription(gestureName: string, lang: SupportedLanguage): string {
  const langMap = LANGUAGE_DESCRIPTIONS[lang];
  if (langMap && langMap[gestureName]) return langMap[gestureName];
  return LANGUAGE_DESCRIPTIONS["en-US"][gestureName] ?? gestureName;
}

let cachedVoices: SpeechSynthesisVoice[] | null = null;

async function ensureVoices(): Promise<SpeechSynthesisVoice[]> {
  if (cachedVoices && cachedVoices.length > 0) return cachedVoices;
  const synth = window.speechSynthesis;
  const immediate = synth.getVoices();
  if (immediate.length > 0) {
    cachedVoices = immediate;
    return immediate;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      cachedVoices = synth.getVoices();
      resolve(cachedVoices);
    };
    synth.onvoiceschanged = () => {
      done();
      synth.onvoiceschanged = null;
    };
    setTimeout(done, 1200);
  });
}

function findVoiceForLang(lang: string): SpeechSynthesisVoice | null {
  const voices = cachedVoices ?? [];
  if (voices.length === 0) return null;
  const langLower = lang.toLowerCase();
  const exact = voices.find((v) => v.lang.toLowerCase() === langLower);
  if (exact) return exact;
  const prefix = langLower.split("-")[0];
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

/* Single-flight queue with hard timeout — prevents both overlap and deadlock */
interface QueueItem {
  text: string;
  lang: string;
}
const queue: QueueItem[] = [];
let speaking = false;
const MAX_QUEUE = 4;

async function pump(): Promise<void> {
  if (speaking || queue.length === 0 || typeof window === "undefined" || !window.speechSynthesis) return;
  speaking = true;
  const item = queue.shift()!;

  try {
    await ensureVoices();
    const u = new SpeechSynthesisUtterance(item.text);
    const cfg = loadTTSConfig();
    u.lang = item.lang;
    u.rate = cfg.rate;
    u.pitch = cfg.pitch;
    u.volume = cfg.volume;
    const voice = findVoiceForLang(item.lang);
    if (voice) u.voice = voice;

    await new Promise<void>((resolve) => {
      const safety = setTimeout(() => resolve(), Math.max(4000, item.text.length * 120));
      u.onend = () => {
        clearTimeout(safety);
        resolve();
      };
      u.onerror = () => {
        clearTimeout(safety);
        resolve();
      };
      try {
        // cancel any zombie utterance from a previous page state before speaking
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(u);
      } catch {
        clearTimeout(safety);
        resolve();
      }
    });
  } finally {
    speaking = false;
    if (queue.length > 0) void pump();
  }
}

function doSpeak(text: string, lang: string): void {
  if (!text || text.trim().length === 0) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ text: text.trim(), lang });
  void pump();
}

export class VoiceAlert {
  private lastSpoken: Record<string, number> = {};
  private playCount: Record<string, number> = {};
  private currentGesture: string | null = null;
  private readonly cooldownMs: number;
  private readonly maxPlays = 3;
  private config: TTSConfig;
  private soundEnabled = true;

  constructor(cooldownMs = 10000) {
    this.cooldownMs = cooldownMs;
    this.config = loadTTSConfig();
    this.config.language = getSavedLanguage();
  }

  setEnabled(v: boolean) {
    this.config.enabled = v;
    saveTTSConfig(this.config);
  }
  setSoundEnabled(v: boolean) {
    this.soundEnabled = v;
  }
  getLanguage(): SupportedLanguage {
    return this.config.language;
  }

  setLanguage(lang: SupportedLanguage) {
    this.config.language = lang;
    saveTTSConfig(this.config);
    saveLanguage(lang);
    this.speakDirect(GREETINGS[lang] ?? GREETINGS["en-US"]);
  }

  speak(gestureName: string, type: GestureType = "hand"): void {
    if (!this.config.enabled) return;
    if (gestureName !== this.currentGesture) {
      this.playCount[gestureName] = 0;
      this.currentGesture = gestureName;
    }
    if ((this.playCount[gestureName] ?? 0) >= this.maxPlays) return;
    const now = Date.now();
    if (now - (this.lastSpoken[gestureName] ?? 0) < this.cooldownMs) return;
    this.lastSpoken[gestureName] = now;
    this.playCount[gestureName] = (this.playCount[gestureName] ?? 0) + 1;

    if (this.soundEnabled && (gestureName === "HELP" || gestureName === "EMERGENCY")) {
      playAlertSound(gestureName);
    }
    doSpeak(getDescription(gestureName, this.config.language), this.config.language);
  }

  speakDirect(text: string, lang?: SupportedLanguage): void {
    if (!this.config.enabled) return;
    doSpeak(text, lang ?? this.config.language);
  }

  resetGesture(gestureName?: string) {
    if (gestureName) this.playCount[gestureName] = 0;
    else this.playCount = {};
  }

  /** Replay by gesture name (localized description) or raw text */
  replay(textOrGesture: string, lang?: SupportedLanguage): void {
    if (!this.config.enabled) return;
    const l = lang ?? this.config.language;
    const desc = getDescription(textOrGesture, l);
    doSpeak(desc === textOrGesture ? textOrGesture : desc, l);
  }

  stop(): void {
    queue.length = 0;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }
}

export const voiceAlert = new VoiceAlert(10000);
