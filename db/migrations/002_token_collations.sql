-- 002: binary collation for every credential and public handle.
--
-- The default table collation is utf8mb4_0900_ai_ci, which is *case-insensitive*
-- and *accent-insensitive*. That is correct for human labels ("Ward 4A" == "ward
-- 4a") and wrong for security tokens.
--
-- Why this matters concretely on console_sessions.session_code:
--   * UNIQUE KEY uq_console_code treats 'AbC123' and 'abc123' as the same value,
--     so two genuinely different 128-bit handles cannot both exist.
--   * A case-insensitive lookup matches either casing, so the value a client
--     presents is not the value that was compared. Comparing a handle under
--     folded collation is not an exact-constant-time comparison of the secret.
--   * Base32 (RFC 4648) is defined as case-SENSITIVE. Folding it is a spec
--     violation, not a convenience.
--
-- The entropy argument still holds for hex digests either way (hex is naturally
-- case-insensitive), but ascii_bin is used across all of them so that "is this
-- byte sequence the one I issued?" has exactly one answer in this schema.
--
-- `ascii` rather than `utf8mb4_bin` because every one of these values is ASCII
-- by construction (base32 / hex), and ascii stores 1 byte per char instead of 4.
--
-- Left alone deliberately:
--   * beds.bed_code, wards.code, users.email  -- human-entered, case-insensitive
--     matching is the behaviour users expect.
--   * messages.idempotency_key, alerts.idempotency_key -- folding case here is
--     the conservative choice: a client that varies case between retries of the
--     same logical request should be deduplicated, not double-inserted.

ALTER TABLE console_sessions
  MODIFY session_code       VARCHAR(32)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY console_token_hash CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

ALTER TABLE auth_sessions
  MODIFY refresh_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

ALTER TABLE email_otps
  MODIFY code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

ALTER TABLE devices
  MODIFY device_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;

ALTER TABLE audit_log
  MODIFY prev_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY hash      CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

-- The generated "one active admission per patient" column must also be binary:
-- it is compared against users.id, and a folded numeric id is still a risk of
-- surprising behaviour if the charset is ever changed on the parent.
ALTER TABLE admissions
  MODIFY active_patient_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(status = 'active', patient_id, NULL)) STORED;
