/**
 * GET /api/auth/google/callback -- finish the Google Sign-In flow.
 *
 * Validates the PKCE verifier and the `state` binding, exchanges the code, and
 * redirects to a same-origin destination. The flow cookie is cleared on every
 * path out, including failures, so a half-finished attempt cannot be resumed.
 */
import { cookies } from "next/headers";
import { completeGoogleAuth, requestMeta } from "@/lib/server/auth";
import { env, loadDotEnv } from "@/lib/server/env";

loadDotEnv();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FLOW_COOKIE = "cs_google_flow";

interface FlowState {
  state: string;
  verifier: string;
  next: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const raw = store.get(FLOW_COOKIE)?.value;
  store.delete(FLOW_COOKIE);

  const destination = (fallback: string, extra?: Record<string, string>) => {
    const target = new URL(fallback === "/" ? "/" : safeNext(fallback), env.appOrigin);
    for (const [key, value] of Object.entries(extra ?? {})) target.searchParams.set(key, value);
    return Response.redirect(target.toString(), 302);
  };

  if (!raw) return destination("/login", { authError: "flow_expired" });

  let flow: FlowState;
  try {
    flow = JSON.parse(raw) as FlowState;
  } catch {
    return destination("/login", { authError: "flow_expired" });
  }

  // Google's own error parameter (user declined, consent denied, etc).
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return destination("/login", { authError: safeErrorCode(oauthError) });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return destination("/login", { authError: "missing_code" });
  }

  // CSRF binding. Without this an attacker could feed a victim a link carrying
  // the attacker's own auth code and silently sign the victim into the
  // attacker's account.
  if (state !== flow.state) {
    return destination("/login", { authError: "state_mismatch" });
  }

  // PKCE. Google does not echo the challenge back to the callback, so the proof
  // is the token exchange itself: the code is only redeemable with the verifier
  // that was stored in this flow cookie. Reject a malformed cookie up front so a
  // tampered or truncated flow never reaches the token endpoint.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(flow.verifier)) {
    return destination("/login", { authError: "pkce_mismatch" });
  }

  const meta = await requestMeta();
  const result = await completeGoogleAuth(code, flow.verifier, meta);

  if (!result.ok) {
    const message =
      result.error === "config"
        ? "google_unavailable"
        : result.error === "suspended"
          ? "account_suspended"
          : result.error === "email_not_verified"
            ? "email_not_verified"
            : "verification_failed";
    return destination("/login", { authError: message });
  }

  return destination(flow.next, { auth: "ok" });
}

function safeNext(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 200);
}

/** Collapse Google's error vocabulary to short codes safe to put in a URL. */
function safeErrorCode(value: string): string {
  if (value === "access_denied") return "declined";
  if (value === "consent_required" || value === "interaction_required") return "consent_required";
  if (value === "unauthorized_client") return "bad_client_id";
  return "google_error";
}
