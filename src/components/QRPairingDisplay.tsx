"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { QrCode, Copy, Check, Smartphone, Pencil, Wifi, RotateCcw, RefreshCw, ScanLine } from "lucide-react";
import { getDashboardOrigin, setDashboardOrigin } from "@/lib/session";
import { useQrPairing } from "@/hooks/useQrPairing";
import QRCode from "qrcode";

interface QRPairingDisplayProps {
  sessionId: string;
  compact?: boolean;
}

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i;

/** Opaque no-cors probe: resolves when the host answers, rejects on network error. */
function probeReachable(url: string, timeoutMs = 1800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    fetch(`${url.replace(/\/+$/, "")}/api/health`, { mode: "no-cors", cache: "no-store" })
      .then(() => done(true))
      .catch(() => done(false));
  });
}

/**
 * Auto-LAN pairing: when served from localhost the QR is useless for other
 * devices, so we ask the server for its private IPv4 addresses
 * (/api/network-info) and probe each candidate until one answers. The first
 * reachable LAN origin wins and the QR re-renders instantly — phones pair
 * with zero manual configuration.
 */
function useAutoLanOrigin(enabled: boolean): { autoOrigin: string | null; probing: boolean } {
  const [autoOrigin, setAutoOrigin] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    if (!enabled || attempted.current) return;
    const origin = getDashboardOrigin();
    if (!LOCALHOST_RE.test(origin)) return; // already paired to a real address
    attempted.current = true;

    let cancelled = false;
    setProbing(true);
    (async () => {
      try {
        const res = await fetch("/api/network-info", { cache: "no-store" });
        if (!res.ok) throw new Error("no-info");
        const data = (await res.json()) as { lan?: { address: string }[] };
        const port = typeof window !== "undefined" ? window.location.port : "";
        const candidates = (data.lan ?? []).slice(0, 4).map(
          (n) => `http://${n.address}${port ? `:${port}` : ""}`
        );
        for (const candidate of candidates) {
          if (cancelled) return;
          if (await probeReachable(candidate)) {
            if (cancelled) return;
            setDashboardOrigin(candidate); // persists; QR effect reacts to origin change
            setAutoOrigin(candidate);
            break;
          }
        }
      } catch {
        // Server unreachable for discovery — manual editor stays available.
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { autoOrigin, probing };
}

export default function QRPairingDisplay({ sessionId, compact = false }: QRPairingDisplayProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [originDraft, setOriginDraft] = useState("");
  const [origin, setOrigin] = useState("");

  // Unique per-bed pairing token + live scan telemetry (IP/device of scanners).
  const { token, linkedDevices, lastScanAt, lastScanIp, rotate } = useQrPairing(sessionId);

  useEffect(() => {
    setOrigin(getDashboardOrigin());
  }, []);

  // Re-sync when the auto-LAN resolver updates the persisted origin.
  const { autoOrigin, probing } = useAutoLanOrigin(!!origin);
  useEffect(() => {
    if (autoOrigin) setOrigin(getDashboardOrigin());
  }, [autoOrigin]);

  useEffect(() => {
    if (!origin || !token) return;
    // The QR carries this bed's UNIQUE pairing token — no two beds share a code,
    // and every scan is reported back with the scanner's IP + device.
    const url = `${origin.replace(/\/+$/, "")}/nurse-view?session=${sessionId}&pair=${token}`;
    QRCode.toDataURL(url, {
      width: compact ? 160 : 280,
      margin: 1,
      color: { dark: "#1f1f1f", light: "#ffffff" },
    }).then(setQrDataUrl).catch(() => {});
  }, [sessionId, compact, origin, token]);

  const dashboardUrl =
    origin && token
      ? `${origin.replace(/\/+$/, "")}/nurse-view?session=${sessionId}&pair=${token}`
      : "";
  // autoOrigin is only ever set to a reachable LAN address, so its presence
  // alone tells us the QR was auto-switched away from localhost.
  const isLanAuto = !!autoOrigin;

  const saveOrigin = () => {
    // Guard against typo'd / socially-suggested origins: the QR sends whoever
    // scans it to this address, so confirm anything that isn't a LAN/private host.
    const clean = originDraft.trim();
    let host = "";
    try {
      host = new URL(clean).hostname;
    } catch {}
    const looksSafe = LOCALHOST_RE.test(clean) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if (clean && !looksSafe && !window.confirm(`Point the pairing QR at "${host}"? Only continue if you trust this address.`)) {
      return;
    }
    setDashboardOrigin(originDraft);
    setOrigin(getDashboardOrigin());
    setEditing(false);
  };

  /** Drop the LAN override and go back to this device's own origin. */
  const revertToSelf = () => {
    if (typeof window === "undefined") return;
    setDashboardOrigin(window.location.origin);
    setOrigin(window.location.origin);
  };

  const handleCopy = async () => {
    if (!dashboardUrl) return;
    try {
      await navigator.clipboard.writeText(dashboardUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const scanStatus =
    lastScanAt != null ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-[#22a67e] font-medium">
        <ScanLine className="w-3 h-3" />
        Linked · {new Date(lastScanAt).toLocaleTimeString()}
        {lastScanIp ? ` · ${lastScanIp}` : ""}
      </span>
    ) : (
      <span className="text-[11px] text-[#9ca3af]">Waiting for first scan…</span>
    );

  if (compact) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="card p-4 mb-6"
      >
        <div className="flex items-center gap-4">
          <div className="shrink-0">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Pairing QR" className="w-16 h-16 rounded-lg" />
            ) : (
              <div className="w-16 h-16 rounded-lg bg-[#f5f3f0] animate-pulse flex items-center justify-center">
                <QrCode className="w-6 h-6 text-[#9ca3af]" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[#6e6e6e] mb-1">Session ID — share with nurse</p>
            <p className="text-lg font-bold text-[#1f1f1f] tracking-widest font-mono">{sessionId}</p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {probing && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[#9ca3af]">
                  <Wifi className="w-3 h-3 animate-pulse" /> Finding PC on WiFi…
                </span>
              )}
              {!probing && LOCALHOST_RE.test(origin) && (
                <button onClick={() => { setOriginDraft(origin); setEditing(true); }}
                  className="inline-flex items-center gap-1 text-[11px] text-[#c63a22] hover:underline">
                  <Pencil className="w-3 h-3" /> Phone can&apos;t connect? Set your PC&apos;s IP
                </button>
              )}
              {!probing && !LOCALHOST_RE.test(origin) && (
                <span className="text-[11px] text-[#22a67e] font-medium truncate max-w-full">
                  {origin}
                </span>
              )}
            </div>
            <div className="mt-0.5">{scanStatus}</div>
          </div>
          <button
            onClick={handleCopy}
            className="p-2.5 rounded-xl bg-[#c63a22]/10 hover:bg-[#c63a22]/20 text-[#c63a22] transition-colors shrink-0"
            aria-label="Copy dashboard URL"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <AnimatePresence>
          {editing && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="mt-3 pt-3 border-t border-[#ececec]">
                <label className="text-[11px] font-medium text-[#6e6e6e]" htmlFor="origin-edit">
                  Dashboard address phones should open (run `ipconfig` → IPv4 address):
                </label>
                <div className="flex gap-2 mt-1.5">
                  <input id="origin-edit" value={originDraft}
                    onChange={(e) => setOriginDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveOrigin(); }}
                    placeholder="http://192.168.1.5:3000"
                    className="input flex-1 text-xs font-mono" />
                  <button onClick={saveOrigin} disabled={!/^https?:\/\//.test(originDraft.trim())}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40">Save</button>
                </div>
                <p className="text-[10px] text-[#9ca3af] mt-1.5">
                  The QR updates instantly. Phone and PC must be on the same WiFi network.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {(isLanAuto || linkedDevices > 0) && (
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {isLanAuto && (
              <button
                onClick={revertToSelf}
                title="Point the QR back at this device's own address"
                className="inline-flex items-center gap-1 text-[10px] text-[#9ca3af] hover:text-[#c63a22]"
              >
                <RotateCcw className="w-3 h-3" /> Use this device&apos;s address instead
              </button>
            )}
            {linkedDevices > 0 && (
              <button
                onClick={rotate}
                title="Invalidate old QR links and print a fresh unique code for this bed"
                className="inline-flex items-center gap-1 text-[10px] text-[#9ca3af] hover:text-[#c63a22]"
              >
                <RefreshCw className="w-3 h-3" /> New QR ({linkedDevices} device{linkedDevices > 1 ? "s" : ""} linked)
              </button>
            )}
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="card p-8"
    >
      <div className="flex items-center gap-2 mb-4">
        <QrCode className="w-5 h-5 text-[#c63a22]" />
        <h3 className="font-semibold text-[#1f1f1f]">Pair Remote Nurse Console</h3>
      </div>
      <p className="text-sm text-[#6e6e6e] mb-6">
        Scan this QR code with a device to open the nurse monitoring dashboard. Each code is
        unique to this bed and tracks which devices connected.
      </p>
      <div className="flex flex-col items-center gap-6">
        <div className="bg-white rounded-2xl p-4 border-2 border-[#ececec]">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Pairing QR Code" className="w-44 h-44" />
          ) : (
            <div className="w-44 h-44 bg-[#f5f3f0] rounded-xl animate-pulse flex items-center justify-center">
              <QrCode className="w-12 h-12 text-[#6e6e6e]" />
            </div>
          )}
        </div>
        <div className="text-center">
          <p className="text-xs text-[#6e6e6e] mb-1">Session ID</p>
          <p className="text-2xl font-bold text-[#1f1f1f] tracking-[0.3em] font-mono">{sessionId}</p>
          {dashboardUrl && (
            <p className="text-[10px] text-[#9ca3af] mt-2 font-mono break-all max-w-xs mx-auto">{dashboardUrl}</p>
          )}
          <div className="mt-2">{scanStatus}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm"
          >
            {copied ? (
              <><Check className="w-4 h-4" /> Copied!</>
            ) : (
              <><Copy className="w-4 h-4" /> Copy Dashboard URL</>
            )}
          </button>
          <button
            onClick={rotate}
            title="Regenerate this bed's unique pairing token — old QR links stop working"
            className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm"
          >
            <RefreshCw className="w-4 h-4" /> Regenerate
          </button>
        </div>
      </div>
      <div className="mt-6 p-3 rounded-xl bg-[#fffbeb] border border-[#fde68a] flex items-start gap-2">
        <Smartphone className="w-4 h-4 text-[#e8993e] shrink-0 mt-0.5" />
        <p className="text-xs text-[#92400e]">
          Open the nurse dashboard on another device and enter this Session ID to pair.
        </p>
      </div>
    </motion.div>
  );
}
