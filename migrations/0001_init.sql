-- Bastion D1 schema (CLAUDE.md §8). All write paths also append to audit_log.

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  vendor        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  vendor          TEXT NOT NULL,
  transport       TEXT NOT NULL,
  conn_meta       TEXT,            -- JSON, non-secret connection metadata
  discovery_ref   TEXT,            -- R2 key of last discovery snapshot
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  version       INTEGER NOT NULL,
  ir_json       TEXT NOT NULL,     -- the IR build plan
  diff_json     TEXT,              -- diff vs previous version
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_project_version ON plans(project_id, version);

CREATE TABLE IF NOT EXISTS imports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  raw_ref       TEXT NOT NULL,     -- R2 key of raw source text
  fragment_json TEXT,              -- AI-normalised IR fragment
  provenance    TEXT,              -- JSON: model, format, warnings
  accepted      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_packs (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  pack_id       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, pack_id)
);

CREATE TABLE IF NOT EXISTS apply_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  plan_id       TEXT REFERENCES plans(id),
  mode          TEXT NOT NULL,     -- 'live' | 'staged'
  result        TEXT,              -- JSON ApplyResult
  bundle_ref    TEXT,              -- R2 key of staged bundle
  readback_ref  TEXT,              -- R2 key of post-apply read
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  before_ref    TEXT,
  after_ref     TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_project ON audit_log(project_id, created_at);
