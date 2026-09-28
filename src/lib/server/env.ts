/**
 * Typed, validated process environment.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Fail loudly at boot rather than silently at 3am. A missing AUTH_SECRET
 *     must not degrade to "sessions are unsigned".
 *  2. Never throw in a build context. `next build` evaluates route modules
 *     without runtime secrets present, so validation is split into `readEnv`
 *     (lazy, throws when a value is actually used) and `assertProductionReady`
 *     (called once at server start).
 *
 * Dotenv loading lives in `loadDotEnv` below, which the db scripts call before
 * importing anything that reads these values.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

let dotEnvLoaded = false;

/** Load .env.local then .env if present. Never overwrites an already-set var. */
export function loadDotEnv(cwd = process.cwd()): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  for (const file of [".env.local", ".env"]) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    // `loadEnvFile` respects existing process.env values, so real environment
    // variables (host config, CI) always win over the file.
    try {
      process.loadEnvFile(path);
    } catch {
      // A malformed file should not stop the process from booting; the
      // validators below will report anything actually missing.
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for the full list.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get databasePoolMax(): number {
    return int("DATABASE_POOL_MAX", 10);
  },
  get databaseSsl(): boolean {
    return bool("DATABASE_SSL", false);
  },
  /**
   * PEM-encoded CA certificate used to verify the database server's TLS
   * certificate.
   *
   * Managed MySQL providers (Aiven and others) terminate the chain in a private
   * root that is not in Node's trust store, so a bare `ssl: {}` fails the
   * handshake with HANDSHAKE_SSL_ERROR -- "self-signed certificate in
   * certificate chain" -- even though the connection is otherwise reachable.
   * Passing the provider's CA makes the certificate genuinely verified rather
   * than blindly trusted via `rejectUnauthorized: false`.
   *
   * Tolerates every shape an operator can realistically paste into a host's
   * environment-variable editor: a real multi-line PEM, one line with literal
   * `\n` escapes, a fully collapsed single line, or a block with stray spaces
   * and CRLF endings. All of them normalise to the same canonical PEM, so a
   * formatting mistake cannot silently degrade the handshake into
   * HANDSHAKE_SSL_ERROR.
   */
  get databaseCa(): string | undefined {
    const raw = optional("DATABASE_CA");
    if (!raw) return undefined;
    // Already canonical: real newlines and an END line. Nothing to rewrite.
    if (raw.includes("\n-----END CERTIFICATE-----")) return raw.trim();

    // Otherwise reassemble from the base64 body alone. Strip the armour, then
    // every character that cannot appear in base64: whitespace, CRLF remnants,
    // and literal backslash escapes alike. Each escape is removed as a whole
    // backslash-letter pair -- deleting the backslash alone would leave the
    // literal `n` of a `\n` in the body and corrupt the certificate.
    const body = raw
      .replace(/-----(?:BEGIN|END) CERTIFICATE-----/g, "")
      .replace(/\\[a-zA-Z]/g, "")
      .replace(/\s/g, "");
    if (!body) return undefined;

    const lines = body.match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
  },
  get redisUrl(): string | undefined {
    return optional("REDIS_URL");
  },
  get redisKeyPrefix(): string {
    return process.env.REDIS_KEY_PREFIX || "cs";
  },
  get authSecret(): string {
    return required("AUTH_SECRET");
  },
  get authPepper(): string {
    return required("AUTH_PEPPER");
  },
  get accessTokenTtl(): number {
    return int("ACCESS_TOKEN_TTL", 900);
  },
  get refreshTokenTtl(): number {
    return int("REFRESH_TOKEN_TTL", 2_592_000);
  },
  get otpTtl(): number {
    return int("OTP_TTL", 600);
  },
  get otpMaxAttempts(): number {
    return int("OTP_MAX_ATTEMPTS", 5);
  },
  get scryptCost(): number {
    return int("SCRYPT_COST", 16_384);
  },
  get googleClientId(): string | undefined {
    return optional("GOOGLE_CLIENT_ID");
  },
  /**
   * Resend HTTP API key. Preferred over SMTP when present: Gmail refuses SMTP
   * sign-in from datacenter IPs, so an OTP that works locally stops arriving
   * once deployed. A verified Resend domain is required for the From address.
   */
  get resendApiKey(): string | undefined {
    return optional("RESEND_API_KEY");
  },
  get googleClientSecret(): string | undefined {
    return optional("GOOGLE_CLIENT_SECRET");
  },
  get smtp(): {
    host: string;
    port: number;
    secure: boolean;
    user: string | undefined;
    pass: string | undefined;
    from: string;
    fromName: string;
  } {
    return {
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: int("SMTP_PORT", 465),
      secure: bool("SMTP_SECURE", true),
      user: optional("SMTP_USER"),
      // Google displays app passwords in space-separated groups of four and
      // invites you to copy them, so a pasted value routinely arrives as
      // "abcd efgh ijkl mnop" (17 chars) and Gmail rejects it with 535
      // BadCredentials. Stripping whitespace here makes the common paste work
      // without anyone having to remember the real format.
      pass: optional("SMTP_APP_PASSWORD")?.replace(/\s+/g, ""),
      from: process.env.MAIL_FROM || process.env.SMTP_USER || "",
      fromName: process.env.MAIL_FROM_NAME || "CareSpeak",
    };
  },
  get deviceToken(): string {
    return process.env.CARESPEAK_DEVICE_TOKEN || "";
  },
  get appOrigin(): string {
    return (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  },
};

/**
 * Refuses to serve a deployment that is missing a secret or is exposing the
 * unauthenticated device-ingest endpoint to the internet. Called from
 * /api/health so a bad deploy is visible immediately rather than discovered
 * during a clinical escalation.
 */
export function auditConfiguration(): {
  ok: boolean;
  problems: string[];
  warnings: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const name of ["DATABASE_URL", "AUTH_SECRET", "AUTH_PEPPER"] as const) {
    if (!process.env[name]) problems.push(`${name} is not set`);
  }

  const secret = process.env.AUTH_SECRET;
  // 32 random bytes base64url is 43 chars. Anything shorter is guessable.
  if (secret && secret.length < 32) {
    problems.push("AUTH_SECRET is shorter than 32 characters");
  }
  const pepper = process.env.AUTH_PEPPER;
  if (pepper && pepper.length < 16) {
    problems.push("AUTH_PEPPER is shorter than 16 characters");
  }

  if (secret && pepper && secret === pepper) {
    problems.push("AUTH_SECRET and AUTH_PEPPER are identical");
  }

  if (!env.databaseUrl.startsWith("mysql://")) {
    problems.push("DATABASE_URL must be a mysql:// connection string");
  }

  if (!env.redisUrl) {
    warnings.push(
      "REDIS_URL is not set: running on the single-instance in-memory bus. Multi-device push will not cross instances.",
    );
  }

  if (!env.deviceToken) {
    warnings.push(
      "CARESPEAK_DEVICE_TOKEN is empty: /api/ingest accepts unsigned writes. Set it before exposing this app to a network.",
    );
  }

  if (!env.googleClientId) {
    warnings.push("GOOGLE_CLIENT_ID is not set: Google Sign-In is disabled.");
  }

  const remoteOrigin = !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(env.appOrigin);

  if (env.resendApiKey) {
    // Resend only accepts mail from a domain you have verified with them.
    if (env.smtp.from && /@gmail\.com|@yahoo\.com|@hotmail\.com|@outlook\.com/i.test(env.smtp.from)) {
      warnings.push(
        "RESEND_API_KEY is set but MAIL_FROM is a free-mail address: Resend will reject it. Set MAIL_FROM to a verified domain, e.g. no-reply@yourdomain.com.",
      );
    }
  } else if (!env.smtp.pass) {
    warnings.push(
      "No mail transport configured: email OTP will not be delivered. Set RESEND_API_KEY for a deployed instance.",
    );
  } else if (remoteOrigin) {
    // The failure that produced "delivery: unavailable" in production.
    warnings.push(
      "Deployed without RESEND_API_KEY, so email OTP relies on Gmail SMTP, which refuses sign-in from datacenter IPs. Expect OTPs to fail on this deployment.",
    );
  }

  const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(env.appOrigin);
  if (remote && !env.deviceToken) {
    problems.push("APP_ORIGIN is public but CARESPEAK_DEVICE_TOKEN is empty");
  }
  if (remote && env.databaseUrl.includes("@127.0.0.1")) {
    warnings.push(
      "APP_ORIGIN is public but DATABASE_URL points at localhost: a hosted instance cannot reach it.",
    );
  }

  return { ok: problems.length === 0, problems, warnings };
}
