"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { ArrowRight, Hand, Eye, Volume2, Shield, Zap, Heart, CheckCircle, Sparkles, Activity, Users, Camera } from "lucide-react";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] as const } },
};

const stagger = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const FEATURES = [
  { icon: Hand, title: "Hand Gesture Recognition", desc: "Five distinct gestures — thumbs up, thumbs down, HELP, both-hands WATER, plus a one-handed palm hold for stroke patients. Detected fully on-device.", color: "#c63a22" },
  { icon: Eye, title: "Eye Movement Tracking", desc: "Iris tracking, double-blink HELP and mouth gestures let completely paralyzed patients communicate — no hand movement required.", color: "#22a67e" },
  { icon: Volume2, title: "Instant Voice Alerts", desc: "Every gesture is spoken aloud in one of 10 Indian languages — nurses hear the need without watching any screen.", color: "#e8993e" },
  { icon: Users, title: "Two-Way Nurse Messaging", desc: "Nurses reply by typing or voice; patients see a full-screen banner and hear it instantly. Communication finally goes both ways.", color: "#8b5cf6" },
  { icon: Activity, title: "Predictive Risk Engine", desc: "Live risk score from alertness, blink rate and HELP frequency. Rules auto-escalate critical patterns with a full audit trail.", color: "#dc2626" },
  { icon: Shield, title: "100% Private by Design", desc: "MediaPipe WASM runs in your browser. No video, no images, no audio ever leave the patient device. CSP-hardened, session-isolated.", color: "#3b82f6" },
  { icon: Zap, title: "Offline-First for Rural India", desc: "AI models cached on first load; every alert queued in IndexedDB and auto-flushed when connectivity returns. Built for real hospital networks.", color: "#0ea5e9" },
  { icon: Heart, title: "IoT Wearable Ready", desc: "A ₹1,100 ESP32 wristband streams heart rate & SpO₂ and carries a physical SOS button — wired straight into the same dashboard.", color: "#c63a22" },
];

const STATS = [
  { value: "478", label: "Face landmarks tracked per frame", icon: Eye },
  { value: "10", label: "Indian languages supported", icon: Volume2 },
  { value: "<1s", label: "Gesture to nurse console latency", icon: Zap },
  { value: "₹0", label: "Software cost — works on any laptop", icon: Heart },
];

function SectionHeading({ label, title, subtitle }: { label?: string; title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-16">
      {label && (
        <motion.div variants={fadeUp} className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#c63a22]/5 border border-[#c63a22]/15 text-[#c63a22] text-sm font-medium mb-4">
          <Sparkles className="w-3.5 h-3.5" />
          {label}
        </motion.div>
      )}
      <motion.h2 variants={fadeUp} className="text-3xl sm:text-4xl lg:text-5xl font-bold text-[#1f1f1f] tracking-tight">
        {title}
      </motion.h2>
      {subtitle && (
        <motion.p variants={fadeUp} className="mt-4 text-lg text-[#6e6e6e] max-w-2xl mx-auto">
          {subtitle}
        </motion.p>
      )}
    </div>
  );
}

function Section({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <section ref={ref} className={`section-padding ${className}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          variants={stagger}
        >
          {children}
        </motion.div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div className="overflow-hidden">

      {/* ── Hero Section — video preserved ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0">
          <video autoPlay muted loop playsInline poster="/hero-bg.jpg" className="w-full h-full object-cover">
            <source src="/hero-bg.mp4" type="video/mp4" />
          </video>
          <div className="absolute inset-0 hero-overlay" />
          <div className="absolute inset-0 hero-overlay-bottom" />
        </div>

        <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-32 pb-20 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/10 border border-white/15 text-white/80 text-sm font-medium mb-6 backdrop-blur-sm">
              <Activity className="w-3.5 h-3.5" />
              Assistive Communication
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="text-5xl sm:text-6xl lg:text-8xl font-extrabold text-white leading-[1.05] tracking-tight"
          >
            Giving Every Patient{" "}
            <span className="gradient-text">a Voice</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="mt-6 text-lg sm:text-xl text-white/70 leading-relaxed max-w-2xl mx-auto"
          >
            Assistive communication for patients who cannot speak or move easily. 
            Use hand gestures or eye movements to express needs — 
            instantly converted to speech. No setup. No servers. No cost.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mt-10 flex flex-col sm:flex-row gap-4 justify-center"
          >
            <a href="/hand-mode"
              className="group inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-2xl bg-[#c63a22] text-white font-semibold text-lg shadow-lg shadow-[#c63a22]/25 hover:shadow-xl hover:shadow-[#c63a22]/30 hover:translate-y-[-2px] active:translate-y-0 transition-[color,background-color,border-color,box-shadow,transform] duration-200"
            >
              <Hand className="w-5 h-5 transition-transform group-hover:-rotate-6" />
              Try Hand Mode
              <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-300" />
            </a>
            <a href="/eye-mode"
              className="group inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-2xl bg-white/10 border border-white/20 text-white font-semibold text-lg hover:bg-white/20 hover:border-white/30 hover:translate-y-[-2px] active:translate-y-0 transition-[color,background-color,border-color,box-shadow,transform] duration-200"
            >
              <Eye className="w-5 h-5 transition-transform group-hover:-rotate-6" />
              Try Eye Mode
              <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-300" />
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-12 flex flex-wrap items-center justify-center gap-6 text-sm text-white/60"
          >
            {["100% on-device AI", "Works offline", "10 Indian languages"].map((text, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4 text-[#22a67e]" />
                {text}
              </span>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="relative -mt-16 pb-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="grid grid-cols-2 md:grid-cols-4 gap-4"
          >
            {STATS.map((stat, i) => {
              const Icon = stat.icon;
              return (
                <div key={i} className="card p-6 text-center animate-float" style={{ animationDelay: `${i * 0.3}s` }}>
                  <Icon className="w-6 h-6 text-[#c63a22] mx-auto mb-3" />
                  <div className="text-3xl font-bold text-[#1f1f1f]">{stat.value}</div>
                  <div className="text-xs text-[#6e6e6e] mt-1">{stat.label}</div>
                </div>
              );
            })}
          </motion.div>
        </div>
      </section>

      {/* ── Challenge ── */}
      <Section className="bg-[#f5f3f0]">
        <SectionHeading
          label="The Challenge"
          title="Millions cannot communicate basic needs"
          subtitle="Hospitalized patients who are intubated, paralyzed, or speech-impaired struggle to express pain, thirst, or the need for help. Nurses cannot always be at the bedside."
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {[
            { title: "ICU & Critical Care", desc: "Patients on ventilators who cannot speak due to breathing tubes", icon: Activity },
            { title: "Stroke & Paralysis", desc: "Individuals with limited or no limb movement who need alternative communication", icon: Heart },
            { title: "Post-Surgery Recovery", desc: "Patients emerging from anesthesia with temporary speech and mobility impairment", icon: Users },
          ].map((item, i) => {
            const Icon = item.icon;
            return (
              <motion.div key={i} variants={fadeUp} className="card p-6 animate-float" style={{ animationDelay: `${i * 0.4}s` }}>
                <Icon className="w-8 h-8 text-[#c63a22] mb-3" />
                <h3 className="font-bold text-[#1f1f1f] mb-2">{item.title}</h3>
                <p className="text-sm text-[#6e6e6e]">{item.desc}</p>
              </motion.div>
            );
          })}
        </div>
      </Section>

      {/* ── Solution ── */}
      <Section>
        <SectionHeading
          label="The Solution"
          title="How CareSpeak works"
          subtitle="On-device computer vision that turns any laptop with a webcam into an assistive communication device."
        />
        <motion.div variants={stagger} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((feat, i) => {
            const Icon = feat.icon;
            return (
              <motion.div key={i} variants={fadeUp} className="group card p-8 animate-glow" style={{ animationDelay: `${i * 0.4}s` }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 transition-transform duration-300 group-hover:scale-110 group-hover:-translate-y-1"
                  style={{ background: `${feat.color}12`, color: feat.color }}
                >
                  <Icon className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-[#1f1f1f] mb-2">{feat.title}</h3>
                <p className="text-[#6e6e6e] text-sm leading-relaxed">{feat.desc}</p>
              </motion.div>
            );
          })}
        </motion.div>
      </Section>

      {/* ── How it works ── */}
      <Section className="bg-[#f5f3f0]">
        <SectionHeading
          title="Three simple steps"
          subtitle="From camera to voice alert in under 500ms"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          {[
            { num: "01", title: "Camera detects", desc: "MediaPipe tracks 21 hand landmarks or 478 face landmarks in real-time via WebAssembly at 30+ FPS" },
            { num: "02", title: "Engine classifies", desc: "Rule-based classifier with temporal smoothing identifies the gesture and assigns a confidence score" },
            { num: "03", title: "Voice speaks", desc: "Browser TTS announces the need aloud in the patient's chosen language — nurses hear it immediately" },
          ].map((step, i) => (
            <motion.div key={i} variants={fadeUp} className="text-center group">
              <div className="w-16 h-16 rounded-2xl bg-[#c63a22] flex items-center justify-center mx-auto mb-5 shadow-md group-hover:shadow-lg group-hover:shadow-[#c63a22]/20 group-hover:scale-110 transition-[box-shadow,transform] duration-300 animate-float" style={{ animationDelay: `${i * 0.5}s` }}>
                <span className="text-2xl font-bold text-white">{step.num}</span>
              </div>
              <h3 className="text-xl font-bold text-[#1f1f1f] mb-3">{step.title}</h3>
              <p className="text-[#6e6e6e] text-sm leading-relaxed max-w-xs mx-auto">{step.desc}</p>
            </motion.div>
          ))}
        </div>
      </Section>

      {/* ── CTA ── */}
      <section className="relative py-24 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#c63a22] via-[#a32e1a] to-[#8f2414]" />
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-white/5 blur-[100px]" />
          <div className="absolute bottom-0 left-0 w-96 h-96 rounded-full bg-white/5 blur-[100px]" />
        </div>
        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="text-4xl sm:text-5xl font-bold text-white leading-tight">
              Ready to give every patient a voice?
            </h2>
            <p className="mt-4 text-lg text-white/70">
              No installation. No setup. Just open Chrome and start communicating.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
              <a href="/hand-mode"
                className="group inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-2xl bg-white text-[#c63a22] font-semibold text-lg shadow-xl hover:shadow-2xl hover:translate-y-[-2px] active:translate-y-0 transition-[color,background-color,border-color,box-shadow,transform] duration-200"
              >
                <Hand className="w-5 h-5" />
                Try Hand Mode
                <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-300" />
              </a>
              <a href="/eye-mode"
                className="group inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-2xl bg-white/10 text-white border border-white/20 font-semibold text-lg hover:bg-white/20 hover:border-white/30 hover:translate-y-[-2px] active:translate-y-0 transition-[color,background-color,border-color,box-shadow,transform] duration-200"
              >
                <Eye className="w-5 h-5" />
                Try Eye Mode
                <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-300" />
              </a>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
