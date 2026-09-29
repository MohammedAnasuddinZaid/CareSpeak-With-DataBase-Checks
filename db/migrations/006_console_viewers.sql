-- ===========================================================================
-- 006: multi-viewer console credentials
--
-- A console session used to authorise exactly ONE browser: `console_sessions`
-- holds a single `console_token_hash`. Whoever claimed a bed first (normally the
-- bedside console) therefore locked every other device out. A nurse who scanned
-- the QR or typed the code into nurse-view hit a 409 dead end ("this bed is
-- already linked") and was told to sign in as staff -- but the requirement is
-- that possession of the code is enough to view the bed, with login reserved for
-- clinical ACTIONS and history.
--
-- This table lets every device that presents the session code mint its OWN read
-- credential. The bedside console's token in `console_sessions` is untouched
-- (it keeps working), and each scanner adds one row here. `verifyConsoleToken`
-- accepts the session's primary hash OR any of these viewer hashes.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS console_viewers (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id   BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3)  NULL,
  UNIQUE KEY uq_viewer_token (token_hash),
  KEY idx_viewer_session (session_id),
  CONSTRAINT fk_viewer_session FOREIGN KEY (session_id) REFERENCES console_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;