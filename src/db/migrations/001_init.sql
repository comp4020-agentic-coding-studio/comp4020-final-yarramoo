CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  display_name TEXT,
  bio TEXT,
  postcode TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE skills (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE user_skills (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  PRIMARY KEY (user_id, skill_id)
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  recruiting INTEGER NOT NULL DEFAULT 1,
  postcode TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE project_skills (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  filled_by INTEGER REFERENCES users(id),
  PRIMARY KEY (project_id, skill_id)
);
CREATE TABLE members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE join_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  skill_id INTEGER REFERENCES skills(id),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE TABLE updates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  update_id INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  width INTEGER,
  height INTEGER
);
CREATE TABLE postcodes (
  postcode TEXT PRIMARY KEY,
  locality TEXT,
  state TEXT,
  lat REAL,
  lon REAL
);
CREATE INDEX idx_projects_status ON projects(status, recruiting);
CREATE INDEX idx_project_skills_skill ON project_skills(skill_id);
CREATE INDEX idx_join_requests_project ON join_requests(project_id, status);
CREATE INDEX idx_updates_project ON updates(project_id, created_at);
CREATE INDEX idx_postcodes_lat ON postcodes(lat);
CREATE INDEX idx_postcodes_lon ON postcodes(lon);
CREATE INDEX idx_sessions_user ON sessions(user_id);
