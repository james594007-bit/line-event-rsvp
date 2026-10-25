-- ⚠️ MANUAL, CONFIRMATION-GATED. NOT a migrations/ file — `wrangler d1
-- migrations apply` will never pick this up or run it automatically.
--
-- Rebuilds BOTH `events` and `registrations` so that events.moderator_id
-- and events.ends_at become NOT NULL — the final target schema already
-- assumed by test/setup.ts and by the application code's TypeScript types.
--
-- registrations also has to be rebuilt, not just events: SQLite's modern
-- ALTER TABLE RENAME rewrites any OTHER table's stored FOREIGN KEY clause
-- that points at the renamed table, so the moment `events` is renamed to
-- `events_pre_not_null` below, `registrations.event_id`'s FK text is
-- rewritten to `REFERENCES events_pre_not_null(id)` — and it stays that
-- way permanently (nothing rewrites it back) even after a *different*
-- table named `events` is created later. Left alone, registrations would
-- end up with a dangling FK reference to a table name that no longer
-- exists once events_pre_not_null is dropped. This script rebuilds
-- registrations too so its FK is re-declared against the real final
-- `events` table, preserving every column and every row.
--
-- DO NOT RUN THIS until ALL of the following are true:
--   1. A backup of the production D1 database has been taken, stored
--      OUTSIDE this git repo, and ENCRYPTED at rest (e.g.
--      `wrangler d1 export line_event_rsvp --remote --output backup.sql`,
--      then encrypt that file — `age` or `gpg -c` are fine — before it
--      leaves the machine that ran the export; never commit the plaintext
--      or ciphertext backup, or any credential, to this repository).
--      Confirm the backup is actually readable (decrypt it and spot-check
--      it) before continuing — an unreadable backup is not a backup.
--   2. The precondition check below returns 0 rows. If it doesn't, either
--      backfill a real ends_at for those rows manually, or — per the
--      approved product decision to clear pre-owner-access test data at
--      cutover (docs/OWNER-ACCESS-TECH-ASSESSMENT.md product decision #5)
--      — delete them first. That is a SEPARATE, explicit step; this file
--      does not do it for you.
--   3. This exact script has been dry-run against a clean LOCAL D1 copy
--      seeded with representative data, and `PRAGMA foreign_key_check;`
--      returned zero rows afterward, with row counts and spot-checked
--      values matching the pre-rebuild data. (Already done once while
--      implementing this branch — see docs/OWNER-ACCESS-IMPLEMENTATION-
--      NOTES.md for the result — but re-verify if this file changes.)
--   4. James has explicitly confirmed running this against the production
--      database, in this session or a later one. Nothing in this repo
--      should trigger it on its own.
--   5. Only once a cutover using this script is confirmed successful:
--      delete the backup from step 1 after 30 days, per the approved
--      retention decision for that backup — not before, and not kept
--      indefinitely either.
--
-- ---- STEP 1: run this by itself first, confirm it returns 0 ----
--
--   SELECT COUNT(*) FROM events WHERE moderator_id IS NULL OR ends_at IS NULL;
--
-- ---- STEP 2: only once step 1 returns 0, run everything below ----
-- ---- STEP 3 (after): run `PRAGMA foreign_key_check;` and confirm 0 rows ----

ALTER TABLE events RENAME TO events_pre_not_null;
ALTER TABLE registrations RENAME TO registrations_pre_not_null;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL REFERENCES moderators(id),
  title TEXT NOT NULL,
  organizer TEXT,
  event_date TEXT,
  ends_at TEXT NOT NULL,
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

INSERT INTO events
  (id, moderator_id, title, organizer, event_date, ends_at, meeting_location, meeting_time, fee, passenger_fee,
   capacity, cutoff_at, group_link, notes, status, enable_attendance_type, enable_car_role, enable_plus_one, created_at)
SELECT
  id, moderator_id, title, organizer, event_date, ends_at, meeting_location, meeting_time, fee, passenger_fee,
  capacity, cutoff_at, group_link, notes, status, enable_attendance_type, enable_car_role, enable_plus_one, created_at
FROM events_pre_not_null;

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

INSERT INTO registrations
  (id, event_id, line_user_id, display_name, picture_url, role, attendance_type, plus_one_count, status, hide_from_roster, created_at, updated_at)
SELECT
  id, event_id, line_user_id, display_name, picture_url, role, attendance_type, plus_one_count, status, hide_from_roster, created_at, updated_at
FROM registrations_pre_not_null;

-- old child first, then old parent — avoids ever having the old parent
-- dropped while something still refers to it. Also must happen BEFORE
-- recreating the indexes below: renaming a table does not rename its
-- indexes, so idx_events_moderator etc. still exist (now attached to
-- events_pre_not_null) until these DROPs remove them along with the table.
DROP TABLE registrations_pre_not_null;
DROP TABLE events_pre_not_null;

CREATE INDEX idx_events_moderator ON events(moderator_id);
CREATE INDEX idx_events_ends_at ON events(ends_at);
CREATE INDEX idx_registrations_event ON registrations(event_id);
