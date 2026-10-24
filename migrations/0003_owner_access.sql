-- Owner/moderator access control: accounts, sessions, audit log, rate limiting,
-- and an events rebuild that makes moderator_id and ends_at mandatory.
--
-- IMPORTANT: this migration intentionally does NOT carry forward existing rows
-- in `events` / `registrations`. All current data is test data (see
-- docs/OWNER-ACCESS-PRD.md section 2) with no moderator owner, so it cannot
-- satisfy the new NOT NULL moderator_id constraint. The documented cutover
-- procedure (stage 5) backs up and clears that data BEFORE this migration
-- runs against the production database. Local/test runs should do the same.

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enforces AC-03 (only one *pending* application at a time) without blocking
-- a later re-application after rejected/suspended — handled in application
-- logic (checks "no existing row with status='pending'") rather than a
-- partial unique index, since D1/SQLite partial indexes on expressions are
-- more fragile to migrate later than a plain application-level check.
CREATE INDEX idx_moderators_line_user ON moderators(line_user_id);
CREATE INDEX idx_moderators_status ON moderators(status);

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

-- ---- events rebuild: add moderator_id (NOT NULL) and ends_at (NOT NULL, ISO date) ----

ALTER TABLE events RENAME TO events_legacy_test_data;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL REFERENCES moderators(id),
  title TEXT NOT NULL,
  organizer TEXT,
  event_date TEXT,              -- free-text display date, e.g. "10/29(四)" — unchanged
  ends_at TEXT NOT NULL,         -- ISO 8601 date (YYYY-MM-DD), the computable date retention is based on
  meeting_location TEXT,
  meeting_time TEXT,
  fee TEXT,
  passenger_fee TEXT,
  capacity INTEGER,
  cutoff_at TEXT,
  group_link TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','full','closed')),
  enable_attendance_type INTEGER NOT NULL DEFAULT 0,
  enable_car_role INTEGER NOT NULL DEFAULT 0,
  enable_plus_one INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_moderator ON events(moderator_id);
CREATE INDEX idx_events_ends_at ON events(ends_at);

-- registrations keeps its existing shape; event_id now points at the rebuilt
-- events table. No data is carried over from events_legacy_test_data for the
-- reason stated at the top of this file.
DROP TABLE IF EXISTS registrations;
CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id),
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  picture_url TEXT,
  role TEXT,
  attendance_type TEXT,
  plus_one_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','cancelled')),
  hide_from_roster INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, line_user_id)
);
CREATE INDEX idx_registrations_event ON registrations(event_id);

DROP TABLE events_legacy_test_data;
