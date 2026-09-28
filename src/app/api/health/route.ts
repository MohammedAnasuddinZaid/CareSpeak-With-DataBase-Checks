import { NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";
import { mailProvider } from "@/lib/server/mailer";
import { auditConfiguration } from "@/lib/server/env";

export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics: open /api/health on your deployed URL.
 *  - driver: "redis"  -> cross-instance safe (multi-device sync will work)
 *  - driver: "memory" -> single-instance only; configure Upstash env vars
 *    (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) and redeploy.
 *  - mail:  "resend" | "smtp" | "none" -> whether OTPs can leave this instance.
 *
 * `mail` is exposed because an OTP that never arrives is otherwise
 * indistinguishable from a patient who is not checking their mail.
 */
export async function GET(): Promise<NextResponse> {
  const store = await getSessionStore();
  const audit = auditConfiguration();

  return NextResponse.json({
    ok: true,
    driver: store.driver,
    redisConfigured: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    mail: mailProvider(),
    // Never the env values themselves: names and warnings only.
    problems: audit.problems,
    warnings: audit.warnings,
    serverTime: Date.now(),
  });
}
