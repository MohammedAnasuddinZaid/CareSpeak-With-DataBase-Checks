/**
 * Shared HTTP plumbing for API routes.
 *
 * Three jobs: uniform JSON error envelopes, a rate limiter that works across
 * instances, and cookie/redirect helpers. Keeping these in one place is what
 * stops each route from inventing its own subtly different failure shape.
 */
import { NextResponse } from "next/server";

import { getBus } from "./realtime";
import { AuthError } from "./auth";

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json(
    { error: message, ...(code ? { code } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Map any thrown value to a response.
 *
 * `AuthError` carries its own status. Anything else is logged and reported as a
 * generic 500 -- an unexpected exception must not leak a stack trace or a SQL
 * fragment to a browser, and a MySQL error message can contain column values.
 */
export function handleError(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] unhandled error:", message);
  return NextResponse.json(
    { error: "Something went wrong on our side. Please try again." },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Distributed rate limit.
 *
 * Backed by the realtime bus so the limit is shared across every app instance:
 * an in-process counter would be multiplied by the instance count and stop being
 * a limit at all. Keys are namespaced per action so a login flood cannot exhaust
 * the OTP budget.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const bus = await getBus();
  const result = await bus.rateLimit(key, limit, windowSeconds);
  return {
    allowed: result.allowed,
    remaining: result.remaining,
    retryAfter: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
  };
}

/** 429 with a Retry-After header, so a client can back off without guessing. */
export function tooManyRequests(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please wait before trying again.", code: "rate_limited" },
    { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } },
  );
}

/** Client IP for rate-limit bucketing. Untrusted, so it is a bucket, not an identity. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (
    (forwarded ? forwarded.split(",")[0]?.trim() : null) ??
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    "local"
  );
}

/** Parse a JSON body, tolerating an empty or malformed one. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const text = await request.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/** Trim and bound a free-text field, so nothing unbounded reaches a column. */
export function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/** Email shape check. Deliberately permissive: the authoritative test is whether
 *  the address can receive mail, and a strict RFC regex rejects valid addresses. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

const SESSION_CODE = /^[A-Z0-9_-]{3,64}$/;

/**
 * Console session code. The original was a fixed 6 characters -- about 30 bits,
 * and printed in every QR code, which made it worth guessing. The generator now
 * emits 22 characters (128 bits); this regex accepts the wider range so codes
 * minted before an upgrade still work.
 */
export function isSessionCode(value: unknown): boolean {
  return typeof value === "string" && SESSION_CODE.test(value);
}
