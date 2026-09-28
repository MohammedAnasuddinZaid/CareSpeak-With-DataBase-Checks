/**
 * GET /api/auth/session -- who am I?
 *
 * The client calls this on mount to decide which shell to render. It reports
 * which sign-in methods are *available* so the login screen can hide options
 * that are not configured, rather than showing a button that always fails.
 */
import { getCurrentUser } from "@/lib/server/auth";
import { googleConfigured } from "@/lib/server/auth";
import { mailConfigured } from "@/lib/server/mailer";
import { handleError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return json({
      user,
      capabilities: {
        google: googleConfigured(),
        emailOtp: mailConfigured(),
        password: true,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
