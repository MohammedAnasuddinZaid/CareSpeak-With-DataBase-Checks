"use client";

/**
 * The auth shell — the frame both `/login` and `/register` sit inside.
 *
 * A full-bleed two-panel layout. The brand panel owns the left half on desktop
 * and collapses to a short band above the form on mobile; the form column is a
 * single centred stack on the light shell surface.
 *
 * The old page put everything in one 416px column floating in the middle of a
 * 200vmax pinwheel: logo, wordmark, "Please Sign In", a sub-line, the card, a
 * trust line and a register line — seven competing elements in 416px, all
 * stacked on top of the same motion. Splitting it gives the pinwheel somewhere
 * to live *beside* the form rather than underneath it, and gives the form a
 * column it can breathe in.
 *
 * Three things about the pinwheel are worth stating, because each was a bug:
 *
 *   1. **The rotation is on the coloured element, not its pseudo-element.** The
 *      first attempt put `rotate(45deg)` on a `::before` that filled the same
 *      200vmax box, so the pseudo rotated about *its own* centre — a full
 *      panel-width away from the intended pivot. Four concentric diamonds do not
 *      tile, so the pinwheel never actually formed. `.pinwheel__panel` is pulled
 *      back with a negative margin so its left-middle lands on the pivot, and
 *      `transform-origin: 0 50%` is stated on the element that carries the
 *      colour.
 *
 *   2. **The card is visible by default.** Driving `opacity` from `:hover` alone
 *      — as the original CSS did — meant the form simply did not exist for
 *      anyone on a touch device, on a keyboard, or who had not happened to rest
 *      a cursor on it. A keyboard user tabbing the page would focus invisible
 *      inputs. The wedges still animate, but they animate *around* a form that
 *      is always there.
 *
 *   3. **The open state is an attribute.** `.auth__brand` flips `data-open`,
 *      which the same CSS selectors that handle `:hover` and `:focus-within`
 *      also read. That gives a ward tablet — the primary device for this app,
 *      and one where `:hover` never fires — the effect through one button,
 *      instead of duplicating the whole thing in JS or in a second set of media
 *      queries.
 *
 * The whole panel is `aria-hidden`: the promise it makes is restated as
 * accessible copy in the form column's own trust line, so nothing is lost by
 * hiding it from assistive technology. That is also why the animate toggle sits
 * outside the tab order — it is a flourish, not something a user needs to
 * operate, and a focusable control inside an `aria-hidden` subtree would be a
 * violation in the other direction.
 *
 * `prefers-reduced-motion` drops every transform in here. A vestibular disorder
 * makes a 200vmax spinning panel genuinely unpleasant, and the column entrance
 * is a 14px rise that nobody would miss.
 */
import { useState } from "react";
import Link from "next/link";
import { Activity, Lock, Radio, Sparkles, WifiOff } from "lucide-react";

/** The three claims the brand panel makes. Short, specific, and each verifiable
 *  elsewhere in the product — a claims list that cannot be checked is noise. */
const PROOF_POINTS = [
  { icon: WifiOff, text: "Runs offline. A dropped ward network never silences a patient." },
  { icon: Lock, text: "Video is processed on the device and never leaves it." },
  { icon: Radio, text: "Every escalation is timestamped and pushed to the nurse in seconds." },
];

export default function LoginStage({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="auth">
      {/* ── Brand panel ──
          The pinwheel is two wrappers, each carrying a `::before` and an
          `::after` — four wedges, one per pseudo-element. */}
      <section className="auth__brand" data-open={open ? "true" : "false"} aria-hidden="true">
        <div className="pinwheel">
          <span className="pinwheel__panel" />
          <span className="pinwheel__panel pinwheel__panel--b" />
        </div>
        <div className="aurora" />
        <div className="grain" />
        <div className="vignette" />

        <Link href="/" className="auth__brandmark auth__brandmark--onstage" tabIndex={-1}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="auth__brandmark-img" />
          <span className="auth__brandmark-name">CareSpeak</span>
        </Link>

        <div className="auth__brand-body">
          <p className="auth__eyebrow">
            <Activity />
            Assistive communication
          </p>

          <h2 className="auth__headline">
            Every patient gets <em>a voice</em>.
          </h2>

          <p className="auth__lede">
            Hand gestures, eye movements and wearable vitals, turned into speech. Built for
            the bedside, not the browser.
          </p>

          <ul className="auth__points">
            {PROOF_POINTS.map(({ icon: Icon, text }) => (
              <li className="auth__point" key={text}>
                <span className="auth__point-icon">
                  <Icon />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="auth__brand-foot">
          <span>
            <Lock />
            Sessions encrypted
          </span>
          <span>
            <Activity />
            Access logged
          </span>
          <button
            type="button"
            aria-pressed={open}
            onClick={() => setOpen((v) => !v)}
            tabIndex={-1}
            className="auth-toggle auth-toggle--edge"
          >
            <Sparkles />
            {open ? "Close" : "Animate"}
          </button>
        </div>
      </section>

      {/* ── Form column ──
          The entrance is a CSS animation rather than a mounted state, so the
          column is never stuck at `opacity: 0` if hydration is slow. */}
      <section className="auth__form">
        <div className="auth__form-inner">{children}</div>
      </section>
    </div>
  );
}
