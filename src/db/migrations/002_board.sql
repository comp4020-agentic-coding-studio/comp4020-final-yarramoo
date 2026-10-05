CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  accepted_answer_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE question_skills (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  PRIMARY KEY (question_id, skill_id)
);
CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE helped (
  answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (answer_id, user_id)
);
CREATE TABLE flags (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('question','answer')),
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_type, target_id, user_id)
);
-- target_type is free text so other content (projects, updates) can attach provenance later.
CREATE TABLE provenance (
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  pledged INTEGER NOT NULL,
  typed_chars INTEGER,
  pasted_prose_chars INTEGER,
  prose_chars INTEGER,
  potentially_ai INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_type, target_id)
);
CREATE INDEX idx_questions_created ON questions(created_at, id);
CREATE INDEX idx_questions_project ON questions(project_id);
CREATE INDEX idx_question_skills_skill ON question_skills(skill_id);
CREATE INDEX idx_answers_question ON answers(question_id, created_at);
CREATE INDEX idx_helped_user ON helped(user_id);
