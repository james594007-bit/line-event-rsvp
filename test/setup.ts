// Mirrors migrations/0003_owner_access.sql for the test D1 instance.
// Kept as plain statements (not a file read) because vitest-pool-workers
// test bodies execute inside the Workers sandbox, where Node's `fs` isn't
// available without extra nodejs_compat wiring we don't otherwise need.
// If migrations/0003 changes, update this to match.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS moderators (
    id TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'moderator' CHECK(role IN ('owner','moderator')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
    session_version INTEGER NOT NULL DEFAULT 0,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT,
    decided_by TEXT REFERENCES moderators(id),
    suspend_reason TEXT,
    pending_display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_moderators_line_user ON moderators(line_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_moderators_status ON moderators(status)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    moderator_id TEXT NOT NULL REFERENCES moderators(id),
    session_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_moderator ON sessions(moderator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL CHECK(event_type IN ('apply','approve','reject','suspend','restore')),
    target_moderator_id TEXT NOT NULL,
    actor_moderator_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK(result IN ('success','denied')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_moderator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    moderator_id TEXT NOT NULL REFERENCES moderators(id),
    title TEXT NOT NULL,
    organizer TEXT,
    event_date TEXT,
    ends_at TEXT NOT NULL,
    activity_location TEXT,
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_moderator ON events(moderator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ends_at ON events(ends_at)`,
  `CREATE TABLE IF NOT EXISTS registrations (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id)`,
  `CREATE TABLE IF NOT EXISTS event_archive_stats (
    event_id TEXT PRIMARY KEY,
    moderator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    final_registered_count INTEGER NOT NULL,
    final_total_headcount INTEGER NOT NULL,
    archived_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

export async function applyTestSchema(db: D1Database) {
  for (const stmt of STATEMENTS) {
    await db.prepare(stmt).run()
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO moderators (id, line_user_id, role, status, decided_at)
       VALUES ('mod_legacy_admin', 'legacy:shared-passcode-admin', 'moderator', 'approved', datetime('now'))`
    )
    .run()
}

export async function resetTestSchema(db: D1Database) {
  const tables = [
    'event_archive_stats',
    'registrations',
    'events',
    'rate_limit_counters',
    'audit_log',
    'sessions',
    'moderators',
  ]
  for (const t of tables) {
    await db.prepare(`DROP TABLE IF EXISTS ${t}`).run()
  }
  await applyTestSchema(db)
}
