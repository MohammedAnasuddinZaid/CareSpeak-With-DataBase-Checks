"use client";

/**
 * "Your history" — the record that survives closing the tab.
 *
 * Everything else in the workspace is *live*: it is scoped to the console
 * session and the device, so it answers "what has this device seen just now".
 * That is the right question for the person using the device and the wrong one
 * for the person who comes back tomorrow, which is why signing in used to show
 * an empty screen even though the gestures had been written.
 *
 * Two states matter and they are not decoration:
 *
 *   - **Signed out.** Says so, and says what signing in changes. A patient who
 *     does not know their gestures are being discarded has no way to find out,
 *     and the data really is discarded — unattributed rows are not patient data.
 *   - **Signed in, empty.** Distinguishes "nothing recorded yet" from "failed to
 *     load", because the first is expected on a first session and the second is
 *     a bug the patient cannot report meaningfully.
 *
 * Reads only `/api/me/history`, which is patient-scoped server-side, so there is
 * no patient id in the query string to tamper with and nothing to filter client
 * side.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  History,
  LogIn,
  RefreshCw,
  HeartPulse,
  Thermometer,
  Wind,
} from "lucide-react";
import type { DeviceVitals, GestureLogEntry } from "@/types";

type Phase = "checking" | "signed-out" | "loading" | "ready" | "error";

interface HistoryPayload {
  ok: true;
  profile: {
    mrn: string;
    bloodGroup: string;
    communicationMode: string;
    preferredLanguage: string;
    aacBoardEnabled: boolean;
  } | null;
  // The real shared types, not a hand-written copy: a local re-declaration of
  // these silently drifts from the API the first time a field is renamed, and a
  // drifted history panel fails quietly -- it just renders blanks.
  vitals: DeviceVitals[];
  gestures: GestureLogEntry[];
  totals: { vitals: number; gestures: number; firstSeenMs: number | null; lastSeenMs: number | null };
}

/** "4m ago" / "3h ago" / "5d ago". Compact, and never "NaN ago". */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--:--";
  }
}

const COMMUNICATION_LABEL: Record<string, string> = {
  hand: "Hand gestures",
  eye: "Eye gaze",
  dwell: "Dwell selection",
  dwell_blink: "Dwell + blink",
  switch: "Switch scanning",
  mixed: "Mixed",
  none: "Not set",
};

export default function MyHistoryPanel() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const res = await fetch("/api/me/history", { cache: "no-store" });

      // 401/403 means "not a patient session" rather than a failure, so it gets
      // its own state instead of an error the patient cannot act on.
      if (res.status === 401 || res.status === 403) {
        setData(null);
        setPhase("signed-out");
        return;
      }
      if (!res.ok) throw new Error(`history ${res.status}`);

      const body = (await res.json()) as HistoryPayload;
      setData(body);
      setPhase("ready");
    } catch {
      setError("We could not load your history just now.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card p-6" aria-labelledby="my-history-heading">
      <div className="flex items-start justify-between gap-3 mb-4">
        <h3
          id="my-history-heading"
          className="text-sm font-bold text-[#1f1f1f] flex items-center gap-2"
        >
          <History className="w-4 h-4 text-[#c63a22]" /> Your History
        </h3>
        {phase === "ready" && (
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh your history"
            className="p-1.5 rounded-lg text-[#6e6e6e] hover:bg-[#f5f3f0] hover:text-[#1f1f1f] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {phase === "checking" || phase === "loading" ? (
        <p className="text-sm text-[#6e6e6e]" role="status" aria-live="polite">
          Loading your history&hellip;
        </p>
      ) : null}

      {phase === "signed-out" && (
        <div className="text-center py-2">
          <div className="w-11 h-11 rounded-xl bg-[#f5f3f0] flex items-center justify-center mx-auto mb-3">
            <LogIn className="w-5 h-5 text-[#6e6e6e]" />
          </div>
          <p className="text-sm text-[#1f1f1f] font-medium mb-1">Sign in to keep your history</p>
          <p className="text-xs text-[#6e6e6e] mb-4 max-w-sm mx-auto">
            Until you sign in, gestures and readings from this device are recorded but not
            attached to an account, so they will not be here when you come back.
          </p>
          <Link href="/login?next=%2Fhand-mode" className="btn-primary px-4 py-2 text-sm inline-flex items-center gap-1.5">
            <LogIn className="w-3.5 h-3.5" /> Sign in
          </Link>
        </div>
      )}

      {phase === "error" && (
        <div role="alert">
          <p className="text-sm text-[#d94a4a] mb-3">{error}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary px-4 py-2 text-sm">
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && data && (
        <div>
          {data.profile && (
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <div className="rounded-xl bg-[#f5f3f0] px-3 py-2">
                <dt className="text-[10px] uppercase tracking-wider font-bold text-[#6e6e6e]">MRN</dt>
                <dd className="text-sm font-bold text-[#1f1f1f] truncate">{data.profile.mrn}</dd>
              </div>
              <div className="rounded-xl bg-[#f5f3f0] px-3 py-2">
                <dt className="text-[10px] uppercase tracking-wider font-bold text-[#6e6e6e]">Blood</dt>
                <dd className="text-sm font-bold text-[#1f1f1f]">{data.profile.bloodGroup}</dd>
              </div>
              <div className="rounded-xl bg-[#f5f3f0] px-3 py-2 col-span-2">
                <dt className="text-[10px] uppercase tracking-wider font-bold text-[#6e6e6e]">Communication</dt>
                <dd className="text-sm font-bold text-[#1f1f1f] truncate">
                  {COMMUNICATION_LABEL[data.profile.communicationMode] ?? data.profile.communicationMode}
                </dd>
              </div>
            </dl>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6e6e6e] mb-4">
            <span>
              <strong className="text-[#1f1f1f]">{data.totals.gestures}</strong> gestures
            </span>
            <span>
              <strong className="text-[#1f1f1f]">{data.totals.vitals}</strong> readings
            </span>
            {data.totals.lastSeenMs && <span>Last activity {ago(data.totals.lastSeenMs)}</span>}
          </div>

          {data.totals.gestures === 0 && data.totals.vitals === 0 ? (
            <p className="text-sm text-[#6e6e6e] rounded-xl bg-[#f5f3f0] px-4 py-6 text-center">
              Nothing recorded yet. Your gestures and readings will appear here as soon as
              you use the workspace &mdash; and they will still be here next time.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {data.gestures.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider font-bold text-[#6e6e6e] mb-2">
                    Recent gestures
                  </h4>
                  <ul className="space-y-1.5">
                    {data.gestures.slice(0, 6).map((g) => (
                      <li
                        key={g.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[#f5f3f0] px-3 py-2"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="font-bold text-sm text-[#c63a22]">{g.gesture}</span>
                          <span className="text-[10px] uppercase tracking-wide text-[#6e6e6e] shrink-0">
                            {g.type}
                          </span>
                          {g.acknowledged && (
                            <CheckCircle2
                              className="w-3.5 h-3.5 text-[#22a67e] shrink-0"
                              aria-label="Seen by staff"
                            />
                          )}
                        </span>
                        <span className="text-[11px] text-[#6e6e6e] shrink-0">
                          {clockTime(g.timestamp)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.vitals.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider font-bold text-[#6e6e6e] mb-2">
                    Recent readings
                  </h4>
                  <ul className="space-y-1.5">
                    {data.vitals.slice(0, 6).map((v, i) => (
                      <li
                        key={`${v.receivedAt}-${i}`}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[#f5f3f0] px-3 py-2 text-xs"
                      >
                        <span className="flex items-center gap-3 text-[#1f1f1f]">
                          {v.heartRate !== undefined && (
                            <span className="flex items-center gap-1">
                              <HeartPulse className="w-3.5 h-3.5 text-[#c63a22]" aria-hidden="true" />
                              {v.heartRate}
                            </span>
                          )}
                          {v.spo2 !== undefined && (
                            <span className="flex items-center gap-1">
                              <Wind className="w-3.5 h-3.5 text-[#3b82f6]" aria-hidden="true" />
                              {v.spo2}%
                            </span>
                          )}
                          {v.temperature !== undefined && (
                            <span className="flex items-center gap-1">
                              <Thermometer className="w-3.5 h-3.5 text-[#e8993e]" aria-hidden="true" />
                              {v.temperature}
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-[#6e6e6e] shrink-0">
                          {clockTime(v.receivedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {data.totals.firstSeenMs && (
            <p className="text-[11px] text-[#6e6e6e] mt-4 flex items-center gap-1.5">
              <Activity className="w-3 h-3" aria-hidden="true" />
              Tracked since {new Date(data.totals.firstSeenMs).toLocaleDateString()}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
