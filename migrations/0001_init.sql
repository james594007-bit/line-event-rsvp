CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  capacity INTEGER,
  cutoff_at TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | full | closed
  group_invite_link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id),
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  picture_url TEXT,
  status TEXT NOT NULL DEFAULT 'registered', -- registered | cancelled
  hide_from_roster INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, line_user_id)
);

CREATE INDEX idx_registrations_event ON registrations(event_id);
