import { NextResponse } from "next/server";
import { getSessionStore } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics: open /api/health on your deployed URL.
 *  - driver: "redis"  -> cross-instance safe (multi-device sync will work)
 *  - driver: "memory" -> single-instance only; configure Upstash env vars
 *    (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) and redeploy.
 */
export async function GET(): Promise<NextResponse> {
  const store = await getSessionStore();
  return NextResponse.json({
    ok: true,
    driver: store.driver,
    redisConfigured: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    serverTime: Date.now(),
  });
}
