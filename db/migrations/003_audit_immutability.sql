-- Audit-log immutability hardening.
--
-- 1. `actor_id` carried ON DELETE SET NULL. That made account deletion rewrite
--    historical audit rows in place: deleting a user set their actor_id to NULL,
--    which changed the row's contents, broke the hash chain, and -- worse -- a
--    routine "remove this test account" query could falsify who did what. The
--    pointer is kept as a plain column so the log can still join to a live
--    account, and `actor_label` snapshots the name for when it no longer can.
--    Erasure still works (the row is no longer forced to reference anyone) while
--    history stays put.
--
-- 2. `ip` was VARBINARY(16) but was being handed arbitrary X-Forwarded-For text.
--    The longest IPv6 text form is 45 characters, so a real IPv6 client did not
--    fit: the address was either truncated or rejected outright, and the audit
--    log silently recorded the wrong source. 45 is the correct width.
--
-- 3. `ip` and `user_agent` were outside the hashed body, so editing either went
--    undetected. They are the forensic fields an investigator actually reads, so
--    they now participate in the hash. Changing the hashed inputs invalidates
--    every existing hash, so the chain must be rebuilt afterwards:
--        npm run db:repair:audit -- --apply --i-understand-this-destroys-evidence

ALTER TABLE audit_log DROP FOREIGN KEY fk_audit_actor;
ALTER TABLE audit_log MODIFY COLUMN ip VARCHAR(45) NULL;
ALTER TABLE audit_log ADD COLUMN actor_label VARCHAR(120) NULL AFTER actor_id;
