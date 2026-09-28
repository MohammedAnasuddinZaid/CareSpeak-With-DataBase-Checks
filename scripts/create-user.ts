/**
 * Create a CareSpeak account from the command line.
 *
 * The app deliberately has no self-service staff signup -- anyone who could pick
 * their own role could read a ward -- so accounts are provisioned by whoever
 * operates the deployment. This is that tool, and it exists because "insert the
 * right rows by hand" is how profile rows end up half-created.
 *
 * It also covers the case the API does not: a real person who needs to sign in
 * with their own mailbox. Self-service *patient* signup can be added later as a
 * public endpoint; this path stays operator-only.
 *
 * Usage:
 *   npm run user:create -- --email a@b.com --name "A B" --role patient --password "..."
 *   npm run user:create -- --email a@b.com --name "A B" --role nurse --list
 *
 * Options:
 *   --email      required
 *   --name       required
 *   --role       patient | nurse | doctor | admin   (default patient)
 *   --password   omit to create a password-less account (Google/OTP only)
 *   --mrn        patient medical record number (default MRN-<id>)
 *   --language   patient preferred language (default en-US)
 *   --list       show the id, role and status of every account
 */
import { loadDotEnv } from "../src/lib/server/env";

import { createUser, loadAuthUser } from "../src/lib/server/auth";
import { query, queryOne, execute, closePool } from "../src/lib/server/db";
import type { RowDataPacket } from "mysql2";

type Role = "patient" | "nurse" | "doctor" | "admin";

const ROLES: Role[] = ["patient", "nurse", "doctor", "admin"];

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadDotEnv();

  if (process.argv.includes("--list")) {
    const rows = await query<RowDataPacket & { id: number; email: string; role: string; status: string; display_name: string }>(
      "SELECT id, email, role, status, display_name FROM users ORDER BY role, email",
    );
    console.log(`${"id".padEnd(5)}${"role".padEnd(9)}${"status".padEnd(11)}email`);
    for (const row of rows) {
      console.log(
        `${String(row.id).padEnd(5)}${row.role.padEnd(9)}${row.status.padEnd(11)}${row.email}  (${row.display_name})`,
      );
    }
    console.log(`\n${rows.length} account(s)`);
    await closePool();
    return;
  }

  const email = flag("email")?.trim().toLowerCase();
  if (!email) fail("--email is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`--email does not look like an address: ${email}`);

  const name = flag("name")?.trim();
  if (!name) fail("--name is required");

  const role = (flag("role") ?? "patient") as Role;
  if (!ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(", ")}`);

  const password = flag("password");

  const existing = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM users WHERE email = ?",
    [email],
  );
  if (existing) {
    console.log(`account already exists: ${email} (id=${existing.id})`);
    await closePool();
    return;
  }

  const hospital = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM hospitals ORDER BY id LIMIT 1",
  );

  const { id } = await createUser({
    email,
    displayName: name,
    role,
    hospitalId: hospital?.id ?? null,
    password,
    // Created by the operator on a verified mailbox, so the address is treated
    // as confirmed rather than pending.
    emailVerified: true,
    mrn: flag("mrn"),
    preferredLanguage: flag("language") ?? "en-US",
    staffRole: role === "patient" ? undefined : role,
  });

  const user = await loadAuthUser(id);
  console.log(`created ${role} account`);
  console.log(`  id      : ${id}`);
  console.log(`  email   : ${email}`);
  console.log(`  name    : ${user?.displayName}`);
  console.log(`  mrn     : ${user?.mrn ?? "(n/a)"}`);
  console.log(`  password: ${password ? "set" : "not set (sign in with Google or an emailed code)"}`);

  if (!password) {
    console.log(`\nRequest a sign-in code at /login -> "Email me a code".`);
  }

  // Leave no half-built accounts behind if anything above failed.
  if (!user) {
    await execute("DELETE FROM users WHERE id = ?", [id]);
    fail("the account row was created but its profile was not; rolled back");
  }

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
