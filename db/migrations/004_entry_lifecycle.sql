-- ===========================================================================
-- 004: durable closed-loop lifecycle on gesture entries
--
-- The legacy in-memory store kept `acknowledged/escalated/resolved` as booleans
-- on the entry itself, so restarting the process lost every clinical action a
-- nurse had taken. `alerts` only covers the actionable queue (HELP, EMERGENCY,
-- pain, inactivity), so a YES/WATER acknowledgement had nowhere durable to
-- live.
--
-- These columns are appended to `gestures` (additive only -- no data is rewritten,
-- no column is dropped, so this is safe to run on a live database) and give every
-- entry the same lifecycle the alert queue already had, attributed to a real user
-- id so the closed loop is auditable.
-- ===========================================================================

ALTER TABLE gestures
  ADD COLUMN status          ENUM ('open','ack','escalated','resolved','auto_resolved') NOT NULL DEFAULT 'open' AFTER language,
  ADD COLUMN ack_by          BIGINT UNSIGNED NULL AFTER status,
  ADD COLUMN ack_at          DATETIME(3)  NULL AFTER ack_by,
  ADD COLUMN escalated_by    ENUM ('staff','system') NULL AFTER ack_at,
  ADD COLUMN escalated_rule  VARCHAR(64)  NULL AFTER escalated_by,
  ADD COLUMN escalated_at    DATETIME(3)  NULL AFTER escalated_rule,
  ADD COLUMN resolved_by     BIGINT UNSIGNED NULL AFTER escalated_at,
  ADD COLUMN resolved_at     DATETIME(3)  NULL AFTER resolved_by,
  ADD COLUMN resolution_note VARCHAR(255) NULL AFTER resolved_at,
  ADD KEY idx_gesture_status (session_id, status, occurred_at DESC),
  ADD KEY idx_gesture_cursor_id (id, created_at),
  ADD CONSTRAINT fk_gesture_ack     FOREIGN KEY (ack_by)     REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_gesture_resolved FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL;

-- The client sends its own string id for every entry and reply. Storing it here
-- turns the offline outbox's retry replay into a genuine no-op: a duplicate POST
-- collides on the unique key instead of creating a second clinical record. This
-- is what makes "exactly once" a schema guarantee rather than a client promise.
ALTER TABLE gestures
  ADD COLUMN client_key VARCHAR(64) NULL AFTER session_id,
  ADD UNIQUE KEY uq_gesture_client (session_id, client_key);

ALTER TABLE messages
  ADD COLUMN client_key VARCHAR(64) NULL AFTER conversation_id,
  ADD UNIQUE KEY uq_message_client (conversation_id, client_key);
