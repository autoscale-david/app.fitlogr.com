-- Refresh-token rotation grace. replaced_by is set when a session is revoked by rotation (not by
-- logout). grace_used_at marks that its one lost-response retry was spent.
ALTER TABLE user_sessions ADD COLUMN replaced_by TEXT;
ALTER TABLE user_sessions ADD COLUMN grace_used_at TEXT;
