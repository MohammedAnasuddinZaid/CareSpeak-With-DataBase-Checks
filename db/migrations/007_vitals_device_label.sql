-- 007_vitals_device_label.sql
-- ---------------------------------------------------------------------------
-- `vitals.device_id` was declared `BIGINT UNSIGNED` with a foreign key to
-- `devices(id)`, but every production writer passes a *string* device label
-- such as "esp32_ward4_bed12". Under strict mode MySQL refuses that value
-- outright (ER_TRUNCATED_WRONG_VALUE_FOR_FIELD); before that, the column was
-- simply never populated because the insert omitted it.
--
-- The device is identified by its patient-facing tag, not by a synthetic
-- `devices` row that nothing ever creates, so the column becomes a
-- `VARCHAR(64)` label with a binary collation (case-insensitive collation on
-- an identifier risks 'ESP32_1' silently colliding with 'esp32_1'). The FK and
-- the old composite index are rebuilt to suit.
-- ---------------------------------------------------------------------------

ALTER TABLE vitals
  DROP FOREIGN KEY fk_vitals_device,
  DROP INDEX     idx_vitals_device,
  MODIFY COLUMN device_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD INDEX      idx_vitals_device (device_id, received_at DESC);