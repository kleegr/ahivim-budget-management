ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD CONSTRAINT users_session_version_nonnegative CHECK (session_version >= 0);
-- Previously disabled accounts must not regain generation-zero cookies when
-- an owner enables them after this release.
UPDATE users SET session_version = 1 WHERE is_active = false;
