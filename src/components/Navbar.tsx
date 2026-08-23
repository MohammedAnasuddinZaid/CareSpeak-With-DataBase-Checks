"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Menu, X, Hand, Eye, Activity, FileText, Info, AlertTriangle, Camera, ClipboardList, BedDouble } from "lucide-react";
import { SUPPORTED_LANGUAGES, SupportedLanguage } from "@/types";
import { voiceAlert } from "@/lib/tts";

const NAV_LINKS = [
  { href: "/hand-mode", label: "Hand Mode", icon: Hand },
  { href: "/eye-mode", label: "Eye Mode", icon: Eye },
  { href: "/cctv", label: "CCTV", icon: Camera },
  { href: "/nurse-view", label: "Nurse", icon: Activity },
  { href: "/ward", label: "Ward", icon: BedDouble },
  { href: "/logs", label: "Logs", icon: FileText },
  { href: "/report", label: "Report", icon: ClipboardList },
  { href: "/about", label: "About", icon: Info },
  { href: "/emergency", label: "Emergency", icon: AlertTriangle, highlight: true },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const currentLang = voiceAlert.getLanguage();
  const currentLangInfo = SUPPORTED_LANGUAGES[currentLang];
  const isLanding = pathname === "/";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleLanguageChange = (lang: SupportedLanguage) => {
    voiceAlert.setLanguage(lang);
    setLangOpen(false);
  };

  const showSolid = scrolled || !isLanding;

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      showSolid ? "nav-solid" : "nav-transparent"
    }`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <a href="/" className="flex items-center gap-2.5 shrink-0 group">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 group-hover:shadow-md group-hover:shadow-[#c63a22]/20 overflow-hidden">
              <img src="/logo.png" alt="CareSpeak" className="w-full h-full object-cover" />
            </div>
            <div className="hidden sm:block">
              <span className={`font-bold text-lg tracking-tight transition-colors duration-300 ${showSolid ? "text-[#1f1f1f]" : "text-white"}`}>
                CareSpeak
              </span>
              
            </div>
          </a>

          <div className="hidden lg:flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const Icon = link.icon;
              const isActive = pathname === link.href;
              return (
                <a key={link.href} href={link.href}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? link.highlight
                        ? "bg-[#c63a22]/10 text-[#c63a22]"
                        : "bg-[#c63a22]/10 text-[#c63a22]"
                      : link.highlight
                      ? showSolid
                        ? "text-[#6e6e6e] hover:text-[#c63a22] hover:bg-[#c63a22]/5"
                        : "text-white/70 hover:text-white hover:bg-white/10"
                      : showSolid
                      ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                      : "text-white/70 hover:text-white hover:bg-white/10"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {link.label}
                </a>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setLangOpen(!langOpen)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                  showSolid ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]" : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
              >
                <span className="text-sm">{currentLangInfo.native}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${langOpen ? "rotate-180" : ""}`} />
              </button>
              <AnimatePresence>
                {langOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.96 }}
                    className="absolute right-0 top-full mt-2 w-48 rounded-2xl bg-white border border-[#ececec] shadow-lg shadow-black/5 py-2 z-50"
                  >
                    {(Object.entries(SUPPORTED_LANGUAGES) as [SupportedLanguage, { label: string; native: string }][]).map(([code, info]) => (
                      <button key={code} onClick={() => handleLanguageChange(code)}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                          currentLang === code ? "text-[#c63a22] bg-[#c63a22]/5 font-medium" : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                        }`}
                      >
                        <span>{info.native}</span>
                        <span className="text-[#9ca3af] text-xs">{info.label}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              onClick={() => setOpen(!open)}
              className={`lg:hidden p-2 rounded-xl transition-all duration-200 ${
                showSolid ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="lg:hidden border-t border-[#ececec] bg-white"
          >
            <div className="px-4 py-3 space-y-1">
              {NAV_LINKS.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href;
                return (
                  <a key={link.href} href={link.href} onClick={() => setOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                      isActive
                        ? link.highlight ? "bg-[#c63a22]/10 text-[#c63a22]" : "bg-[#c63a22]/10 text-[#c63a22]"
                        : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {link.label}
                  </a>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
