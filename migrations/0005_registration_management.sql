ALTER TABLE registrations ADD COLUMN cancelled_by TEXT CHECK(cancelled_by IN ('participant','moderator'));

CREATE TABLE registration_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  actor_moderator_id TEXT NOT NULL REFERENCES moderators(id),
  action TEXT NOT NULL CHECK(action IN ('edit','remove','restore')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_registration_audit_event ON registration_audit_log(event_id, created_at);
