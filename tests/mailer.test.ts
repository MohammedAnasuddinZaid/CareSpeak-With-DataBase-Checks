/**
 * Mail transport selection.
 *
 * The bug this file exists to prevent: an OTP that works on a laptop and never
 * arrives once deployed. Gmail refuses SMTP sign-in from datacenter IP ranges,
 * so a Gmail-only config looks healthy in development and silently fails in
 * production. Selecting the transport has to be an explicit, tested decision.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mailProvider,
  mailConfigured,
  mailRecipientScope,
  resolveResendFrom,
  sendOtpEmail,
} from "@/lib/server/mailer";

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

describe("resolveResendFrom", () => {
  it("uses the sandbox when MAIL_FROM is unset", () => {
    delete process.env.MAIL_FROM;
    const { from, sandbox } = resolveResendFrom();
    expect(sandbox).toBe(true);
    expect(from).toBe("onboarding@resend.dev");
  });

  it("refuses a gmail.com From address and uses the sandbox", () => {
    // Confirmed against the live API: 403 "The gmail.com domain is not
    // verified". Passing it through would 403 on every single send.
    process.env.MAIL_FROM = "mohdanasuddin555@gmail.com";
    const { from, sandbox } = resolveResendFrom();
    expect(sandbox).toBe(true);
    expect(from).toBe("onboarding@resend.dev");
  });

  it("refuses other free-mail providers too", () => {
    for (const address of ["a@yahoo.com", "b@hotmail.com", "c@outlook.com", "d@icloud.com"]) {
      process.env.MAIL_FROM = address;
      expect(resolveResendFrom().sandbox).toBe(true);
    }
  });

  it("uses a verified custom domain as-is", () => {
    process.env.MAIL_FROM = "no-reply@carespeak.health";
    const { from, sandbox } = resolveResendFrom();
    expect(sandbox).toBe(false);
    expect(from).toContain("no-reply@carespeak.health");
  });
});

describe("mailRecipientScope", () => {
  it("is owner-only on the sandbox", () => {
    // The deployment can be correctly configured and still reach nobody else.
    process.env.RESEND_API_KEY = "re_testkey";
    process.env.MAIL_FROM = "someone@gmail.com";
    expect(mailRecipientScope()).toBe("owner");
  });

  it("is all with a verified domain", () => {
    process.env.RESEND_API_KEY = "re_testkey";
    process.env.MAIL_FROM = "no-reply@carespeak.health";
    expect(mailRecipientScope()).toBe("all");
  });

  it("is unknown without a Resend key", () => {
    expect(mailRecipientScope()).toBe("unknown");
  });
});

describe("deployment audit", () => {
  it("warns that a free-mail MAIL_FROM leaves the sandbox owner-only", async () => {
    const { loadDotEnv, auditConfiguration } = await import("@/lib/server/env");
    loadDotEnv();
    process.env.RESEND_API_KEY = "re_testkey";
    process.env.APP_ORIGIN = "https://carespeakdb.vercel.app";
    process.env.MAIL_FROM = "mohdanasuddin555@gmail.com";

    const { warnings } = auditConfiguration();
    // The exact trap that shipped: correctly configured, still unable to reach
    // any patient but the Resend account owner.
    expect(
      warnings.some((w) => /only to the address registered/i.test(w)),
    ).toBe(true);
  });

  it("warns when a deployed instance has no Resend key", async () => {
    const { loadDotEnv, auditConfiguration } = await import("@/lib/server/env");
    loadDotEnv();
    delete process.env.RESEND_API_KEY;
    process.env.APP_ORIGIN = "https://carespeakdb.vercel.app";
    process.env.SMTP_USER = "someone@gmail.com";
    process.env.SMTP_APP_PASSWORD = "abcd efgh ijkl mnop";

    const { warnings } = auditConfiguration();
    expect(warnings.some((w) => w.includes("Gmail SMTP"))).toBe(true);
  });
});

describe("sendOtpEmail without a transport", () => {
  it("fails with an actionable reason instead of throwing", async () => {
    const result = await sendOtpEmail("patient@example.com", "123456", "login");
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/RESEND_API_KEY|SMTP_USER/);
  });
});
