/**
 * Mail transport selection.
 *
 * The bug this file exists to prevent: an OTP that works on a laptop and never
 * arrives once deployed. Gmail refuses SMTP sign-in from datacenter IP ranges,
 * so a Gmail-only config looks healthy in development and silently fails in
 * production. Selecting the transport has to be an explicit, tested decision.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mailProvider, mailConfigured, sendOtpEmail } from "@/lib/server/mailer";

const ORIGINAL = { ...process.env };

// `env` in env.ts is a set of getters that read process.env on each access, so
// these read the stubbed values without needing a module cache reset.
beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_APP_PASSWORD;
  delete process.env.MAIL_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("mailProvider", () => {
  it("is none with nothing configured", () => {
    expect(mailProvider()).toBe("none");
  });

  it("is smtp when only SMTP credentials exist", () => {
    process.env.SMTP_USER = "someone@gmail.com";
    process.env.SMTP_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(mailProvider()).toBe("smtp");
  });

  it("is resend when a Resend key exists", () => {
    process.env.RESEND_API_KEY = "re_testkey";
    expect(mailProvider()).toBe("resend");
  });

  it("prefers Resend over a leftover SMTP config", () => {
    // The deployment case: SMTP works locally, Resend is what actually sends.
    process.env.SMTP_USER = "someone@gmail.com";
    process.env.SMTP_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.RESEND_API_KEY = "re_testkey";
    expect(mailProvider()).toBe("resend");
  });
});

describe("mailConfigured", () => {
  it("tracks whether any transport is usable", () => {
    expect(mailConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "re_testkey";
    expect(mailConfigured()).toBe(true);
  });
});

describe("sendOtpEmail without a transport", () => {
  it("fails with an actionable reason instead of throwing", async () => {
    const result = await sendOtpEmail("patient@example.com", "123456", "login");
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/RESEND_API_KEY|SMTP_USER/);
  });
});
