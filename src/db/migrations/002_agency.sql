-- One shared space agency for the whole site: one budget, one reputation,
-- shared pads and rockets (plans/mission-control.md, D3).
CREATE TABLE agency (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  budget INTEGER NOT NULL,
  reputation INTEGER NOT NULL
);
INSERT INTO agency (id, budget, reputation) VALUES (1, 1000, 50);

CREATE TABLE pads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  condition INTEGER NOT NULL CHECK (condition BETWEEN 0 AND 100)
);
INSERT INTO pads (name, condition) VALUES ('LC-1', 100);

CREATE TABLE rockets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  condition INTEGER NOT NULL CHECK (condition BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('ready', 'repair', 'lost')),
  flights INTEGER NOT NULL DEFAULT 0
);
INSERT INTO rockets (name, condition, status) VALUES ('K1-01', 100, 'ready'), ('K1-02', 100, 'ready'), ('K1-03', 100, 'ready');

ALTER TABLE missions ADD COLUMN rocket_id INTEGER REFERENCES rockets(id);
ALTER TABLE missions ADD COLUMN pad_id INTEGER REFERENCES pads(id);

CREATE TABLE agency_ledger (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  mission_id INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  crew_id INTEGER REFERENCES crew(id),
  budget_delta INTEGER NOT NULL,
  reputation_delta INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX agency_ledger_at ON agency_ledger(id DESC);
CREATE INDEX agency_ledger_mission ON agency_ledger(mission_id);
