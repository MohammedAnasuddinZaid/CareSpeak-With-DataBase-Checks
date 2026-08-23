import { AlertAction, GestureLogEntry, PatientMetrics } from "@/types";

/**
 * Offline-first durable queue (IndexedDB). Every outbound message that fails to
 * reach the server lands here and is flushed automatically when connectivity
 * returns — via the `online` event, Background Sync, or explicit flush calls.
 * Latest-wins semantics for metrics; FIFO for alerts and actions.
 */

const DB_NAME = "carespeak";
const DB_VERSION = 1;
const STORE = "outbox";

export type OutboxPayload =
  | { channel: "alert"; body: { type: "new_gesture"; entry: GestureLogEntry } }
  | { channel: "action"; body: { type: string; entryId: string; action: AlertAction } }
  | { channel: "metrics"; body: { type: "metrics"; patientMetrics: PatientMetrics; deviceId: string } };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no-indexeddb"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await openDB();
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const request = fn(t.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

export async function enqueue(payload: OutboxPayload): Promise<void> {
  await tx("readwrite", (s) => s.add(payload));
  requestBackgroundSync();
}

export async function dequeueAll(): Promise<{ key: IDBValidKey; payload: OutboxPayload }[]> {
  const [keys, values] = await Promise.all([
    tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()),
    tx<OutboxPayload[]>("readonly", (s) => s.getAll()),
  ]);
  if (!keys || !values) return [];
  return keys.map((key, i) => ({ key, payload: values[i] }));
}

export async function remove(key: IDBValidKey): Promise<void> {
  await tx("readwrite", (s) => s.delete(key));
}

/** Metrics are latest-wins: drop older queued metric payloads for same device */
export async function enqueueMetricsLatestWins(body: OutboxPayload & { channel: "metrics" }): Promise<void> {
  const existing = await dequeueAll();
  for (const item of existing) {
    if (item.payload.channel === "metrics" && item.payload.body.deviceId === body.body.deviceId) {
      await remove(item.key);
    }
  }
  await enqueue(body);
}

export function requestBackgroundSync(): void {
  try {
    void navigator.serviceWorker?.ready?.then((reg) => {
      const sync = (reg as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      }).sync;
      void sync?.register("carespeak-flush").catch(() => {});
    });
  } catch {}
}
