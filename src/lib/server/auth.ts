/**
 * Authentication, session lifecycle and access control.
 *
 * Design
 * ------
 * Two cookies, deliberately different in kind:
 *
 *   cs_at  access token  -- a short-lived (15 min) JWT in an httpOnly cookie.
 *                          Stateless, so the hot path needs no database round
 *                          trip. A revoked user is locked out by `status` being
 *                          re-checked on refresh, not on every read.
 *   cs_rt  refresh token -- a 32-byte opaque token whose *sha256* is the only
 *                          thing stored. Rotated on every use: redeeming one
 *                          revokes it and mints a successor, so a stolen token
 *                          is good for at most one refresh before the theft
 *                          shows up as a revoked row.
 *
 * Why not a session cookie alone: a stateless JWT access token means the
 * realtime stream and the vitals read path do not each pay a query, which
 * matters once several ward dashboards are open at once.
 *
 * Why not a JWT refresh token: a refresh token that cannot be individually
 * revoked is a permanent credential. Opaque + a row in `auth_sessions` means
 * "log out this device" actually works.
 *
 * Access control is two-layer, because a role alone is not enough on a ward:
 *   RBAC  what kind of account is this (patient / nurse / doctor / admin)
 *   ABAC  is this specific clinician assigned to this specific patient
 *
 * A nurse is not entitled to every bed in the hospital. `requirePatientAccess`
 * enforces the assignment check, and admins bypass it deliberately.
 */
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import type { RowDataPacket } from "mysql2";

import { env, loadDotEnv } from "./env";
import { query, queryOne, execute, transaction, txExecute, txQuery } from "./db";
import { generateToken, hashToken, safeEqualHex, verifyPassword } from "./crypto";
import { recordAudit } from "./audit";

loadDotEnv();

export const ACCESS_COOKIE = "cs_at";
export const REFRESH_COOKIE = "cs_rt";

export type Role = "patient" | "nurse" | "doctor" | "admin";

export interface AuthUser {
  id: number;
  hospitalId: number | null;
  email: string;
  displayName: string;
  role: Role;
  avatarUrl: string | null;
  locale: string;
  status: "active" | "pending" | "suspended";
  mfaEnabled: boolean;
  /** Present only on the patient row. */
  mrn: string | null;
  preferredLanguage: string | null;
  communicationMode: string | null;
  /** Present only on the staff row. */
  department: string | null;
}

interface AccessClaims {
  sub: string;
  role: Role;
  hid: number | null;
  /** Session id in auth_sessions, so a refresh can revoke this exact chain. */
  sid: number;
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(env.authSecret);
}

/* -------------------------------------------------------------------------- */
/* Password sign-in                                                            */
/* -------------------------------------------------------------------------- */

export interface PasswordSignInResult {
  ok: boolean;
  user?: AuthUser;
  /** Populated on failure; the caller must not distinguish these to the client. */
  error?: "invalid_credentials" | "locked" | "suspended" | "pending";
}

/**
 * Verify an email + password.
 *
 * Failure is deliberately uniform. Telling a caller "this account exists but is
 * locked" is an account-enumeration oracle, so the caller-facing error is always
 * `invalid_credentials` even when the real cause was a lockout.
 *
 * The `failed_logins` counter and `locked_until` implement progressive
 * throttling; the bus-level rate limit in the route handler is the outer layer.
 */
export async function signInWithPassword(
  email: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<PasswordSignInResult> {
  const normalised = email.trim().toLowerCase();
  const row = await queryOne<RowDataPacket & {
    id: number;
    password_hash: string | null;
    status: "active" | "pending" | "suspended";
    role: Role;
    failed_logins: number;
    is_locked: number;
  }>("SELECT id, password_hash, status, role, failed_logins, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS is_locked FROM users WHERE email = ?", [
    normalised,
  ]);

  if (!row) {
    // Spend comparable time on a miss so response latency does not reveal
    // whether the account exists.
    await verifyPassword(password, null);
    return { ok: false, error: "invalid_credentials" };
  }

  // Compared by MySQL, not in JS. `locked_until` is a naive DATETIME written
  // with NOW(3) in the *database's* timezone; parsing it with `new Date()` would
  // interpret it in the *app server's* timezone. The two agree only when both
  // hosts happen to share a zone, so on a UTC database behind an IST host a
  // 15-minute lockout would either evaporate or stretch to five hours.
  if (row.is_locked) {
    await verifyPassword(password, row.password_hash);
    return { ok: false, error: "locked" };
  }

  if (row.status === "suspended") {
    await verifyPassword(password, row.password_hash);
    return { ok: false, error: "suspended" };
  }

  if (!row.password_hash) {
    // OAuth-only account. Refusing here is what stops someone from "signing in"
    // with a blank password field if the hash were ever NULL.
    return { ok: false, error: "invalid_credentials" };
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const failures = Number(row.failed_logins ?? 0) + 1;
    // 5 strikes for 15 minutes, then the window doubles up to a 24h lock.
    const lockMinutes = failures >= 10 ? 1440 : failures >= 5 ? 15 : 0;
    await execute(
      `UPDATE users
          SET failed_logins = ?,
              locked_until = IF(? > 0, DATE_ADD(NOW(3), INTERVAL ? MINUTE), NULL)
        WHERE id = ?`,
      [failures, lockMinutes, lockMinutes, row.id],
    );
    return { ok: false, error: "invalid_credentials" };
  }

  await execute(
    "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?",
    [row.id],
  );

  const user = await loadAuthUser(row.id);
  if (!user) return { ok: false, error: "invalid_credentials" };

  await issueSession(user, meta);
  return { ok: true, user };
}

/* -------------------------------------------------------------------------- */
/* Email OTP sign-in                                                            */
/* -------------------------------------------------------------------------- */

/** Six digits from a CSPRNG. Leading zeros are preserved as part of the string. */
export function generateOtpCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const value = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

export type OtpPurpose = "login" | "signup" | "verify_email" | "pin_reset";

/**
 * Create an OTP row, invalidating any outstanding code for the same
 * email + purpose. Only the newest code can ever succeed, so a leaked earlier
 * email is inert the moment a new one is requested.
 */
export async function issueOtp(
  email: string,
  purpose: OtpPurpose,
  meta: { ip: string | null },
): Promise<string> {
  const normalised = email.trim().toLowerCase();
  const code = generateOtpCode();
  const { hashOtpCode } = await import("./crypto");

  await transaction(async (conn) => {
    await txExecute(
      conn,
      "UPDATE email_otps SET consumed_at = NOW(3) WHERE email = ? AND purpose = ? AND consumed_at IS NULL",
      [normalised, purpose],
    );
    await txExecute(
      conn,
      `INSERT INTO email_otps (email, purpose, code_hash, max_attempts, expires_at, ip)
       VALUES (?,?,?,?, DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)`,
      [normalised, purpose, hashOtpCode(code, purpose, normalised), env.otpMaxAttempts, env.otpTtl, meta.ip],
    );
  });

  return code;
}

export type OtpVerifyResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: "invalid" | "expired" | "too_many_attempts" | "no_account" };

/**
 * Redeem an OTP. Consumes it on success and increments `attempts` on every
 * failure, so five wrong guesses invalidate a still-valid code.
 */
export async function redeemOtp(
  email: string,
  code: string,
  purpose: OtpPurpose,
  meta: { ip: string | null; userAgent: string | null },
): Promise<OtpVerifyResult> {
  const normalised = email.trim().toLowerCase();
  const { hashOtpCode } = await import("./crypto");

  const row = await queryOne<RowDataPacket & {
    id: number;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    expires_at: string;
    consumed_at: string | null;
    is_expired: number;
  }>(
    // `is_expired` is evaluated by MySQL so the deadline is judged against the
    // clock that wrote it, not the app host's timezone.
    `SELECT id, code_hash, attempts, max_attempts, expires_at, consumed_at,
            (expires_at <= NOW(3)) AS is_expired
       FROM email_otps
      WHERE email = ? AND purpose = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [normalised, purpose],
  );

  if (!row) return { ok: false, error: "invalid" };
  if (row.consumed_at) return { ok: false, error: "invalid" };
  if (Number(row.attempts) >= Number(row.max_attempts)) return { ok: false, error: "too_many_attempts" };
  if (row.is_expired) return { ok: false, error: "expired" };
  if (!safeEqualHex(hashOtpCode(code, purpose, normalised), row.code_hash)) {
    await execute("UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    return { ok: false, error: "invalid" };
  }

  const user = await queryOne<RowDataPacket & { id: number }>("SELECT id FROM users WHERE email = ?", [
    normalised,
  ]);
  if (!user) return { ok: false, error: "no_account" };

  await execute("UPDATE email_otps SET consumed_at = NOW(3) WHERE id = ?", [row.id]);
  await execute(
    "UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW(3)), last_login_at = NOW(3) WHERE id = ?",
    [user.id],
  );

  const loaded = await loadAuthUser(user.id);
  if (!loaded) return { ok: false, error: "no_account" };
  if (loaded.status === "suspended") return { ok: false, error: "no_account" };

  await issueSession(loaded, meta);
  return { ok: true, user: loaded };
}

/* -------------------------------------------------------------------------- */
/* Google Sign-In (OAuth 2.0 authorization code + PKCE)                         */
/* -------------------------------------------------------------------------- */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export function googleConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

function googleRedirectUri(): string {
  return `${env.appOrigin}/api/auth/google/callback`;
}

/**
 * Begin the Google flow. Returns the URL to redirect the browser to, including
 * a PKCE verifier we hold in a cookie so the callback can prove it is the same
 * session that started the dance. Without PKCE an intercepted auth code is
 * redeemable by whoever intercepted it.
 */
export function beginGoogleAuth(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    // `state` is the CSRF binding; PKCE is the code-interception defence.
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

export type GoogleAuthResult =
  | { ok: true; user: AuthUser; created: boolean }
  | {
      ok: false;
      error: "config" | "exchange_failed" | "verification_failed" | "email_not_verified" | "suspended";
    };

/**
 * Complete the Google flow: exchange the code, verify the id_token against
 * Google's published JWKS, then find-or-create the local account.
 *
 * The stable subject identifier is the primary key for identity; the email is
 * display data plus a convergence hint. An unverified Google email is rejected
 * outright. A *verified* Google email that already exists locally links to that
 * row, which is what makes an OTP-created account and a Google account for the
 * same person converge.
 */
export async function completeGoogleAuth(
  code: string,
  codeVerifier: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<GoogleAuthResult> {
  if (!googleConfigured()) return { ok: false, error: "config" };

  let tokens: GoogleTokenResponse;
  try {
    const body = new URLSearchParams({
      code,
      client_id: env.googleClientId ?? "",
      client_secret: env.googleClientSecret ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    });
    // Sent only for the authorization-code flow. Google requires it to match the
    // challenge from /api/auth/google; omitting it would make the exchange fail,
    // and sending a mismatched one is what PKCE is designed to catch.
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: "exchange_failed" };
    tokens = (await res.json()) as GoogleTokenResponse;
  } catch {
    return { ok: false, error: "exchange_failed" };
  }

  if (!tokens.id_token) return { ok: false, error: "exchange_failed" };

  // Verify signature, issuer, audience and expiry against Google's keys.
  // Skipping this would let anyone mint an id_token in a browser and walk in.
  let payload: Record<string, unknown>;
  try {
    const jwks = await joseRemoteJwks();
    const { payload: verified } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.googleClientId,
    });
    payload = verified as Record<string, unknown>;
  } catch {
    return { ok: false, error: "verification_failed" };
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!sub || !email) return { ok: false, error: "verification_failed" };

  const profile: GoogleProfile = {
    sub,
    email,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : email.split("@")[0],
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };

  // An unverified Google email is never acceptable, not even for an account that
  // was already known locally. The flag is the only signal we have that the
  // address is actually controlled by this person, and every path below either
  // creates an account or attaches a Google identity to an existing one.
  if (!profile.emailVerified) {
    return { ok: false, error: "email_not_verified" };
  }

  const existingBySub = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM users WHERE google_sub = ?",
    [profile.sub],
  );
  if (existingBySub) {
    const user = await loadAuthUser(existingBySub.id);
    if (!user) return { ok: false, error: "verification_failed" };
    if (user.status === "suspended") return { ok: false, error: "suspended" };
    await execute("UPDATE users SET last_login_at = NOW(3) WHERE id = ?", [user.id]);
    await issueSession(user, meta);
    return { ok: true, user, created: false };
  }

  // Link to an existing local account with the same verified email. This is the
  // path for "I signed up with an OTP, now I want Google Sign-In".
  const existingByEmail = await queryOne<RowDataPacket & { id: number; status: string }>(
    "SELECT id, status FROM users WHERE email = ?",
    [profile.email],
  );
  if (existingByEmail) {
    if (existingByEmail.status === "suspended") return { ok: false, error: "suspended" };
    await execute(
      "UPDATE users SET google_sub = ?, avatar_url = COALESCE(?, avatar_url), email_verified_at = COALESCE(email_verified_at, NOW(3)), last_login_at = NOW(3) WHERE id = ?",
      [profile.sub, profile.picture, existingByEmail.id],
    );
    const user = await loadAuthUser(existingByEmail.id);
    if (!user) return { ok: false, error: "verification_failed" };
    await issueSession(user, meta);
    return { ok: true, user, created: false };
  }

  // New account. Default role is `patient`; a human promotes staff accounts
  // from the admin console. Self-service staff signup would let anyone with a
  // Google account read a ward.
  const hospital = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM hospitals ORDER BY id LIMIT 1",
  );
  const created = await createUser({
    email: profile.email,
    displayName: profile.name,
    role: "patient",
    hospitalId: hospital?.id ?? null,
    avatarUrl: profile.picture,
    googleSub: profile.sub,
    emailVerified: true,
  });

  const user = await loadAuthUser(created.id);
  if (!user) return { ok: false, error: "verification_failed" };
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: "auth.google_signup",
    entityType: "user",
    entityId: user.id,
    detail: { email: user.email },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  await issueSession(user, meta);
  return { ok: true, user, created: true };
}

/** Build a JOSE key resolver against Google's rotating JWKS. */
async function joseRemoteJwks() {
  const { createRemoteJWKSet } = await import("jose");
  return createRemoteJWKSet(new URL(GOOGLE_JWKS));
}

/* -------------------------------------------------------------------------- */
/* Session issuance and verification                                           */
/* -------------------------------------------------------------------------- */

export async function loadAuthUser(userId: number): Promise<AuthUser | null> {
  const row = await queryOne<RowDataPacket & Record<string, unknown>>(
    `SELECT u.id, u.hospital_id, u.email, u.display_name, u.role, u.avatar_url, u.locale,
            u.status, u.mfa_enabled,
            p.mrn, p.preferred_language, p.communication_mode,
            s.department
       FROM users u
       LEFT JOIN patient_profiles p ON p.user_id = u.id
       LEFT JOIN staff_profiles   s ON s.user_id = u.id
      WHERE u.id = ?`,
    [userId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    hospitalId: row.hospital_id == null ? null : Number(row.hospital_id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as Role,
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    locale: String(row.locale),
    status: row.status as AuthUser["status"],
    mfaEnabled: Number(row.mfa_enabled) === 1,
    mrn: row.mrn == null ? null : String(row.mrn),
    preferredLanguage: row.preferred_language == null ? null : String(row.preferred_language),
    communicationMode:
      row.communication_mode == null ? null : String(row.communication_mode),
    department: row.department == null ? null : String(row.department),
  };
}

/**
 * Mint a session: an `auth_sessions` row for the refresh chain, a signed access
 * JWT bound to that row, and both cookies.
 */
export async function issueSession(
  user: AuthUser,
  meta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const refreshToken = generateToken(32);
  const expiresAt = new Date(Date.now() + env.refreshTokenTtl * 1000)
    .toISOString()
    .slice(0, 23)
    .replace("T", " ");

  const result = await execute(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES (?,?,?,?,?)`,
    [
      user.id,
      hashToken(refreshToken),
      meta.userAgent?.slice(0, 255) ?? null,
      meta.ip,
      expiresAt,
    ],
  );

  const sessionId = result.insertId;
  const accessToken = await signAccessToken({
    sub: String(user.id),
    role: user.role,
    hid: user.hospitalId,
    sid: sessionId,
  });

  const store = await cookies();
  const secure = env.appOrigin.startsWith("https://");

  store.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: env.accessTokenTtl,
  });
  store.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/api/auth",
    // Scoped to the auth endpoints on purpose: this long-lived credential should
    // never ride along on ordinary page navigations or be readable by a route
    // that has no business seeing it.
    maxAge: env.refreshTokenTtl,
  });
}

async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role, hid: claims.hid, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer("carespeak")
    .setAudience("carespeak-web")
    .setExpirationTime(`${env.accessTokenTtl}s`)
    .sign(signingKey());
}

async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: "carespeak",
      audience: "carespeak-web",
    });
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const sid = typeof payload.sid === "number" ? payload.sid : null;
    if (!sub || sid === null) return null;
    return {
      sub,
      role: payload.role as Role,
      hid: typeof payload.hid === "number" ? payload.hid : null,
      sid,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the caller from the access cookie.
 *
 * Returns null for anonymous, expired, malformed, or *revoked* sessions. The
 * `auth_sessions` lookup on every request is the cost of the revocation
 * guarantee; it is a primary-key hit on a 64-char hash, so it stays sub-
 * millisecond, and it is what makes "log out everywhere" real rather than
 * aspirational.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  const row = await queryOne<RowDataPacket & { revoked_at: string | null; is_expired: number }>(
    "SELECT revoked_at, (expires_at <= NOW(3)) AS is_expired FROM auth_sessions WHERE id = ?",
    [claims.sid],
  );
  if (!row || row.revoked_at) return null;
  if (row.is_expired) return null;

  const user = await loadAuthUser(Number(claims.sub));
  if (!user || user.status !== "active") return null;
  return user;
}

/**
 * Redeem a refresh token: revoke the presented one, mint a successor, reissue the
 * access token. Returns null when the token is unknown, already used, revoked or
 * expired. Replaying a consumed token yields null *and* revokes the whole chain,
 * because presenting a token twice is either a bug or a theft and both warrant
 * ending the session.
 */
export async function refreshSession(
  meta: { ip: string | null; userAgent: string | null },
): Promise<AuthUser | null> {
  const store = await cookies();
  const presented = store.get(REFRESH_COOKIE)?.value;
  if (!presented) return null;

  const row = await queryOne<RowDataPacket & {
    id: number;
    user_id: number;
    revoked_at: string | null;
    is_expired: number;
  }>(
    "SELECT id, user_id, revoked_at, (expires_at <= NOW(3)) AS is_expired FROM auth_sessions WHERE refresh_token_hash = ?",
    [hashToken(presented)],
  );
  if (!row) return null;

  if (row.revoked_at) {
    // Replay of an already-redeemed token: assume compromise, kill the family.
    await execute(
      "UPDATE auth_sessions SET revoked_at = NOW(3), revoked_reason = 'replay_detected' WHERE user_id = ? AND revoked_at IS NULL",
      [row.user_id],
    );
    await recordAudit({
      actorId: row.user_id,
      actorRole: "system",
      action: "auth.refresh_replay",
      entityType: "auth_session",
      entityId: row.id,
      detail: { reason: "presented refresh token was already redeemed" },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await clearSessionCookies();
    return null;
  }

  if (row.is_expired) return null;

  const user = await loadAuthUser(row.user_id);
  if (!user || user.status !== "active") {
    await clearSessionCookies();
    return null;
  }

  await execute(
    "UPDATE auth_sessions SET revoked_at = NOW(3), revoked_reason = 'rotated', last_used_at = NOW(3) WHERE id = ?",
    [row.id],
  );
  await issueSession(user, meta);
  return user;
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/** Revoke the caller's own session. `allDevices` ends every session for the user. */
export async function signOut(allDevices = false): Promise<void> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  const claims = token ? await verifyAccessToken(token) : null;

  if (claims) {
    if (allDevices) {
      await execute(
        "UPDATE auth_sessions SET revoked_at = NOW(3), revoked_reason = 'signed_out_all' WHERE user_id = ? AND revoked_at IS NULL",
        [claims.sub],
      );
    } else {
      await execute(
        "UPDATE auth_sessions SET revoked_at = NOW(3), revoked_reason = 'signed_out' WHERE id = ?",
        [claims.sid],
      );
    }
  }
  await clearSessionCookies();
}

/* -------------------------------------------------------------------------- */
/* Account creation                                                             */
/* -------------------------------------------------------------------------- */

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: Role;
  hospitalId: number | null;
  password?: string;
  googleSub?: string | null;
  avatarUrl?: string | null;
  phoneE164?: string | null;
  locale?: string;
  emailVerified?: boolean;
  /** Required when role is `patient`. */
  mrn?: string;
  preferredLanguage?: string;
  communicationMode?: string;
  /** Staff-only extras. */
  staffRole?: "nurse" | "doctor" | "admin";
  department?: string | null;
  licenseNo?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<{ id: number }> {
  const { hashPassword } = await import("./crypto");
  const email = input.email.trim().toLowerCase();
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  const result = await execute(
    `INSERT INTO users
       (hospital_id, email, password_hash, google_sub, display_name, role, phone_e164,
        avatar_url, locale, email_verified_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`,
    [
      input.hospitalId,
      email,
      passwordHash,
      input.googleSub ?? null,
      input.displayName,
      input.role,
      input.phoneE164 ?? null,
      input.avatarUrl ?? null,
      input.locale ?? "en-US",
      input.emailVerified ? new Date().toISOString().slice(0, 23).replace("T", " ") : null,
    ],
  );
  const userId = result.insertId;

  if (input.role === "patient") {
    await execute(
      `INSERT INTO patient_profiles
         (user_id, mrn, preferred_language, communication_mode)
       VALUES (?,?,?,?)`,
      [
        userId,
        input.mrn ?? `MRN-${userId}`,
        input.preferredLanguage ?? "en-US",
        input.communicationMode ?? "mixed",
      ],
    );
  } else {
    await execute(
      `INSERT INTO staff_profiles (user_id, staff_role, department, license_no)
       VALUES (?,?,?,?)`,
      [userId, input.staffRole ?? (input.role as "nurse" | "doctor" | "admin"), input.department ?? null, input.licenseNo ?? null],
    );
  }

  return { id: userId };
}

/* -------------------------------------------------------------------------- */
/* Authorisation                                                               */
/* -------------------------------------------------------------------------- */

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/** Throws unless the caller is signed in. Use at the top of a protected route. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("unauthenticated", "Sign in to continue.", 401);
  return user;
}

/** Throws unless the caller holds one of `roles`. */
export async function requireRole(...roles: Role[]): Promise<AuthUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new AuthError("forbidden", "Your role does not permit this action.", 403);
  }
  return user;
}

/** Throws unless the caller is clinical staff (nurse, doctor, admin). */
export async function requireStaff(): Promise<AuthUser> {
  return requireRole("nurse", "doctor", "admin");
}

export function isStaff(user: AuthUser | null): boolean {
  return user !== null && (user.role === "nurse" || user.role === "doctor" || user.role === "admin");
}

/**
 * ABAC check: may this user view this patient's record?
 *
 * Staff assigned to the patient pass. Admins pass, because an account
 * administrator has to be able to investigate an incident. A patient passes only
 * for their own record. Everyone else is refused, which is what stops a nurse
 * covering another ward from reading a stranger's vitals by guessing an id.
 */
export async function canAccessPatient(
  user: AuthUser,
  patientId: number,
): Promise<boolean> {
  if (user.role === "patient") return user.id === patientId;
  if (user.role === "admin") return true;

  const row = await queryOne<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM care_assignments
      WHERE staff_id = ? AND patient_id = ? AND unassigned_at IS NULL`,
    [user.id, patientId],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function requirePatientAccess(patientId: number): Promise<AuthUser> {
  const user = await requireUser();
  if (!(await canAccessPatient(user, patientId))) {
    throw new AuthError("forbidden", "You are not assigned to this patient.", 403);
  }
  return user;
}

/* -------------------------------------------------------------------------- */
/* Request metadata                                                            */
/* -------------------------------------------------------------------------- */

/** Best-effort client IP. Proxy headers are untrusted, so this is for audit only. */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ip =
    (forwarded ? forwarded.split(",")[0]?.trim() : null) ??
    h.get("x-real-ip") ??
    h.get("cf-connecting-ip");
  return { ip: ip ? ip.slice(0, 45) : null, userAgent: h.get("user-agent")?.slice(0, 255) ?? null };
}

export { query, queryOne, execute, transaction };
