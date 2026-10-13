-- Cross-cutting project themes (0-3 per project), anonymous community upvotes, and a finished-builds feed.
CREATE TABLE project_themes (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  theme TEXT NOT NULL,
  PRIMARY KEY (project_id, theme)
);
CREATE INDEX idx_project_themes_theme ON project_themes(theme, project_id);

CREATE TABLE upvotes (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_upvotes_user ON upvotes(user_id);

ALTER TABLE projects ADD COLUMN finished_at TEXT NULL;
UPDATE projects SET finished_at = updated_at WHERE status = 'done';
CREATE INDEX idx_projects_finished ON projects(finished_at DESC) WHERE finished_at IS NOT NULL;
