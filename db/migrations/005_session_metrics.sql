-- ===========================================================================
-- 005: durable "latest vision metrics" per session
--
-- Blink rate / alertness / movement arrive from the camera loop several times a
-- second. `vitals` is a sample table read by a gap-free SSE cursor, so appending
-- every camera frame would add millions of rows a day per bed and make the
-- cursor useless for the vitals it was actually designed for.
--
-- The legacy store had exactly one slot per (session, device) and the UI only
-- ever renders the newest value, so this is one row per session updated in place.
-- Durable (survives restart, unlike the in-memory store) without being a firehose.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  device_id       VARCHAR(64)  NOT NULL DEFAULT 'camera',
  blink_rate      DECIMAL(6,2) NULL,
  alertness_score DECIMAL(5,2) NULL,
  -- Client sends milliseconds; stored in ms to match the wire format exactly so a
  -- round-trip cannot silently change the unit a threshold is compared against.
  eye_closure_ms  INT UNSIGNED NULL,
  movement_activity DECIMAL(5,4) NULL,
  last_seen       DATETIME(3)  NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_metric_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
