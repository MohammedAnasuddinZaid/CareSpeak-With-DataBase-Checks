/**
 * Standalone SMTP connectivity probe.
 *
 * Isolates nodemailer + Gmail auth from the app so a 535 or a hung TLS
 * handshake is distinguishable from a bug in our own code. Run:
 *   npx tsx scripts/smtp-probe.ts <recipient>
 */
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

function envFromFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const cfg = envFromFile(".env.local");
const user = process.env.SMTP_PROBE_USER || cfg.SMTP_USER || "";
// App Passwords render as 4 groups of 4; SMTP needs them concatenated.
const pass = (process.env.SMTP_PROBE_PASS || cfg.SMTP_APP_PASSWORD || "").replace(/\s+/g, "");
const host = cfg.SMTP_HOST ?? "smtp.gmail.com";
const port = Number(cfg.SMTP_PORT ?? 465);
const recipient = process.argv[2] || user;

console.log(`user=${user} host=${host}:${port} passLen=${pass.length} recipient=${recipient}`);

async function main(): Promise<void> {
  const tx = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });

  try {
    const info = await tx.sendMail({
      from: { name: "CareSpeak", address: user },
      to: recipient,
      subject: "CareSpeak SMTP probe",
      text: "SMTP probe from CareSpeak. Safe to delete.",
    });
    console.log("RESULT: delivered", info.messageId);
  } catch (err) {
    const e = err as { code?: string; command?: string; responseCode?: number; message?: string };
    console.log("RESULT: failed");
    console.log("  code        :", e.code);
    console.log("  command     :", e.command);
    console.log("  responseCode:", e.responseCode);
    console.log("  message     :", e.message);
  }

  tx.close();
}

void main().then(() => process.exit(0));
