-- Member safety. We store no date of birth: signup only records that the person confirmed they are 18+.
ALTER TABLE users ADD COLUMN adult_confirmed_at TEXT;
UPDATE users SET adult_confirmed_at = CURRENT_TIMESTAMP;

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT NULL
);
-- One open report per reporter per target.
CREATE UNIQUE INDEX idx_reports_one_open ON reports(reporter_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id)
);
