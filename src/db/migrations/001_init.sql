-- Mission Control schema. Nothing is deployed yet, so this file is replaced
-- rather than chained; the next change goes in 002.

-- A person: a callsign plus a cookie token. Only sha256(token) is stored.
CREATE TABLE crew (
  id INTEGER PRIMARY KEY,
  callsign TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE missions (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  sequence_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'live', 'done')),
  -- engine State as JSON, rewritten after every accepted action and event
  state_json TEXT NOT NULL,
  -- nowMs for the engine = Date.now() - clock_offset_ms (grows across restarts)
  clock_offset_ms INTEGER NOT NULL DEFAULT 0,
  -- wall clock at the last persist; the gap to boot time is downtime
  last_seen_ms INTEGER NOT NULL DEFAULT 0,
  outcome_json TEXT,
  created_by INTEGER NOT NULL REFERENCES crew(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX missions_status ON missions(status, created_at);

CREATE TABLE seats (
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  crew_id INTEGER NOT NULL REFERENCES crew(id),
  PRIMARY KEY (mission_id, role)
);
CREATE INDEX seats_crew ON seats(crew_id);

-- Every ACCEPTED action and the nowMs it was applied at: init(seed) plus this
-- log is the whole mission. crew_id is NULL for actions the server took itself.
CREATE TABLE mission_actions (
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  now_ms INTEGER NOT NULL,
  crew_id INTEGER REFERENCES crew(id),
  action_json TEXT NOT NULL,
  PRIMARY KEY (mission_id, seq)
);

-- Engine events. They carry fault truth: never sent to a client before the
-- mission is done.
CREATE TABLE mission_events (
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at_t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  data_json TEXT,
  PRIMARY KEY (mission_id, seq)
);
