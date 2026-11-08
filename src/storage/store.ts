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
  Review,
  ReviewStatus,
  RouterTurn,
  Task,
  TaskStatus,
  WaitRecord,
  Worker,
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

function mapWait(row: Row): WaitRecord {
  const kinds = strOrNull(row['match_kinds']);
  return {
    id: str(row['id']),
    workerId: str(row['worker_id']),
    groupId: str(row['group_id']),
    matchFrom: strOrNull(row['match_from']),
    matchReplyTo: strOrNull(row['match_reply_to']),
    matchKinds: kinds ? (JSON.parse(kinds) as MessageKind[]) : null,
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
    requestedBy: str(row['requested_by']),
    reviewerId: strOrNull(row['reviewer_id']),
    requestMessageId: str(row['request_message_id']),
    replyMessageId: strOrNull(row['reply_message_id']),
    status: str(row['status']) as ReviewStatus,
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
    // 兼容模块 1 早期版本留下的数据库文件。
    const columns = this.db.prepare('PRAGMA table_info(message)').all() as { name?: string }[];
    if (!columns.some((column) => column.name === 'dedupe_key')) {
      this.db.exec('ALTER TABLE message ADD COLUMN dedupe_key TEXT');
    }
  }

  close(): void {
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
                            payload, reply_to, refs, dedupe_key, status, created_at, delivered_at, consumed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id, message.groupId, message.taskId, message.fromKind, message.fromId, message.toKind,
      message.toId, message.kind, message.body,
      message.payload ? JSON.stringify(message.payload) : null,
      message.replyTo,
      message.refs ? JSON.stringify(message.refs) : null,
      message.dedupeKey,
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

  listArtifacts(taskId: string): Artifact[] {
    return this.all('SELECT * FROM artifact WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapArtifact);
  }

  // ---------------- wait ----------------

  createWait(wait: WaitRecord): WaitRecord {
    this.run(
      `INSERT INTO wait_record (id, worker_id, group_id, match_from, match_reply_to, match_kinds,
                                deadline_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      wait.id, wait.workerId, wait.groupId, wait.matchFrom, wait.matchReplyTo,
      wait.matchKinds ? JSON.stringify(wait.matchKinds) : null,
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
      `INSERT INTO review (id, task_id, artifact_id, artifact_version, requested_by, reviewer_id,
                           request_message_id, reply_message_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id, review.taskId, review.artifactId, review.artifactVersion, review.requestedBy,
      review.reviewerId, review.requestMessageId, review.replyMessageId, review.status, review.createdAt,
    );
    return review;
  }

  getReviewByRequestMessage(messageId: string): Review | null {
    const row = this.get('SELECT * FROM review WHERE request_message_id = ?', messageId);
    return row ? mapReview(row) : null;
  }

  answerReview(requestMessageId: string, replyMessageId: string): void {
    this.run(
      "UPDATE review SET status = 'answered', reply_message_id = ? WHERE request_message_id = ?",
      replyMessageId, requestMessageId,
    );
  }

  listOpenReviews(taskId: string): Review[] {
    return this.all("SELECT * FROM review WHERE task_id = ? AND status = 'pending'", taskId).map(mapReview);
  }

  listReviews(taskId: string): Review[] {
    return this.all('SELECT * FROM review WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapReview);
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
