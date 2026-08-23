"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { QrCode, Copy, Check, Smartphone, Pencil } from "lucide-react";
import { getNurseDashboardUrl, getDashboardOrigin, setDashboardOrigin } from "@/lib/session";
import QRCode from "qrcode";

interface QRPairingDisplayProps {
  sessionId: string;
  compact?: boolean;
}

export default function QRPairingDisplay({ sessionId, compact = false }: QRPairingDisplayProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [originDraft, setOriginDraft] = useState("");
  const [origin, setOrigin] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setOrigin(getDashboardOrigin());
  }, []);

  useEffect(() => {
    if (!origin) return;
    const url = `${origin.replace(/\/+$/, "")}/nurse-view?session=${sessionId}`;
    QRCode.toDataURL(url, {
      width: compact ? 160 : 280,
      margin: 1,
      color: { dark: "#1f1f1f", light: "#ffffff" },
    }).then(setQrDataUrl).catch(() => {});
  }, [sessionId, compact, origin]);

  const dashboardUrl = origin ? `${origin.replace(/\/+$/, "")}/nurse-view?session=${sessionId}` : "";

  const saveOrigin = () => {
    setDashboardOrigin(originDraft);
    setOrigin(getDashboardOrigin());
    setEditing(false);
  };

  const handleCopy = async () => {
    if (!dashboardUrl) return;
    try {
      await navigator.clipboard.writeText(dashboardUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (compact) {
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin);
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
              <canvas ref={canvasRef} className="w-16 h-16 rounded-lg bg-[#f5f3f0]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[#6e6e6e] mb-1">Session ID — share with nurse</p>
            <p className="text-lg font-bold text-[#1f1f1f] tracking-widest font-mono">{sessionId}</p>
            {isLocalhost && (
              <button onClick={() => { setOriginDraft(origin); setEditing(true); }}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-[#c63a22] hover:underline">
                <Pencil className="w-3 h-3" /> Phone can&apos;t connect? Set your PC&apos;s IP
              </button>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="p-2.5 rounded-xl bg-[#c63a22]/10 hover:bg-[#c63a22]/20 text-[#c63a22] transition-all shrink-0"
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
        Scan this QR code with a device to open the nurse monitoring dashboard.
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
        </div>
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
