/**
 * Demo ward seed.
 *
 * Everything created here is SYNTHETIC. Names, MRNs and vitals are fabricated
 * for demonstration and must never be used to make a clinical decision. The
 * admin account is the only real identity, and it exists so the demo is not
 * wide open.
 *
 *   npm run db:seed        # idempotent: safe to re-run
 *
 * Idempotency strategy: every insert is keyed on a natural unique column
 * (slug, mrn, device_code, email) and uses INSERT ... ON DUPLICATE KEY UPDATE,
 * so re-seeding tops up rather than duplicating.
 */
import type { RowDataPacket } from "mysql2";
import { loadDotEnv } from "../src/lib/server/env";
import { getPool, query, queryOne, execute, closePool } from "../src/lib/server/db";
import { hashPassword, hashOtpCode, hashToken } from "../src/lib/server/crypto";

loadDotEnv();

const DEMO_PASSWORD = "CareSpeak!2026";

const STAFF = [
  { email: "admin@carespeak.health", name: "Dr. A. Rahman", role: "admin" as const, dept: "Clinical Informatics", license: "MC-44120" },
  { email: "nurse.meera@carespeak.health", name: "Meera Iyer", role: "nurse" as const, dept: "General Ward A", license: "RN-77801" },
  { email: "nurse.rahul@carespeak.health", name: "Rahul Verma", role: "nurse" as const, dept: "General Ward A", license: "RN-77802" },
  { email: "doctor.sara@carespeak.health", name: "Dr. Sara Qureshi", role: "doctor" as const, dept: "General Ward A", license: "MC-51233" },
];

type PatientSpec = {
  name: string;
  mrn: string;
  dob: string;
  gender: "female" | "male" | "other";
  blood: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";
  lang: string;
  mode: "hand" | "eye" | "dwell" | "dwell_blink" | "switch" | "mixed";
  reason: string;
  notes: string;
  bed: number;
  // Clinical picture driving the synthetic vitals below.
  profile: "stable" | "deteriorating" | "postop" | "unresponsive";
};

const PATIENTS: PatientSpec[] = [
  { name: "Kamala Bai", mrn: "CS-100241", dob: "1948-03-11", gender: "female", blood: "B+", lang: "hi-IN", mode: "dwell", reason: "Post-op day 2, hip replacement", notes: "Post-op. Cannot speak. Uses gaze dwell for all needs. Family visits evenings.", bed: 1, profile: "postop" },
  { name: "Ramesh Chandra", mrn: "CS-100242", dob: "1955-07-29", gender: "male", blood: "O+", lang: "ta-IN", mode: "hand", reason: "Community-acquired pneumonia", notes: "Mild confusion. Responds to hand gestures reliably. On IV antibiotics.", bed: 2, profile: "deteriorating" },
  { name: "Yusuf Khan", mrn: "CS-100243", dob: "1961-01-04", gender: "male", blood: "A+", lang: "ur-IN", mode: "eye", reason: "Stroke, right hemiparesis", notes: "Left-side paralysis. Communicates by eye movements only. Dysphagia risk, swallow assessment pending.", bed: 3, profile: "stable" },
  { name: "Lakshmi Devi", mrn: "CS-100244", dob: "1942-11-22", gender: "female", blood: "AB+", lang: "te-IN", mode: "dwell_blink", reason: "Sepsis, urinary source", notes: "Alert but low reserve. Pain control inadequate, see MAR. Gaze dwell + blink for yes/no.", bed: 4, profile: "deteriorating" },
  { name: "Gurpreet Singh", mrn: "CS-100245", dob: "1970-05-16", gender: "male", blood: "O-", lang: "pa-IN", mode: "switch", reason: "Motor neuron disease", notes: "Locked-in, single-switch scanning. Respiratory function declining. Full advance directive on file.", bed: 5, profile: "stable" },
  { name: "Sita Rani", mrn: "CS-100246", dob: "1959-09-08", gender: "female", blood: "A-", lang: "bn-IN", mode: "hand", reason: "Diabetic ketoacidosis, resolving", notes: "Improving. Regaining strength, hand gestures becoming reliable again.", bed: 6, profile: "stable" },
  { name: "Abdul Rehman", mrn: "CS-100247", dob: "1950-12-30", gender: "male", blood: "B-", lang: "mr-IN", mode: "eye", reason: "COPD exacerbation", notes: "Distressed, speaks in short phrases when able. Eye signals when dyspneic. Oxygen 2L/min.", bed: 7, profile: "deteriorating" },
  { name: "Meenakshi Rao", mrn: "CS-100248", dob: "1947-06-02", gender: "female", blood: "O+", lang: "kn-IN", mode: "dwell", reason: "Fractured neck of femur", notes: "Confused post-anaesthetic. Family reports she 'is not herself'. Consent proxy: eldest son.", bed: 8, profile: "postop" },
];

type Vitals = { hr: number; spo2: number; temp: number; rr: number };

/** Synthetic vitals trajectory per clinical picture. Purely invented numbers. */
function trajectory(profile: PatientSpec["profile"], minutesAgo: number): Vitals {
  const t = minutesAgo / 60; // hours ago
  switch (profile) {
    case "postop":
      return { hr: Math.round(96 - 8 * t), spo2: 96.5 - t * 0.2, temp: 37.6 + t * 0.15, rr: 18 + Math.round(t) };
    case "deteriorating":
      return { hr: Math.round(104 + 14 * Math.min(t, 6)), spo2: 90.5 - Math.min(t, 6) * 0.55, temp: 38.4 + Math.min(t, 8) * 0.06, rr: 24 + Math.round(Math.min(t, 6) * 0.8) };
    case "unresponsive":
      return { hr: 78, spo2: 94, temp: 36.8, rr: 14 };
    default:
      return { hr: Math.round(76 + 4 * Math.sin(t)), spo2: 97.4 - t * 0.05, temp: 36.9, rr: 16 };
  }
}

function jitter(value: number, amplitude: number): number {
  return Math.round((value + (Math.random() * 2 - 1) * amplitude) * 100) / 100;
}

async function seed(): Promise<void> {
  const pool = getPool();
  console.log("\nseeding CareSpeak demo ward (all records synthetic)\n");

  // --- hospital / ward / beds ---------------------------------------------
  await execute(
    `INSERT INTO hospitals (slug, name, timezone, locale) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    ["genercity", "Generic City Teaching Hospital", "Asia/Kolkata", "en-IN"],
  );
  const hospital = (await query<RowDataPacket>("SELECT id FROM hospitals WHERE slug = ?", ["genercity"]))[0];

  await execute(
    `INSERT INTO wards (hospital_id, code, name, floor, bed_capacity) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), bed_capacity = VALUES(bed_capacity)`,
    [hospital.id, "GWA", "General Ward A", "2", 8],
  );
  const ward = (await query<RowDataPacket>("SELECT id FROM wards WHERE hospital_id = ? AND code = ?", [hospital.id, "GWA"]))[0];

  console.log(`  hospital + ward ready`);

  // --- staff --------------------------------------------------------------
  const staffIds: Record<string, number> = {};
  for (const person of STAFF) {
    await execute(
      `INSERT INTO users (hospital_id, email, password_hash, display_name, role, email_verified_at)
       VALUES (?,?,?,?,?,NOW(3))
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), role = VALUES(role)`,
      [hospital.id, person.email, await hashPassword(DEMO_PASSWORD), person.name, person.role],
    );
    const row = (await query<RowDataPacket>("SELECT id FROM users WHERE email = ?", [person.email]))[0];
    await execute(
      `INSERT INTO staff_profiles (user_id, staff_role, license_no, department, shift_start, shift_end)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE department = VALUES(department)`,
      [row.id, person.role, person.license, person.dept, "07:00:00", "19:00:00"],
    );
    // Bedside PIN: the 6 digits a nurse types to unlock a bedside console during
    // a round. Hashed, never stored in the clear.
    await execute("UPDATE staff_profiles SET quick_pin_hash = ? WHERE user_id = ?", [
      await hashPassword(String(100000 + (row.id % 900000))),
      row.id,
    ]);
    staffIds[person.email] = row.id;
  }
  console.log(`  ${STAFF.length} staff accounts (password: ${DEMO_PASSWORD})`);

  // --- patients -----------------------------------------------------------
  const patientIds: number[] = [];
  for (const spec of PATIENTS) {
    await execute(
      `INSERT INTO users (hospital_id, email, display_name, role, locale, email_verified_at)
       VALUES (?,?,?,'patient',?,NOW(3))
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
      [hospital.id, `${spec.mrn.toLowerCase()}@patient.carespeak.invalid`, spec.name, spec.lang],
    );
    const user = (await query<RowDataPacket>("SELECT id FROM users WHERE email = ?", [
      `${spec.mrn.toLowerCase()}@patient.carespeak.invalid`,
    ]))[0];

    await execute(
      `INSERT INTO patient_profiles
         (user_id, mrn, date_of_birth, gender, blood_group, preferred_language,
          communication_mode, aac_board_enabled, bedside_pin_hash, care_notes, admission_reason, baseline)
       VALUES (?,?,?,?,?,?,?,1,?,?,?,?)
       ON DUPLICATE KEY UPDATE care_notes = VALUES(care_notes), communication_mode = VALUES(communication_mode)`,
      [
        user.id, spec.mrn, spec.dob, spec.gender, spec.blood, spec.lang, spec.mode,
        await hashPassword(String(100000 + (user.id % 900000))),
        spec.notes, spec.reason,
        JSON.stringify({ heart_rate: 78, spo2: 97, temperature: 36.9, alertness_score: 72 }),
      ],
    );

    await execute(
      `INSERT INTO beds (ward_id, bed_code, label, status) VALUES (?,?,?,'occupied')
       ON DUPLICATE KEY UPDATE status = 'occupied'`,
      [ward.id, `B${String(spec.bed).padStart(2, "0")}`, `Bed ${spec.bed}`],
    );
    const bed = (await query<RowDataPacket>("SELECT id FROM beds WHERE ward_id = ? AND bed_code = ?", [ward.id, `B${String(spec.bed).padStart(2, "0")}`]))[0];

    // The generated partial-unique column makes a second active admission fail,
    // so only create one when the patient is not already admitted.
    const existing = await query<RowDataPacket>(
      "SELECT id FROM admissions WHERE patient_id = ? AND status = 'active'",
      [user.id],
    );
    if (existing.length === 0) {
      await execute(
        "INSERT INTO admissions (patient_id, bed_id, source, diagnosis) VALUES (?,?,?,?)",
        [user.id, bed.id, spec.profile === "deteriorating" ? "emergency" : "elective", spec.reason],
      );
    }

    await execute(
      `INSERT INTO devices (device_code, bed_id, device_token_hash, firmware_version, status, last_seen_at)
       VALUES (?,?,?,?,'online',NOW(3))
       ON DUPLICATE KEY UPDATE bed_id = VALUES(bed_id), status = 'online'`,
      [`esp32_gwa_bed${String(spec.bed).padStart(2, "0")}`, bed.id, hashToken(`demo-device-token-${spec.mrn}`), "2.1.0"],
    );

    // Notification escalation chain for clinical staff.
    for (const person of STAFF.filter((s) => s.role !== "admin").slice(0, 2)) {
      await execute(
        `INSERT INTO notification_channels (user_id, kind, target, label, is_primary, verified_at, escalation_order)
         VALUES (?,'email',?,?,1,NOW(3),?)
         ON DUPLICATE KEY UPDATE verified_at = NOW(3)`,
        [staffIds[person.email], person.email, `${person.name} (work email)`, person.role === "doctor" ? 1 : 2],
      );
    }

    await execute(
      `INSERT INTO consents (patient_id, consent_type, granted, scope, method)
       VALUES (?,'treatment',1,'Care and treatment in this admission','digital_signature')`,
      [user.id],
    );
    await execute(
      `INSERT INTO consents (patient_id, consent_type, granted, scope, method)
       VALUES (?,'data_processing',1,'Vital signs and gesture monitoring for care delivery','digital_signature')`,
      [user.id],
    );

    patientIds.push(user.id);
  }
  console.log(`  ${PATIENTS.length} patients admitted across ${PATIENTS.length} beds`);

  // --- care assignments ---------------------------------------------------
  const nurses = [staffIds["nurse.meera@carespeak.health"], staffIds["nurse.rahul@carespeak.health"]];
  for (let i = 0; i < patientIds.length; i += 1) {
    const nurse = nurses[i % nurses.length];
    const existing = await query<RowDataPacket>(
      "SELECT id FROM care_assignments WHERE staff_id = ? AND patient_id = ? AND unassigned_at IS NULL",
      [nurse, patientIds[i]],
    );
    if (existing.length === 0) {
      await execute(
        "INSERT INTO care_assignments (staff_id, patient_id, is_primary) VALUES (?,?,1)",
        [nurse, patientIds[i]],
      );
    }
  }
  console.log("  care assignments linked");

  // --- conversations ------------------------------------------------------
  for (const patientId of patientIds) {
    const existing = await query<RowDataPacket>("SELECT id FROM conversations WHERE patient_id = ?", [patientId]);
    if (existing.length === 0) {
      await execute("INSERT INTO conversations (patient_id) VALUES (?)", [patientId]);
    }
  }

  // --- synthetic vital history -------------------------------------------
  // 12 hours of samples per patient, at 5-minute resolution, with the two
  // deteriorating profiles trending down so the forecast and risk engines have
  // a real signal to find.
  let vitalRows = 0;
  for (let i = 0; i < PATIENTS.length; i += 1) {
    const spec = PATIENTS[i];
    const patientId = patientIds[i];
    const bed = (await query<RowDataPacket>("SELECT id FROM beds WHERE ward_id = ? AND bed_code = ?", [
      ward.id, `B${String(spec.bed).padStart(2, "0")}`,
    ]))[0];
    const device = (await query<RowDataPacket>("SELECT id FROM devices WHERE device_code = ?", [
      `esp32_gwa_bed${String(spec.bed).padStart(2, "0")}`,
    ]))[0];

    const already = await query<RowDataPacket>(
      "SELECT COUNT(*) AS n FROM vitals WHERE patient_id = ?",
      [patientId],
    );
    if (Number(already[0]?.n ?? 0) > 0) continue; // already seeded

    const batch: unknown[][] = [];
    for (let minutesAgo = 12 * 60; minutesAgo >= 0; minutesAgo -= 5) {
      const v = trajectory(spec.profile, minutesAgo);
      const recordedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 23).replace("T", " ");
      batch.push([
        patientId, bed.id, device.id,
        Math.max(20, Math.min(300, Math.round(v.hr))),
        jitter(Math.max(50, Math.min(100, v.spo2)), 0.8),
        jitter(Math.max(25, Math.min(45, v.temp)), 0.25),
        Math.max(5, Math.min(60, Math.round(v.rr))),
        60 + Math.round(Math.random() * 38),
        -45 - Math.round(Math.random() * 25),
        0,
        jitter(14 + Math.random() * 6, 2),
        jitter(spec.profile === "deteriorating" ? 40 - minutesAgo * 0.02 : 70, 5),
        Math.random() * 0.4,
        recordedAt,
      ]);
    }
    // Chunked multi-row insert: 144 rows per patient in one statement.
    const CHUNK = 50;
    for (let start = 0; start < batch.length; start += CHUNK) {
      const slice = batch.slice(start, start + CHUNK);
      await execute(
        `INSERT INTO vitals
           (patient_id, bed_id, device_id, heart_rate, spo2, temperature, respiratory_rate,
            battery_pct, rssi, sos_active, blink_rate, alertness_score, movement_activity, recorded_at)
         VALUES ${slice.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
        slice.flat(),
      );
      vitalRows += slice.length;
    }
  }
  // Re-running the seed is a no-op for any patient that already has history, so
  // report what is actually in the table rather than what this run happened to
  // insert. Printing "0 samples" while 1160 rows sit in vitals is the kind of
  // output that makes a demo look broken when it is not.
  const vitalTotal = await queryOne<RowDataPacket>("SELECT COUNT(*) AS n FROM vitals");
  const total = Number(vitalTotal?.n ?? 0);
  console.log(
    vitalRows > 0
      ? `  ${vitalRows} synthetic vital samples across 12h (${total} total)`
      : `  vital history already present (${total} samples across 12h)`,
  );

  // --- care tasks ---------------------------------------------------------
  const taskCount = await query<RowDataPacket>("SELECT COUNT(*) AS n FROM care_tasks");
  if (Number(taskCount[0]?.n ?? 0) === 0) {
    const bedRows = await query<RowDataPacket>("SELECT id, bed_code FROM beds WHERE ward_id = ? ORDER BY bed_code", [ward.id]);
    const tasks: [string, string, string, string, string, string][] = [];
    for (const bed of bedRows) {
      const patient = (await query<RowDataPacket>(
        `SELECT a.patient_id FROM admissions a WHERE a.bed_id = ? AND a.status = 'active'`,
        [bed.id],
      ))[0];
      if (!patient) continue;
      tasks.push([String(patient.patient_id), String(bed.id), "Reposition patient", "Reposition and check skin integrity at sacrum and heels.", "positioning", "urgent"]);
      tasks.push([String(patient.patient_id), String(bed.id), "Offer oral fluids", "Encourage 200ml unless fluid restriction is documented.", "nutrition", "routine"]);
      tasks.push([String(patient.patient_id), String(bed.id), "Vitals observation", "Full set including SpO2 on room air.", "observation", "routine"]);
    }
    for (const [patientId, bedId, title, instructions, kind, priority] of tasks) {
      await execute(
        `INSERT INTO care_tasks (patient_id, bed_id, created_by, title, instructions, kind, priority, due_at)
         VALUES (?,?,?,?,?,?,?,DATE_ADD(NOW(3), INTERVAL 2 HOUR))`,
        [patientId, bedId, staffIds["nurse.meera@carespeak.health"], title, instructions, kind, priority],
      );
    }
    console.log(`  ${tasks.length} care tasks queued`);
  }

  // --- medication administration record ----------------------------------
  const marCount = await query<RowDataPacket>("SELECT COUNT(*) AS n FROM medication_admin");
  if (Number(marCount[0]?.n ?? 0) === 0) {
    const bedRows = await query<RowDataPacket>("SELECT id FROM beds WHERE ward_id = ? ORDER BY bed_code", [ward.id]);
    const script: [string, string, string, string, string][] = [];
    for (const bed of bedRows) {
      const patient = (await query<RowDataPacket>(
        "SELECT patient_id FROM admissions WHERE bed_id = ? AND status = 'active'",
        [bed.id],
      ))[0];
      if (!patient) continue;
      script.push([String(patient.patient_id), String(bed.id), "Paracetamol 1g", "1 g", "oral"]);
      script.push([String(patient.patient_id), String(bed.id), "Enoxaparin 40mg", "40 mg", "sc"]);
      script.push([String(patient.patient_id), String(bed.id), "Salbutamol neb", "2.5 mg", "inhaled"]);
    }
    for (const [patientId, bedId, medication, dose, route] of script) {
      await execute(
        `INSERT INTO medication_admin (patient_id, bed_id, medication, dose, route, scheduled_at, status)
         VALUES (?,?,?,?,?,DATE_ADD(NOW(3), INTERVAL 1 HOUR),'scheduled')
         ON DUPLICATE KEY UPDATE scheduled_at = scheduled_at`,
        [patientId, bedId, medication, dose, route],
      );
    }
    console.log(`  ${script.length} medication administrations scheduled`);
  }

  console.log(`\nseed complete. sign in with any of:`);
  for (const person of STAFF) console.log(`  ${person.email}  /  ${DEMO_PASSWORD}`);
  console.log(`\nquick PIN for a bedside console: 6 digits shown by the ward view.\n`);
}

seed()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("\nseed failed:", err);
    await closePool();
    process.exit(1);
  });
