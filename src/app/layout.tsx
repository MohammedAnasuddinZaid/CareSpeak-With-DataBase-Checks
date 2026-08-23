import type { Metadata, Viewport } from "next";
import "@/app/globals.css";
import Navbar from "@/components/Navbar";
import ErrorBoundary from "@/components/ErrorBoundary";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

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
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="min-h-screen antialiased">
        <ServiceWorkerRegister />
        <ErrorBoundary>
          <Navbar />
          <main className="min-h-screen">{children}</main>
        </ErrorBoundary>
        <footer className="border-t border-[#ececec] bg-white py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-10">
              <div className="md:col-span-2">
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/logo.png" alt="CareSpeak logo" className="w-full h-full object-cover" />
                  </div>
                  <span className="font-bold text-lg text-[#1f1f1f]">CareSpeak</span>
                </div>
                <p className="text-[#6e6e6e] text-sm leading-relaxed max-w-md">
                  Turning any laptop into an assistive communication device.
                  On-device AI translates gestures and eye movements into speech —
                  private by design, offline-capable, and IoT-ready for hospital wards.
                </p>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-4">Product</h4>
                <div className="space-y-3">
                  {[
                    { href: "/hand-mode", label: "Hand Mode" },
                    { href: "/eye-mode", label: "Eye Mode" },
                    { href: "/nurse-view", label: "Nurse Dashboard" },
                    { href: "/emergency", label: "Emergency" },
                  ].map((link) => (
                    <a key={link.href} href={link.href}
                      className="block text-sm text-[#6e6e6e] hover:text-[#c63a22] transition-colors">{link.label}</a>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-4">Resources</h4>
                <div className="space-y-3">
                  {[
                    { href: "/about", label: "About" },
                    { href: "/logs", label: "Gesture Logs" },
                    { href: "/report", label: "Clinical Report" },
                  ].map((link) => (
                    <a key={link.href} href={link.href}
                      className="block text-sm text-[#6e6e6e] hover:text-[#c63a22] transition-colors">{link.label}</a>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-4">Legal</h4>
                <div className="space-y-3">
                  {[
                    { href: "/privacy", label: "Privacy Policy" },
                    { href: "/terms", label: "Terms of Service" },
                    { href: "/license", label: "License" },
                  ].map((link) => (
                    <a key={link.href} href={link.href}
                      className="block text-sm text-[#6e6e6e] hover:text-[#c63a22] transition-colors">{link.label}</a>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-12 pt-8 border-t border-[#ececec] flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="text-sm text-[#6e6e6e]">
                © {new Date().getFullYear()} CareSpeak. Giving every patient a voice.
              </div>
              <div className="flex items-center gap-4 text-xs text-[#6e6e6e]">
                <span>On-device AI · video never leaves the patient device</span>
                <span>Works offline (PWA)</span>
              </div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
