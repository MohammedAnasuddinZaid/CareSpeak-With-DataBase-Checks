"use client";

import { usePathname } from "next/navigation";

/**
 * The marketing footer.
 *
 * Hidden on `/login` and `/register`. Both routes are a self-contained
 * full-height surface with its own waymark, its own trust line and its own way to
 * the other auth page — a five-column product/legal sitemap underneath a sign-in
 * form is a second navigation competing with the one control the user came for,
 * and on the auth shell it also pushes the page past 100dvh so the shell's own
 * `overflow: hidden` starts clipping.
 */
const BARE_ROUTES = ["/login", "/register"];

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { href: "/hand-mode", label: "Hand Mode" },
      { href: "/eye-mode", label: "Eye Mode" },
      { href: "/nurse-view", label: "Nurse Dashboard" },
      { href: "/emergency", label: "Emergency" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { href: "/about", label: "About" },
      { href: "/logs", label: "Gesture Logs" },
      { href: "/report", label: "Clinical Report" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/terms", label: "Terms of Service" },
      { href: "/license", label: "License" },
    ],
  },
];

export default function SiteFooter() {
  const pathname = usePathname();
  if (BARE_ROUTES.includes(pathname)) return null;

  return (
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
              Turning any laptop into an assistive communication device. On-device AI translates
              gestures and eye movements into speech — private by design, offline-capable, and
              IoT-ready for hospital wards.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h4 className="text-xs font-semibold text-[#1f1f1f] uppercase tracking-widest mb-4">
                {col.heading}
              </h4>
              <div className="space-y-3">
                {col.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="block text-sm text-[#6e6e6e] hover:text-[#c63a22] transition-colors"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-[#ececec] flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="text-sm text-[#6e6e6e]">
            &copy; {new Date().getFullYear()} CareSpeak. Giving every patient a voice.
          </div>
          <div className="flex items-center gap-4 text-xs text-[#6e6e6e]">
            <span>On-device AI &middot; video never leaves the patient device</span>
            <span>Works offline (PWA)</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
