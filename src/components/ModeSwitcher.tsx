"use client";

/**
 * The input-method toggle for the two gesture workspaces.
 *
 * Hand Mode and Eye Mode are not two pages. They are two ways of driving the
 * same job — turning a movement into a word — and they were being presented as
 * two destinations in the global site bar, which put them in a nav group with
 * Nurse, Ward and Logs. That was wrong twice over. It gave a workspace state the
 * same weight as a location, and it spent two of the bar's few permanent slots
 * on a choice the patient changes *while working*, not while navigating.
 *
 * So they moved here, into the header of the workspace itself, where the choice
 * sits directly above the camera and the gesture guide it configures. Switching
 * is now visible, adjacent and contextual: you can see which method you are
 * using without looking away from the thing the method is for.
 *
 * Why a segmented control and not a `<select>`: this is a two-way choice between
 * two named methods, both of which stay meaningful at any width, and the patient
 * needs to be able to hit the target with a hand that may be the one they are
 * using to communicate. That is a large, always-visible target — not a control
 * that hides its options behind a second click. `role="radiogroup"` with real
 * arrow-key handling, because a control the user has to click precisely and
 * cannot Tab between is a barrier for exactly the people this product is for.
 *
 * Navigating rather than toggling in place is deliberate: the two modes mount
 * different camera pipelines and different model assets, and the old behaviour —
 * keeping one page mounted and swapping a state variable — meant the previous
 * pipeline stayed alive behind the new one, still holding the camera. A real
 * navigation unmounts it.
 */
import { useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Eye, Hand } from "lucide-react";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/hooks/useUiLanguage";

const MODES = [
  { href: "/hand-mode", key: "handMode" as const, fallback: "Hand Mode", icon: Hand },
  { href: "/eye-mode", key: "eyeMode" as const, fallback: "Eye Mode", icon: Eye },
];

/** Where the two modes sit in a row. Arrow keys move within this list, so the
 *  order is the keyboard order and it is fixed. */
const ROVING_INDEX = MODES.map((_, i) => i);

export default function ModeSwitcher({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const lang = useUiLanguage();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = MODES.findIndex((m) => m.href === pathname);
  const active = current === -1 ? 0 : current;

  const label = useCallback(
    (i: number) => t(lang, MODES[i].key) || MODES[i].fallback,
    [lang],
  );

  /**
   * Arrow keys move the selection and activate it, which is how a radiogroup is
   * specified to behave. Without this a keyboard user has to Tab to each mode in
   * turn to find out which one is active, and the whole point of the control is
   * answering "what am I using right now?".
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + MODES.length) % MODES.length;
    router.push(MODES[next].href);
    // The route change unmounts and remounts this control, so the focus is
    // re-established on the same frame rather than being lost to <body>.
    requestAnimationFrame(() => refs.current[next]?.focus());
  };

  return (
    <div
      role="radiogroup"
      aria-label="Input method"
      className={`mode-switch ${className}`}
      onKeyDown={onKeyDown}
    >
      {ROVING_INDEX.map((i) => {
        const { href, icon: Icon } = MODES[i];
        const isActive = i === active;
        return (
          <button
            key={href}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (!isActive) router.push(href);
            }}
            className="mode-switch__opt"
          >
            {isActive && (
              <motion.span
                layoutId="mode-switch-pill"
                className="mode-switch__pill"
                transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.6 }}
              />
            )}
            <Icon className="mode-switch__icon" aria-hidden="true" />
            <span className="mode-switch__text">{label(i)}</span>
          </button>
        );
      })}
    </div>
  );
}
