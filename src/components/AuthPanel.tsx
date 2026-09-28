"use client";

/**
 * Sign-in surface.
 *
 * One component owns all three methods (password, emailed code, Google) because
 * they share the same post-login destination and the same error presentation,
 * and splitting them into three routes would mean duplicating both.
 *
 * The emailed-code path is deliberately a fallback rather than the default: a
 * hospital tablet is often shared, and a six-digit code typed on a shared device
 * leaves a weaker credential behind than a password on a managed account.
 *
 * Layout notes, since the old version was the crowded one:
 *
 *   - The Google block, the method tabs and the form are three `.auth__section`s
 *     in **one** card with hairline rules between them, instead of three nested
 *     boxes each with their own border and padding. One card, one set of radii.
 *   - The tab indicator is a single element with `layoutId`, so it *slides*
 *     between Password and Email code rather than blinking on and off.
 *   - Every field is a wrapper (`.auth-field`) with the icon, the input and the
 *     reveal button inside it, so the focus ring wraps all three as one shape
 *     instead of stopping at the input's edge.
 *   - The six-digit code is six real inputs, so a phone shows six native
 *     numeric keypads, the platform can autofill an SMS code into the first
 *     cell, and each cell is its own 44px tap target.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

type Method = "password" | "otp";
type Phase = "idle" | "sending" | "sent" | "verifying";

interface AuthUser {
  id: number;
  displayName: string;
  role: "patient" | "nurse" | "doctor" | "admin";
  email: string;
}

interface Capabilities {
  google: boolean;
  emailOtp: boolean;
  password: boolean;
}

/** Where each role lands after signing in. */
function destinationFor(role: AuthUser["role"]): string {
  if (role === "nurse" || role === "doctor" || role === "admin") return "/nurse-view";
  return "/hand-mode";
}

const OTP_LENGTH = 6;
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Copy for an error code handed back by the Google callback. */
const GOOGLE_ERRORS: Record<string, string> = {
  declined: "Google sign-in was cancelled.",
  consent_required: "Google asked for consent that was not granted.",
  state_mismatch: "That sign-in link could not be verified. Please try again.",
  pkce_mismatch: "That sign-in link could not be verified. Please try again.",
  flow_expired: "The sign-in took too long. Please try again.",
  account_suspended: "This account has been suspended. Contact your administrator.",
  google_unavailable: "Google Sign-In is not configured on this server.",
};

/**
 * Caps Lock is the single most common cause of a "correct" password being
 * rejected, and the user cannot see it from the masked field — so the form says
 * so rather than letting them retype the same wrong thing three times.
 *
 * `getModifierState` is missing from the DOM lib types in some configurations,
 * hence the guard.
 */
function capsLockOn(el: EventTarget | null): boolean {
  const get = (el as { getModifierState?: (k: string) => boolean } | null)?.getModifierState;
  return typeof get === "function" ? get.call(el, "CapsLock") : false;
}

/**
 * `nextPath` arrives as a prop rather than through `useSearchParams` on purpose.
 * A client `useSearchParams` forces the entire route into a Suspense boundary,
 * and because the shared shell is a client component, that boundary swallows
 * the *whole* page — the server ships an empty background rectangle and the
 * user watches a blank screen paint, then fill in. Reading the one value we
 * need on the server keeps the shell, the copy and the form in the initial HTML.
 */
export default function AuthPanel({
  nextPath = null,
  authError = null,
}: {
  nextPath?: string | null;
  authError?: string | null;
}) {
  const router = useRouter();

  const [method, setMethod] = useState<Method>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [digits, setDigits] = useState<string[]>(() => Array(OTP_LENGTH).fill(""));
  const [phase, setPhase] = useState<Phase>("idle");
  // Seeded from the query string rather than pushed in by an effect, so a failed
  // Google hand-off explains itself in the first paint instead of flashing in a
  // moment later.
  const [error, setError] = useState<string | null>(
    () => (authError ? (GOOGLE_ERRORS[authError] ?? "Google sign-in could not be completed.") : null),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<Capabilities>({ google: false, emailOtp: false, password: true });
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);

  const code = useMemo(() => digits.join(""), [digits]);

  /** Only a plain same-origin path is honoured — see `go`. */
  const safeNext = useMemo(
    () =>
      nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : null,
    [nextPath],
  );

  // Which methods this server actually supports. Asking beats guessing: a Google
  // button on a server with no client id is a dead end for the user.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { capabilities?: Capabilities } | null) => {
        if (!cancelled && data?.capabilities) setCaps(data.capabilities);
      })
      .catch(() => {
        /* the form still works with password-only; nothing to report */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Someone who is already signed in has no business on this page — showing them
   * a login form that silently fails is worse than sending them where they were
   * going.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: AuthUser } | null) => {
        if (cancelled || !data?.user) return;
        router.replace(safeNext ?? destinationFor(data.user.role));
      })
      .catch(() => {
        /* not signed in, or offline: the form below is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [safeNext, router]);

  const go = useCallback(
    (user: AuthUser) => {
      // A `next` from the URL is attacker-controllable, so it is only honoured
      // when it is a plain same-origin path.
      router.push(safeNext ?? destinationFor(user.role));
      router.refresh();
    },
    [safeNext, router],
  );

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok || !data.user) {
        setError(data.error ?? "Sign-in failed.");
        return;
      }
      go(data.user);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPhase("sending");
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        expiresInSeconds?: number;
        devCode?: string;
        delivery?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Could not send a code.");
        setPhase("idle");
        return;
      }
      setPhase("sent");
      // On localhost there is no inbox to check, so the server returns the code
      // and we show it. That is gated on a loopback APP_ORIGIN server-side.
      setNotice(
        data.devCode
          ? `Development server: your code is ${data.devCode}`
          : `We sent a 6-digit code to ${email}. It expires in ${Math.round(
              (data.expiresInSeconds ?? 600) / 60,
            )} minutes.`,
      );
      // The first cell is focused as soon as the phase flips, not on a timer.
      requestAnimationFrame(() => cellRefs.current[0]?.focus());
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPhase("idle");
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPhase("verifying");
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok || !data.user) {
        setError(data.error ?? "That code is not correct.");
        setPhase("sent");
        return;
      }
      go(data.user);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPhase("sent");
    }
  }

  /* ── One-time code entry ──
     Six real inputs, kept in step by hand. `maxLength={1}` per cell is what makes
     paste and SMS-autofill work: the browser drops the rest of the value into
     the remaining cells because the form's own `onChange` distributes it. */
  const setDigit = (index: number, raw: string) => {
    const chars = raw.replace(/\D/g, "");
    if (!chars.length) {
      setDigits((d) => d.map((v, i) => (i === index ? "" : v)));
      return;
    }
    setDigits((d) => {
      const next = [...d];
      // A pasted or autofilled chunk fills from the cell it landed on.
      for (let i = 0; i < chars.length && index + i < OTP_LENGTH; i += 1) {
        next[index + i] = chars[i];
      }
      return next;
    });
    const target = Math.min(index + chars.length, OTP_LENGTH - 1);
    cellRefs.current[target]?.focus();
  };

  const onCellKey = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      e.preventDefault();
      setDigits((d) => d.map((v, i) => (i === index - 1 ? "" : v)));
      cellRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      cellRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      e.preventDefault();
      cellRefs.current[index + 1]?.focus();
    }
  };

  const resetCode = () => {
    setDigits(Array(OTP_LENGTH).fill(""));
    setPhase("idle");
    setNotice(null);
    setError(null);
    requestAnimationFrame(() => cellRefs.current[0]?.focus());
  };

  const switchMethod = (next: Method) => {
    setMethod(next);
    setError(null);
    setNotice(null);
    setPhase("idle");
    setDigits(Array(OTP_LENGTH).fill(""));
  };

  const startGoogle = () => {
    // A full navigation, not fetch: the callback sets cookies via redirect and
    // we want the browser to follow the whole chain.
    window.location.href = `/api/auth/google${safeNext ? `?next=${encodeURIComponent(safeNext)}` : ""}`;
  };

  const showOtpEntry = method === "otp" && (phase === "sent" || phase === "verifying");
  const codeComplete = digits.every((d) => d !== "");

  return (
    <>
      <div className="auth__head">
        <h1 className="auth__title">Sign in</h1>
        <p className="auth__subtitle">
          Access your bedside console or ward dashboard.
        </p>
      </div>

      <div className="auth__card">
        {caps.google && (
          <div className="auth__section auth__section--social">
            <button type="button" onClick={startGoogle} className="auth-btn auth-btn--ghost">
              <GoogleMark />
              Continue with Google
            </button>
            <p className="auth-rule">or</p>
          </div>
        )}

        {caps.emailOtp && (
          <div className="auth__section auth__section--tabs">
            <div className="auth-tabs" role="tablist" aria-label="Sign-in method">
              {(
                [
                  { id: "password" as const, label: "Password", icon: KeyRound },
                  { id: "otp" as const, label: "Email code", icon: Mail },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = method === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchMethod(tab.id)}
                    className="auth-tab"
                  >
                    {active && (
                      <motion.span
                        layoutId="auth-tab"
                        className="auth-tab__indicator"
                        transition={{ type: "spring", stiffness: 480, damping: 40 }}
                      />
                    )}
                    <Icon />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div
          className={
            caps.google || caps.emailOtp ? "auth__section auth__section--form" : "auth__section"
          }
        >
          {(error || notice) && (
            <div className="auth-stack">
              {error && (
                <p className="auth-alert auth-alert--error" role="alert">
                  <AlertCircle />
                  <span>{error}</span>
                </p>
              )}
              {notice && (
                <p className="auth-alert auth-alert--info">
                  <CheckCircle2 />
                  <span>{notice}</span>
                </p>
              )}
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {/* ── Password ── */}
            {method === "password" && (
              <motion.form
                key="password"
                onSubmit={submitPassword}
                className="auth-stack"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: EASE }}
              >
                <div>
                  <label className="auth-label" htmlFor="email">
                    <span className="auth-label__text">Work email</span>
                  </label>
                  <div className="auth-field">
                    <Mail className="auth-field__icon" />
                    <input
                      id="email"
                      className="auth-field__input"
                      type="email"
                      name="email"
                      autoComplete="username"
                      inputMode="email"
                      spellCheck={false}
                      placeholder="you@hospital.org"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div>
                  <div className="auth-label">
                    <label className="auth-label__text" htmlFor="password">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        switchMethod("otp");
                        setNotice(
                          "Enter your email address and we will send a one-time code — no password needed.",
                        );
                      }}
                      className="auth-link"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="auth-field">
                    <Lock className="auth-field__icon" />
                    <input
                      id="password"
                      className="auth-field__input"
                      type={revealed ? "text" : "password"}
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setCapsLock(capsLockOn(e.target));
                      }}
                      onKeyUp={(e) => setCapsLock(capsLockOn(e.currentTarget))}
                      onBlur={(e) => {
                        setCapsLock(capsLockOn(e.currentTarget));
                        setRevealed(false);
                      }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setRevealed((v) => !v)}
                      aria-label={revealed ? "Hide password" : "Show password"}
                      aria-pressed={revealed}
                      className="auth-field__action"
                    >
                      {revealed ? <EyeOff /> : <Eye />}
                    </button>
                  </div>
                  {capsLock ? (
                    <p className="auth-hint auth-hint--error">
                      <AlertCircle />
                      Caps Lock is on.
                    </p>
                  ) : (
                    <p className="auth-hint">Your password is never sent anywhere but this server.</p>
                  )}
                </div>

                <Submit busy={busy} label="Sign in" />
              </motion.form>
            )}

            {/* ── Email code: request ── */}
            {method === "otp" && phase !== "sent" && phase !== "verifying" && (
              <motion.form
                key="otp-request"
                onSubmit={requestCode}
                className="auth-stack"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: EASE }}
              >
                <div>
                  <label className="auth-label" htmlFor="otp-email">
                    <span className="auth-label__text">Email address</span>
                  </label>
                  <div className="auth-field">
                    <Mail className="auth-field__icon" />
                    <input
                      id="otp-email"
                      className="auth-field__input"
                      type="email"
                      name="email"
                      autoComplete="username"
                      inputMode="email"
                      spellCheck={false}
                      placeholder="you@hospital.org"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <p className="auth-hint">
                    We will email you a 6-digit code. No password to remember, which helps on a
                    shared ward tablet.
                  </p>
                </div>

                <Submit busy={phase === "sending"} label="Email me a code" icon={<Mail />} />
              </motion.form>
            )}

            {/* ── Email code: verify ── */}
            {showOtpEntry && (
              <motion.form
                key="otp-verify"
                onSubmit={verifyCode}
                className="auth-stack"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: EASE }}
              >
                <div>
                  <div className="auth-label">
                    <label className="auth-label__text" htmlFor="otp-cell-0">
                      6-digit code
                    </label>
                    <button type="button" onClick={resetCode} className="auth-link">
                      Use a different email
                    </button>
                  </div>
                  <div className="auth-otp" data-armed={code.length > 0 ? "true" : "false"}>
                    {digits.map((digit, i) => (
                      <input
                        key={i}
                        id={`otp-cell-${i}`}
                        ref={(el) => {
                          cellRefs.current[i] = el;
                        }}
                        className="auth-otp__cell"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        /* The first cell accepts the *whole* code, so an SMS
                           one-time-code autofill — which the platform hands to a
                           single field — is not truncated to one digit before
                           this handler can distribute it. The rest are
                           single-digit so nothing can overflow its cell. */
                        maxLength={i === 0 ? OTP_LENGTH : 1}
                        autoComplete={i === 0 ? "one-time-code" : "off"}
                        aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
                        value={digit}
                        data-filled={digit ? "true" : "false"}
                        onChange={(e) => setDigit(i, e.target.value)}
                        onKeyDown={(e) => onCellKey(i, e)}
                        onPaste={(e) => {
                          // Take the whole clipboard, ignore whatever the browser
                          // would have inserted into just this cell.
                          e.preventDefault();
                          setDigit(i, e.clipboardData.getData("text"));
                        }}
                      />
                    ))}
                  </div>
                </div>

                <Submit
                  busy={phase === "verifying"}
                  label="Verify and sign in"
                  icon={<Sparkles />}
                  disabled={!codeComplete}
                />
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="auth-foot">
        <p>
          Patient without an account?{" "}
          <Link href="/register" className="auth-link auth-link--inline">
            Create one
          </Link>
        </p>
        <p className="auth-trust">
          <ShieldCheck />
          Sessions are encrypted and expire automatically. Clinical access is logged.
        </p>
      </div>
    </>
  );
}

/* ── Pieces ── */

function Submit({
  busy,
  label,
  icon,
  disabled,
}: {
  busy: boolean;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="submit" disabled={busy || disabled} className="auth-btn">
      {busy ? (
        <>
          <Spinner />
          Working…
        </>
      ) : (
        <>
          {icon}
          {label}
          {!icon && <ArrowRight />}
        </>
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="auth-spinner" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
