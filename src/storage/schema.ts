/** 数据库结构。新库直接建全量结构；旧库由 Store.migrate() 增量补列，不删数据。 */
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
  review_epoch     INTEGER NOT NULL DEFAULT 0,
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
  broadcast_id TEXT,
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
  reason        TEXT NOT NULL DEFAULT 'reply',
  match_from    TEXT,
  match_reply_to TEXT,
  match_kinds   TEXT,
  deadline_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_wait_worker ON wait_record(worker_id, resolved_at);

CREATE TABLE IF NOT EXISTS review (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  artifact_id        TEXT NOT NULL,
  artifact_version   INTEGER NOT NULL,
  artifact_sha256    TEXT NOT NULL DEFAULT '',
  epoch              INTEGER NOT NULL DEFAULT 0,
  requested_by       TEXT NOT NULL,
  reviewer_id        TEXT,
  request_message_id TEXT NOT NULL,
  reply_message_id   TEXT,
  outcome            TEXT NOT NULL DEFAULT 'pending',
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS worker_note (
  id           TEXT PRIMARY KEY,
  worker_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  covered_seq  INTEGER NOT NULL,
  epoch        INTEGER NOT NULL,
  content      TEXT NOT NULL,
  source_turns INTEGER NOT NULL,
  source_chars INTEGER NOT NULL,
  failed       INTEGER NOT NULL DEFAULT 0,
  fail_reason  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_worker ON worker_note(worker_id, created_at);

CREATE TABLE IF NOT EXISTS event (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  worker_id  TEXT,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
`;
