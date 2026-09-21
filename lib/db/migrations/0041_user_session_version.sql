-- Revocable sessions: the JWT carries the version it was issued at, and every
-- server-side session check compares it with this column. Bumped on password
-- and role changes. Existing tokens carry no version and are treated as 0, so
-- this migration signs nobody out.
ALTER TABLE `users` ADD COLUMN `session_version` INTEGER NOT NULL DEFAULT 0;
