/**
 * Nurse-console audible alarm: a two-tone siren (Web Audio, no assets) that
 * loops while any EMERGENCY is unacknowledged. Mute state persists locally so
 * a nurse's choice survives refreshes — silencing is always one tap away.
 */
const MUTE_KEY = "carespeak_alarm_muted";

let ctx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;
let toggle: ReturnType<typeof setInterval> | null = null;

export function isAlarmMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAlarmMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {}
  if (muted) stopAlarm();
}

export function startAlarm(): void {
  if (isAlarmMuted() || typeof window === "undefined") return;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  void ctx.resume();
  if (osc) return; // already sounding

  gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 660;
  osc.connect(gain);
  osc.start();

  // fade in, then alternate between the two siren tones
  gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.15);
  let high = true;
  toggle = setInterval(() => {
    if (!osc || !ctx) return;
    high = !high;
    osc.frequency.setTargetAtTime(high ? 880 : 620, ctx.currentTime, 0.03);
    // gentle pulsing so it alarms without being painful
    gain?.gain.setTargetAtTime(high ? 0.07 : 0.045, ctx.currentTime, 0.05);
  }, 450);
}

export function stopAlarm(): void {
  if (toggle) clearInterval(toggle);
  toggle = null;
  if (gain && ctx) {
    try {
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    } catch {}
  }
  const o = osc;
  const c = ctx;
  osc = null;
  setTimeout(() => {
    try {
      o?.stop();
      o?.disconnect();
      if (c && c.state === "running" && !osc) {
        /* keep context alive for reuse */
      }
    } catch {}
  }, 200);
}
