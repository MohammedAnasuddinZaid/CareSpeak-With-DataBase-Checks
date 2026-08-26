import { GestureLogEntry, GestureType } from "@/types";

const STORAGE_KEY = "carespeak_gesture_log";
const MAX_ENTRIES = 300;
const BC_CHANNEL_NAME = "carespeak_sync";

let broadcastChannel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(BC_CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return broadcastChannel;
}

export function loadGestureLog(): GestureLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as GestureLogEntry[]) : [];
  } catch {
    return [];
  }
}

function saveGestureLog(log: GestureLogEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(0, MAX_ENTRIES)));
  } catch {}
}

export interface AddGestureLogOptions {
  sessionId?: string;
  source?: GestureLogEntry["source"];
}

/**
 * Persist + locally broadcast a gesture. Network fan-out belongs to
 * NetworkSync.sendAlert so every alert is transmitted exactly once — this
 * function deliberately does NOT touch the outbox (it used to enqueue AND
 * sendAlert posted directly, so every alert crossed the network twice and the
 * duplicate could wipe a nurse's acknowledgement server-side).
 */
export function addGestureLog(
  gesture: string,
  description: string,
  confidence: number,
  type: GestureType,
  language = "en-US",
  opts: AddGestureLogOptions = {}
): GestureLogEntry {
  const entry: GestureLogEntry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    gesture,
    description,
    confidence,
    type,
    timestamp: Date.now(),
    language,
    source: opts.source ?? "camera",
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };
  const log = loadGestureLog();
  log.unshift(entry);
  saveGestureLog(log);
  try {
    getChannel()?.postMessage({ kind: "new_gesture", entry, sessionId: opts.sessionId });
  } catch {}
  return entry;
}

export function applyStatusLocal(id: string, status: "acknowledge" | "escalate" | "resolve"): void {
  const log = loadGestureLog();
  const idx = log.findIndex((e) => e.id === id);
  if (idx === -1) return;
  if (status === "acknowledge") {
    log[idx].acknowledged = true;
    log[idx].acknowledgedAt = Date.now();
  } else if (status === "escalate") {
    log[idx].escalated = true;
    log[idx].escalatedAt = Date.now();
  } else {
    log[idx].resolved = true;
    log[idx].acknowledged = true;
    log[idx].resolvedAt = Date.now();
  }
  saveGestureLog(log);
}

export function acknowledgeEntry(id: string): void {
  applyStatusLocal(id, "acknowledge");
  try {
    getChannel()?.postMessage({
      kind: "action",
      action: { type: "acknowledge", entryId: id, timestamp: Date.now() },
    });
  } catch {}
}

export function clearGestureLog(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  try {
    getChannel()?.postMessage({ kind: "clear" });
  } catch {}
}

export interface GestureUpdateHandlers {
  onGesture?: (entry: GestureLogEntry) => void;
  onClear?: () => void;
  onAction?: (type: string, entryId: string) => void;
}

export function subscribeToGestureUpdates(handlers: GestureUpdateHandlers): () => void {
  const channel = getChannel();
  if (!channel) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data) return;
    if (data.kind === "new_gesture" && data.entry) handlers.onGesture?.(data.entry as GestureLogEntry);
    else if (data.kind === "clear") handlers.onClear?.();
    else if (data.kind === "action")
      handlers.onAction?.(String(data.action?.type ?? ""), String(data.action?.entryId ?? ""));
  };
  channel.addEventListener("message", handler);
  return () => channel.removeEventListener("message", handler);
}
