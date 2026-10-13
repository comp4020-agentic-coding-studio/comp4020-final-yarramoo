-- Interest lobbies (per category and region) that form teams, and the leader vote on formed teams.
CREATE TABLE lobby_members (
  category TEXT NOT NULL,
  region TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NULL,
  skills TEXT NULL,
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, region, user_id)
);
CREATE INDEX idx_lobby_members_user ON lobby_members(user_id);
CREATE INDEX idx_lobby_members_joined ON lobby_members(category, region, joined_at);

-- leader_pending = 1 while a formed team has not yet elected a leader; owner_id is then a placeholder.
ALTER TABLE projects ADD COLUMN leader_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN formed_from_lobby TEXT NULL; -- "<category>:<region>"

CREATE TABLE leader_votes (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  voter_id INTEGER NOT NULL REFERENCES users(id),
  candidate_id INTEGER NOT NULL REFERENCES users(id),
  voted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, voter_id)
);
CREATE INDEX idx_leader_votes_candidate ON leader_votes(project_id, candidate_id);
