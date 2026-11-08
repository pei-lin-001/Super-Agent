/** 数据库结构。一次性建表，不做迁移框架：模块 1 允许重建 .data/agent.db。 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS task (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  goal             TEXT NOT NULL,
  brief            TEXT NOT NULL DEFAULT '',
  done_criteria    TEXT NOT NULL DEFAULT '',
  require_review   INTEGER NOT NULL DEFAULT 0,
  owner_worker_id  TEXT,
  status           TEXT NOT NULL,
  close_reason     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
);

CREATE TABLE IF NOT EXISTS worker (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  parent_id   TEXT,
  role        TEXT NOT NULL,
  brief       TEXT NOT NULL,
  status      TEXT NOT NULL,
  model       TEXT,
  step_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_worker_group ON worker(group_id);

CREATE TABLE IF NOT EXISTS message (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  task_id      TEXT,
  from_kind    TEXT NOT NULL,
  from_id      TEXT NOT NULL,
  to_kind      TEXT NOT NULL,
  to_id        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  payload      TEXT,
  reply_to     TEXT,
  refs         TEXT,
  dedupe_key   TEXT,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  consumed_at  TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_to ON message(to_id, status);
CREATE INDEX IF NOT EXISTS idx_message_group ON message(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_dedupe ON message(group_id, dedupe_key);

CREATE TABLE IF NOT EXISTS artifact (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  worker_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_task ON artifact(task_id, name, version);

CREATE TABLE IF NOT EXISTS wait_record (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL,
  group_id      TEXT NOT NULL,
  match_from    TEXT,
  match_reply_to TEXT,
  match_kinds   TEXT,
  deadline_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_wait_worker ON wait_record(worker_id, resolved_at);

CREATE TABLE IF NOT EXISTS review (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  artifact_version  INTEGER NOT NULL,
  requested_by      TEXT NOT NULL,
  reviewer_id       TEXT,
  request_message_id TEXT NOT NULL,
  reply_message_id  TEXT,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_task ON review(task_id, status);

CREATE TABLE IF NOT EXISTS worker_turn (
  id           TEXT PRIMARY KEY,
  worker_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT,
  tool_calls   TEXT,
  tool_call_id TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_worker ON worker_turn(worker_id, seq);

CREATE TABLE IF NOT EXISTS router_turn (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  worker_id  TEXT,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
`;
