import { NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";
import { mailProvider, mailRecipientScope } from "@/lib/server/mailer";
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
    // "all" = any patient can be reached. "owner" = the Resend sandbox, which
    // delivers only to the address registered on the Resend account, so OTPs
    // for other patients will fail. Worth its own field: a deployment can be
    // correctly configured and still unable to reach anyone.
    mailRecipientScope: mailRecipientScope(),
    // Never the env values themselves: names and warnings only.
    problems: audit.problems,
    warnings: audit.warnings,
    serverTime: Date.now(),
  });
}
