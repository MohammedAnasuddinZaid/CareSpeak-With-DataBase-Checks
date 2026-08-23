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
  "te-IN": "\u0c28\u0cae\u0c38\u0c4d\u0c15\u0c3e\u0c30\u0c02, \u0c07\u0c26\u0c3f \u0c15\u0c47\u0c30\u0c4d\u200c\u0c38\u0c4d\u0c2a\u0c40\u0c15\u0c4d. \u0c28\u0c47\u0c28\u0c41 \u0c2e\u0c40\u0c15\u0c41 \u0c0e\u0c32\u0c3e \u0c38\u0c39\u0c3e\u0c2f\u0c02 \u0c1a\u0c47\u0c2f\u0c17\u0c32\u0c28\u0c41?",
  "mr-IN": "\u0928\u092e\u0938\u094d\u0915\u093e\u0930, \u0939\u0947 \u0915\u0947\u0905\u0930\u0938\u094d\u092a\u0940\u0915 \u0906\u0939\u0947. \u092e\u0940 \u0924\u0941\u092e\u091a\u0940 \u0915\u0936\u0940 \u092e\u0926\u0924 \u0915\u0930\u0942 \u0936\u0915\u0924\u094b?",
  "gu-IN": "\u0aa8\u0aae\u0ab8\u0acd\u0aa4\u0ac7, \u0a86 \u0a95\u0ac7\u0ab0\u0ab8\u0acd\u0aaa\u0ac0\u0a95 \u0a9b\u0ac7. \u0ab9\u0ac1\u0a82 \u0aa4\u0aae\u0aa8\u0ac7 \u0a95\u0ac7\u0ab5\u0ac0 \u0ab0\u0ac0\u0aa4\u0ac7 \u0aae\u0aa6\u0aa6 \u0a95\u0ab0\u0ac0 \u0ab6\u0a95\u0ac1\u0a82?",
  "kn-IN": "\u0ca8\u0cae\u0cb8\u0ccd\u0c95\u0cbe\u0cb0, \u0c87\u0ca6\u0cc1 \u0c95\u0cc7\u0cb0\u0cb8\u0ccd\u0caa\u0cc0\u0c95\u0ccd. \u0ca8\u0cbe\u0ca8\u0cc1 \u0ca8\u0cbf\u0cae\u0c97\u0cc6 \u0cb9\u0cc7\u0c97\u0cc6 \u0cb8\u0cb9\u0cbe\u0caf \u0cae\u0cbe\u0ca1\u0cac\u0cb2\u0ccd\u0cb2\u0cbf?",
  "ml-IN": "\u0d28\u0d2e\u0d38\u0d4d\u0d15\u0d3e\u0d30\u0d02, \u0d07\u0d24\u0d4d \u0d15\u0d47\u0d2f\u0d30\u0d4d\u200d\u0d38\u0d4d\u0d2a\u0d40\u0d15\u0d4d \u0d06\u0d23\u0d41. \u0d1e\u0d3e\u0d28\u0d4d \u0d28\u0d3f\u0d19\u0d4d\u0d19\u0d33\u0d46 \u0d0e\u0d19\u0d4d\u0d19\u0d28\u0d46 \u0d38\u0d39\u0d3e\u0d2f\u0d3f\u0d15\u0d4d\u0d15\u0d3e\u0d02?",
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

/**
 * Voice lists arrive asynchronously on many browsers (and sometimes never fire
 * onvoiceschanged), so poll until populated with a hard timeout.
 */
async function ensureVoices(timeoutMs = 5000): Promise<SpeechSynthesisVoice[]> {
  if (cachedVoices && cachedVoices.length > 0) return cachedVoices;
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  const synth = window.speechSynthesis;
  const immediate = synth.getVoices();
  if (immediate.length > 0) {
    cachedVoices = immediate;
    return immediate;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      synth.onvoiceschanged = null;
      cachedVoices = synth.getVoices();
      resolve(cachedVoices);
    };
    const poll = setInterval(() => {
      if (synth.getVoices().length > 0) finish();
    }, 250);
    synth.onvoiceschanged = finish;
    setTimeout(finish, timeoutMs);
  });
}

function findVoiceForLang(lang: string): SpeechSynthesisVoice | null {
  const voices = cachedVoices ?? [];
  if (voices.length === 0) return null;
  const langLower = lang.toLowerCase().replace("_", "-");
  const exact = voices.find((v) => v.lang.toLowerCase().replace("_", "-") === langLower);
  if (exact) return exact;
  const prefix = langLower.split("-")[0];
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

/** Best audible English voice (prefers Indian English for accent familiarity). */
function findEnglishVoice(): SpeechSynthesisVoice | null {
  const voices = cachedVoices ?? [];
  if (voices.length === 0) return null;
  return (
    voices.find((v) => v.lang.toLowerCase().startsWith("en-in")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("en")) ??
    voices[0]
  );
}

/* Single-flight queue — prevents overlap and deadlock */
interface QueueItem {
  text: string;
  lang: string;
  /** Spoken in English (with an English voice) when the target language has
   *  no installed voice AND remote TTS is unavailable — guarantees the patient
   *  ALWAYS hears something. */
  fallbackText?: string;
}
const queue: QueueItem[] = [];
let speaking = false;
const MAX_QUEUE = 4;

/**
 * Remote TTS for languages whose voice is not installed locally (Windows ships
 * only en/hi by default). Covers every supported Indian language; used only
 * while online so offline behaviour degrades to the English local-voice path.
 */
function gttsUrl(text: string, lang: string): string {
  const base = lang.split("-")[0];
  return (
    "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&ttsspeed=0.9" +
    `&tl=${encodeURIComponent(base)}&q=${encodeURIComponent(text.slice(0, 190))}`
  );
}

function playRemoteTts(url: string, timeoutMs = 7000): Promise<boolean> {
  if (typeof Audio === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.onended = null;
      audio.onerror = null;
      resolve(ok);
    };
    const audio = new Audio(url);
    const timer = setTimeout(() => done(false), timeoutMs);
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    try {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => done(false));
    } catch {
      done(false);
    }
  });
}

async function pump(): Promise<void> {
  if (speaking || queue.length === 0 || typeof window === "undefined" || !window.speechSynthesis) return;
  speaking = true;
  const item = queue.shift()!;

  try {
    await ensureVoices();

    let text = item.text;
    let lang = item.lang;
    let voice = findVoiceForLang(lang);

    // Preferred when the device lacks the language's voice: stream the NATIVE
    // text from remote neural-quality TTS instead of dropping to English.
    const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    if (!voice && !lang.toLowerCase().startsWith("en") && online) {
      const ok = await playRemoteTts(gttsUrl(item.text, item.lang));
      if (ok) return;
    }

    if (!voice && !lang.toLowerCase().startsWith("en") && item.fallbackText) {
      // No local voice and remote unavailable — never stay silent.
      text = item.fallbackText;
      lang = "en-US";
      voice = findVoiceForLang("en-US");
    }
    voice = voice ?? findEnglishVoice();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const cfg = loadTTSConfig();
    u.rate = cfg.rate;
    u.pitch = cfg.pitch;
    u.volume = cfg.volume;
    if (voice) u.voice = voice;

    await new Promise<void>((resolve) => {
      const safety = setTimeout(() => resolve(), Math.max(4000, text.length * 120));
      u.onend = () => {
        clearTimeout(safety);
        resolve();
      };
      u.onerror = () => {
        clearTimeout(safety);
        resolve();
      };
      try {
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

function doSpeak(text: string, lang: string, fallbackText?: string): void {
  if (!text || text.trim().length === 0) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ text: text.trim(), lang, fallbackText });
  void pump();
}

export class VoiceAlert {
  private lastSpoken: Record<string, number> = {};
  private config: TTSConfig;
  private soundEnabled = true;

  /**
   * Cooldown-only rate limiting: the same gesture re-announces after
   * `cooldownMs`; different gestures announce instantly. No cumulative cap —
   * a patient who keeps asking must keep being heard.
   */
  constructor(cooldownMs = 4000) {
    this.cooldownMs = cooldownMs;
    this.config = loadTTSConfig();
    this.config.language = getSavedLanguage();
  }
  private readonly cooldownMs: number;

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
    void ensureVoices().then(() => {
      doSpeak(GREETINGS[lang] ?? GREETINGS["en-US"], lang);
    });
  }

  speak(gestureName: string, type: GestureType = "hand"): void {
    if (!this.config.enabled) return;
    const now = Date.now();
    // EMERGENCY intentionally bypasses the cooldown (triple-siren pattern).
    if (gestureName !== "EMERGENCY" && now - (this.lastSpoken[gestureName] ?? 0) < this.cooldownMs) return;
    this.lastSpoken[gestureName] = now;

    if (this.soundEnabled && (gestureName === "HELP" || gestureName === "EMERGENCY")) {
      playAlertSound(gestureName);
    }
    doSpeak(
      getDescription(gestureName, this.config.language),
      this.config.language,
      LANGUAGE_DESCRIPTIONS["en-US"][gestureName]
    );
  }

  speakDirect(text: string, lang?: SupportedLanguage): void {
    if (!this.config.enabled) return;
    doSpeak(text, lang ?? this.config.language);
  }

  /** Clear cooldown state (e.g., when tracking restarts). */
  resetGesture(gestureName?: string) {
    if (gestureName) delete this.lastSpoken[gestureName];
    else this.lastSpoken = {};
  }

  /** Replay by gesture name (localized description) or raw text */
  replay(textOrGesture: string, lang?: SupportedLanguage): void {
    if (!this.config.enabled) return;
    const l = lang ?? this.config.language;
    const desc = getDescription(textOrGesture, l);
    doSpeak(desc === textOrGesture ? textOrGesture : desc, l, LANGUAGE_DESCRIPTIONS["en-US"][textOrGesture]);
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

export const voiceAlert = new VoiceAlert(4000);
