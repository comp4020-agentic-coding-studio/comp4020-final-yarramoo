-- Honesty system: community flags are gone; provenance carries quiet behaviour signals and a
-- score for admin review. Rebuilt (not ALTERed) because SQLite cannot ADD a column whose
-- default is CURRENT_TIMESTAMP.
DROP TABLE flags;
CREATE TABLE provenance_new (
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  pledged INTEGER NOT NULL,
  typed_chars INTEGER,
  pasted_prose_chars INTEGER,
  prose_chars INTEGER,
  potentially_ai INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER,
  paste_events INTEGER,
  deletions INTEGER,
  score REAL,
  hidden INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_type, target_id)
);
-- Old rows predate the signals (and their potentially_ai came from flags): they become "unknown".
INSERT INTO provenance_new (target_type, target_id, pledged, typed_chars, pasted_prose_chars, prose_chars)
  SELECT target_type, target_id, pledged, typed_chars, pasted_prose_chars, prose_chars FROM provenance;
DROP TABLE provenance;
ALTER TABLE provenance_new RENAME TO provenance;
CREATE INDEX idx_provenance_score ON provenance(score DESC);
CREATE INDEX idx_provenance_hidden ON provenance(hidden);
