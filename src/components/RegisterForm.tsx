"use client";

/**
 * Patient self-registration.
 *
 * Deliberately no role selector. A nurse, doctor, or admin account is
 * provisioned by an administrator, so offering the choice here would let anyone
 * mint themselves clinical access. The server hard-codes `patient` regardless of
 * what is posted, and this form does not pretend to offer a choice.
 *
 * Same shell as `/login`, and the same three-part card, so the two pages read as
 * one surface. What is different is the *feedback*: a live four-segment strength
 * meter on the password, because the server requires ten characters and the
 * previous version only said so in a sentence below the field — which is a
 * sentence nobody reads until after the third failed submit.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Info, Lock, Mail, Stethoscope, User } from "lucide-react";

const MIN_PASSWORD = 10;

const LANGUAGES = [
  { value: "en-US", label: "English" },
  { value: "hi-IN", label: "हिन्दी (Hindi)" },
  { value: "ta-IN", label: "தமிழ் (Tamil)" },
  { value: "te-IN", label: "తెలుగు (Telugu)" },
  { value: "kn-IN", label: "ಕನ್ನಡ (Kannada)" },
  { value: "ml-IN", label: "മലയാളം (Malayalam)" },
  { value: "bn-IN", label: "বাংলা (Bengali)" },
  { value: "mr-IN", label: "मराठी (Marathi)" },
  { value: "gu-IN", label: "ગુજરાતી (Gujarati)" },
  { value: "pa-IN", label: "ਪੰਜਾਬੀ (Punjabi)" },
];

/**
 * A four-bucket strength read, not a real entropy estimate — the point is to move
 * the goalposts in front of the user, and to stop rewarding `Password1!` with a
 * "strong" bar. Length carries the most weight because it is the only factor a
 * patient will reliably get right.
 */
function scorePassword(value: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!value) return { score: 0, label: "" };

  let score = 0;
  if (value.length >= MIN_PASSWORD) score += 2;
  else if (value.length >= 6) score += 1;

  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;

  // A bar that reads "strong" on a 10-character dictionary word is worse than
  // no bar, so mixed-case-plus-digits is capped until there is real length.
  if (value.length < MIN_PASSWORD + 4) score = Math.min(score, 3);

  const clamped = Math.min(4, Math.max(1, score)) as 1 | 2 | 3 | 4;
  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: "Too easy to guess",
    2: "Weak",
    3: "Reasonable",
    4: "Strong",
  };
  return { score: clamped, label: labels[clamped] };
}

export default function RegisterForm() {
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [language, setLanguage] = useState("en-US");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = useMemo(() => scorePassword(password), [password]);
  // Only a *typed* password can be too short. An empty field is not an error the
  // user needs to be told about before they have typed anything.
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (tooShort) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, email, password, preferredLanguage: language }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        verificationEmailSent?: boolean;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "We could not create that account.");
        return;
      }
      setDone(
        data.verificationEmailSent
          ? `Account created. We sent a 6-digit code to ${email} — use it on the sign-in page to verify your address.`
          : `Account created. Sign in with your email and password, then verify ${email} from the sign-in page.`,
      );
      // Land them on sign-in rather than an empty dashboard: the account is
      // unverified until the emailed code is redeemed.
      setTimeout(() => router.push("/login"), 2600);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="auth__head">
        <h1 className="auth__title">Create a patient account</h1>
        <p className="auth__subtitle">
          For patients and family. Staff accounts are issued by your hospital.
        </p>
      </div>

      <div className="auth__card">
        <div className="auth__section">
          {(error || done) && (
            <div className="auth-stack">
              {error && (
                <p className="auth-alert auth-alert--error" role="alert">
                  <AlertCircle />
                  <span>{error}</span>
                </p>
              )}
              {done && (
                <p className="auth-alert auth-alert--info">
                  <CheckCircle2 />
                  <span>{done}</span>
                </p>
              )}
            </div>
          )}

          <form onSubmit={submit} className="auth-stack">
            <div>
              <label className="auth-label" htmlFor="reg-name">
                <span className="auth-label__text">Full name</span>
              </label>
              <div className="auth-field">
                <User className="auth-field__icon" />
                <input
                  id="reg-name"
                  className="auth-field__input"
                  name="name"
                  autoComplete="name"
                  placeholder="Meera Iyer"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  minLength={2}
                  required
                />
              </div>
            </div>

            <div>
              <label className="auth-label" htmlFor="reg-email">
                <span className="auth-label__text">Email address</span>
              </label>
              <div className="auth-field">
                <Mail className="auth-field__icon" />
                <input
                  id="reg-email"
                  className="auth-field__input"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  spellCheck={false}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <label className="auth-label" htmlFor="reg-password">
                <span className="auth-label__text">Password</span>
              </label>
              <div className="auth-field" data-invalid={tooShort ? "true" : "false"}>
                <Lock className="auth-field__icon" />
                <input
                  id="reg-password"
                  className="auth-field__input"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={MIN_PASSWORD}
                  required
                />
              </div>
              {password.length > 0 && (
                <div className="auth-meter" data-score={strength.score}>
                  <span className="auth-meter__seg" />
                  <span className="auth-meter__seg" />
                  <span className="auth-meter__seg" />
                  <span className="auth-meter__seg" />
                </div>
              )}
              <p className={`auth-hint ${tooShort ? "auth-hint--error" : ""}`}>
                {tooShort ? (
                  <>
                    <AlertCircle />
                    Use at least {MIN_PASSWORD} characters.
                  </>
                ) : (
                  <>
                    {password.length > 0 && `${strength.label}. `}
                    At least {MIN_PASSWORD} characters. A short phrase you will remember beats a
                    scrambled word you will not.
                  </>
                )}
              </p>
            </div>

            <div>
              <label className="auth-label" htmlFor="reg-lang">
                <span className="auth-label__text">Preferred language</span>
              </label>
              <select
                id="reg-lang"
                className="auth-select"
                name="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="auth-hint">
                CareSpeak reads alerts aloud in this language, on the patient device and on the
                nurse&rsquo;s.
              </p>
            </div>

            <button type="submit" disabled={busy || tooShort} className="auth-btn">
              {busy ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>

        <div className="auth__section auth__section--note">
          <p className="auth-alert auth-alert--neutral">
            <Info />
            <span>
              Accounts created here are for patients only. If you are a nurse, doctor, or
              administrator, sign in with the credentials issued by your hospital.
            </span>
          </p>
        </div>
      </div>

      <div className="auth-foot">
        <p>
          Already have an account?{" "}
          <Link href="/login" className="auth-link auth-link--inline">
            Sign in
          </Link>
        </p>
        <p className="auth-trust">
          <Stethoscope />
          Clinical access is provisioned and audited.
        </p>
      </div>
    </>
  );
}
