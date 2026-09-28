/**
 * Adopt the signed-in patient's recorded language for speech.
 *
 * The patient picks a language at registration and it is stored on their
 * profile, but the bedside console runs on a shared ward tablet that anybody can
 * sit down at. Without this, a Tamil-speaking patient registered on one device
 * is spoken to in English on the next one -- and the first thing a patient
 * experiences is the wrong language.
 *
 * This is deliberately silent (no greeting) and deliberately overridable: once
 * someone picks a language in the nav that choice wins and this stops applying.
 * Staff carry no patient profile, so a null preference is simply ignored.
 */
"use client";

import { useEffect } from "react";
import { voiceAlert } from "@/lib/tts";

interface SessionUser {
  preferredLanguage?: string | null;
}

export default function ProfileLanguageSync(): null {
  useEffect(() => {
    let cancelled = false;

    async function sync(): Promise<void> {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { user?: SessionUser | null };
        if (cancelled) return;
        voiceAlert.applyProfileLanguage(data.user?.preferredLanguage ?? null);
      } catch {
        // Signed out, offline, or mid-deploy -- the previous language stands.
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
