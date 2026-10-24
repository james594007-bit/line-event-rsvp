CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,            -- 主題
  organizer TEXT,                 -- 主揪
  event_date TEXT,                -- 日期
  meeting_location TEXT,          -- 集合地點
  meeting_time TEXT,              -- 集合時間
  fee TEXT,                       -- 費用
  passenger_fee TEXT,             -- 乘客車資
  capacity INTEGER,               -- 人數
  cutoff_at TEXT,                 -- 報名截止日
  group_link TEXT,                -- 活動群連結(報名後直接顯示,不用等成團)
  notes TEXT,                     -- 備註 / 活動聲明
  status TEXT NOT NULL DEFAULT 'open', -- open | full | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id),
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  picture_url TEXT,
  role TEXT,                      -- 'driver' | 'passenger' | null(無車位考量)
  status TEXT NOT NULL DEFAULT 'registered', -- registered | cancelled
  hide_from_roster INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, line_user_id)
);

CREATE INDEX idx_registrations_event ON registrations(event_id);
