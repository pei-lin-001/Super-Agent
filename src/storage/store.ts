import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newEventId, newReviewId, newWaitId, nowIso } from '../domain/ids.ts';
import { assertMessageTransition, assertTaskTransition, assertWorkerTransition } from '../domain/state.ts';
import type {
  Artifact,
  EventRecord,
  Message,
  MessageKind,
  MessageRefs,
  MessageStatus,
  ProcessJob,
  Review,
  ReviewOutcome,
  RouterTurn,
  Task,
  TaskStatus,
  WaitReason,
  WaitRecord,
  Worker,
  WorkerNote,
  WorkerStatus,
  WorkerTurn,
} from '../domain/types.ts';
import { SCHEMA_SQL } from './schema.ts';

type Row = Record<string, unknown>;

/** node:sqlite 只接受 null，不接受 undefined。 */
function bind(value: unknown): null | string | number | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mapTask(row: Row): Task {
  return {
    id: str(row['id']),
    groupId: str(row['group_id']),
    title: str(row['title']),
    goal: str(row['goal']),
    brief: str(row['brief']),
    doneCriteria: str(row['done_criteria']),
    requireReview: num(row['require_review']) === 1,
    reviewEpoch: num(row['review_epoch'] ?? 0),
    maintenance: num(row['maintenance'] ?? 0),
    ownerWorkerId: strOrNull(row['owner_worker_id']),
    status: str(row['status']) as TaskStatus,
    closeReason: strOrNull(row['close_reason']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    closedAt: strOrNull(row['closed_at']),
  };
}

function mapWorker(row: Row): Worker {
  return {
    id: str(row['id']),
    groupId: str(row['group_id']),
    parentId: strOrNull(row['parent_id']),
    role: str(row['role']),
    brief: str(row['brief']),
    status: str(row['status']) as WorkerStatus,
    model: strOrNull(row['model']),
    stepCount: num(row['step_count']),
    runEpoch: num(row['run_epoch'] ?? 0),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    lastError: strOrNull(row['last_error']),
  };
}

function mapMessage(row: Row): Message {
  const payloadRaw = strOrNull(row['payload']);
  const refsRaw = strOrNull(row['refs']);
  return {
    id: str(row['id']),
    groupId: str(row['group_id']),
    taskId: strOrNull(row['task_id']),
    fromKind: str(row['from_kind']) as Message['fromKind'],
    fromId: str(row['from_id']),
    toKind: str(row['to_kind']) as Message['toKind'],
    toId: str(row['to_id']),
    kind: str(row['kind']) as MessageKind,
    body: str(row['body']),
    payload: payloadRaw ? (JSON.parse(payloadRaw) as Record<string, unknown>) : null,
    replyTo: strOrNull(row['reply_to']),
    refs: refsRaw ? (JSON.parse(refsRaw) as MessageRefs) : null,
    dedupeKey: strOrNull(row['dedupe_key']),
    broadcastId: strOrNull(row['broadcast_id']),
    status: str(row['status']) as MessageStatus,
    createdAt: str(row['created_at']),
    deliveredAt: strOrNull(row['delivered_at']),
    consumedAt: strOrNull(row['consumed_at']),
    error: strOrNull(row['error']),
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: str(row['id']),
    taskId: str(row['task_id']),
    workerId: str(row['worker_id']),
    name: str(row['name']),
    path: str(row['path']),
    version: num(row['version']),
    sha256: str(row['sha256']),
    bytes: num(row['bytes']),
    createdAt: str(row['created_at']),
  };
}

function mapJob(row: Row): ProcessJob {
  const args = strOrNull(row['args_json']);
  return {
    id: str(row['id']),
    taskId: str(row['task_id']),
    workerId: str(row['worker_id']),
    command: str(row['command']),
    args: args ? (JSON.parse(args) as string[]) : [],
    cwd: str(row['cwd']),
    pid: row['pid'] === null || row['pid'] === undefined ? null : num(row['pid']),
    status: str(row['status']) as ProcessJob['status'],
    exitCode: row['exit_code'] === null || row['exit_code'] === undefined ? null : num(row['exit_code']),
    signal: strOrNull(row['signal']),
    stdoutPath: str(row['stdout_path']),
    stderrPath: str(row['stderr_path']),
    timeoutMs: num(row['timeout_ms']),
    startedAt: str(row['started_at']),
    endedAt: strOrNull(row['ended_at']),
    error: strOrNull(row['error']),
  };
}

function mapWait(row: Row): WaitRecord {
  const kinds = strOrNull(row['match_kinds']);
  return {
    id: str(row['id']),
    workerId: str(row['worker_id']),
    groupId: str(row['group_id']),
    reason: (strOrNull(row['reason']) ?? 'reply') as WaitReason,
    matchFrom: strOrNull(row['match_from']),
    matchReplyTo: strOrNull(row['match_reply_to']),
    matchKinds: kinds ? (JSON.parse(kinds) as MessageKind[]) : null,
    matchJob: strOrNull(row['match_job']),
    deadlineAt: str(row['deadline_at']),
    createdAt: str(row['created_at']),
    resolvedAt: strOrNull(row['resolved_at']),
  };
}

function mapReview(row: Row): Review {
  return {
    id: str(row['id']),
    taskId: str(row['task_id']),
    artifactId: str(row['artifact_id']),
    artifactVersion: num(row['artifact_version']),
    artifactSha256: strOrNull(row['artifact_sha256']) ?? '',
    epoch: num(row['epoch'] ?? 0),
    requestedBy: str(row['requested_by']),
    reviewerId: strOrNull(row['reviewer_id']),
    requestMessageId: str(row['request_message_id']),
    replyMessageId: strOrNull(row['reply_message_id']),
    outcome: (strOrNull(row['outcome']) ?? 'pending') as ReviewOutcome,
    createdAt: str(row['created_at']),
  };
}

function mapNote(row: Row): WorkerNote {
  return {
    id: str(row['id']),
    workerId: str(row['worker_id']),
    taskId: str(row['task_id']),
    fromSeq: num(row['from_seq']),
    toSeq: num(row['to_seq']),
    coveredSeq: num(row['covered_seq']),
    epoch: num(row['epoch']),
    content: str(row['content']),
    sourceTurns: num(row['source_turns']),
    sourceChars: num(row['source_chars']),
    failed: num(row['failed']) === 1,
    failReason: strOrNull(row['fail_reason']),
    createdAt: str(row['created_at']),
  };
}

function mapTurn(row: Row): WorkerTurn {
  return {
    id: str(row['id']),
    workerId: str(row['worker_id']),
    seq: num(row['seq']),
    role: str(row['role']) as WorkerTurn['role'],
    content: strOrNull(row['content']),
    toolCalls: row['tool_calls'] ? JSON.parse(str(row['tool_calls'])) : null,
    toolCallId: strOrNull(row['tool_call_id']),
    createdAt: str(row['created_at']),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /**
   * 增量迁移：只补列，不删数据、不重建表。
   * 旧记录里无法判定的状态一律落到「不安全」的一侧（例如旧检查记为 inconclusive）。
   */
  private migrate(): void {
    const ensureColumn = (table: string, column: string, ddl: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
      if (!columns.some((item) => item.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    ensureColumn('task', 'review_epoch', 'review_epoch INTEGER NOT NULL DEFAULT 0');
    ensureColumn('task', 'maintenance', 'maintenance INTEGER NOT NULL DEFAULT 0');
    ensureColumn('worker', 'run_epoch', 'run_epoch INTEGER NOT NULL DEFAULT 0');
    ensureColumn('message', 'dedupe_key', 'dedupe_key TEXT');
    ensureColumn('message', 'broadcast_id', 'broadcast_id TEXT');
    ensureColumn('wait_record', 'reason', "reason TEXT NOT NULL DEFAULT 'reply'");
    ensureColumn('wait_record', 'match_job', 'match_job TEXT');
    ensureColumn('review', 'artifact_sha256', "artifact_sha256 TEXT NOT NULL DEFAULT ''");
    ensureColumn('review', 'epoch', 'epoch INTEGER NOT NULL DEFAULT 0');
    ensureColumn('review', 'outcome', "outcome TEXT NOT NULL DEFAULT 'pending'");
    // 旧版 review.status 只有 pending/answered，无法表达结论，一律不放行。
    this.db.exec(
      `UPDATE review SET outcome = 'inconclusive' WHERE outcome = 'pending' AND status = 'answered'`,
    );
  }

  close(): void {
    if (!this.db.isOpen) return;
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params.map(bind) as never[])) as Row[];
  }

  private get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params.map(bind) as never[])) as Row | undefined;
  }

  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params.map(bind) as never[]));
  }

  // ---------------- task ----------------

  createTask(task: Task): Task {
    this.run(
      `INSERT INTO task (id, group_id, title, goal, brief, done_criteria, require_review,
                         owner_worker_id, status, close_reason, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.groupId, task.title, task.goal, task.brief, task.doneCriteria,
      task.requireReview ? 1 : 0,
      task.ownerWorkerId, task.status, task.closeReason, task.createdAt, task.updatedAt, task.closedAt,
    );
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.get('SELECT * FROM task WHERE id = ?', id);
    return row ? mapTask(row) : null;
  }

  getTaskByGroup(groupId: string): Task | null {
    const row = this.get('SELECT * FROM task WHERE group_id = ?', groupId);
    return row ? mapTask(row) : null;
  }

  listTasks(): Task[] {
    return this.all('SELECT * FROM task ORDER BY created_at ASC').map(mapTask);
  }

  listOpenTasks(): Task[] {
    return this.all(
      "SELECT * FROM task WHERE status IN ('pending','active','waiting') ORDER BY created_at ASC",
    ).map(mapTask);
  }

  setTaskStatus(id: string, status: TaskStatus, options: { reason?: string } = {}): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`任务不存在：${id}`);
    assertTaskTransition(task.status, status);
    const now = nowIso();
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    const closedAt = isTerminal ? now : task.closedAt;
    this.run(
      'UPDATE task SET status = ?, close_reason = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      status, options.reason ?? task.closeReason, now, closedAt, id,
    );
    return { ...task, status, closeReason: options.reason ?? task.closeReason, updatedAt: now, closedAt };
  }

  updateTaskRequirements(id: string, patch: { goal?: string; brief?: string; doneCriteria?: string; title?: string }): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`任务不存在：${id}`);
    this.run(
      'UPDATE task SET title = ?, goal = ?, brief = ?, done_criteria = ?, updated_at = ? WHERE id = ?',
      patch.title ?? task.title,
      patch.goal ?? task.goal,
      patch.brief ?? task.brief,
      patch.doneCriteria ?? task.doneCriteria,
      nowIso(),
      id,
    );
  }

  setTaskOwner(id: string, workerId: string): void {
    this.run('UPDATE task SET owner_worker_id = ?, updated_at = ? WHERE id = ?', workerId, nowIso(), id);
  }

  // ---------------- worker ----------------

  createWorker(worker: Worker): Worker {
    this.run(
      `INSERT INTO worker (id, group_id, parent_id, role, brief, status, model, step_count, created_at, updated_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      worker.id, worker.groupId, worker.parentId, worker.role, worker.brief, worker.status,
      worker.model, worker.stepCount, worker.createdAt, worker.updatedAt, worker.lastError,
    );
    return worker;
  }

  getWorker(id: string): Worker | null {
    const row = this.get('SELECT * FROM worker WHERE id = ?', id);
    return row ? mapWorker(row) : null;
  }

  listGroupWorkers(groupId: string): Worker[] {
    return this.all('SELECT * FROM worker WHERE group_id = ? ORDER BY created_at ASC', groupId).map(mapWorker);
  }

  listWorkers(): Worker[] {
    return this.all('SELECT * FROM worker ORDER BY created_at ASC').map(mapWorker);
  }

  countWorkers(): number {
    const row = this.get('SELECT COUNT(*) AS n FROM worker');
    return row ? num(row['n']) : 0;
  }

  setWorkerStatus(id: string, status: WorkerStatus, error?: string | null): Worker {
    const worker = this.getWorker(id);
    if (!worker) throw new Error(`Worker 不存在：${id}`);
    assertWorkerTransition(worker.status, status);
    this.run(
      'UPDATE worker SET status = ?, updated_at = ?, last_error = ? WHERE id = ?',
      status, nowIso(), error === undefined ? worker.lastError : error, id,
    );
    return { ...worker, status, updatedAt: nowIso(), lastError: error === undefined ? worker.lastError : error };
  }

  bumpWorkerStep(id: string, delta = 1): void {
    this.run('UPDATE worker SET step_count = step_count + ?, updated_at = ? WHERE id = ?', delta, nowIso(), id);
  }

  addWorkerStepTotal(groupId: string, delta: number): void {
    this.run('UPDATE worker SET step_count = step_count + ? WHERE group_id = ?', delta, groupId);
  }

  groupStepTotal(groupId: string): number {
    const row = this.get('SELECT COALESCE(SUM(step_count), 0) AS n FROM worker WHERE group_id = ?', groupId);
    return row ? num(row['n']) : 0;
  }

  // ---------------- message ----------------

  insertMessage(message: Message): Message {
    this.run(
      `INSERT INTO message (id, group_id, task_id, from_kind, from_id, to_kind, to_id, kind, body,
                            payload, reply_to, refs, dedupe_key, broadcast_id, status,
                            created_at, delivered_at, consumed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id, message.groupId, message.taskId, message.fromKind, message.fromId, message.toKind,
      message.toId, message.kind, message.body,
      message.payload ? JSON.stringify(message.payload) : null,
      message.replyTo,
      message.refs ? JSON.stringify(message.refs) : null,
      message.dedupeKey,
      message.broadcastId,
      message.status, message.createdAt, message.deliveredAt, message.consumedAt, message.error,
    );
    return message;
  }

  findMessageByDedupeKey(groupId: string, key: string): Message | null {
    const row = this.get('SELECT * FROM message WHERE group_id = ? AND dedupe_key = ? LIMIT 1', groupId, key);
    return row ? mapMessage(row) : null;
  }

  getMessage(id: string): Message | null {
    const row = this.get('SELECT * FROM message WHERE id = ?', id);
    return row ? mapMessage(row) : null;
  }

  setMessageStatus(id: string, status: MessageStatus, error?: string | null): void {
    const message = this.getMessage(id);
    if (!message) throw new Error(`消息不存在：${id}`);
    assertMessageTransition(message.status, status);
    const now = nowIso();
    const deliveredAt = status === 'delivered' ? now : message.deliveredAt;
    const consumedAt = status === 'consumed' ? now : message.consumedAt;
    this.run(
      'UPDATE message SET status = ?, delivered_at = ?, consumed_at = ?, error = ? WHERE id = ?',
      status, deliveredAt, consumedAt, error === undefined ? message.error : error, id,
    );
  }

  /** 某 Worker 未消费的收件箱（组内点对点 + 广播）。 */
  listInbox(workerId: string): Message[] {
    const worker = this.getWorker(workerId);
    if (!worker) return [];
    return this.all(
      `SELECT * FROM message
        WHERE status IN ('queued','delivered')
          AND ((to_kind = 'worker' AND to_id = ?)
               OR (to_kind = 'group' AND group_id = ?))
        ORDER BY created_at ASC`,
      workerId, worker.groupId,
    ).map(mapMessage);
  }

  /** Router 未消费的消息。 */
  listRouterInbox(): Message[] {
    return this.all(
      "SELECT * FROM message WHERE to_kind = 'router' AND status IN ('queued','delivered') ORDER BY created_at ASC",
    ).map(mapMessage);
  }

  listGroupMessages(groupId: string, limit = 200): Message[] {
    return this.all(
      'SELECT * FROM message WHERE group_id = ? ORDER BY created_at ASC LIMIT ?',
      groupId, limit,
    ).map(mapMessage);
  }

  listMessagesForWorker(workerId: string, limit = 100): Message[] {
    return this.all(
      `SELECT * FROM message
        WHERE (to_kind = 'worker' AND to_id = ?) OR (from_kind = 'worker' AND from_id = ?)
        ORDER BY created_at ASC LIMIT ?`,
      workerId, workerId, limit,
    ).map(mapMessage);
  }

  expireStaleMessages(beforeIso: string): number {
    const rows = this.all(
      "SELECT id FROM message WHERE status IN ('queued','delivered') AND created_at < ?",
      beforeIso,
    );
    for (const row of rows) {
      this.run("UPDATE message SET status = 'expired', error = '超过存活时间未被消费' WHERE id = ?", str(row['id']));
    }
    return rows.length;
  }

  // ---------------- artifact ----------------

  insertArtifact(artifact: Artifact): Artifact {
    this.run(
      `INSERT INTO artifact (id, task_id, worker_id, name, path, version, sha256, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artifact.id, artifact.taskId, artifact.workerId, artifact.name, artifact.path,
      artifact.version, artifact.sha256, artifact.bytes, artifact.createdAt,
    );
    return artifact;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.get('SELECT * FROM artifact WHERE id = ?', id);
    return row ? mapArtifact(row) : null;
  }

  latestArtifactByName(taskId: string, name: string): Artifact | null {
    const row = this.get(
      'SELECT * FROM artifact WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1',
      taskId, name,
    );
    return row ? mapArtifact(row) : null;
  }

  getArtifactVersion(taskId: string, name: string, version: number): Artifact | null {
    const row = this.get(
      'SELECT * FROM artifact WHERE task_id = ? AND name = ? AND version = ?',
      taskId, name, version,
    );
    return row ? mapArtifact(row) : null;
  }

  listArtifacts(taskId: string): Artifact[] {
    return this.all('SELECT * FROM artifact WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapArtifact);
  }

  // ---------------- wait ----------------

  /** 运行代次：使暂停/取消之前发出的响应失去执行资格。 */
  bumpWorkerEpoch(workerId: string): number {
    this.run('UPDATE worker SET run_epoch = run_epoch + 1 WHERE id = ?', workerId);
    return num(this.get('SELECT run_epoch FROM worker WHERE id = ?', workerId)?.['run_epoch'] ?? 0);
  }

  bumpGroupEpoch(groupId: string): void {
    for (const worker of this.listGroupWorkers(groupId)) this.bumpWorkerEpoch(worker.id);
  }

  setMaintenance(taskId: string, value: boolean): void {
    this.run('UPDATE task SET maintenance = ?, updated_at = ? WHERE id = ?', value ? 1 : 0, nowIso(), taskId);
  }

  // ---------------- Watchdog 会话 / 问题 / 动作 ----------------

  appendWdTurn(turn: { id: string; role: 'user' | 'assistant'; content: string }): void {
    this.run('INSERT INTO wd_turn (id, role, content, created_at) VALUES (?, ?, ?, ?)', turn.id, turn.role, turn.content, nowIso());
  }

  listWdTurns(limit = 20): { role: 'user' | 'assistant'; content: string; createdAt: string }[] {
    const rows = this.all('SELECT * FROM wd_turn ORDER BY created_at DESC LIMIT ?', limit);
    return rows
      .map((row) => ({ role: str(row['role']) as 'user' | 'assistant', content: str(row['content']), createdAt: str(row['created_at']) }))
      .reverse();
  }

  upsertWdIssue(input: {
    id: string;
    taskId: string | null;
    title: string;
    note: string;
    checkAfter: string | null;
  }): void {
    const now = nowIso();
    const existing = this.get('SELECT id, attempts FROM wd_issue WHERE id = ?', input.id);
    if (existing) {
      this.run(
        `UPDATE wd_issue SET title = ?, note = ?, check_after = ?, last_seen = ?, attempts = ? WHERE id = ?`,
        input.title, input.note, input.checkAfter, now, num(existing['attempts']) + 1, input.id,
      );
      return;
    }
    this.run(
      `INSERT INTO wd_issue (id, task_id, title, status, attempts, note, check_after, first_seen, last_seen)
       VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?)`,
      input.id, input.taskId, input.title, input.note, input.checkAfter, now, now,
    );
  }

  listOpenIssues(): { id: string; taskId: string | null; title: string; attempts: number; note: string | null; checkAfter: string | null }[] {
    return this.all("SELECT * FROM wd_issue WHERE status = 'open' ORDER BY last_seen ASC").map((row) => ({
      id: str(row['id']),
      taskId: strOrNull(row['task_id']),
      title: str(row['title']),
      attempts: num(row['attempts']),
      note: strOrNull(row['note']),
      checkAfter: strOrNull(row['check_after']),
    }));
  }

  closeWdIssue(id: string, note: string): void {
    this.run("UPDATE wd_issue SET status = 'closed', note = ?, last_seen = ? WHERE id = ?", note, nowIso(), id);
  }

  appendWdAction(input: { id: string; issueId: string | null; action: string; reason: string; expected: string; result: string }): void {
    this.run(
      `INSERT INTO wd_action (id, issue_id, action, reason, expected, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.issueId, input.action, input.reason, input.expected, input.result, nowIso(),
    );
  }

  listWdActions(limit = 20): { action: string; reason: string; result: string; createdAt: string }[] {
    return this.all('SELECT * FROM wd_action ORDER BY created_at DESC LIMIT ?', limit).map((row) => ({
      action: str(row['action']),
      reason: str(row['reason']),
      result: str(row['result']),
      createdAt: str(row['created_at']),
    }));
  }

  // ---------------- Router 会话续接 / 行为覆盖 / 控制命令 ----------------

  saveRouterSession(session: { id: string; taskId: string | null; messages: unknown; reason: string | null }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO router_session (id, task_id, messages, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, reason = excluded.reason,
         status = 'pending', updated_at = excluded.updated_at`,
      session.id, session.taskId, JSON.stringify(session.messages), session.reason, now, now,
    );
  }

  pendingRouterSession(): { id: string; taskId: string | null; messages: unknown; reason: string | null } | null {
    const row = this.get("SELECT * FROM router_session WHERE status = 'pending' ORDER BY updated_at DESC LIMIT 1");
    if (!row) return null;
    return {
      id: str(row['id']),
      taskId: strOrNull(row['task_id']),
      messages: JSON.parse(str(row['messages'])),
      reason: strOrNull(row['reason']),
    };
  }

  closeRouterSession(id: string, status: 'done' | 'abandoned'): void {
    this.run('UPDATE router_session SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  activeOverride(key: string): { version: number; content: string } | null {
    const row = this.get(
      'SELECT version, content FROM behavior_override WHERE key = ? AND active = 1 ORDER BY version DESC LIMIT 1',
      key,
    );
    return row ? { version: num(row['version']), content: str(row['content']) } : null;
  }

  insertOverride(input: {
    id: string;
    key: string;
    content: string;
    reason: string;
    author: string;
  }): { version: number } {
    const row = this.get('SELECT MAX(version) AS v FROM behavior_override WHERE key = ?', input.key);
    const version = num(row?.['v'] ?? 0) + 1;
    this.run('UPDATE behavior_override SET active = 0 WHERE key = ?', input.key);
    this.run(
      `INSERT INTO behavior_override (id, key, version, content, reason, author, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      input.id, input.key, version, input.content, input.reason, input.author, nowIso(),
    );
    return { version };
  }

  listOverrides(key: string): { version: number; content: string; reason: string; author: string; active: number; createdAt: string }[] {
    return this.all('SELECT * FROM behavior_override WHERE key = ? ORDER BY version DESC', key).map((row) => ({
      version: num(row['version']),
      content: str(row['content']),
      reason: str(row['reason']),
      author: str(row['author']),
      active: num(row['active']),
      createdAt: str(row['created_at']),
    }));
  }

  rollbackOverride(key: string, version: number): boolean {
    const row = this.get('SELECT id FROM behavior_override WHERE key = ? AND version = ?', key, version);
    if (!row) return false;
    this.run('UPDATE behavior_override SET active = 0 WHERE key = ?', key);
    this.run('UPDATE behavior_override SET active = 1 WHERE id = ?', str(row['id']));
    return true;
  }

  insertControlCommand(input: { id: string; command: string; payload: string | null; source: string }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO control_command (id, command, payload, status, result, source, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      input.id, input.command, input.payload, input.source, now, now,
    );
  }

  listPendingControls(limit = 20): { id: string; command: string; payload: string | null; source: string; createdAt: string }[] {
    return this.all("SELECT * FROM control_command WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?", limit).map((row) => ({
      id: str(row['id']),
      command: str(row['command']),
      payload: strOrNull(row['payload']),
      source: str(row['source']),
      createdAt: str(row['created_at']),
    }));
  }

  finishControl(id: string, status: 'done' | 'failed', result: string): void {
    this.run('UPDATE control_command SET status = ?, result = ?, updated_at = ? WHERE id = ?', status, result, nowIso(), id);
  }

  listRecentControls(limit = 20): { id: string; command: string; status: string; result: string | null; createdAt: string }[] {
    return this.all('SELECT * FROM control_command ORDER BY created_at DESC LIMIT ?', limit).map((row) => ({
      id: str(row['id']),
      command: str(row['command']),
      status: str(row['status']),
      result: strOrNull(row['result']),
      createdAt: str(row['created_at']),
    }));
  }

  // ---------------- 进程作业 ----------------

  insertJob(job: ProcessJob): ProcessJob {
    this.run(
      `INSERT INTO process_job (id, task_id, worker_id, command, args_json, cwd, pid, status, exit_code,
                                signal, stdout_path, stderr_path, timeout_ms, started_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id, job.taskId, job.workerId, job.command, JSON.stringify(job.args), job.cwd, job.pid, job.status,
      job.exitCode, job.signal, job.stdoutPath, job.stderrPath, job.timeoutMs, job.startedAt, job.endedAt, job.error,
    );
    return job;
  }

  updateJob(job: ProcessJob): void {
    this.run(
      `UPDATE process_job SET pid = ?, status = ?, exit_code = ?, signal = ?, ended_at = ?, error = ?
       WHERE id = ?`,
      job.pid, job.status, job.exitCode, job.signal, job.endedAt, job.error, job.id,
    );
  }

  getJob(id: string): ProcessJob | null {
    const row = this.get('SELECT * FROM process_job WHERE id = ?', id);
    return row ? mapJob(row) : null;
  }

  listJobs(taskId: string): ProcessJob[] {
    return this.all('SELECT * FROM process_job WHERE task_id = ? ORDER BY started_at ASC', taskId).map(mapJob);
  }

  listRunningJobs(taskId: string): ProcessJob[] {
    return this.all("SELECT * FROM process_job WHERE task_id = ? AND status = 'running'", taskId).map(mapJob);
  }

  listAllRunningJobs(): ProcessJob[] {
    return this.all("SELECT * FROM process_job WHERE status = 'running'").map(mapJob);
  }

  createWait(wait: WaitRecord): WaitRecord {
    this.run(
      `INSERT INTO wait_record (id, worker_id, group_id, reason, match_from, match_reply_to, match_kinds,
                                match_job, deadline_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      wait.id, wait.workerId, wait.groupId, wait.reason, wait.matchFrom, wait.matchReplyTo,
      wait.matchKinds ? JSON.stringify(wait.matchKinds) : null, wait.matchJob ?? null,
      wait.deadlineAt, wait.createdAt, wait.resolvedAt,
    );
    return wait;
  }

  listActiveWaits(): WaitRecord[] {
    return this.all('SELECT * FROM wait_record WHERE resolved_at IS NULL ORDER BY created_at ASC').map(mapWait);
  }

  listActiveWaitsForWorker(workerId: string): WaitRecord[] {
    return this.all(
      'SELECT * FROM wait_record WHERE worker_id = ? AND resolved_at IS NULL ORDER BY created_at ASC',
      workerId,
    ).map(mapWait);
  }

  resolveWait(id: string): void {
    this.run('UPDATE wait_record SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', nowIso(), id);
  }

  clearWaitsForWorker(workerId: string): void {
    this.run('UPDATE wait_record SET resolved_at = ? WHERE worker_id = ? AND resolved_at IS NULL', nowIso(), workerId);
  }

  // ---------------- review ----------------

  createReview(review: Review): Review {
    this.run(
      `INSERT INTO review (id, task_id, artifact_id, artifact_version, artifact_sha256, epoch,
                           requested_by, reviewer_id, request_message_id, reply_message_id,
                           outcome, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id, review.taskId, review.artifactId, review.artifactVersion, review.artifactSha256,
      review.epoch, review.requestedBy, review.reviewerId, review.requestMessageId,
      review.replyMessageId, review.outcome, review.outcome, review.createdAt,
    );
    return review;
  }

  /** 一次检查请求可能覆盖多份产物，必须整批写入。 */
  createReviews(reviews: Review[]): void {
    for (const review of reviews) this.createReview(review);
  }

  listReviewsByRequest(requestMessageId: string): Review[] {
    return this.all('SELECT * FROM review WHERE request_message_id = ?', requestMessageId).map(mapReview);
  }

  getReviewByRequestMessage(messageId: string): Review | null {
    const row = this.get('SELECT * FROM review WHERE request_message_id = ?', messageId);
    return row ? mapReview(row) : null;
  }

  answerReview(requestMessageId: string, replyMessageId: string, reviewerId: string, outcome: ReviewOutcome): void {
    this.run(
      `UPDATE review SET outcome = ?, status = ?, reply_message_id = ?, reviewer_id = ?
        WHERE request_message_id = ? AND outcome = 'pending'`,
      outcome, outcome, replyMessageId, reviewerId, requestMessageId,
    );
  }

  listOpenReviews(taskId: string): Review[] {
    return this.all("SELECT * FROM review WHERE task_id = ? AND outcome = 'pending'", taskId).map(mapReview);
  }

  listReviews(taskId: string): Review[] {
    return this.all('SELECT * FROM review WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapReview);
  }

  countActiveWorkers(): number {
    const row = this.get(
      "SELECT COUNT(*) AS n FROM worker WHERE status NOT IN ('done','failed','cancelled')",
    );
    return row ? num(row['n']) : 0;
  }

  countWorkersInGroup(groupId: string): number {
    const row = this.get('SELECT COUNT(*) AS n FROM worker WHERE group_id = ?', groupId);
    return row ? num(row['n']) : 0;
  }

  bumpReviewEpoch(taskId: string): number {
    this.run('UPDATE task SET review_epoch = review_epoch + 1, updated_at = ? WHERE id = ?', nowIso(), taskId);
    const row = this.get('SELECT review_epoch FROM task WHERE id = ?', taskId);
    return row ? num(row['review_epoch']) : 0;
  }

  // ---------------- turns ----------------

  appendWorkerTurn(turn: WorkerTurn): void {
    this.run(
      `INSERT INTO worker_turn (id, worker_id, seq, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      turn.id, turn.workerId, turn.seq, turn.role, turn.content,
      turn.toolCalls ? JSON.stringify(turn.toolCalls) : null, turn.toolCallId, turn.createdAt,
    );
  }

  listWorkerTurnsBefore(workerId: string, seq: number, limit: number): WorkerTurn[] {
    return this.all(
      'SELECT * FROM worker_turn WHERE worker_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      workerId, seq, limit,
    ).map(mapTurn).reverse();
  }

  /** 全部历史的规模（字符数是估算口径，不是 token）。 */
  workerTurnStats(workerId: string): { turns: number; chars: number } {
    const row = this.get(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(LENGTH(COALESCE(content, ''))), 0) AS c,
              COALESCE(SUM(LENGTH(COALESCE(tool_calls, ''))), 0) AS t
         FROM worker_turn WHERE worker_id = ?`,
      workerId,
    );
    return row ? { turns: num(row['n']), chars: num(row['c']) + num(row['t']) } : { turns: 0, chars: 0 };
  }

  countWorkerTurns(workerId: string): number {
    const row = this.get('SELECT COUNT(*) AS n FROM worker_turn WHERE worker_id = ?', workerId);
    return row ? num(row['n']) : 0;
  }

  listWorkerTurns(workerId: string, limit = 40): WorkerTurn[] {
    const rows = this.all(
      'SELECT * FROM worker_turn WHERE worker_id = ? ORDER BY seq DESC LIMIT ?',
      workerId, limit,
    );
    return rows.map(mapTurn).reverse();
  }

  // ---------------- 工作记录 ----------------

  insertWorkerNote(note: WorkerNote): void {
    this.run(
      `INSERT INTO worker_note
         (id, worker_id, task_id, from_seq, to_seq, covered_seq, epoch, content, source_turns, source_chars, failed, fail_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      note.id, note.workerId, note.taskId, note.fromSeq, note.toSeq, note.coveredSeq,
      note.epoch, note.content, note.sourceTurns, note.sourceChars,
      note.failed ? 1 : 0, note.failReason ?? null, note.createdAt,
    );
  }

  /** 最新一条成功记录；失败记录不参与注入。 */
  latestSuccessfulNote(workerId: string): WorkerNote | null {
    const row = this.get(
      'SELECT * FROM worker_note WHERE worker_id = ? AND failed = 0 ORDER BY created_at DESC LIMIT 1',
      workerId,
    );
    return row ? mapNote(row) : null;
  }

  latestNote(workerId: string): WorkerNote | null {
    const row = this.get('SELECT * FROM worker_note WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1', workerId);
    return row ? mapNote(row) : null;
  }

  listWorkerNotes(workerId: string, limit = 10): WorkerNote[] {
    return this.all(
      'SELECT * FROM worker_note WHERE worker_id = ? ORDER BY created_at DESC LIMIT ?',
      workerId, limit,
    ).map(mapNote);
  }

  /** 最近连续失败次数（遇到一条成功即停止）。 */
  consecutiveNoteFailures(workerId: string): number {
    const rows = this.all(
      'SELECT failed FROM worker_note WHERE worker_id = ? ORDER BY created_at DESC LIMIT 10',
      workerId,
    );
    let count = 0;
    for (const row of rows) {
      if (num(row['failed']) === 1) count += 1;
      else break;
    }
    return count;
  }

  searchWorkerTurns(
    workerId: string,
    options: { fromSeq: number; toSeq: number; role: string | null; limit: number },
  ): WorkerTurn[] {
    const params: (string | number)[] = [workerId, options.fromSeq, options.toSeq];
    let sql =
      'SELECT * FROM worker_turn WHERE worker_id = ? AND seq >= ? AND seq <= ?';
    if (options.role) {
      sql += ' AND role = ?';
      params.push(options.role);
    }
    sql += ' ORDER BY seq DESC LIMIT ?';
    params.push(options.limit);
    return this.all(sql, ...params).map(mapTurn).reverse();
  }

  listWorkerTurnsRange(workerId: string, fromSeq: number, toSeq: number): WorkerTurn[] {
    return this.all(
      'SELECT * FROM worker_turn WHERE worker_id = ? AND seq >= ? AND seq <= ? ORDER BY seq',
      workerId, fromSeq, toSeq,
    ).map(mapTurn);
  }

  appendRouterTurn(turn: RouterTurn): void {
    this.run(
      'INSERT INTO router_turn (id, role, content, created_at) VALUES (?, ?, ?, ?)',
      turn.id, turn.role, turn.content, turn.createdAt,
    );
  }

  listRouterTurns(limit = 30): RouterTurn[] {
    const rows = this.all('SELECT * FROM router_turn ORDER BY created_at DESC LIMIT ?', limit);
    return rows
      .map((row) => ({
        id: str(row['id']),
        role: str(row['role']) as RouterTurn['role'],
        content: str(row['content']),
        createdAt: str(row['created_at']),
      }))
      .reverse();
  }

  // ---------------- events ----------------

  appendEvent(taskId: string | null, workerId: string | null, type: string, detail?: string): void {
    this.run(
      'INSERT INTO event (id, task_id, worker_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newEventId(), taskId, workerId, type, detail ?? null, nowIso(),
    );
  }

  listEvents(taskId: string, limit = 200): EventRecord[] {
    return this.all(
      'SELECT * FROM event WHERE task_id = ? ORDER BY created_at ASC LIMIT ?',
      taskId, limit,
    ).map((row) => ({
      id: str(row['id']),
      taskId: strOrNull(row['task_id']),
      workerId: strOrNull(row['worker_id']),
      type: str(row['type']),
      detail: strOrNull(row['detail']),
      createdAt: str(row['created_at']),
    }));
  }

  newWaitId(): string {
    return newWaitId();
  }

  newReviewId(): string {
    return newReviewId();
  }
}
