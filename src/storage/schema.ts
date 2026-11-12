/** 数据库结构。新库直接建全量结构；旧库由 Store.migrate() 增量补列，不删数据。 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Workspace：相似任务的工作空间。
--
-- 之前 group 只是 task 的哈希后缀（grp_<taskId>），任务一结束整组就散了。
-- 现在它是独立实体：有自己的名字、记忆、成员，任务只是它接的一次活。
-- 沿用 group_id 作为 id（迁移期兼容），新代码一律叫 workspace_id。
CREATE TABLE IF NOT EXISTS workspace (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  brief           TEXT NOT NULL DEFAULT '',
  -- 归属在创建时固化：之后别的话题引用它也只是引用，不改归属。
  session_key     TEXT,
  conversation_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_active_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_conversation ON workspace(conversation_id, last_active_at);
CREATE INDEX IF NOT EXISTS idx_workspace_status ON workspace(status, last_active_at);

CREATE TABLE IF NOT EXISTS task (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  goal             TEXT NOT NULL,
  brief            TEXT NOT NULL DEFAULT '',
  done_criteria    TEXT NOT NULL DEFAULT '',
  require_review   INTEGER NOT NULL DEFAULT 0,
  review_epoch     INTEGER NOT NULL DEFAULT 0,
  maintenance      INTEGER NOT NULL DEFAULT 0,
  owner_worker_id  TEXT,
  source_channel     TEXT,
  source_account_id  TEXT,
  source_peer_id     TEXT,
  source_session_key TEXT,
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
  match_job     TEXT,
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
  session_key TEXT,
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

CREATE TABLE IF NOT EXISTS router_session (
  id           TEXT PRIMARY KEY,
  session_key  TEXT,
  task_id      TEXT,
  messages     TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_session_status ON router_session(status);

-- Router 的对话摘要：按话题维护一份累计记录，替代"只留最近 N 条"的硬截断。
-- 结构对齐 worker_note，covered_seq 是水位线（router_turn.seq）。
CREATE TABLE IF NOT EXISTS router_note (
  id           TEXT PRIMARY KEY,
  session_key  TEXT,
  conversation_id TEXT,
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  covered_seq  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  source_turns INTEGER NOT NULL,
  source_chars INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_note_conversation ON router_note(conversation_id, created_at);

-- ---- 渠道层：入站、游标、发件与渠道会话 ----
CREATE TABLE IF NOT EXISTS channel_inbound (
  id                  TEXT PRIMARY KEY,
  channel             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  peer_id             TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  session_key         TEXT NOT NULL,
  thread_id           TEXT,
  body                TEXT NOT NULL DEFAULT '',
  attachments         TEXT,
  unsupported         TEXT,
  silent              INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,
  reason              TEXT,
  received_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  handled_at          TEXT,
  claimed_task_id     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_dedupe ON channel_inbound(channel, account_id, event_id);
CREATE INDEX IF NOT EXISTS idx_inbound_status ON channel_inbound(status, created_at);

CREATE TABLE IF NOT EXISTS channel_cursor (
  channel    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  cursor     TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, account_id)
);

CREATE TABLE IF NOT EXISTS channel_outbound (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  peer_id     TEXT NOT NULL,
  session_key TEXT NOT NULL,
  task_id     TEXT,
  body        TEXT NOT NULL,
  segments    TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON channel_outbound(status, created_at);

CREATE TABLE IF NOT EXISTS channel_session (
  session_key       TEXT PRIMARY KEY,
  channel           TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  peer_id           TEXT NOT NULL,
  router_session_id TEXT,
  context_token     TEXT,
  context_updated_at TEXT,
  last_inbound_at   TEXT,
  last_outbound_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---- 对话话题：一个聊天窗口里可以有多个互相独立的话题 ----
-- 聊天窗口（session_key）是地址，话题是内容边界：历史、任务、待续接执行按话题隔离。
CREATE TABLE IF NOT EXISTS conversation (
  id                 TEXT PRIMARY KEY,
  session_key        TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  last_message_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation(session_key, status, last_message_at);

CREATE TABLE IF NOT EXISTS router_decision (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_no    INTEGER NOT NULL,
  text       TEXT,
  tool_calls TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_decision_session ON router_decision(session_id, status);

CREATE TABLE IF NOT EXISTS router_action (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  tool       TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_router_action_key ON router_action(session_id, action_key);

CREATE TABLE IF NOT EXISTS behavior_override (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  author     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_override_key ON behavior_override(key, version);

CREATE TABLE IF NOT EXISTS control_command (
  id         TEXT PRIMARY KEY,
  command    TEXT NOT NULL,
  payload    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  result     TEXT,
  source     TEXT NOT NULL DEFAULT 'watchdog',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_status ON control_command(status, created_at);

CREATE TABLE IF NOT EXISTS process_job (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  worker_id        TEXT NOT NULL,
  command          TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  pid              INTEGER,
  status           TEXT NOT NULL,
  exit_code        INTEGER,
  signal           TEXT,
  scope            TEXT NOT NULL DEFAULT 'biz',
  stdout_path      TEXT NOT NULL,
  stderr_path      TEXT NOT NULL,
  timeout_ms       INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_task ON process_job(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_job_status ON process_job(status);

CREATE TABLE IF NOT EXISTS wd_turn (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 维护对话的累计摘要：wd_turn 只增不减，不压会一路撞窗口。
-- 水位线用 wd_turn 的隐式 rowid，不必再加列。
CREATE TABLE IF NOT EXISTS wd_note (
  id           TEXT PRIMARY KEY,
  from_row     INTEGER NOT NULL,
  to_row       INTEGER NOT NULL,
  covered_row  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  source_turns INTEGER NOT NULL,
  source_chars INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

-- Worker 向 Watchdog 提的维护申请。
-- 与 control_command 分表：那个是「维护者下命令」，这个是「执行者提申请」，
-- 方向相反，混在一起以后分不清谁在指挥谁。
CREATE TABLE IF NOT EXISTS wd_request (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  task_id    TEXT,
  worker_id  TEXT,
  reason     TEXT NOT NULL,
  refs       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  result     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_request_status ON wd_request(status, created_at);

CREATE TABLE IF NOT EXISTS wd_issue (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  attempts    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  check_after TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_issue_status ON wd_issue(status, check_after);

CREATE TABLE IF NOT EXISTS model_call (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT,
  model_alias  TEXT,
  response_model TEXT,
  purpose      TEXT NOT NULL,
  task_id      TEXT,
  worker_id    TEXT,
  session_id   TEXT,
  router_session_key TEXT,
  router_scope_known INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  http_attempts INTEGER,
  prompt_tokens INTEGER,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  completion_tokens INTEGER,
  usage_known  INTEGER NOT NULL DEFAULT 0,
  cancelled    INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_call_started ON model_call(started_at);
CREATE INDEX IF NOT EXISTS idx_model_call_purpose ON model_call(purpose, status);

-- Router 与 Watchdog 之间的通道。
-- 两个进程只通过数据库通信，所以这里既是消息队列也是审计记录。
-- notice 不要求回应；request/question 要求 reply，且 reply 不能再 reply
-- （否则两个模型会互相唤醒到天亮的死循环）。hops 就是那道闸门。
CREATE TABLE IF NOT EXISTS intercom (
  id          TEXT PRIMARY KEY,
  from_layer  TEXT NOT NULL,
  to_layer    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  topic_id    TEXT,
  reply_to    TEXT,
  session_key TEXT,
  conversation_id TEXT,
  route_known INTEGER NOT NULL DEFAULT 0,
  task_id     TEXT,
  body        TEXT NOT NULL,
  refs        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  hops        INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intercom_to ON intercom(to_layer, status, created_at);
CREATE INDEX IF NOT EXISTS idx_intercom_topic ON intercom(topic_id);

CREATE TABLE IF NOT EXISTS wd_question (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  answer     TEXT,
  error      TEXT,
  asked_at   TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wd_question_status ON wd_question(status, asked_at);

CREATE TABLE IF NOT EXISTS wd_action (
  command_id TEXT,
  id         TEXT PRIMARY KEY,
  issue_id   TEXT,
  action     TEXT NOT NULL,
  reason     TEXT,
  expected   TEXT,
  result     TEXT,
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
