-- Owner/moderator access control: accounts, sessions, audit log, rate
-- limiting, and event ownership — NON-DESTRUCTIVE preparation only.
--
-- This migration does NOT drop, rename, or rebuild `events` or
-- `registrations`, and does not delete any existing row. It only adds new
-- tables (purely additive) and two new NULLABLE columns on `events`
-- (moderator_id, ends_at), then backfills existing events to the synthetic
-- LEGACY_MODERATOR_ID so they stay reachable through the still-live
-- passcode-gated admin endpoints — an additive UPDATE, not data loss.
--
-- Promoting moderator_id/ends_at to NOT NULL (the final target shape — see
-- test/setup.ts, which already reflects it, since tests describe the end
-- state) requires a table rebuild in SQLite, which IS a real, if normally
-- safe, destructive-shaped operation. That step lives in
-- ops/finalize-owner-access-not-null.sql instead, deliberately NOT in this
-- migrations/ directory, so `wrangler d1 migrations apply` can never run it
-- automatically. It must be run manually, only after a backup, and only
-- after James has explicitly confirmed — see ops/README.md.

CREATE TABLE moderators (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'moderator' CHECK(role IN ('owner','moderator')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
  session_version INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT REFERENCES moderators(id),
  suspend_reason TEXT,
  -- Live LINE display name at application time, shown to the owner ONLY
  -- while status = 'pending' (FR-06: temporary display during review is
  -- allowed; no permanent profile of it). Cleared on approve/reject.
  pending_display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enforces AC-03 (only one *pending* application at a time) without blocking
-- a later re-application after rejected/suspended — handled in application
-- logic (checks "no existing row with status='pending'") rather than a
-- partial unique index, since D1/SQLite partial indexes on expressions are
-- more fragile to migrate later than a plain application-level check.
CREATE INDEX idx_moderators_line_user ON moderators(line_user_id);
CREATE INDEX idx_moderators_status ON moderators(status);

-- Synthetic row the still-live, passcode-gated legacy event endpoints
-- attribute their events to, since that shared-passcode model has no real
-- per-moderator identity. line_user_id is a value that can never collide
-- with a real LINE user id (those are always "U" + 32 hex chars). Removed
-- along with the rest of the legacy system at the stage 5 cutover.
INSERT INTO moderators (id, line_user_id, role, status, decided_at)
VALUES ('mod_legacy_admin', 'legacy:shared-passcode-admin', 'moderator', 'approved', datetime('now'));

CREATE TABLE sessions (
  -- id is the SHA-256 hash (hex) of the random token stored in the cookie.
  -- The raw token itself is never persisted.
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL REFERENCES moderators(id),
  session_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_moderator ON sessions(moderator_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('apply','approve','reject','suspend','restore')),
  target_moderator_id TEXT NOT NULL,
  actor_moderator_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('success','denied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_target ON audit_log(target_moderator_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Minimal, self-contained fallback for request throttling (login/callback,
-- apply, owner decision endpoints). Not dependent on the zone's Cloudflare
-- plan — see docs/OWNER-ACCESS-TECH-ASSESSMENT.md addendum for why.
CREATE TABLE rate_limit_counters (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL, -- unix seconds, floored to the window size
  count INTEGER NOT NULL DEFAULT 0
);

-- De-identified summary kept when an event itself is purged by the 1-year
-- retention sweep (docs/OWNER-ACCESS-PRD.md §8.3 / FR allows retaining
-- de-identified stats). No LINE user ids, display names, or other
-- participant-identifying fields — only aggregate counts.
CREATE TABLE event_archive_stats (
  event_id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  final_registered_count INTEGER NOT NULL,
  final_total_headcount INTEGER NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- events: additive, nullable columns only — no rename, no rebuild ----
ALTER TABLE events ADD COLUMN moderator_id TEXT REFERENCES moderators(id);
ALTER TABLE events ADD COLUMN ends_at TEXT; -- ISO 8601 date (YYYY-MM-DD) once set; NULL on existing rows until backfilled

CREATE INDEX idx_events_moderator ON events(moderator_id);
CREATE INDEX idx_events_ends_at ON events(ends_at);

-- Every existing event predates ownership entirely; attribute them to the
-- same synthetic moderator the legacy endpoints already use, so they stay
-- reachable through /api/events instead of becoming orphaned (NULL
-- moderator_id would make them invisible to every moderator-scoped query
-- without actually deleting them — worse for operability, no safer).
-- ends_at is deliberately left NULL here: there's no reliable source to
-- derive a real ISO date from the old free-text event_date (e.g.
-- "10/29(四)" has no year), and retention.ts's queries all compare
-- `ends_at <= ?`, which SQL NULL never satisfies — so these rows simply
-- never get swept by the retention job rather than being purged on a
-- guessed date.
UPDATE events SET moderator_id = 'mod_legacy_admin' WHERE moderator_id IS NULL;
