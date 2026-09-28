/**
 * GET /api/auth/google -- start the Google Sign-In flow.
 *
 * Issues a `state` (CSRF binding) and a PKCE `code_verifier`, pairs them into a
 * short-lived httpOnly cookie, and redirects. The callback can only complete a
 * flow this browser started.
 *
 * The verifier is written to a cookie rather than kept in module state so that a
 * stateless or multi-instance deployment works: nothing depends on the callback
 * landing on the same process that started it.
 */
import { cookies } from "next/headers";
import { beginGoogleAuth, googleConfigured } from "@/lib/server/auth";
import { fail } from "@/lib/server/http";
import { loadDotEnv, env } from "@/lib/server/env";

loadDotEnv();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FLOW_COOKIE = "cs_google_flow";
const FLOW_TTL_SECONDS = 600;

export async function GET(request: Request) {
  if (!googleConfigured()) {
    return fail("Google Sign-In is not configured on this server.", 503, "google_unavailable");
  }

  const url = new URL(request.url);
  // Carry a "next" destination through the round trip so a deep link survives
  // the redirect to Google and back.
  const next = safeNext(url.searchParams.get("next"));

  const state = crypto.randomUUID();
  const verifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const challenge = await sha256Base64Url(verifier);

  const store = await cookies();
  store.set(FLOW_COOKIE, JSON.stringify({ state, verifier, next }), {
    httpOnly: true,
    secure: env.appOrigin.startsWith("https://"),
    sameSite: "lax",
    path: "/api/auth",
    maxAge: FLOW_TTL_SECONDS,
  });

  return Response.redirect(beginGoogleAuth(state, challenge), 302);
}

/**
 * Only same-origin absolute paths are honoured. An open redirect here would turn
 * the sign-in flow into a phishing primitive: an attacker sends a victim a
 * legitimate-looking Google link that lands them on an attacker page after
 * authenticating.
 */
function safeNext(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 200);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
