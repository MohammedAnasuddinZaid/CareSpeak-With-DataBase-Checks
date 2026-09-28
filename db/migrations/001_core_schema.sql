-- CareSpeak core schema
-- MySQL 8.0+ / InnoDB / utf8mb4
--
-- Design notes
--  * The system of record is MySQL. Redis is a cache + fan-out bus only, never a
--    source of truth, so a Redis flush must never lose clinical data.
--  * `console_sessions.session_code` replaces the old 6-character localStorage
--    session id (30 bits of entropy, printed in every QR code). 22 base32 chars
--    is 128 bits.
--  * Secrets at rest are hashes, never plaintext: password_hash (scrypt),
--    refresh_token_hash, otp code_hash, bed/device pin hashes.
--  * vitals/alerts/audit_log carry no ON DELETE CASCADE from the clinical side;
--    they reference patients with ON DELETE RESTRICT so a record cannot be
--    orphaned. GDPR/DPDP erasure is handled by anonymising, not dropping.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64)  NOT NULL PRIMARY KEY,
  applied_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hospitals (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(64)  NOT NULL,
  name        VARCHAR(160) NOT NULL,
  timezone    VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  locale      VARCHAR(16)  NOT NULL DEFAULT 'en-US',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hospitals_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS wards (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hospital_id  BIGINT UNSIGNED NOT NULL,
  code         VARCHAR(32)  NOT NULL,
  name         VARCHAR(120) NOT NULL,
  floor        VARCHAR(32)  NULL,
  bed_capacity SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wards_code (hospital_id, code),
  CONSTRAINT fk_wards_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS beds (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ward_id       BIGINT UNSIGNED NOT NULL,
  bed_code      VARCHAR(32)  NOT NULL,
  label         VARCHAR(64)  NOT NULL,
  status        ENUM ('available','occupied','cleaning','maintenance') NOT NULL DEFAULT 'available',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_beds_code (ward_id, bed_code),
  KEY idx_beds_status (ward_id, status),
  CONSTRAINT fk_beds_ward FOREIGN KEY (ward_id) REFERENCES wards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hospital_id      BIGINT UNSIGNED NULL,
  email            VARCHAR(254) NOT NULL,
  password_hash    VARCHAR(255) NULL,          -- NULL for OAuth-only / PIN-only accounts
  google_sub       VARCHAR(128) NULL,          -- Google's stable user id, never the email
  display_name     VARCHAR(120) NOT NULL,
  role             ENUM ('patient','nurse','doctor','admin') NOT NULL DEFAULT 'patient',
  phone_e164       VARCHAR(20)  NULL,
  avatar_url       VARCHAR(512) NULL,
  locale           VARCHAR(16)  NOT NULL DEFAULT 'en-US',
  status           ENUM ('active','pending','suspended') NOT NULL DEFAULT 'active',
  email_verified_at DATETIME(3) NULL,
  totp_secret_enc  VARBINARY(255) NULL,        -- AES-256-GCM, key from TOTP_ENCRYPTION_KEY
  mfa_enabled      TINYINT(1)   NOT NULL DEFAULT 0,
  failed_logins    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until     DATETIME(3)  NULL,
  last_login_at    DATETIME(3)  NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google_sub (google_sub),
  KEY idx_users_role (hospital_id, role, status),
  CONSTRAINT fk_users_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS patient_profiles (
  user_id            BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  mrn                VARCHAR(32)  NOT NULL,     -- medical record number
  date_of_birth      DATE         NULL,
  gender             ENUM ('female','male','other','unknown') NOT NULL DEFAULT 'unknown',
  blood_group        ENUM ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown') NOT NULL DEFAULT 'unknown',
  preferred_language VARCHAR(16)  NOT NULL DEFAULT 'en-US',
  -- How the patient is able to communicate. Drives which input surface we render.
  communication_mode ENUM ('hand','eye','dwell','dwell_blink','switch','mixed','none') NOT NULL DEFAULT 'mixed',
  aac_board_enabled  TINYINT(1)   NOT NULL DEFAULT 1,
  bedside_pin_hash   VARBINARY(255) NULL,      -- scrypt; unlocked by staff walking the ward
  bedside_pin_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  bedside_pin_locked_until DATETIME(3) NULL,
  care_notes         TEXT         NULL,
  admission_reason   VARCHAR(255) NULL,
  -- Pre-illness / baseline values so deviation-from-own-normal works from day one.
  baseline           JSON         NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_patient_mrn (mrn),
  KEY idx_patient_lang (preferred_language),
  CONSTRAINT fk_patient_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  staff_role    ENUM ('nurse','doctor','admin') NOT NULL,
  license_no    VARCHAR(64)  NULL,
  department    VARCHAR(120) NULL,
  shift_start   TIME         NULL,
  shift_end     TIME         NULL,
  quick_pin_hash VARBINARY(255) NULL,          -- 6-digit ward-walk PIN
  quick_pin_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  quick_pin_locked_until DATETIME(3) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_staff_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Refresh tokens. Rotating: every refresh mints a new row and revokes the old one,
-- so a stolen token is usable at most once before the theft is visible in the table.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id            BIGINT UNSIGNED NOT NULL,
  refresh_token_hash CHAR(64)     NOT NULL,     -- sha256 hex of the opaque token
  user_agent         VARCHAR(255) NULL,
  ip                 VARBINARY(16) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at       DATETIME(3)  NULL,
  expires_at         DATETIME(3)  NOT NULL,
  revoked_at         DATETIME(3)  NULL,
  revoked_reason     VARCHAR(64)  NULL,
  UNIQUE KEY uq_auth_refresh (refresh_token_hash),
  KEY idx_auth_user (user_id, revoked_at, expires_at),
  CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Email one-time passcodes. Codes are stored hashed; a row is the only proof of life.
CREATE TABLE IF NOT EXISTS email_otps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(254) NOT NULL,
  purpose     ENUM ('login','signup','verify_email','pin_reset','sos_test') NOT NULL DEFAULT 'login',
  code_hash   CHAR(64)     NOT NULL,            -- sha256 hex of "<code>:<purpose>:<email>"
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at  DATETIME(3)  NOT NULL,
  consumed_at DATETIME(3)  NULL,
  ip          VARBINARY(16) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_otp_lookup (email, purpose, created_at DESC),
  KEY idx_otp_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Clinical context: admission, assignment, device, console
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admissions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id   BIGINT UNSIGNED NOT NULL,
  bed_id       BIGINT UNSIGNED NOT NULL,
  admitted_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  discharged_at DATETIME(3) NULL,
  status       ENUM ('active','discharged','transferred') NOT NULL DEFAULT 'active',
  source       ENUM ('walk_in','transfer','elective','emergency') NOT NULL DEFAULT 'walk_in',
  diagnosis    VARCHAR(255) NULL,
  notes        TEXT         NULL,
  -- MySQL has no partial indexes, so "one active admission per patient" is
  -- expressed as a stored generated column that is NULL once discharged.
  -- NULLs never collide in a UNIQUE key, so history is unconstrained.
  active_patient_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(status = 'active', patient_id, NULL)) STORED,
  UNIQUE KEY uq_admission_one_active (active_patient_id),
  KEY idx_admission_bed (bed_id, status),
  KEY idx_admission_time (admitted_at DESC),
  CONSTRAINT fk_admission_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_admission_bed     FOREIGN KEY (bed_id)     REFERENCES beds (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS care_assignments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  staff_id      BIGINT UNSIGNED NOT NULL,
  patient_id    BIGINT UNSIGNED NOT NULL,
  is_primary    TINYINT(1)   NOT NULL DEFAULT 0,
  assigned_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  unassigned_at DATETIME(3)  NULL,
  KEY idx_assign_staff (staff_id, unassigned_at),
  KEY idx_assign_patient (patient_id, unassigned_at),
  CONSTRAINT fk_assign_staff   FOREIGN KEY (staff_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_assign_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS devices (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_code      VARCHAR(64)  NOT NULL,       -- e.g. esp32_ward4_bed12, set in firmware
  bed_id           BIGINT UNSIGNED NULL,
  -- sha256 of the shared device secret. Compared with a constant-time equality check
  -- so /api/ingest can no longer be an open write endpoint.
  device_token_hash CHAR(64)    NULL,
  firmware_version VARCHAR(32)  NULL,
  status           ENUM ('provisioning','online','offline','retired') NOT NULL DEFAULT 'provisioning',
  last_seen_at     DATETIME(3)  NULL,
  battery_pct      TINYINT UNSIGNED NULL,
  rssi             SMALLINT     NULL,
  provisioned_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_device_code (device_code),
  KEY idx_device_bed (bed_id, status),
  CONSTRAINT fk_device_bed FOREIGN KEY (bed_id) REFERENCES beds (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Replaces the 6-char localStorage session id. session_code is the public handle
-- (128 bits, safe in a QR code); console_token_hash is what actually authorises
-- reads, so a leaked QR alone does not grant access to the clinical record.
CREATE TABLE IF NOT EXISTS console_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_code       VARCHAR(32)  NOT NULL,     -- 22 chars base32 = 128 bits
  console_token_hash CHAR(64)     NOT NULL,
  patient_id         BIGINT UNSIGNED NULL,
  bed_id             BIGINT UNSIGNED NULL,
  label              VARCHAR(120) NULL,
  status             ENUM ('active','ended') NOT NULL DEFAULT 'active',
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at       DATETIME(3)  NULL,
  expires_at         DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_console_code (session_code),
  UNIQUE KEY uq_console_token (console_token_hash),
  KEY idx_console_patient (patient_id, status),
  KEY idx_console_expiry (expires_at),
  CONSTRAINT fk_console_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_console_bed     FOREIGN KEY (bed_id)     REFERENCES beds (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Who opened which bed console. Token-gated exactly as before, but durable now
-- and joined to a real user instead of a free-text role string.
CREATE TABLE IF NOT EXISTS pairing_scans (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NULL,
  role        ENUM ('nurse','doctor','admin','patient','family','unknown') NOT NULL DEFAULT 'unknown',
  ip          VARBINARY(16) NULL,
  ip_display  VARCHAR(64)  NULL,
  user_agent  VARCHAR(255) NULL,
  scanned_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_scan_session (session_id, scanned_at DESC),
  CONSTRAINT fk_scan_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_scan_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Telemetry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vitals (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id     BIGINT UNSIGNED NULL,
  bed_id         BIGINT UNSIGNED NULL,
  device_id      BIGINT UNSIGNED NULL,
  session_id     BIGINT UNSIGNED NULL,
  heart_rate       SMALLINT UNSIGNED NULL,
  spo2             DECIMAL(4,1) NULL,
  temperature      DECIMAL(3,1) NULL,
  respiratory_rate SMALLINT UNSIGNED NULL,
  battery_pct      TINYINT UNSIGNED NULL,
  rssi             SMALLINT NULL,
  sos_active       TINYINT(1) NOT NULL DEFAULT 0,
  blink_rate       DECIMAL(6,2) NULL,
  alertness_score  DECIMAL(5,2) NULL,
  movement_activity DECIMAL(5,4) NULL,
  eye_closure_ms   INT UNSIGNED NULL,
  recorded_at     DATETIME(3)  NOT NULL,      -- device clock
  received_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3), -- server clock, authoritative
  -- The SSE cursor reads `id`, which is monotonic and gap-free, so a client can
  -- resume from "id > N" without ever missing or double-counting a sample.
  KEY idx_vitals_cursor (received_at, id),
  KEY idx_vitals_patient (patient_id, received_at DESC),
  KEY idx_vitals_bed (bed_id, received_at DESC),
  KEY idx_vitals_device (device_id, received_at DESC),
  KEY idx_vitals_sos (patient_id, sos_active, received_at DESC),
  CONSTRAINT fk_vitals_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vitals_bed     FOREIGN KEY (bed_id)     REFERENCES beds (id) ON DELETE SET NULL,
  CONSTRAINT fk_vitals_device  FOREIGN KEY (device_id)  REFERENCES devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS gestures (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id  BIGINT UNSIGNED NULL,
  patient_id  BIGINT UNSIGNED NULL,
  gesture     VARCHAR(32)  NOT NULL,
  description VARCHAR(255) NOT NULL,
  confidence  DECIMAL(4,3) NULL,
  modality    ENUM ('hand','eye','facs','dwell','switch','voice','manual','system') NOT NULL DEFAULT 'hand',
  source      ENUM ('camera','demo','iot','manual','system') NOT NULL DEFAULT 'camera',
  language    VARCHAR(16)  NOT NULL DEFAULT 'en-US',
  payload     JSON         NULL,               -- raw gesture detail for later replay
  occurred_at DATETIME(3)  NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_gesture_cursor (created_at, id),
  KEY idx_gesture_session (session_id, occurred_at DESC),
  KEY idx_gesture_patient (patient_id, occurred_at DESC),
  KEY idx_gesture_name (patient_id, gesture, occurred_at DESC),
  CONSTRAINT fk_gesture_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE SET NULL,
  CONSTRAINT fk_gesture_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===========================================================================
-- alerts
-- ===========================================================================
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id      BIGINT UNSIGNED NULL,
  bed_id          BIGINT UNSIGNED NULL,
  session_id      BIGINT UNSIGNED NULL,
  -- Expanded well past hand/eye gestures: pain inference and fall detection
  -- produce alerts that no physical gesture could ever raise.
  kind            ENUM ('help','emergency','pain','pain_inferred','inactivity','fall','bed_exit','wandering','device','vitals') NOT NULL,
  severity        ENUM ('info','low','moderate','high','critical') NOT NULL DEFAULT 'moderate',
  title           VARCHAR(160) NOT NULL,
  detail          TEXT         NULL,
  status          ENUM ('open','ack','escalated','resolved','auto_resolved') NOT NULL DEFAULT 'open',
  -- Explainer payload: exact Shapley attributions + the clinical citation that
  -- justifies the rule. Stored so an auditor sees the same maths the UI showed.
  attribution     JSON         NULL,
  citations       JSON         NULL,
  rule_key        VARCHAR(64)  NULL,
  risk_score      DECIMAL(5,2) NULL,
  risk_band       ENUM ('low','moderate','high','critical') NULL,
  raised_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ack_by          BIGINT UNSIGNED NULL,
  ack_at          DATETIME(3)  NULL,
  escalated_by    ENUM ('staff','system') NULL,
  escalated_at    DATETIME(3)  NULL,
  resolved_by     BIGINT UNSIGNED NULL,
  resolved_at     DATETIME(3)  NULL,
  resolution_note VARCHAR(255) NULL,
  -- Client-supplied idempotency key. Unique per session so a retried POST (offline
  -- outbox replay, flaky mobile network) can never create a duplicate alert.
  idempotency_key VARCHAR(128) NULL,
  KEY idx_alert_cursor (raised_at, id),
  KEY idx_alert_queue (status, severity, raised_at DESC),
  KEY idx_alert_patient (patient_id, raised_at DESC),
  KEY idx_alert_bed (bed_id, raised_at DESC),
  UNIQUE KEY uq_alert_idem (session_id, idempotency_key),
  CONSTRAINT fk_alert_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_alert_bed     FOREIGN KEY (bed_id)     REFERENCES beds (id) ON DELETE SET NULL,
  CONSTRAINT fk_alert_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE SET NULL,
  CONSTRAINT fk_alert_ack     FOREIGN KEY (ack_by)     REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_alert_resolved FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ===========================================================================
-- conversations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id      BIGINT UNSIGNED NOT NULL,
  bed_id          BIGINT UNSIGNED NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_message_at DATETIME(3)  NULL,
  UNIQUE KEY uq_conversation_patient (patient_id),
  KEY idx_conversation_recent (last_message_at DESC),
  CONSTRAINT fk_conv_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_conv_bed     FOREIGN KEY (bed_id)     REFERENCES beds (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NULL,
  sender_role     ENUM ('patient','nurse','doctor','admin','system') NOT NULL DEFAULT 'system',
  direction       ENUM ('nurse_to_patient','patient_to_nurse','system') NOT NULL,
  body            VARCHAR(2000) NOT NULL,
  lang            VARCHAR(16)  NOT NULL DEFAULT 'en-US',
  kind            ENUM ('free','quick_phrase','voice','system') NOT NULL DEFAULT 'free',
  phrase_key      VARCHAR(64)  NULL,          -- i18n key when kind='quick_phrase'
  delivered_at    DATETIME(3)  NULL,
  read_at         DATETIME(3)  NULL,
  spoken_at       DATETIME(3)  NULL,          -- confirmed TTS playback on the patient console
  -- Client-supplied idempotency key. Paired with the gap-free id cursor this makes
  -- the reply-loop class of bug structurally impossible, not merely fixed.
  idempotency_key VARCHAR(128) NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_message_cursor (conversation_id, id),
  KEY idx_message_unread (conversation_id, read_at),
  UNIQUE KEY uq_message_idem (conversation_id, idempotency_key),
  CONSTRAINT fk_msg_conv   FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id)       REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS notification_channels (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  kind            ENUM ('email','sms','whatsapp','push','webhook') NOT NULL,
  target          VARCHAR(254) NOT NULL,
  label           VARCHAR(120) NULL,
  is_primary      TINYINT(1) NOT NULL DEFAULT 0,
  verified_at     DATETIME(3) NULL,
  escalation_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_channel_target (user_id, kind, target),
  KEY idx_channel_escalation (kind, verified_at, escalation_order),
  CONSTRAINT fk_channel_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Care workflow
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_tasks (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id    BIGINT UNSIGNED NULL,
  bed_id        BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NULL,
  assigned_to   BIGINT UNSIGNED NULL,
  title         VARCHAR(200) NOT NULL,
  instructions  TEXT         NULL,
  kind          ENUM ('observation','medication','positioning','hygiene','mobility','nutrition','other') NOT NULL DEFAULT 'other',
  priority      ENUM ('routine','urgent','stat') NOT NULL DEFAULT 'routine',
  status        ENUM ('pending','in_progress','done','skipped') NOT NULL DEFAULT 'pending',
  due_at        DATETIME(3)  NULL,
  completed_at  DATETIME(3)  NULL,
  completed_by  BIGINT UNSIGNED NULL,
  skip_reason   VARCHAR(255) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_task_patient (patient_id, status, due_at),
  KEY idx_task_bed (bed_id, status, due_at),
  KEY idx_task_assignee (assigned_to, status, due_at),
  CONSTRAINT fk_task_patient   FOREIGN KEY (patient_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_bed       FOREIGN KEY (bed_id)       REFERENCES beds (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_creator   FOREIGN KEY (created_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_task_assignee  FOREIGN KEY (assigned_to)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_task_completer FOREIGN KEY (completed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Medication administration record. A MAR row is a legal clinical document:
-- it must attribute the dose to a named human and a moment in time.
CREATE TABLE IF NOT EXISTS medication_admin (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id      BIGINT UNSIGNED NOT NULL,
  bed_id          BIGINT UNSIGNED NULL,
  medication      VARCHAR(200) NOT NULL,
  dose            VARCHAR(80)  NOT NULL,
  route           ENUM ('oral','iv','im','sc','topical','inhaled','rectal','other') NOT NULL DEFAULT 'oral',
  scheduled_at    DATETIME(3)  NULL,
  administered_at DATETIME(3)  NULL,
  administered_by BIGINT UNSIGNED NULL,
  status          ENUM ('scheduled','given','held','missed','refused') NOT NULL DEFAULT 'scheduled',
  refusal_reason  VARCHAR(255) NULL,
  notes           VARCHAR(500) NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mar_slot (patient_id, medication, scheduled_at),
  KEY idx_mar_patient (patient_id, administered_at DESC),
  KEY idx_mar_bed (bed_id, status, scheduled_at),
  CONSTRAINT fk_mar_patient FOREIGN KEY (patient_id)      REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_mar_bed     FOREIGN KEY (bed_id)          REFERENCES beds (id) ON DELETE SET NULL,
  CONSTRAINT fk_mar_admin   FOREIGN KEY (administered_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- FACS (Facial Action Coding System) pain inference. action_units holds the AU
-- intensities that produced facs_score, so a clinician can audit the inference.
CREATE TABLE IF NOT EXISTS pain_assessments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id   BIGINT UNSIGNED NULL,
  session_id   BIGINT UNSIGNED NULL,
  method       ENUM ('facs','gaze','self_report','observed') NOT NULL,
  facs_score   DECIMAL(4,2) NULL,              -- 0..4 derived from AU4/6/7/9/10
  action_units JSON         NULL,
  pain_score   DECIMAL(4,2) NULL,              -- 0..10 normalised
  confidence   DECIMAL(4,3) NULL,
  assessed_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_pain_patient (patient_id, assessed_at DESC),
  KEY idx_pain_cursor (assessed_at, id),
  CONSTRAINT fk_pain_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_pain_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Per-patient rolling baselines so alerts fire on deviation from the patient's own
-- normal, not a population constant. Recomputed off the vitals table.
CREATE TABLE IF NOT EXISTS baselines (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id   BIGINT UNSIGNED NOT NULL,
  metric       VARCHAR(32)  NOT NULL,          -- heart_rate | spo2 | temperature | alertness_score
  mean_value   DECIMAL(8,3) NOT NULL,
  stddev       DECIMAL(8,3) NOT NULL DEFAULT 0,
  p05          DECIMAL(8,3) NULL,
  p95          DECIMAL(8,3) NULL,
  sample_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_hours INT UNSIGNED NOT NULL DEFAULT 168,
  computed_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_baseline (patient_id, metric),
  CONSTRAINT fk_baseline_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------------

-- Hash-chained audit log. Each row stores sha256(prev_hash || canonical_row).
-- Editing or deleting any historical row breaks every later hash, visibly.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id    BIGINT UNSIGNED NULL,
  actor_role  ENUM ('patient','nurse','doctor','admin','system','device') NOT NULL DEFAULT 'system',
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(48)  NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  detail      JSON         NULL,
  ip          VARBINARY(16) NULL,
  user_agent  VARCHAR(255) NULL,
  prev_hash   CHAR(64)     NOT NULL,
  hash        CHAR(64)     NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_entity (entity_type, entity_id, id),
  KEY idx_audit_actor (actor_id, created_at DESC),
  KEY idx_audit_time (created_at DESC),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- India's DPDP Act 2023 requires demonstrable, revocable, purpose-bound consent.
CREATE TABLE IF NOT EXISTS consents (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id  BIGINT UNSIGNED NOT NULL,
  consent_type ENUM ('treatment','data_processing','emergency_access','research','analytics','third_party_sharing') NOT NULL,
  granted     TINYINT(1)   NOT NULL,
  scope       VARCHAR(500) NULL,
  policy_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  method      ENUM ('verbal','written','digital_signature','proxy') NOT NULL DEFAULT 'digital_signature',
  granted_by  BIGINT UNSIGNED NULL,            -- proxy/guardian where applicable
  granted_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at  DATETIME(3)  NULL,
  KEY idx_consent_patient (patient_id, consent_type, granted_at DESC),
  CONSTRAINT fk_consent_patient FOREIGN KEY (patient_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_consent_grantor FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
