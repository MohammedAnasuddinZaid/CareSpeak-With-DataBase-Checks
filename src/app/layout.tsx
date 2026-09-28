import type { Metadata, Viewport } from "next";
import "@/app/globals.css";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import ErrorBoundary from "@/components/ErrorBoundary";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ProfileLanguageSync from "@/components/ProfileLanguageSync";

export const metadata: Metadata = {
  title: "CareSpeak — Giving Every Patient a Voice",
  description:
    "Assistive communication for patients who cannot speak or move easily. Hand gestures, eye movements and wearable vitals — converted to speech and streamed to clinicians in real time. Works offline.",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "default",
    "apple-mobile-web-app-title": "CareSpeak",
    "mobile-web-app-capable": "yes",
    "application-name": "CareSpeak",
  },
};

export const viewport: Viewport = {
  themeColor: "#c63a22",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        {/* Raleway is the sign-in stage's face. Loaded with `display=swap` so a
            blocked or slow Google Fonts request falls back to the system stack
            instead of leaving the form invisible, and preloaded so it is usually
            there before the card paints. */}
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link
          rel="preload"
          as="style"
          href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700&display=swap"
        />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="min-h-screen antialiased">
        <ServiceWorkerRegister />
        <ProfileLanguageSync />
        <ErrorBoundary>
          <Navbar />
          {/* The floor is `100vh` and not `100dvh` on purpose: the auth shell
              sizes itself to `100dvh`, which is never shorter, so the floor is
              inert there — whereas on a route whose content is short, `100dvh`
              would leave a gap that grows every time a mobile browser hides its
              URL bar. */}
          <main className="min-h-screen">{children}</main>
        </ErrorBoundary>
        <SiteFooter />
      </body>
    </html>
  );
}
