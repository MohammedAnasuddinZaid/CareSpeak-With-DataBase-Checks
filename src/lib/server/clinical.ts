/**
 * MySQL clinical repository — the system of record for everything a bedside
 * console and a nurse console exchange.
 *
 * Before this, `src/lib/server/store.ts` held the entire clinical record in a
 * process-local Map. Two consequences that make it unfit for a real ward:
 *
 *   1. Every nurse action was lost on restart. "I acknowledged that at 14:02"
 *     was unprovable, and the closed-loop escalation chain was a UI fiction.
 *   2. With more than one server instance, the nurse's dashboard and the
 *     patient's console could be talking to two different processes and simply
 *      not see each other's writes.
 *
 * This module is the replacement. Design rules it holds to:
 *
 *   - Reads of clinical data are *always* authorised. Possession of the session
 *     code (the bed's QR / typed ID) is enough to mint a read credential for
 *     that bed -- login is reserved for clinical ACTIONS and history. The first
 *     credential is the session's primary token; every other device gets its own
 *     viewer credential in `console_viewers`, so the bedside console and any
 *     number of phones can watch the same bed at once. Credentials never cross
 *     sessions.
 *   - Writes are idempotent on the client's own string id, so the offline
 *     outbox's retry replay collides on a unique key instead of creating a
 *     second clinical record.
 *   - SSE resumes from a monotonic, gap-free `id` cursor, so a reconnect can
 *     never skip or double-count a sample.
 */
import type { RowDataPacket } from "mysql2/promise";
import { execute, query, queryOne, transaction, txExecute, isDuplicateKey } from "./db";
import { generateToken, hashToken, constantTimeEqual } from "./crypto";
import { sanitizeVitals, clampFinite } from "./vitals";
import type {
  DeviceVitals,
  GestureLogEntry,
  NurseReply,
  PatientMetrics,
} from "@/types";
import type { AuthUser } from "./auth";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface ConsoleSession {
  id: number;
  code: string;
  patientId: number | null;
  bedId: number | null;
}

interface SessionRow extends RowDataPacket {
  id: number;
  session_code: string;
  patient_id: number | null;
  bed_id: number | null;
}

export const SESSION_CODE_RE = /^[A-Z0-9_-]{3,32}$/;

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return SESSION_CODE_RE.test(code) ? code : null;
}

/** A console session is handed out per bed; 12h keeps an unattended ward from
 *  accumulating a permanent pile of live credentials. */
const SESSION_TTL_HOURS = 12;

/* -------------------------------------------------------------------------- */
/* Session resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a session code to a durable `console_sessions` row, creating it on
 * first sight.
 *
 * The backfill is the part that matters. A session code is just a string at
 * first ("BED-12"), so there is no patient to authorise against — which is
 * exactly why the legacy code could leak. On creation we try to bind it to a
 * real admitted patient by matching the code against an active bed label, and
 * every later call re-attempts the bind, so a session created before a patient
 * was admitted picks up the patient on the next request.
 */
export async function getOrCreateSession(
  code: string,
  label?: string,
): Promise<{ session: ConsoleSession; token: string | null; created: boolean }> {
  const clean = normalizeCode(code);
  if (!clean) throw new Error("invalid session code");

  const existing = await queryOne<SessionRow>(
    `SELECT id, session_code, patient_id, bed_id FROM console_sessions
      WHERE session_code = ? LIMIT 1`,
    [clean],
  );

  if (existing) {
    const bound = await bindToAdmission(existing);
    return {
      session: toSession(bound),
      token: null,
      created: false,
    };
  }

  // Mint a console token up front. It is returned exactly once, to the caller
  // that created the session; after this the plaintext is unrecoverable and only
  // sha256(token) remains, which is what the QR and the console cookie carry.
  const token = generateToken(32);
  const inserted = await insertSession(clean, token, label);

  const row = await queryOne<SessionRow>(
    `SELECT id, session_code, patient_id, bed_id FROM console_sessions
      WHERE session_code = ? LIMIT 1`,
    [clean],
  );
  if (!row) throw new Error("session creation failed");

  // If another request won the race, the row now holds the *winner's* token
  // hash. Handing the loser's freshly minted token back would be worse than
  // useless: the console would store a credential that can never verify, and
  // because the cookie is then immutable, the bed would be permanently
  // unclaimable. Returning null makes the loser fall through to the claim
  // handshake, which resolves the correct credential.
  const tokenToReturn = inserted ? token : null;

  const bound = await bindToAdmission(row);
  return { session: toSession(bound), token: tokenToReturn, created: inserted };
}

/** @returns true when this call is the one that created the row. */
async function insertSession(code: string, token: string, label?: string): Promise<boolean> {
  try {
    await query(
      `INSERT INTO console_sessions
         (session_code, console_token_hash, label, status, expires_at)
       VALUES (?, ?, ?, 'active', DATE_ADD(NOW(3), INTERVAL ? HOUR))`,
      [code, hashToken(token), label?.slice(0, 120) ?? null, SESSION_TTL_HOURS],
    );
    return true;
  } catch (err) {
    // Two devices can race to create the same bed session. The loser reports
    // "not created" and lets the caller re-read the winner's row, so a
    // simultaneous boot is not a 500.
    if (isDuplicateKey(err)) return false;
    throw err;
  }
}

/**
 * Is this session currently readable at all?
 *
 * The same predicate `verifyConsoleToken` enforces, exposed on its own so the
 * claim handshake can ask it BEFORE minting a credential. Expiry and status are
 * deliberately evaluated in SQL against NOW(3) for the timezone reason documented
 * on `verifyConsoleToken`.
 *
 * Without this, claiming an ended or expired bed minted a viewer credential,
 * set it as the cookie, and answered 200 — so the console reported a successful
 * pairing, opened its stream, and then had every single read refused with a 401
 * it had no way to interpret. The client sat in its "Reconnecting…" state
 * forever, retrying a link that could never come up, because the one response
 * that would have told it to stop (the claim) claimed success. A pairing that
 * cannot be read must be refused at the door.
 */
export async function isSessionReadable(sessionId: number): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { readable: number }>(
    `SELECT (status = 'active' AND expires_at > NOW(3)) AS readable
       FROM console_sessions
      WHERE id = ?
      LIMIT 1`,
    [sessionId],
  );
  return Number(row?.readable ?? 0) === 1;
}

/**
 * Bind a session to an admitted patient by matching its code against active bed
 * labels. Best effort: an unbound session is still usable, it just cannot be
 * authorised against a patient, so a read attempt on it is refused rather than
 * silently allowed.
 */
async function bindToAdmission(row: SessionRow): Promise<SessionRow> {
  if (row.patient_id) return row;

  const bound = await queryOne<RowDataPacket & { bed_id: number; patient_id: number }>(
    `SELECT a.bed_id, a.patient_id
       FROM admissions a
       JOIN beds b ON b.id = a.bed_id
      WHERE a.status = 'active'
        AND ( UPPER(b.bed_code) = ?
              OR UPPER(REPLACE(b.bed_code, '-', '')) = REPLACE(?, '-', '')
              OR UPPER(b.label) = ? )
      ORDER BY a.admitted_at DESC
      LIMIT 1`,
    [row.session_code, row.session_code, row.session_code],
  ).catch(() => null);

  if (!bound) return row;

  await query(
    `UPDATE console_sessions SET patient_id = ?, bed_id = ? WHERE id = ?`,
    [bound.patient_id, bound.bed_id, row.id],
  );
  return { ...row, patient_id: bound.patient_id, bed_id: bound.bed_id };
}

function toSession(row: SessionRow): ConsoleSession {
  return {
    id: Number(row.id),
    code: String(row.session_code),
    patientId: row.patient_id === null ? null : Number(row.patient_id),
    bedId: row.bed_id === null ? null : Number(row.bed_id),
  };
}

/**
 * Mint a second (or third, or Nth) read credential for an existing session.
 *
 * ``console_sessions.console_token_hash`` is a single slot: whoever claimed the
 * bed first (normally the bedside console) owns it, and a second device that
 * presents the same code used to be refused outright. Every device that scans
 * the QR or types the code should be able to view the bed without a login, so a
 * claim on an existing session now mints a fresh viewer credential here instead
 * of dying on a 409.
 */
export async function mintViewerCredential(sessionId: number): Promise<string> {
  const token = generateToken(32);
  await query(
    `INSERT INTO console_viewers (session_id, token_hash) VALUES (?, ?)`,
    [sessionId, hashToken(token)],
  );
  return token;
}

/**
 * Constant-time check of a console token against the stored hash.
 *
 * The token is the thing that authorises a read for a non-staff caller, so
 * this must not leak length or prefix through timing, and a wrong token must be
 * indistinguishable from a missing one.
 *
 * A token verifies if it is either the session's own primary credential or one
 * of its viewer credentials, so the bedside console and every phone that
 * scanned its QR can all hold valid credentials for the same bed at once. A
 * credential never crosses sessions: the hash is looked up against this
 * session's rows only.
 */
export async function verifyConsoleToken(code: string, token: string | null): Promise<ConsoleSession | null> {
  if (!token || token.length < 16 || token.length > 128) return null;
  const clean = normalizeCode(code);
  if (!clean) return null;

  // Expiry is filtered in SQL, not in JS, on purpose. `dateStrings` returns
  // "YYYY-MM-DD HH:MM:SS.mmm", and `new Date(...)` parses that form as *local*
  // time. On this host (UTC+5:30) a row that is genuinely valid until 19:00 UTC
  // therefore read back as 13:30 UTC and every console token was cut off five and
  // a half hours early -- a shift that started at 07:00 lost its nurse link at
  // 13:30 with no error anywhere. MySQL compares against NOW(3) in the same
  // pinned UTC session, so this is correct regardless of the host's timezone.
  const row = await queryOne<SessionRow>(
    `SELECT id, session_code, patient_id, bed_id
       FROM console_sessions
      WHERE session_code = ?
        AND status = 'active'
        AND expires_at > NOW(3)
      LIMIT 1`,
    [clean],
  );
  if (!row) return null;

  const actual = Buffer.from(hashToken(token), "hex");
  const actualLen = actual.length;

  // The session's own primary credential.
  const hashRow = await queryOne<RowDataPacket & { console_token_hash: string }>(
    `SELECT console_token_hash FROM console_sessions WHERE id = ? LIMIT 1`,
    [row.id],
  );
  if (hashRow) {
    const expected = Buffer.from(String(hashRow.console_token_hash), "hex");
    if (expected.length === actualLen && constantTimeEqual(expected, actual)) return toSession(row);
  }

  // Every viewer credential this session minted for other devices.
  const viewers = await query<RowDataPacket>(
    `SELECT token_hash FROM console_viewers WHERE session_id = ?`,
    [row.id],
  );
  for (const v of viewers) {
    const expected = Buffer.from(String(v.token_hash), "hex");
    if (expected.length === actualLen && constantTimeEqual(expected, actual)) return toSession(row);
  }

  return null;
}

/**
 * Keep an active session alive.
 *
 * The comment this replaces claimed it stopped a console being "reaped
 * mid-shift", but it only wrote `last_seen_at`; `expires_at` was fixed at
 * creation, so a console opened at 07:00 still died at 19:00 no matter how
 * active it was. A 12h shift that starts at 07:00 ends at 20:00, so the console
 * went dark in the last hour. Sliding the expiry from the last touch fixes that
 * while still expiring a genuinely abandoned console after the idle window.
 */
export async function touchSession(id: number): Promise<void> {
  await query(
    `UPDATE console_sessions
        SET last_seen_at = NOW(3),
            expires_at = GREATEST(expires_at, DATE_ADD(NOW(3), INTERVAL ? HOUR))
      WHERE id = ? AND status = 'active'`,
    [SESSION_TTL_HOURS, id],
  );
}

/* -------------------------------------------------------------------------- */
/* Authorisation                                                               */
/* -------------------------------------------------------------------------- */

export type ReadAuth =
  | { ok: true; via: "console_token" | "staff" | "patient"; user: AuthUser | null }
  | { ok: false; reason: "unauthenticated" | "forbidden" };

/**
 * Bind an unpaired console session to the patient who is signed in and using it.
 *
 * This is what makes a patient's own history survive between logins.
 *
 * `bindToAdmission` can only match a session code against a real bed label, so a
 * patient on their own phone — whose code the browser invented at random, like
 * `T57S44` — matched nothing, ever. The session stayed `patient_id IS NULL`, and
 * two things followed:
 *
 *   - `authorizeRead` refused the session outright (`forbidden` for a patient
 *     role), so the patient could not read back their own device's record; and
 *   - `appendGesture` writes `patient_id = session.patientId`, i.e. NULL, so
 *     every gesture was stored belonging to nobody.
 *
 * That is the reported symptom exactly: data is being written, and signing in
 * again shows an empty history, because none of it was ever attached to the
 * account.
 *
 * The guard is the whole security argument, so it is one statement:
 *
 *     WHERE patient_id IS NULL AND bed_id IS NULL
 *
 * A session is claimable only while it has never been attached to a bed. Once
 * `bed_id` is set this is a clinical console at a real bed, and a patient must
 * not be able to point their account at it — otherwise anyone who learned a bed
 * code could write their own gestures into an admitted patient's chart and read
 * back an admission they were never assigned to. Refusing rather than
 * re-pointing an already-claimed session is the other half: two patients sharing
 * a ward tablet cannot overwrite each other, and the first claimer keeps it.
 *
 * @returns the claimed session, or null when it was already bound, already has a
 *          bed, is not active, or does not exist.
 */
export async function claimSessionForPatient(
  code: string,
  userId: number,
): Promise<ConsoleSession | null> {
  const clean = normalizeCode(code);
  if (!clean) return null;

  const result = await execute(
    `UPDATE console_sessions
        SET patient_id = ?, last_seen_at = NOW(3)
      WHERE session_code = ?
        AND status = 'active'
        AND patient_id IS NULL
        AND bed_id IS NULL`,
    [userId, clean],
  );
  // Zero affected rows is the common case, not a failure: a real bed console,
  // somebody else's session, or a repeat claim by the same patient.
  if (result.affectedRows === 0) return null;

  const row = await queryOne<SessionRow>(
    `SELECT id, session_code, patient_id, bed_id FROM console_sessions
      WHERE session_code = ? LIMIT 1`,
    [clean],
  );
  return row ? toSession(row) : null;
}

/**
 * Decide whether a caller may read a session's clinical record.
 *
 * Two independent credentials, deliberately not interchangeable:
 *
 *   - The **console token** authorises the bedside console for its own session.
 *     It grants nothing else: no other bed, no staff functions.
 *   - A **staff account** authorises by assignment (ABAC) in auth.ts, so a
 *     nurse covering another ward cannot read a stranger's vitals.
 *
 * A session code with neither is refused. That refusal is the whole point of
 * this module.
 */
export async function authorizeRead(
  code: string,
  consoleToken: string | null,
  user: AuthUser | null,
): Promise<{ auth: ReadAuth; session: ConsoleSession | null }> {
  if (consoleToken) {
    const session = await verifyConsoleToken(code, consoleToken);
    if (session) {
      await touchSession(session.id);
      return { auth: { ok: true, via: "console_token", user: null }, session };
    }
  }

  if (user) {
    const { session } = await getOrCreateSession(code);

    // A patient on their own device: the session has no admitted patient because
    // no bed owns it. Try to attach it to *this* account before deciding, so that
    // signing in is what makes the device theirs and their history starts
    // accumulating from that moment. The claim is refused for a session that
    // already has a patient or a bed, so this cannot reach a clinical console.
    if (user.role === "patient" && session.patientId === null && session.bedId === null) {
      // Deliberately not wrapped in a catch. `claimSessionForPatient` already
      // returns null for the ordinary "someone got there first" case; letting a
      // real database error propagate keeps an outage a 500 instead of
      // reporting it to the patient as "forbidden", which would send them
      // hunting for a permissions problem that does not exist.
      const claimed = await claimSessionForPatient(code, user.id);
      if (claimed) {
        await touchSession(claimed.id);
        return { auth: { ok: true, via: "patient", user }, session: claimed };
      }
    }

    // Unbound sessions (no admitted patient) are staff-visible so a nurse can
    // still see and triage a bed that has no patient record yet.
    if (session.patientId === null) {
      if (user.role === "patient") return { auth: { ok: false, reason: "forbidden" }, session: null };
      return { auth: { ok: true, via: "staff", user }, session };
    }
    const { canAccessPatient } = await import("./auth");
    if (await canAccessPatient(user, session.patientId)) {
      await touchSession(session.id);
      // A patient returning to their own already-claimed device is still the
      // patient, not staff. Reporting "staff" here made the first request after
      // claiming look different from every later one, which matters because
      // `via` is what callers and audits use to tell those two cases apart.
      return { auth: { ok: true, via: user.role === "patient" ? "patient" : "staff", user }, session };
    }
  }

  return { auth: { ok: false, reason: user ? "forbidden" : "unauthenticated" }, session: null };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

interface GestureRow extends RowDataPacket {
  id: number;
  client_key: string | null;
  gesture: string;
  description: string;
  confidence: number | null;
  modality: string;
  source: string;
  language: string;
  occurred_ms: number;
  created_ms: number;
  status: string;
  ack_at: Date | null;
  escalated_by: string | null;
  escalated_at: Date | null;
  resolved_at: Date | null;
}

const ENTRY_SELECT = `
  SELECT g.id, g.client_key, g.gesture, g.description, g.confidence, g.modality,
         g.source, g.language,
         UNIX_TIMESTAMP(g.occurred_at) * 1000 AS occurred_ms,
         UNIX_TIMESTAMP(g.created_at)   * 1000 AS created_ms,
         g.status, g.ack_at, g.escalated_by, g.escalated_at, g.resolved_at
    FROM gestures g
   WHERE g.session_id = ?`;

function toEntry(r: GestureRow): GestureLogEntry {
  const entry: GestureLogEntry = {
    // The client's own id is the stable identity it already tracks; fall back to
    // the surrogate key only if an old row predates client_key.
    id: r.client_key ?? String(r.id),
    gesture: r.gesture,
    description: r.description,
    confidence: r.confidence === null ? 0 : Number(r.confidence),
    type: r.modality === "eye" ? "eye" : r.modality === "system" ? "system" : "hand",
    timestamp: Number(r.occurred_ms),
    serverTime: Number(r.created_ms),
    language: r.language,
    source: (["demo", "iot", "manual", "system"].includes(r.source) ? r.source : "camera") as
      | "demo" | "iot" | "manual" | "system" | "camera",
  };
  if (r.status === "ack" || r.status === "escalated" || r.status === "resolved") {
    entry.acknowledged = true;
    entry.acknowledgedAt = r.ack_at ? new Date(r.ack_at).getTime() : undefined;
  }
  if (r.status === "escalated" || r.status === "resolved") {
    entry.escalated = true;
    entry.escalatedBy = r.escalated_by === "system" ? "system" : "staff";
    entry.escalatedAt = r.escalated_at ? new Date(r.escalated_at).getTime() : undefined;
  }
  if (r.status === "resolved") {
    entry.resolved = true;
    entry.resolvedAt = r.resolved_at ? new Date(r.resolved_at).getTime() : undefined;
  }
  return entry;
}

export async function readEntries(sessionId: number, sinceMs = 0): Promise<GestureLogEntry[]> {
  // `since` is a millisecond cursor over created_at; the surrogate id is the
  // tie-breaker so two entries landing in the same millisecond cannot be skipped.
  const rows = await query<GestureRow>(
    `${ENTRY_SELECT} AND g.created_at > FROM_UNIXTIME(? / 1000)
      ORDER BY g.created_at ASC, g.id ASC LIMIT 500`,
    [sessionId, sinceMs],
  );
  return rows.map(toEntry);
}

interface VitalsRow extends RowDataPacket {
  device_id: string;
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  sos_active: number;
  battery_pct: number | null;
  rssi: number | null;
  received_ms: number;
}

function toVitals(r: VitalsRow): DeviceVitals {
  return {
    deviceId: r.device_id,
    heartRate: r.heart_rate === null ? undefined : Number(r.heart_rate),
    spo2: r.spo2 === null ? undefined : Number(r.spo2),
    temperature: r.temperature === null ? undefined : Number(r.temperature),
    sosActive: Number(r.sos_active) === 1,
    batteryPct: r.battery_pct === null ? undefined : Number(r.battery_pct),
    rssi: r.rssi === null ? undefined : Number(r.rssi),
    receivedAt: Number(r.received_ms),
  };
}

export async function readVitals(sessionId: number): Promise<DeviceVitals[]> {
  const rows = await query<VitalsRow>(
    `SELECT v.device_id, v.heart_rate, v.spo2, v.temperature, v.sos_active,
            v.battery_pct, v.rssi,
            UNIX_TIMESTAMP(v.received_at) * 1000 AS received_ms
       FROM vitals v
      WHERE v.session_id = ?
      ORDER BY v.received_at DESC, v.id DESC
      LIMIT 120`,
    [sessionId],
  );
  return rows.map(toVitals).reverse();
}

/* -------------------------------------------------------------------------- */
/* Patient history                                                             */
/* -------------------------------------------------------------------------- */

/** How much history the workspace shows. */
export const HISTORY_LIMIT = 60;

export interface PatientHistory {
  profile: {
    mrn: string;
    bloodGroup: string;
    communicationMode: string;
    preferredLanguage: string;
    aacBoardEnabled: boolean;
  } | null;
  vitals: DeviceVitals[];
  gestures: GestureLogEntry[];
  totals: { vitals: number; gestures: number; firstSeenMs: number | null; lastSeenMs: number | null };
}

interface ProfileRow extends RowDataPacket {
  mrn: string;
  blood_group: string;
  communication_mode: string;
  preferred_language: string;
  aac_board_enabled: number;
}

interface HistoryVitalsRow extends RowDataPacket {
  device_id: string | null;
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  battery_pct: number | null;
  rssi: number | null;
  sos_active: number;
  recorded_ms: number;
}

interface HistoryCountRow extends RowDataPacket {
  vitals: number;
  gestures: number;
  first_ms: number | null;
  last_ms: number | null;
}

/**
 * Everything a patient has produced, keyed to their **account** rather than to a
 * console session.
 *
 * The console-scoped readers above answer "what has this bedside device seen
 * since it was switched on", which is the right question for a nurse watching a
 * live bed. It is the wrong question for a patient signing back in, because their
 * device id and session code are gone by then — so this reads by `patient_id`,
 * which survives.
 *
 * Scoped to one patient id, and the caller is authorised against exactly that id
 * in auth.ts before this runs. There is no "recent patients" query here to
 * accidentally widen.
 */
export async function readPatientHistory(patientId: number): Promise<PatientHistory> {
  const [profile, vitalsRows, gestureRows, totals] = await Promise.all([
    queryOne<ProfileRow>(
      `SELECT mrn, blood_group, communication_mode, preferred_language, aac_board_enabled
         FROM patient_profiles WHERE user_id = ? LIMIT 1`,
      [patientId],
    ),
    query<HistoryVitalsRow>(
      `SELECT device_id, heart_rate, spo2, temperature, battery_pct, rssi,
              sos_active, UNIX_TIMESTAMP(recorded_at) * 1000 AS recorded_ms
         FROM vitals
        WHERE patient_id = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?`,
      [patientId, HISTORY_LIMIT],
    ),
    query<GestureRow>(
      `SELECT g.id, g.client_key, g.gesture, g.description, g.confidence, g.modality,
              g.source, g.language,
              UNIX_TIMESTAMP(g.occurred_at) * 1000 AS occurred_ms,
              UNIX_TIMESTAMP(g.created_at)   * 1000 AS created_ms,
              g.status, g.ack_at, g.escalated_by, g.escalated_at, g.resolved_at
         FROM gestures g
        WHERE g.patient_id = ?
        ORDER BY g.occurred_at DESC, g.id DESC
        LIMIT ?`,
      [patientId, HISTORY_LIMIT],
    ),
    queryOne<HistoryCountRow>(
      `SELECT
         (SELECT COUNT(*) FROM vitals   WHERE patient_id = ?) AS vitals,
         (SELECT COUNT(*) FROM gestures WHERE patient_id = ?) AS gestures,
         (SELECT MIN(t) FROM (SELECT UNIX_TIMESTAMP(recorded_at) * 1000 AS t
                                FROM vitals   WHERE patient_id = ?
                             UNION ALL
                             SELECT UNIX_TIMESTAMP(occurred_at) * 1000 AS t
                                FROM gestures WHERE patient_id = ?) x) AS first_ms,
         (SELECT MAX(t) FROM (SELECT UNIX_TIMESTAMP(recorded_at) * 1000 AS t
                                FROM vitals   WHERE patient_id = ?
                             UNION ALL
                             SELECT UNIX_TIMESTAMP(occurred_at) * 1000 AS t
                                FROM gestures WHERE patient_id = ?) x) AS last_ms`,
      [patientId, patientId, patientId, patientId, patientId, patientId],
    ),
  ]);

  return {
    profile: profile
      ? {
          mrn: String(profile.mrn),
          bloodGroup: String(profile.blood_group),
          communicationMode: String(profile.communication_mode),
          preferredLanguage: String(profile.preferred_language),
          aacBoardEnabled: profile.aac_board_enabled === 1,
        }
      : null,
    // Newest first, so the panel can render straight from the array. `recorded_at`
    // is the reading's own time and `DeviceVitals` has one timestamp field, so it
    // carries both roles here; a vitals history is about when the reading was
    // taken, not when the row landed.
    vitals: vitalsRows.map((r) => ({
      deviceId: r.device_id ?? "unknown",
      heartRate: r.heart_rate ?? undefined,
      spo2: r.spo2 === null ? undefined : Number(r.spo2),
      temperature: r.temperature === null ? undefined : Number(r.temperature),
      batteryPct: r.battery_pct ?? undefined,
      rssi: r.rssi ?? undefined,
      sosActive: r.sos_active === 1,
      receivedAt: r.recorded_ms,
    })),
    gestures: gestureRows.map(toEntry),
    totals: {
      vitals: Number(totals?.vitals ?? 0),
      gestures: Number(totals?.gestures ?? 0),
      firstSeenMs: totals?.first_ms === null || totals?.first_ms === undefined ? null : Number(totals.first_ms),
      lastSeenMs: totals?.last_ms === null || totals?.last_ms === undefined ? null : Number(totals.last_ms),
    },
  };
}

interface MetricsRow extends RowDataPacket {
  blink_rate: number | null;
  alertness_score: number | null;
  eye_closure_ms: number | null;
  movement_activity: number | null;
  last_seen: Date | null;
}

export async function readMetrics(sessionId: number): Promise<PatientMetrics> {
  const row = await queryOne<MetricsRow>(
    `SELECT blink_rate, alertness_score, eye_closure_ms, movement_activity, last_seen
       FROM session_metrics WHERE session_id = ?`,
    [sessionId],
  );
  if (!row) return {};
  const out: PatientMetrics = {};
  if (row.blink_rate !== null) out.blinkRate = Number(row.blink_rate);
  if (row.alertness_score !== null) out.alertnessScore = Number(row.alertness_score);
  if (row.eye_closure_ms !== null) out.eyeClosureDuration = Number(row.eye_closure_ms);
  if (row.movement_activity !== null) out.movementActivity = Number(row.movement_activity);
  if (row.last_seen) out.lastSeen = new Date(row.last_seen).toISOString();
  return out;
}

interface MessageRow extends RowDataPacket {
  id: number;
  client_key: string | null;
  body: string;
  lang: string;
  sender_role: string;
  created_ms: number;
}

function toReply(r: MessageRow): NurseReply {
  const from = r.sender_role === "doctor" ? "Doctor" : r.sender_role === "nurse" ? "Nurse" : "Care team";
  return {
    id: r.client_key ?? String(r.id),
    text: r.body,
    lang: r.lang,
    from,
    timestamp: Number(r.created_ms),
  };
}

export async function readReplies(sessionId: number, sinceMs = 0): Promise<NurseReply[]> {
  // Only nurse->patient messages are rendered on the patient console; a patient's
  // own message must not be echoed back to them as if the nurse had said it.
  const rows = await query<MessageRow>(
    `SELECT m.id, m.client_key, m.body, m.lang, m.sender_role,
            UNIX_TIMESTAMP(m.created_at) * 1000 AS created_ms
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.id = ? AND m.direction = 'nurse_to_patient'
        AND m.created_at > FROM_UNIXTIME(? / 1000)
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 100`,
    [await conversationIdFor(sessionId), sinceMs],
  );
  return rows.map(toReply);
}

/** The conversation a session's messages belong to. */
async function conversationIdFor(sessionId: number): Promise<number | null> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    `SELECT c.id
       FROM conversations c
       JOIN console_sessions s ON s.patient_id = c.patient_id
      WHERE s.id = ? AND c.bed_id <=> s.bed_id
      LIMIT 1`,
    [sessionId],
  );
  return row ? Number(row.id) : null;
}

export interface Snapshot {
  entries: GestureLogEntry[];
  patientMetrics: PatientMetrics;
  vitals: DeviceVitals[];
  replies: NurseReply[];
}

export async function readSnapshot(sessionId: number, sinceMs = 0): Promise<Snapshot> {
  const [entries, patientMetrics, vitals, replies] = await Promise.all([
    readEntries(sessionId, sinceMs),
    readMetrics(sessionId),
    readVitals(sessionId),
    readReplies(sessionId, Math.max(sinceMs - 60_000, 0)),
  ]);
  return { entries, patientMetrics, vitals, replies };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/** Gestures that mean a human needs to intervene, and their alert severity. */
const ALERTING: Record<string, { kind: "help" | "emergency"; severity: "high" | "critical" }> = {
  HELP: { kind: "help", severity: "high" },
  EMERGENCY: { kind: "emergency", severity: "critical" },
};

/**
 * Append a gesture, and open a matching alert for the actionable ones.
 *
 * Idempotent on the client's entry id: the offline outbox replays unacknowledged
 * POSTs on reconnect, and a retry must not produce a second clinical record or a
 * second alert. The unique key turns that into a silent no-op instead.
 */
export async function appendGesture(
  session: ConsoleSession,
  entry: GestureLogEntry,
): Promise<{ created: boolean }> {
  return transaction(async (conn) => {
    let created = true;
    try {
      await txExecute(
        conn,
        `INSERT INTO gestures
           (session_id, client_key, patient_id, gesture, description, confidence,
            modality, source, language, payload, occurred_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [
          session.id,
          entry.id,
          session.patientId,
          entry.gesture,
          entry.description.slice(0, 255),
          entry.confidence,
          entry.type === "eye" ? "eye" : entry.type === "system" ? "system" : "hand",
          entry.source ?? "camera",
          entry.language,
          JSON.stringify({ escalated: entry.escalated ?? false }),
          new Date(entry.timestamp),
        ],
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      created = false; // replay of something we already have
    }

    const rule = ALERTING[entry.gesture];
    if (rule && created) {
      await txExecute(
        conn,
        `INSERT INTO alerts
           (patient_id, bed_id, session_id, kind, severity, title, detail, status, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        [
          session.patientId,
          session.bedId,
          session.id,
          rule.kind,
          rule.severity,
          entry.gesture === "EMERGENCY" ? "Emergency gesture" : "Help requested",
          entry.description.slice(0, 2000),
          `g:${entry.id}`,
        ],
      ).catch((e) => {
        if (!isDuplicateKey(e)) throw e;
      });
    }
    return { created };
  });
}

const STATUS_SQL: Record<string, string> = {
  acknowledge: `status = 'ack', ack_by = ?, ack_at = NOW(3)`,
  escalate: `status = 'escalated', ack_by = COALESCE(ack_by, ?), ack_at = COALESCE(ack_at, NOW(3)),
             escalated_by = ?, escalated_at = NOW(3)`,
  resolve: `status = 'resolved', ack_by = COALESCE(ack_by, ?), ack_at = COALESCE(ack_at, NOW(3)),
            resolved_by = ?, resolved_at = NOW(3)`,
};

/**
 * Record a clinical action against an entry. Attributed to a real user id so the
 * closed loop is auditable, and mirrored onto the alert row so the ward queue and
 * the entry never disagree about whether something was handled.
 */
export async function setEntryStatus(
  session: ConsoleSession,
  entryId: string,
  action: keyof typeof STATUS_SQL,
  actor: AuthUser | null,
  bySystem = false,
): Promise<boolean> {
  const who = bySystem ? null : actor?.id ?? null;
  const role = bySystem ? "system" : "staff";
  const sql = STATUS_SQL[action];
  if (!sql) return false;

  const params: unknown[] = action === "escalate" ? [who, role] : [who];
  const result = await execute(
    `UPDATE gestures SET ${sql} WHERE session_id = ? AND (client_key = ? OR id = ?)`,
    [...params, session.id, entryId, Number.isNaN(Number(entryId)) ? 0 : Number(entryId)],
  );
  if (!result.affectedRows) return false;

  // Mirror onto the alert so the ward queue reflects the same state.
  await query(
    `UPDATE alerts
        SET status = ?,
            ack_by = COALESCE(ack_by, ?),
            ack_at = COALESCE(ack_at, NOW(3)),
            escalated_by = CASE WHEN ? = 'escalated' THEN COALESCE(escalated_by, ?) ELSE escalated_by END,
            escalated_at = CASE WHEN ? = 'escalated' THEN COALESCE(escalated_at, NOW(3)) ELSE escalated_at END,
            resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_by END,
            resolved_at = CASE WHEN ? = 'resolved' THEN NOW(3) ELSE resolved_at END
      WHERE session_id = ? AND idempotency_key = ?`,
    [
      action === "acknowledge" ? "ack" : action === "escalate" ? "escalated" : "resolved",
      who,
      action, role,
      action,
      action, who,
      action,
      session.id,
      `g:${entryId}`,
    ],
  );
  return true;
}

export async function setMetrics(
  sessionId: number,
  deviceId: string,
  metrics: PatientMetrics,
): Promise<void> {
  const blink = clampFinite(metrics.blinkRate, 0, 500);
  const alertness = clampFinite(metrics.alertnessScore, 0, 100);
  const closure = clampFinite(metrics.eyeClosureDuration, 0, 6 * 60 * 60 * 1000);
  const movement = clampFinite(metrics.movementActivity, 0, 1);
  if (blink === undefined && alertness === undefined && closure === undefined && movement === undefined) {
    return;
  }
  await query(
    `INSERT INTO session_metrics
       (session_id, device_id, blink_rate, alertness_score, eye_closure_ms, movement_activity, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       device_id = VALUES(device_id),
       blink_rate = COALESCE(VALUES(blink_rate), blink_rate),
       alertness_score = COALESCE(VALUES(alertness_score), alertness_score),
       eye_closure_ms = COALESCE(VALUES(eye_closure_ms), eye_closure_ms),
       movement_activity = COALESCE(VALUES(movement_activity), movement_activity),
       last_seen = NOW(3)`,
    [sessionId, deviceId.slice(0, 64), blink ?? null, alertness ?? null, closure ?? null, movement ?? null],
  );
}

/**
 * Record a device vital-sign sample. Sanitised server-side: the ESP32 is an
 * unauthenticated-ish HTTP client on a ward network and a NaN or a 900 bpm value
 * must not reach a clinical record or a threshold comparison.
 */
export async function setVitals(
  session: ConsoleSession,
  raw: DeviceVitals,
): Promise<void> {
  const clean = sanitizeVitals(raw);
  await query(
    `INSERT INTO vitals
       (patient_id, bed_id, session_id, heart_rate, spo2, temperature,
        battery_pct, rssi, sos_active, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)))`,
    [
      session.patientId,
      session.bedId,
      session.id,
      raw.deviceId.slice(0, 64),
      clean.heartRate ?? null,
      clean.spo2 === undefined ? null : clean.spo2,
      clean.temperature ?? null,
      clean.batteryPct ?? null,
      clean.rssi ?? null,
      clean.sosActive ? 1 : 0,
      raw.receivedAt ? new Date(raw.receivedAt) : null,
    ],
  );
}

/**
 * Store a nurse reply. `exactly once` is structural here: the unique key on
 * (conversation_id, client_key) means a retried POST cannot deliver the same
 * message twice, which was the reply-loop bug this table was designed to make
 * impossible.
 */
export async function setReply(
  session: ConsoleSession,
  reply: NurseReply,
  actor: AuthUser | null,
): Promise<{ created: boolean }> {
  if (!session.patientId) return { created: false };

  return transaction(async (conn) => {
    const [existing] = await conn.query<RowDataPacket[] & RowDataPacket[]>(
      `SELECT c.id AS id
         FROM conversations c
        WHERE c.patient_id = ? AND c.bed_id <=> ?
        LIMIT 1`,
      [session.patientId, session.bedId],
    );
    let conversationId = (existing as RowDataPacket[])[0]?.id as number | undefined;
    if (conversationId === undefined) {
      const created = await txExecute(
        conn,
        `INSERT INTO conversations (patient_id, bed_id, last_message_at)
         VALUES (?, ?, NOW(3))`,
        [session.patientId, session.bedId],
      );
      conversationId = created.insertId;
    }

    try {
      await txExecute(
        conn,
        `INSERT INTO messages
           (conversation_id, client_key, sender_id, sender_role, direction, body, lang, kind)
         VALUES (?, ?, ?, ?, 'nurse_to_patient', ?, ?, 'free')`,
        [
          conversationId,
          reply.id,
          actor?.id ?? null,
          actor?.role === "doctor" ? "doctor" : actor?.role === "admin" ? "admin" : "nurse",
          reply.text.slice(0, 2000),
          reply.lang,
        ],
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return { created: false };
    }

    await txExecute(conn, `UPDATE conversations SET last_message_at = NOW(3) WHERE id = ?`, [
      conversationId,
    ]);
    return { created: true };
  });
}

/* -------------------------------------------------------------------------- */
/* Ward board                                                                  */
/* -------------------------------------------------------------------------- */

export interface WardRow {
  session: string;
  bed: string | null;
  patient: string | null;
  patientId: number | null;
  lastGesture: string | null;
  lastAt: number | null;
  unacknowledged: number;
  escalated: number;
  today: number;
  alertness: number | null;
  movement: number | null;
  heartRate: number | null;
  spo2: number | null;
  sosActive: boolean;
  linkedDevices: number;
  lastScanAt: number | null;
  lastScanIp: string | null;
  lastSeen: number | null;
}

/**
 * The ward board: one row per live bed.
 *
 * Built as a single query with per-session subqueries rather than N round trips
 * — a 30-bed board is one statement, not ninety. That matters because this is the
 * screen a nurse stares at during a shift; the old version did four sequential
 * awaits per bed and took visibly longer as the ward filled up.
 *
 * Scoped by ABAC when a staff account is supplied: a nurse sees the beds of
 * patients they are actively assigned to, plus unbound beds (no patient record
 * yet, which still need triage visibility). Admins see the whole ward. This is
 * the check that used to be missing, where any signed-in nurse saw every bed.
 */
export async function wardSnapshot(user: AuthUser | null): Promise<WardRow[]> {
  const scopeAll = user?.role === "admin" || user === null;
  const params: unknown[] = [user?.id ?? 0];
  const scopeClause = scopeAll
    ? ""
    : `AND (s.patient_id IS NULL OR EXISTS (
              SELECT 1 FROM care_assignments ca
               WHERE ca.staff_id = ? AND ca.patient_id = s.patient_id
                 AND ca.unassigned_at IS NULL))`;

  const rows = await query<
    RowDataPacket & {
      session_code: string;
      bed_code: string | null;
      display_name: string | null;
      patient_id: number | null;
      last_gesture: string | null;
      last_at_ms: number | null;
      unacknowledged: number | null;
      escalated: number | null;
      today: number | null;
      blink_rate: number | null;
      alertness_score: number | null;
      movement_activity: number | null;
      heart_rate: number | null;
      spo2: number | null;
      sos_active: number | null;
      linked_devices: number | null;
      last_scan_at_ms: number | null;
      last_scan_ip: string | null;
      last_seen_ms: number | null;
    }
  >(
    `SELECT s.session_code,
            b.bed_code,
            p.display_name,
            s.patient_id,
            ge.gesture AS last_gesture,
            UNIX_TIMESTAMP(ge.occurred_at) * 1000 AS last_at_ms,
            (SELECT COUNT(*) FROM gestures g2
              WHERE g2.session_id = s.id AND g2.status = 'open') AS unacknowledged,
            (SELECT COUNT(*) FROM gestures g3
              WHERE g3.session_id = s.id AND g3.status = 'escalated') AS escalated,
            (SELECT COUNT(*) FROM gestures g4
              WHERE g4.session_id = s.id AND g4.created_at >= CURDATE()) AS today,
            m.blink_rate, m.alertness_score, m.movement_activity,
            v.heart_rate, v.spo2, v.sos_active,
            (SELECT COUNT(DISTINCT sc2.ip) FROM pairing_scans sc2
              WHERE sc2.session_id = s.id) AS linked_devices,
            UNIX_TIMESTAMP(sc.scanned_at) * 1000 AS last_scan_at_ms,
            sc.ip_display AS last_scan_ip,
            UNIX_TIMESTAMP(GREATEST(COALESCE(v.received_at, '1970-01-01'),
                                    COALESCE(s.last_seen_at, '1970-01-01'))) * 1000 AS last_seen_ms
       FROM console_sessions s
       LEFT JOIN beds b ON b.id = s.bed_id
       LEFT JOIN users p ON p.id = s.patient_id
       LEFT JOIN session_metrics m ON m.session_id = s.id
       LEFT JOIN vitals v ON v.id = (
             SELECT id FROM vitals WHERE session_id = s.id
              ORDER BY received_at DESC, id DESC LIMIT 1)
       LEFT JOIN gestures ge ON ge.id = (
             SELECT id FROM gestures WHERE session_id = s.id
              ORDER BY created_at DESC, id DESC LIMIT 1)
       LEFT JOIN pairing_scans sc ON sc.id = (
             SELECT id FROM pairing_scans WHERE session_id = s.id
              ORDER BY scanned_at DESC, id DESC LIMIT 1)
      WHERE s.status = 'active' AND s.expires_at > NOW(3) ${scopeClause}
      ORDER BY b.bed_code IS NULL, b.bed_code ASC
      LIMIT 200`,
    params,
  );

  const now = Date.now();
  return rows.map((r) => ({
    session: r.session_code,
    bed: r.bed_code,
    patient: r.display_name,
    patientId: r.patient_id === null ? null : Number(r.patient_id),
    lastGesture: r.last_gesture,
    lastAt: r.last_at_ms ? Number(r.last_at_ms) : null,
    unacknowledged: Number(r.unacknowledged ?? 0),
    escalated: Number(r.escalated ?? 0),
    today: Number(r.today ?? 0),
    alertness: r.alertness_score === null ? null : Number(r.alertness_score),
    movement: r.movement_activity === null ? null : Number(r.movement_activity),
    heartRate: r.heart_rate === null ? null : Number(r.heart_rate),
    spo2: r.spo2 === null ? null : Number(r.spo2),
    sosActive: Number(r.sos_active) === 1,
    linkedDevices: Number(r.linked_devices ?? 0),
    lastScanAt: r.last_scan_at_ms ? Number(r.last_scan_at_ms) : null,
    lastScanIp: r.last_scan_ip,
    lastSeen: r.last_seen_ms && Number(r.last_seen_ms) > 0 ? Number(r.last_seen_ms) : null,
  }));
}
