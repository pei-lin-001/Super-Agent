import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionRevoked, isRevoked, revocationReason } from '../runtime/execution.ts';
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
  Workspace,
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

/** router_turn 行 → 结构体；只暴露给模型需要的字段。 */
function toWorkspace(row: Row): Workspace {
  return {
    id: str(row['id']),
    title: str(row['title']),
    brief: str(row['brief']),
    sessionKey: strOrNull(row['session_key']),
    conversationId: strOrNull(row['conversation_id']),
    status: str(row['status']) as Workspace['status'],
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    lastActiveAt: strOrNull(row['last_active_at']),
  };
}

function toRouterTurn(row: Record<string, unknown>): RouterTurn {
  return {
    id: str(row['id']),
    role: str(row['role']) as RouterTurn['role'],
    content: str(row['content']),
    createdAt: str(row['created_at']),
  };
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
    workspaceId: strOrNull(row['workspace_id']) ?? str(row['group_id']),
    title: str(row['title']),
    goal: str(row['goal']),
    brief: str(row['brief']),
    doneCriteria: str(row['done_criteria']),
    requireReview: num(row['require_review']) === 1,
    reviewEpoch: num(row['review_epoch'] ?? 0),
    maintenance: num(row['maintenance'] ?? 0),
    ownerWorkerId: strOrNull(row['owner_worker_id']),
    sourceChannel: strOrNull(row['source_channel'] ?? null),
    sourceAccountId: strOrNull(row['source_account_id'] ?? null),
    sourcePeerId: strOrNull(row['source_peer_id'] ?? null),
    sourceSessionKey: strOrNull(row['source_session_key'] ?? null),
    sourceConversationId: strOrNull(row['source_conversation_id'] ?? null),
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
    workspaceId: strOrNull(row['workspace_id']) ?? str(row['group_id']),
    currentTaskId: strOrNull(row['current_task_id']),
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
    scope: row['scope'] === null || row['scope'] === undefined ? 'biz' : str(row['scope']),
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
    isError: row['is_error'] === null || row['is_error'] === undefined ? null : num(row['is_error']) === 1,
    createdAt: str(row['created_at']),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, options: { instanceId?: string } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.instanceId = options.instanceId ?? `local_${process.pid}_${Date.now()}`;
    this.db = new DatabaseSync(path);
    // 多进程同时访问同一个库（主系统 + 维护者 + 命令行客户端）：
    // WAL 让读写不互相阻塞，busy_timeout 让短时的写冲突自动重试而不是直接失败。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
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
    ensureColumn('task', 'source_channel', 'source_channel TEXT');
    ensureColumn('task', 'source_account_id', 'source_account_id TEXT');
    ensureColumn('task', 'source_peer_id', 'source_peer_id TEXT');
    ensureColumn('task', 'source_session_key', 'source_session_key TEXT');
    ensureColumn('channel_inbound', 'silent', 'silent INTEGER NOT NULL DEFAULT 0');
    // 入站消息的话题归属：附件认领、材料补充都按它筛选，不再临时读"当前话题指针"。
    ensureColumn('channel_inbound', 'conversation_id', 'conversation_id TEXT');
    ensureColumn('channel_outbound', 'next_attempt_at', 'next_attempt_at TEXT');
    // 工具结果是否失败：历史回放要靠它区分「失败」和「成功但没输出」。
    ensureColumn('worker_turn', 'is_error', 'is_error INTEGER');
    ensureColumn('router_turn', 'session_key', 'session_key TEXT');
    ensureColumn('router_session', 'session_key', 'session_key TEXT');
    // 话题归属：老记录为 NULL，按"本聊天任何话题都可见"处理（见 router 的 visibleTo）。
    ensureColumn('channel_session', 'current_conversation_id', 'current_conversation_id TEXT');
    ensureColumn('router_turn', 'conversation_id', 'conversation_id TEXT');
    // 稳定水位线：router_turn 原来只有 created_at，同一毫秒的多条无法确定先后。
    ensureColumn('router_turn', 'seq', 'seq INTEGER');
    // 老记录按 (created_at, rowid) 回填序号，只在缺失时补，可重复执行。
    this.db.exec(`
      UPDATE router_turn
         SET seq = (
           SELECT COUNT(*) FROM router_turn r2
            WHERE (r2.created_at < router_turn.created_at)
               OR (r2.created_at = router_turn.created_at AND r2.rowid <= router_turn.rowid)
         )
       WHERE seq IS NULL
    `);
    ensureColumn('router_session', 'conversation_id', 'conversation_id TEXT');
    ensureColumn('task', 'source_conversation_id', 'source_conversation_id TEXT');
    // 任务与成员都挂到 workspace 上。迁移期沿用 group_id 作为 workspace id，
    // 所以这里不再加新列：语义变了，值不变。
    ensureColumn('worker', 'current_task_id', 'current_task_id TEXT');
    ensureColumn('worker', 'workspace_id', 'workspace_id TEXT');
    ensureColumn('task', 'workspace_id', 'workspace_id TEXT');
    // 回填：老任务的 group_id 就是它当初的 workspace id，一对一，直接抄。
    this.db.exec("UPDATE task SET workspace_id = group_id WHERE workspace_id IS NULL");
    this.db.exec("UPDATE worker SET workspace_id = group_id WHERE workspace_id IS NULL");
    this.db.exec(`
      INSERT INTO workspace (id, title, brief, session_key, conversation_id, status, created_at, updated_at, last_active_at)
      SELECT t.group_id, t.title, t.brief, t.source_session_key, t.source_conversation_id,
             CASE WHEN t.status IN ('completed','cancelled','failed') THEN 'active' ELSE 'active' END,
             t.created_at, t.updated_at, t.updated_at
        FROM task t
       WHERE NOT EXISTS (SELECT 1 FROM workspace w WHERE w.id = t.group_id)
    `);
    // 成员的当前任务：取它所在组里最早的活跃任务，没有就为空（休眠）。
    this.db.exec(`
      UPDATE worker
         SET current_task_id = (
           SELECT t.id FROM task t
            WHERE t.group_id = worker.group_id
              AND t.status NOT IN ('completed','cancelled','failed')
            ORDER BY t.created_at ASC LIMIT 1
         )
       WHERE current_task_id IS NULL
    `);
    // 索引必须建在补列之后：老库里这两列还不存在，先建索引会直接报 no such column。
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_router_turn_session ON router_turn(session_key, created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_router_session_key ON router_session(session_key, status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_router_turn_conversation ON router_turn(conversation_id, created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_router_session_conversation ON router_session(conversation_id, status)');
    // 话题上线前的历史收进该会话最早的话题：否则升级后按话题查历史什么都看不到。
    // 只在会话已经有话题时收，且只收 conversation_id 为空的行，可重复执行。
    this.db.exec(`
      UPDATE router_turn
         SET conversation_id = (
           SELECT c.id FROM conversation c
            WHERE c.session_key = router_turn.session_key
            ORDER BY c.created_at ASC, c.rowid ASC LIMIT 1
         )
       WHERE conversation_id IS NULL
         AND session_key IS NOT NULL
         AND EXISTS (SELECT 1 FROM conversation c2 WHERE c2.session_key = router_turn.session_key)
    `);
    // 入站记录同理：老附件的归属收进该会话最早的话题，避免"文件在哪个话题里"说不清。
    this.db.exec(`
      UPDATE channel_inbound
         SET conversation_id = (
           SELECT c.id FROM conversation c
            WHERE c.session_key = channel_inbound.session_key
            ORDER BY c.created_at ASC, c.rowid ASC LIMIT 1
         )
       WHERE conversation_id IS NULL
         AND EXISTS (SELECT 1 FROM conversation c2 WHERE c2.session_key = channel_inbound.session_key)
    `);
    ensureColumn('wd_action', 'command_id', 'command_id TEXT');
    ensureColumn('model_call', 'instance_id', 'instance_id TEXT');
    ensureColumn('model_call', 'model_alias', 'model_alias TEXT');
    ensureColumn('model_call', 'response_model', 'response_model TEXT');
    // 旧库补列：缓存命中数之前没记，账本比真实消耗小一个数量级。
    ensureColumn('model_call', 'cached_tokens', 'cached_tokens INTEGER');
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
    this.closed = true;
    if (!this.db.isOpen) return;
    this.db.close();
  }

  /**
   * 统一的存储可用性检查。
   *
   * 这里同时挡住两件事：数据库已经关闭；当前执行过程已经被撤销。
   * 放在最底层的 SQL 入口，是为了让异常分支、finally、迟到回调也走同一条边界，
   * 而不是靠每个调用点各自记得检查。
   */
  private assertUsable(): void {
    if (this.closed) throw new ExecutionRevoked('存储已关闭，拒绝访问');
    if (isRevoked()) throw new ExecutionRevoked(revocationReason() ?? undefined);
  }

  tx<T>(fn: () => T): T {
    this.assertUsable();
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
    this.assertUsable();
    return this.db.prepare(sql).all(...(params.map(bind) as never[])) as Row[];
  }

  private get(sql: string, ...params: unknown[]): Row | undefined {
    this.assertUsable();
    return this.db.prepare(sql).get(...(params.map(bind) as never[])) as Row | undefined;
  }

  private run(sql: string, ...params: unknown[]): void {
    this.assertUsable();
    this.db.prepare(sql).run(...(params.map(bind) as never[]));
  }

  // ---------------- workspace ----------------

  createWorkspace(input: {
    id: string;
    title: string;
    brief?: string;
    sessionKey?: string | null;
    conversationId?: string | null;
  }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO workspace (id, title, brief, session_key, conversation_id, status, created_at, updated_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      input.id, input.title, input.brief ?? '', input.sessionKey ?? null, input.conversationId ?? null,
      now, now, now,
    );
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.get('SELECT * FROM workspace WHERE id = ?', id);
    return row ? toWorkspace(row) : null;
  }

  /** 列表默认只给活跃的：归档的不该占据 Router 的表单。 */
  listWorkspaces(options: { status?: 'active' | 'archived'; limit?: number } = {}): Workspace[] {
    const status = options.status ?? 'active';
    return this.all(
      'SELECT * FROM workspace WHERE status = ? ORDER BY COALESCE(last_active_at, updated_at) DESC LIMIT ?',
      status, options.limit ?? 50,
    ).map(toWorkspace);
  }

  /**
   * 某个会话可见的工作空间。
   *
   * 三种情况分开写，因为 SQL 里 `= NULL` 永远不成立，混在一个条件里会漏。
   * 归属在创建时固化：别的会话引用过的空间不会跑到这里来。
   */
  listWorkspacesForConversation(sessionKey: string | null, conversationId: string | null): Workspace[] {
    const order = 'ORDER BY COALESCE(last_active_at, updated_at) DESC LIMIT 50';
    if (sessionKey === null) {
      return this.all(
        `SELECT * FROM workspace WHERE status = 'active' AND session_key IS NULL ${order}`,
      ).map(toWorkspace);
    }
    // 没有话题上下文（例如「某个任务完成了」的通知轮）时，退回会话级全貌：
    // 这时不是"在某个话题里提问"，而是要在整个会话里找产物属于谁。
    const rows = conversationId === null
      ? this.all(
          `SELECT * FROM workspace WHERE status = 'active' AND session_key = ? ${order}`,
          sessionKey,
        )
      : this.all(
          `SELECT * FROM workspace WHERE status = 'active' AND session_key = ?
             AND (conversation_id = ? OR conversation_id IS NULL) ${order}`,
          sessionKey, conversationId,
        );
    return rows.map(toWorkspace);
  }

  touchWorkspace(id: string): void {
    const now = nowIso();
    this.run('UPDATE workspace SET last_active_at = ?, updated_at = ? WHERE id = ?', now, now, id);
  }

  setWorkspaceStatus(id: string, status: 'active' | 'archived'): void {
    this.run('UPDATE workspace SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  // ---------------- task ----------------

  createTask(task: Task): Task {
    this.run(
      `INSERT INTO task (id, group_id, workspace_id, title, goal, brief, done_criteria, require_review,
                         owner_worker_id, source_channel, source_account_id, source_peer_id,
                         source_session_key, source_conversation_id, status, close_reason,
                         created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.groupId, task.workspaceId ?? task.groupId, task.title, task.goal, task.brief, task.doneCriteria,
      task.requireReview ? 1 : 0,
      task.ownerWorkerId, task.sourceChannel ?? null, task.sourceAccountId ?? null,
      task.sourcePeerId ?? null, task.sourceSessionKey ?? null, task.sourceConversationId ?? null,
      task.status, task.closeReason, task.createdAt, task.updatedAt, task.closedAt,
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

  /**
   * 这个工作空间里最近的一条任务。
   *
   * 和 getTaskByGroup 的区别：那个只给一条（同组可能已经有多条任务），
   * 这个按时间倒序取最新——任务完成后成员会休眠、currentTaskId 归空，
   * Router 仍然要能看到「最近做完的是哪件事」，否则它连产物属于哪个任务都不知道。
   */
  latestTaskForWorkspace(workspaceId: string): Task | null {
    const row = this.get('SELECT * FROM task WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1', workspaceId);
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
      `INSERT INTO worker (id, group_id, workspace_id, current_task_id, parent_id, role, brief, status, model, step_count, created_at, updated_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      worker.id, worker.groupId, worker.workspaceId ?? worker.groupId, worker.currentTaskId ?? null,
      worker.parentId, worker.role, worker.brief, worker.status,
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

  /**
   * 数据库里排队中的业务 Worker（可能由另一个进程创建，需要本进程接管调度）。
   * 维护挂起的是任务（task.maintenance），不是 Worker 自己的字段。
   */
  listQueuedWorkers(): Worker[] {
    return this.all(
      `SELECT w.* FROM worker w
         LEFT JOIN task t ON t.id = w.group_id
        WHERE w.status = 'queued' AND COALESCE(t.maintenance, 0) = 0
        ORDER BY w.created_at ASC`,
    ).map(mapWorker);
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

  updateWorkerBrief(id: string, brief: string): void {
    this.run('UPDATE worker SET brief = ?, updated_at = ? WHERE id = ?', brief, nowIso(), id);
  }

  /** 成员在为哪个任务干活；null 表示休眠。 */
  setWorkerCurrentTask(id: string, taskId: string | null): void {
    this.run('UPDATE worker SET current_task_id = ?, updated_at = ? WHERE id = ?', taskId, nowIso(), id);
  }

  /** 某个空间下可以叫醒的成员（休眠且没有在服务的任务）。 */
  listDormantWorkers(workspaceId: string): Worker[] {
    return this.all(
      "SELECT * FROM worker WHERE group_id = ? AND status = 'dormant' ORDER BY updated_at DESC",
      workspaceId,
    ).map(mapWorker);
  }

  listAllDormantWorkers(): Worker[] {
    return this.all("SELECT * FROM worker WHERE status = 'dormant'").map(mapWorker);
  }

  countDormantWorkers(): number {
    const row = this.get("SELECT COUNT(*) AS n FROM worker WHERE status = 'dormant'");
    return Number((row as { n?: unknown } | undefined)?.n ?? 0);
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
  /**
   * Router 收件箱。
   *
   * 传 sessionKey 时只返回来源是该会话的任务消息：多条聊天交错时，
   * 一次汇报不能把别的聊天的材料混进来。传 null 返回 CLI 与无来源任务的消息。
   */
  /**
   * 待交给 Router 的 Worker 消息。
   *
   * 传了话题就按话题过滤：别的任务的话题不该出现在这个会话的收件箱里。
   * 老任务没有话题归属（source_conversation_id 为 NULL），仍在本聊天各话题可见。
   */
  listRouterInbox(sessionKey: string | null = null, conversationId: string | null = null): Message[] {
    if (sessionKey === null) {
      return this.all(
        `SELECT m.* FROM message m
         LEFT JOIN task t ON t.id = m.task_id
         WHERE m.to_kind = 'router' AND m.status IN ('queued','delivered')
           AND (m.task_id IS NULL OR t.source_session_key IS NULL)
         ORDER BY m.created_at ASC`,
      ).map(mapMessage);
    }
    if (conversationId !== null) {
      return this.all(
        `SELECT m.* FROM message m
         JOIN task t ON t.id = m.task_id
         WHERE m.to_kind = 'router' AND m.status IN ('queued','delivered')
           AND t.source_session_key = ?
           AND (t.source_conversation_id = ? OR t.source_conversation_id IS NULL)
         ORDER BY m.created_at ASC`,
        sessionKey, conversationId,
      ).map(mapMessage);
    }
    return this.all(
      `SELECT m.* FROM message m
       JOIN task t ON t.id = m.task_id
       WHERE m.to_kind = 'router' AND m.status IN ('queued','delivered')
         AND t.source_session_key = ?
       ORDER BY m.created_at ASC`,
      sessionKey,
    ).map(mapMessage);
  }

  /**
   * 收件箱里涉及的（会话键, 话题）组合，按它分组汇报。
   *
   * 只按会话键分组会把两个话题的材料混进同一次汇报；只按话题分组又会丢
   * CLI 会话（话题为 null）的消息。
   */
  routerInboxTargets(): { sessionKey: string | null; conversationId: string | null }[] {
    const rows = this.all(
      `SELECT DISTINCT t.source_session_key AS k, t.source_conversation_id AS c FROM message m
       LEFT JOIN task t ON t.id = m.task_id
       WHERE m.to_kind = 'router' AND m.status IN ('queued','delivered')`,
    );
    return rows.map((row) => ({
      sessionKey: strOrNull(row['k']),
      conversationId: strOrNull(row['c']),
    }));
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

  private closed = false;
  readonly path: string;
  /** 本进程的实例标识：用来区分"谁发起的调用"，重启后不会重复。 */
  readonly instanceId: string;

  get isClosed(): boolean {
    return this.closed;
  }

  setMaintenance(taskId: string, value: boolean): void {
    this.run('UPDATE task SET maintenance = ?, updated_at = ? WHERE id = ?', value ? 1 : 0, nowIso(), taskId);
  }

  // ---------------- Watchdog 会话 / 问题 / 动作 ----------------

  appendWdTurn(turn: {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    /** 测试与导入场景可以指定时间；正常调用用当前时间。 */
    createdAt?: string;
  }): void {
    this.run(
      'INSERT INTO wd_turn (id, role, content, created_at) VALUES (?, ?, ?, ?)',
      turn.id,
      turn.role,
      turn.content,
      turn.createdAt ?? nowIso(),
    );
  }

  /**
   * 真正的对话轮次（只有 user / assistant）。
   * 调查日志里的工具记录不在这里：它们没有调用标识，不能当正式 tool 消息重发。
   */
  /** 水位线之后的维护对话（摘要已覆盖的部分不重复取）。 */
  listWdDialogueSince(afterRow: number, limit = 400): { row: number; id: string; role: 'user' | 'assistant'; content: string }[] {
    return this.all(
      `SELECT rowid AS rid, id, role, content FROM wd_turn WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
      afterRow, limit,
    ).map((row) => ({
      row: Number((row as { rid?: unknown }).rid ?? 0),
      id: str((row as { id?: unknown }).id),
      role: str((row as { role?: unknown }).role) as 'user' | 'assistant',
      content: str((row as { content?: unknown }).content),
    }));
  }

  latestWatchdogNote(): { content: string; coveredRow: number } | null {
    const row = this.get('SELECT content, covered_row FROM wd_note ORDER BY created_at DESC, rowid DESC LIMIT 1');
    if (!row) return null;
    return {
      content: str((row as { content?: unknown }).content),
      coveredRow: Number((row as { covered_row?: unknown }).covered_row ?? 0),
    };
  }

  insertWatchdogNote(input: {
    id: string;
    fromRow: number;
    toRow: number;
    coveredRow: number;
    content: string;
    sourceTurns: number;
    sourceChars: number;
  }): void {
    this.run(
      `INSERT INTO wd_note (id, from_row, to_row, covered_row, content, source_turns, source_chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.fromRow, input.toRow, input.coveredRow, input.content,
      input.sourceTurns, input.sourceChars, nowIso(),
    );
  }

  listWdDialogue(limit = 10): { id: string; role: 'user' | 'assistant'; content: string }[] {
    // 先取最近的若干条，再按时间正序返回：直接正序 + LIMIT 拿到的是最早的历史，
    // 问答超过十组之后，新内容永远进不了下一次请求。
    // 同时间的记录用 rowid 保证稳定次序。
    const rows = this.all(
      `SELECT id, role, content FROM (
         SELECT id, role, content, created_at, rowid AS rid
         FROM wd_turn WHERE role IN ('user','assistant')
         ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, rid ASC`,
      limit,
    );
    return rows.map((row) => ({
      id: str(row['id']),
      role: str(row['role']) as 'user' | 'assistant',
      content: str(row['content']),
    }));
  }

  /** 调查日志（含工具记录），只用于给人看或作为文字背景。 */
  listWdToolLog(limit = 12): { tool: string; summary: string }[] {
    return this.all(
      "SELECT content FROM wd_turn WHERE role = 'tool' ORDER BY created_at DESC, rowid DESC LIMIT ?",
      limit,
    ).map((row) => {
      const text = str(row['content']);
      const index = text.indexOf(': ');
      return index > 0 ? { tool: text.slice(0, index), summary: text.slice(index + 2) } : { tool: '', summary: text };
    });
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

  appendWdAction(input: {
    id: string;
    issueId: string | null;
    commandId?: string | null;
    action: string;
    reason: string;
    expected: string;
    result: string;
  }): void {
    this.run(
      `INSERT INTO wd_action (id, issue_id, command_id, action, reason, expected, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.issueId,
      input.commandId ?? null,
      input.action,
      input.reason,
      input.expected,
      input.result,
      nowIso(),
    );
  }

  insertWdQuestion(id: string, question: string): void {
    this.run(`INSERT INTO wd_question (id, question, status, asked_at) VALUES (?, ?, 'pending', ?)`, id, question, nowIso());
  }

  nextPendingQuestion(): { id: string; question: string } | null {
    const row = this.get(`SELECT id, question FROM wd_question WHERE status = 'pending' ORDER BY asked_at ASC LIMIT 1`);
    return row ? { id: str(row['id']), question: str(row['question']) } : null;
  }

  finishWdQuestion(id: string, answer: string | null, error: string | null): void {
    this.run(
      `UPDATE wd_question SET status = ?, answer = ?, error = ?, answered_at = ? WHERE id = ?`,
      error ? 'failed' : 'done', answer, error, nowIso(), id,
    );
  }

  getWdQuestion(id: string): { id: string; question: string; status: string; answer: string | null; error: string | null } | null {
    const row = this.get('SELECT * FROM wd_question WHERE id = ?', id);
    if (!row) return null;
    return {
      id: str(row['id']),
      question: str(row['question']),
      status: str(row['status']),
      answer: strOrNull(row['answer']),
      error: strOrNull(row['error']),
    };
  }

  listWdActions(limit = 20): {
    id: string;
    issueId: string | null;
    commandId: string | null;
    action: string;
    reason: string;
    result: string;
    createdAt: string;
  }[] {
    return this.all('SELECT * FROM wd_action ORDER BY created_at DESC LIMIT ?', limit).map((row) => ({
      id: str(row['id']),
      issueId: strOrNull(row['issue_id']),
      commandId: strOrNull(row['command_id']),
      action: str(row['action']),
      reason: str(row['reason']),
      result: str(row['result']),
      createdAt: str(row['created_at']),
    }));
  }

  // ---------------- Router 会话续接 / 行为覆盖 / 控制命令 ----------------

  saveRouterSession(session: {
    id: string;
    taskId: string | null;
    messages: unknown;
    reason: string | null;
    /** 来源会话；为空表示 CLI。同一会话的多条待续接互不覆盖。 */
    sessionKey?: string | null;
    /** 话题归属：同一聊天里的不同话题各自续接，互不覆盖。 */
    conversationId?: string | null;
    /**
     * running = 正在跑（不可续接）；pending = 中断待续接。
     *
     * 运行中的会话也会落库（崩溃后才有续接入口），但绝不能当成"待续接"，
     * 否则定时恢复会把它再跑一遍，用户就收到重复回复。
     */
    status?: 'running' | 'pending';
  }): void {
    const now = nowIso();
    const status = session.status ?? 'pending';
    this.run(
      `INSERT INTO router_session (id, session_key, conversation_id, task_id, messages, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, reason = excluded.reason,
         session_key = excluded.session_key, conversation_id = excluded.conversation_id,
         status = excluded.status, updated_at = excluded.updated_at`,
      session.id, session.sessionKey ?? null, session.conversationId ?? null, session.taskId,
      JSON.stringify(session.messages), session.reason, status, now, now,
    );
  }

  /**
   * 取指定会话的待续接过程。
   *
   * 传 null 表示 CLI 会话。不能只挑全库最后一条：多个聊天各自用完额度后，
   * 每条会话都要能恢复。
   */
  pendingRouterSession(sessionKey: string | null = null, conversationId: string | null = null): {
    id: string;
    taskId: string | null;
    messages: unknown;
    reason: string | null;
    sessionKey: string | null;
    conversationId: string | null;
  } | null {
    const row =
      conversationId !== null
        ? this.get(
            "SELECT * FROM router_session WHERE status = 'pending' AND conversation_id = ? ORDER BY updated_at DESC LIMIT 1",
            conversationId,
          )
        : sessionKey === null
        ? this.get(
            "SELECT * FROM router_session WHERE status = 'pending' AND session_key IS NULL ORDER BY updated_at DESC LIMIT 1",
          )
        : this.get(
            "SELECT * FROM router_session WHERE status = 'pending' AND session_key = ? ORDER BY updated_at DESC LIMIT 1",
            sessionKey,
          );
    if (!row) return null;
    return {
      id: str(row['id']),
      taskId: strOrNull(row['task_id']),
      messages: JSON.parse(str(row['messages'])),
      reason: strOrNull(row['reason']),
      sessionKey: strOrNull(row['session_key']),
      conversationId: strOrNull(row['conversation_id']),
    };
  }

  /** 仍待续接的会话键（去重）。话题内的续接请用 pendingRouterSessions。 */
  pendingRouterSessionKeys(): (string | null)[] {
    return [...new Set(this.pendingRouterSessions().map((item) => item.sessionKey))];
  }

  /** 仍待续接的会话（去重），用于重启后逐会话、逐话题恢复。 */
  pendingRouterSessions(): { sessionKey: string | null; conversationId: string | null }[] {
    const rows = this.all(
      "SELECT DISTINCT session_key, conversation_id FROM router_session WHERE status = 'pending'",
    );
    return rows.map((row) => ({
      sessionKey: strOrNull(row['session_key']),
      conversationId: strOrNull(row['conversation_id']),
    }));
  }

  /**
   * 把上一个进程遗留的 running 会话收回成 pending。
   *
   * 只在启动时调用一次：同一时刻只有本进程在跑，所以 running 一定属于已退出的进程。
   */
  resumeStaleRouterSessions(): number {
    const rows = this.all("SELECT id FROM router_session WHERE status = 'running'");
    if (rows.length > 0) {
      this.run("UPDATE router_session SET status = 'pending', updated_at = ? WHERE status = 'running'", nowIso());
    }
    return rows.length;
  }

  /** 只改话题归属：话题在轮内切换时用，不动消息内容与状态。 */
  setRouterSessionConversation(id: string, conversationId: string | null): void {
    this.run(
      'UPDATE router_session SET conversation_id = ?, updated_at = ? WHERE id = ?',
      conversationId, nowIso(), id,
    );
  }

  closeRouterSession(id: string, status: 'done' | 'abandoned'): void {
    this.run('UPDATE router_session SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  startModelCall(input: {
    id: string;
    purpose: 'router' | 'worker' | 'note' | 'router-note' | 'watchdog' | 'context';
    model: string;
    taskId?: string | null;
    workerId?: string | null;
    sessionId?: string | null;
    /** Worker 选择的模型别名；为空表示按默认别名执行。 */
    modelAlias?: string | null;
  }): void {
    this.run(
      `INSERT INTO model_call (id, instance_id, purpose, task_id, worker_id, session_id, model, model_alias, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      input.id,
      this.instanceId,
      input.purpose,
      input.taskId ?? null,
      input.workerId ?? null,
      input.sessionId ?? null,
      input.model,
      input.modelAlias ?? null,
      nowIso(),
    );
  }

  finishModelCall(input: {
    id: string;
    status: 'ok' | 'failed' | 'cancelled' | 'interrupted';
    usage?: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    } | null;
    httpAttempts?: number | null;
    error?: string | null;
    /** 提供方实际返回的模型标识，与请求的模型分开保存。 */
    responseModel?: string | null;
  }): void {
    // usage 缺失记为未知（usage_known=0），不填 0；提供方明确返回的 0 会保留。
    const known = input.usage ? 1 : 0;
    this.run(
      `UPDATE model_call SET status = ?, prompt_tokens = ?, completion_tokens = ?, cached_tokens = ?,
         usage_known = ?, http_attempts = ?, error = ?, response_model = ?, ended_at = ? WHERE id = ?`,
      input.status,
      input.usage?.promptTokens ?? null,
      input.usage?.completionTokens ?? null,
      input.usage?.cacheReadTokens ?? null,
      known,
      input.httpAttempts ?? null,
      input.error ?? null,
      input.responseModel ?? null,
      nowIso(),
      input.id,
    );
  }

  listModelCalls(
    limit = 50,
  ): {
    id: string;
    purpose: string;
    status: string;
    error: string | null;
    model: string | null;
    modelAlias: string | null;
    responseModel: string | null;
    workerId: string | null;
    taskId: string | null;
    httpAttempts: number | null;
  }[] {
    return this.all(
      `SELECT id, purpose, status, error, model, model_alias, response_model, worker_id, task_id, http_attempts
       FROM model_call ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      limit,
    ).map((row) => ({
      id: str(row['id']),
      purpose: str(row['purpose']),
      status: str(row['status']),
      error: strOrNull(row['error']),
      model: strOrNull(row['model']),
      modelAlias: strOrNull(row['model_alias']),
      responseModel: strOrNull(row['response_model']),
      workerId: strOrNull(row['worker_id']),
      taskId: strOrNull(row['task_id']),
      httpAttempts: row['http_attempts'] === null ? null : Number(row['http_attempts']),
    }));
  }

  /**
   * 收敛已退出实例留下的 running 记录。
   *
   * 只处理"确认已经不在运行"的实例：
   * - 没有实例标识的历史记录保持 running，如实表示归属未知；
   * - 存活实例的调用一律不动；
   * - 无法确认身份的实例也不动，宁可留一条可疑记录，也不能误伤正在跑的调用。
   */
  recoverModelCalls(isAlive: (instanceId: string) => boolean): { interrupted: number; kept: number } {
    const rows = this.all("SELECT id, instance_id FROM model_call WHERE status = 'running'") as Row[];
    let interrupted = 0;
    let kept = 0;
    for (const row of rows) {
      const owner = strOrNull(row['instance_id']);
      if (owner === null || owner === this.instanceId) {
        kept += 1;
        continue;
      }
      if (isAlive(owner)) {
        kept += 1;
        continue;
      }
      this.run(
        `UPDATE model_call SET status = 'interrupted', error = COALESCE(error, '实例已退出，记录已收敛') WHERE id = ?`,
        str(row['id']),
      );
      interrupted += 1;
    }
    return { interrupted, kept };
  }

  modelCallStats(): { purpose: string; calls: number; ok: number; failed: number; usageKnown: number }[] {
    return this.all(
      `SELECT purpose, COUNT(*) AS calls,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN status IN ('failed','cancelled','interrupted') THEN 1 ELSE 0 END) AS failed,
         SUM(usage_known) AS usageKnown
       FROM model_call GROUP BY purpose ORDER BY purpose`,
    ).map((row) => ({
      purpose: str(row['purpose']),
      calls: num(row['calls']),
      ok: num(row['ok']),
      failed: num(row['failed']),
      usageKnown: num(row['usageKnown']),
    }));
  }

  saveRouterDecision(input: {
    id: string;
    sessionId: string;
    turnNo: number;
    text: string | null;
    toolCalls: unknown;
  }): void {
    this.run(
      `INSERT INTO router_decision (id, session_id, turn_no, text, tool_calls, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      input.id, input.sessionId, input.turnNo, input.text, JSON.stringify(input.toolCalls), nowIso(),
    );
  }

  pendingRouterDecision(
    sessionId: string,
  ): { id: string; turnNo: number; text: string | null; toolCalls: unknown } | null {
    const row = this.get(
      `SELECT * FROM router_decision WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      sessionId,
    );
    if (!row) return null;
    return {
      id: str(row['id']),
      turnNo: num(row['turn_no']),
      text: strOrNull(row['text']),
      toolCalls: JSON.parse(str(row['tool_calls'])),
    };
  }

  /**
   * 决策完成与检查点一起提交。
   *
   * 只把决策标 done、不推进 router_session 的 messages，崩溃后恢复会拿回
   * "工具还没执行"的旧快照，于是同一批动作被再做一次（重复建任务）。
   * 两者必须原子：要么都在，要么都不在。
   */
  finishRouterDecision(input: { id: string; sessionId: string; messages: unknown }): void {
    const now = nowIso();
    this.tx(() => {
      this.run(`UPDATE router_decision SET status = 'done' WHERE id = ?`, input.id);
      this.run(
        `UPDATE router_session SET messages = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(input.messages), now, input.sessionId,
      );
    });
  }

  getRouterAction(sessionId: string, actionKey: string): { tool: string; result: string } | null {
    const row = this.get('SELECT tool, result FROM router_action WHERE session_id = ? AND action_key = ?', sessionId, actionKey);
    return row ? { tool: str(row['tool']), result: str(row['result']) } : null;
  }

  saveRouterAction(input: { id: string; sessionId: string; actionKey: string; tool: string; result: string }): void {
    this.run(
      `INSERT OR IGNORE INTO router_action (id, session_id, action_key, tool, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      input.id, input.sessionId, input.actionKey, input.tool, input.result, nowIso(),
    );
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

  /** Worker 提的维护申请。refs 是 JSON 数组：commit、文件、命令，供维护者自行核对。 */
  insertWdRequest(input: {
    id: string;
    kind: string;
    taskId: string | null;
    workerId: string | null;
    reason: string;
    refs: string[];
  }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO wd_request (id, kind, task_id, worker_id, reason, refs, status, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      input.id, input.kind, input.taskId, input.workerId, input.reason,
      JSON.stringify(input.refs), now, now,
    );
  }

  listPendingWdRequests(limit = 10): {
    id: string;
    kind: string;
    taskId: string | null;
    workerId: string | null;
    reason: string;
    refs: string[];
    createdAt: string;
  }[] {
    return this.all(
      "SELECT * FROM wd_request WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
      limit,
    ).map((row) => {
      let refs: string[] = [];
      const raw = strOrNull(row['refs']);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) refs = parsed.filter((item): item is string => typeof item === 'string');
        } catch {
          // 格式坏掉不该让维护者看不到这条申请；保留空 refs，正文里还有 reason。
        }
      }
      return {
        id: str(row['id']),
        kind: str(row['kind']),
        taskId: strOrNull(row['task_id']),
        workerId: strOrNull(row['worker_id']),
        reason: str(row['reason']),
        refs,
        createdAt: str(row['created_at']),
      };
    });
  }

  /** 申请只允许从 pending 转一次，重复处理会被这里挡住。 */
  resolveWdRequest(id: string, status: 'accepted' | 'rejected' | 'done' | 'failed', result: string): boolean {
    const current = this.get('SELECT status FROM wd_request WHERE id = ?', id) as { status?: unknown } | null;
    if (!current || str(current.status) !== 'pending') return false;
    this.run('UPDATE wd_request SET status = ?, result = ?, updated_at = ? WHERE id = ?', status, result, nowIso(), id);
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
                                signal, scope, stdout_path, stderr_path, timeout_ms, started_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id, job.taskId, job.workerId, job.command, JSON.stringify(job.args), job.cwd, job.pid, job.status,
      job.exitCode, job.signal, job.scope ?? 'biz', job.stdoutPath, job.stderrPath, job.timeoutMs, job.startedAt, job.endedAt, job.error,
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

  listRunningJobsByScope(scope: string): ProcessJob[] {
    return this.all("SELECT * FROM process_job WHERE scope = ? AND status = 'running'", scope).map(mapJob);
  }

  listAllRunningJobs(scope = 'biz'): ProcessJob[] {
    return this.all("SELECT * FROM process_job WHERE status = 'running' AND COALESCE(scope, 'biz') = ?", scope).map(mapJob);
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
      `INSERT INTO worker_turn (id, worker_id, seq, role, content, tool_calls, tool_call_id, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turn.id, turn.workerId, turn.seq, turn.role, turn.content,
      turn.toolCalls ? JSON.stringify(turn.toolCalls) : null, turn.toolCallId,
      turn.isError === undefined || turn.isError === null ? null : (turn.isError ? 1 : 0),
      turn.createdAt,
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

  appendRouterTurn(turn: RouterTurn & { sessionKey?: string | null; conversationId?: string | null }): void {
    // seq 是单调水位线，压缩时用它记住"摘要覆盖到哪一条"。
    const next = this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS value FROM router_turn') as { value?: unknown } | null;
    this.run(
      'INSERT INTO router_turn (id, role, content, session_key, conversation_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      turn.id, turn.role, turn.content, turn.sessionKey ?? null, turn.conversationId ?? null,
      Number(next?.value ?? 1), turn.createdAt,
    );
  }

  /** 按 seq 区间取对话历史（压缩用），按 seq 升序。 */
  listRouterTurnsBySeq(conversationId: string | null, sessionKey: string | null, fromSeq: number, toSeq: number): (RouterTurn & { seq: number })[] {
    const scope = conversationId !== null
      ? { clause: 'conversation_id = ?', params: [conversationId] }
      : sessionKey !== null
        ? { clause: 'session_key = ?', params: [sessionKey] }
        : { clause: 'session_key IS NULL', params: [] as unknown[] };
    const rows = this.all(
      `SELECT * FROM router_turn WHERE ${scope.clause} AND seq >= ? AND seq <= ? ORDER BY seq ASC`,
      ...scope.params, fromSeq, toSeq,
    );
    return rows.map((row) => ({ ...toRouterTurn(row), seq: Number((row as { seq?: unknown }).seq ?? 0) }));
  }

  /** 水位线之后、且仍在窗口里的对话历史。 */
  listRouterTurnsSince(conversationId: string | null, sessionKey: string | null, afterSeq: number): (RouterTurn & { seq: number })[] {
    const scope = conversationId !== null
      ? { clause: 'conversation_id = ?', params: [conversationId] }
      : sessionKey !== null
        ? { clause: 'session_key = ?', params: [sessionKey] }
        : { clause: 'session_key IS NULL', params: [] as unknown[] };
    const rows = this.all(
      `SELECT * FROM router_turn WHERE ${scope.clause} AND seq > ? ORDER BY seq ASC`,
      ...scope.params, afterSeq,
    );
    return rows.map((row) => ({ ...toRouterTurn(row), seq: Number((row as { seq?: unknown }).seq ?? 0) }));
  }

  /** 最新一份对话摘要。 */
  latestRouterNote(conversationId: string | null, sessionKey: string | null): { content: string; coveredSeq: number; createdAt: string } | null {
    const scope = conversationId !== null
      ? { clause: 'conversation_id = ?', params: [conversationId] }
      : sessionKey !== null
        ? { clause: 'session_key = ?', params: [sessionKey] }
        : { clause: 'session_key IS NULL', params: [] as unknown[] };
    const row = this.get(
      `SELECT content, covered_seq, created_at FROM router_note WHERE ${scope.clause} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ...scope.params,
    );
    if (!row) return null;
    return {
      content: String((row as { content?: unknown }).content ?? ''),
      coveredSeq: Number((row as { covered_seq?: unknown }).covered_seq ?? 0),
      createdAt: String((row as { created_at?: unknown }).created_at ?? ''),
    };
  }

  insertRouterNote(input: {
    id: string;
    sessionKey: string | null;
    conversationId: string | null;
    fromSeq: number;
    toSeq: number;
    coveredSeq: number;
    content: string;
    sourceTurns: number;
    sourceChars: number;
  }): void {
    this.run(
      `INSERT INTO router_note (id, session_key, conversation_id, from_seq, to_seq, covered_seq, content, source_turns, source_chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.sessionKey, input.conversationId, input.fromSeq, input.toSeq, input.coveredSeq,
      input.content, input.sourceTurns, input.sourceChars, nowIso(),
    );
  }

  /**
   * 只读指定会话的对话历史。
   *
   * 传了 conversationId 就按话题过滤——同一个聊天里不同话题的历史互不可见；
   * 没传则沿用按聊天地址（sessionKey）过滤，CLI 为 null。
   */
  listRouterTurns(limit = 30, sessionKey: string | null = null, conversationId: string | null = null): RouterTurn[] {
    if (conversationId !== null) {
      const rows = this.all(
        'SELECT * FROM router_turn WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        conversationId, limit,
      );
      return rows.reverse().map(toRouterTurn);
    }
    const rows =
      sessionKey === null
        ? this.all(
            'SELECT * FROM router_turn WHERE session_key IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?',
            limit,
          )
        : this.all(
            'SELECT * FROM router_turn WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
            sessionKey, limit,
          );
    return rows.map(toRouterTurn).reverse();
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

  // ---------------- 渠道层：入站 / 游标 / 发件 / 渠道会话 ----------------

  /**
   * 把一批入站消息与新的游标放进同一个事务。
   *
   * 顺序是「先落库、再前移游标」：写库失败时游标不动，重启还能重新拉到这批消息；
   * 反过来会丢掉已经确认、但没来得及处理的那些。
   */
  recordInboundBatch(input: {
    channel: string;
    accountId: string;
    /** 只接受这些发送者的消息；为空表示尚未绑定主人。 */
    ownerIds: string[];
    events: {
      id: string;
      eventId: string;
      peerId: string;
      senderId: string;
      platformMessageId: string;
      sessionKey: string;
      threadId: string | null;
      body: string;
      attachments: unknown;
      unsupported: string | null;
      /** 只留痕、不回信（例如群聊）。 */
      silent?: boolean;
      receivedAt: string;
    }[];
    cursor: string | null;
  }): { accepted: string[]; duplicates: string[]; rejected: string[] } {
    return this.tx(() => {
      const now = nowIso();
      const accepted: string[] = [];
      const duplicates: string[] = [];
      const rejected: string[] = [];
      for (const event of input.events) {
        const existing = this.get(
          'SELECT id FROM channel_inbound WHERE channel = ? AND account_id = ? AND event_id = ?',
          input.channel, input.accountId, event.eventId,
        );
        if (existing) {
          duplicates.push(event.id);
          continue;
        }
        // 陌生发送者与未绑定主人：记录事实但不交给 Router，避免任何模型调用。
        const allowed = input.ownerIds.length > 0 && input.ownerIds.includes(event.senderId);
        const status = allowed ? 'pending' : 'rejected';
        const reason = allowed
          ? null
          : input.ownerIds.length === 0
            ? '尚未绑定主人身份'
            : '发送者不在授权列表';
        this.run(
          `INSERT INTO channel_inbound (id, channel, account_id, event_id, peer_id, sender_id,
             platform_message_id, session_key, thread_id, body, attachments, unsupported,
             silent, status, reason, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.id, input.channel, input.accountId, event.eventId, event.peerId, event.senderId,
          event.platformMessageId, event.sessionKey, event.threadId, event.body,
          JSON.stringify(event.attachments), event.unsupported,
          event.silent === true ? 1 : 0, status, reason, event.receivedAt, now,
        );
        if (allowed) accepted.push(event.id);
        else rejected.push(event.id);
      }
      if (input.cursor !== null) {
        this.run(
          `INSERT INTO channel_cursor (channel, account_id, cursor, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(channel, account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          input.channel, input.accountId, input.cursor, now,
        );
      }
      return { accepted, duplicates, rejected };
    });
  }

  getChannelCursor(channel: string, accountId: string): string | null {
    const row = this.get(
      'SELECT cursor FROM channel_cursor WHERE channel = ? AND account_id = ?',
      channel, accountId,
    );
    return row ? strOrNull(row['cursor']) : null;
  }

  listPendingInbound(limit = 20): {
    id: string;
    channel: string;
    accountId: string;
    peerId: string;
    senderId: string;
    platformMessageId: string;
    sessionKey: string;
    body: string;
    attachments: unknown;
    unsupported: string | null;
    silent: boolean;
    receivedAt: string;
  }[] {
    return this.all(
      "SELECT * FROM channel_inbound WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?",
      limit,
    ).map((row) => ({
      id: str(row['id']),
      channel: str(row['channel']),
      accountId: str(row['account_id']),
      peerId: str(row['peer_id']),
      senderId: str(row['sender_id']),
      platformMessageId: str(row['platform_message_id']),
      sessionKey: str(row['session_key']),
      body: str(row['body']),
      attachments: JSON.parse(str(row['attachments'] ?? '[]')),
      unsupported: strOrNull(row['unsupported']),
      silent: num(row['silent'] ?? 0) === 1,
      receivedAt: str(row['received_at']),
    }));
  }

  /**
   * 取某个会话里带附件、尚未归属任务、且已成功交接的入站记录。
   *
   * 用于把用户发来的材料真正落到任务目录：交接失败的记录不算。
   * 传了话题就只认这个话题的附件——否则在乙话题建任务会把甲话题刚发的文件
   * 一起认领走，用户看到的是"文件跑到了别的话题里"。
   */
  listUnclaimedSessionAttachments(
    sessionKey: string,
    conversationId: string | null = null,
    limit = 50,
  ): {
    id: string;
    attachments: unknown;
    receivedAt: string;
  }[] {
    // 没有话题归属的老记录（升级前写入）只在"这个聊天只有一个话题"时才算进来：
    // 那时不存在分错话题的可能；有两个以上话题就拒绝认领，不猜。
    const topicClause =
      conversationId === null
        ? ''
        : ` AND (conversation_id = ?
               OR (conversation_id IS NULL
                   AND (SELECT COUNT(*) FROM conversation c
                         WHERE c.session_key = channel_inbound.session_key AND c.status = 'active') <= 1))`;
    return this.all(
      `SELECT * FROM channel_inbound
       WHERE session_key = ? AND status = 'handed' AND claimed_task_id IS NULL
         AND attachments IS NOT NULL AND attachments != '[]'${topicClause}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      ...(conversationId === null ? [sessionKey, limit] : [sessionKey, conversationId, limit]),
    ).map((row) => ({
      id: str(row['id']),
      attachments: JSON.parse(str(row['attachments'] ?? '[]')),
      receivedAt: str(row['received_at']),
    }));
  }

  claimInboundAttachments(ids: string[], taskId: string): void {
    for (const id of ids) {
      this.run('UPDATE channel_inbound SET claimed_task_id = ? WHERE id = ?', taskId, id);
    }
  }

  /** 把升级前没有话题归属的入站记录收进该会话的第一个话题。 */
  adoptOrphanInbound(sessionKey: string, conversationId: string): number {
    this.assertUsable();
    const result = this.db
      .prepare('UPDATE channel_inbound SET conversation_id = ? WHERE session_key = ? AND conversation_id IS NULL')
      .run(conversationId, sessionKey);
    return Number(result.changes ?? 0);
  }

  /** 记下这条入站消息属于哪个话题；交接时写入，之后不再变。 */
  setInboundConversation(id: string, conversationId: string): void {
    this.run('UPDATE channel_inbound SET conversation_id = ? WHERE id = ?', conversationId, id);
  }

  markInbound(id: string, status: 'handed' | 'rejected' | 'failed', reason?: string | null): void {
    this.run(
      'UPDATE channel_inbound SET status = ?, reason = ?, handled_at = ? WHERE id = ?',
      status, reason ?? null, nowIso(), id,
    );
  }

  enqueueOutbound(input: {
    id: string;
    channel: string;
    accountId: string;
    peerId: string;
    sessionKey: string;
    taskId: string | null;
    body: string;
    segments: unknown;
  }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO channel_outbound (id, channel, account_id, peer_id, session_key, task_id,
         body, segments, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      input.id, input.channel, input.accountId, input.peerId, input.sessionKey, input.taskId,
      input.body, JSON.stringify(input.segments), now, now,
    );
  }

  listPendingOutbound(limit = 10): {
    id: string;
    channel: string;
    accountId: string;
    peerId: string;
    sessionKey: string;
    taskId: string | null;
    body: string;
    segments: unknown;
    attempts: number;
  }[] {
    const now = nowIso();
    return this.all(
      `SELECT * FROM channel_outbound
       WHERE status IN ('pending','partial')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      now, limit,
    ).map((row) => ({
      id: str(row['id']),
      channel: str(row['channel']),
      accountId: str(row['account_id']),
      peerId: str(row['peer_id']),
      sessionKey: str(row['session_key']),
      taskId: strOrNull(row['task_id']),
      body: str(row['body']),
      segments: JSON.parse(str(row['segments'] ?? '[]')),
      attempts: num(row['attempts']),
    }));
  }

  /** 某会话的发件记录，供测试与排查；按创建顺序。 */
  listOutboundBySession(sessionKey: string, limit = 50): {
    id: string;
    channel: string;
    accountId: string;
    peerId: string;
    taskId: string | null;
    status: string;
    segments: unknown;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
  }[] {
    return this.all(
      'SELECT * FROM channel_outbound WHERE session_key = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
      sessionKey,
      limit,
    ).map((row) => ({
      id: str(row['id']),
      channel: str(row['channel']),
      accountId: str(row['account_id']),
      peerId: str(row['peer_id']),
      taskId: strOrNull(row['task_id']),
      status: str(row['status']),
      segments: JSON.parse(str(row['segments'] ?? '[]')),
      attempts: num(row['attempts']),
      lastError: strOrNull(row['last_error']),
      nextAttemptAt: strOrNull(row['next_attempt_at']),
    }));
  }

  updateOutbound(input: {
    id: string;
    segments: unknown;
    status: 'pending' | 'partial' | 'sent' | 'failed' | 'unknown';
    attempts: number;
    lastError?: string | null;
    /** 最早下次可尝试时间；null 表示立刻可试。 */
    nextAttemptAt?: string | null;
  }): void {
    const now = nowIso();
    this.run(
      `UPDATE channel_outbound SET segments = ?, status = ?, attempts = ?, last_error = ?,
         next_attempt_at = ?, updated_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
       WHERE id = ?`,
      JSON.stringify(input.segments), input.status, input.attempts, input.lastError ?? null,
      input.nextAttemptAt ?? null, now, input.status, now, input.id,
    );
  }

  getChannelSession(sessionKey: string): {
    sessionKey: string;
    channel: string;
    accountId: string;
    peerId: string;
    routerSessionId: string | null;
    contextToken: string | null;
  } | null {
    const row = this.get('SELECT * FROM channel_session WHERE session_key = ?', sessionKey);
    if (!row) return null;
    return {
      sessionKey: str(row['session_key']),
      channel: str(row['channel']),
      accountId: str(row['account_id']),
      peerId: str(row['peer_id']),
      routerSessionId: strOrNull(row['router_session_id']),
      contextToken: strOrNull(row['context_token']),
    };
  }

  upsertChannelSession(input: {
    sessionKey: string;
    channel: string;
    accountId: string;
    peerId: string;
    touch?: 'inbound' | 'outbound';
  }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO channel_session (session_key, channel, account_id, peer_id, last_inbound_at,
         last_outbound_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET
         last_inbound_at = CASE WHEN ? = 'inbound' THEN excluded.updated_at ELSE channel_session.last_inbound_at END,
         last_outbound_at = CASE WHEN ? = 'outbound' THEN excluded.updated_at ELSE channel_session.last_outbound_at END,
         updated_at = excluded.updated_at`,
      input.sessionKey, input.channel, input.accountId, input.peerId,
      input.touch === 'inbound' ? now : null, input.touch === 'outbound' ? now : null, now, now,
      input.touch ?? null, input.touch ?? null,
    );
  }

  /**
   * 保存微信对端回复上下文。
   *
   * 这是渠道私有状态：只在适配器发送时使用，不进入模型提示词、也不写进调用转储。
   */
  setChannelContextToken(sessionKey: string, token: string | null): void {
    const now = nowIso();
    this.run(
      `UPDATE channel_session SET context_token = ?, context_updated_at = ?, updated_at = ?
       WHERE session_key = ?`,
      token, now, now, sessionKey,
    );
  }

  // ---------------- 对话话题 ----------------

  createConversation(input: { id: string; sessionKey: string; title: string; now: string }): void {
    this.run(
      `INSERT INTO conversation (id, session_key, title, status, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      input.id, input.sessionKey, input.title, input.now, input.now, input.now,
    );
  }

  getConversation(id: string): {
    id: string;
    sessionKey: string;
    title: string;
    status: string;
    lastMessageAt: string | null;
  } | null {
    const row = this.get('SELECT * FROM conversation WHERE id = ?', id);
    if (!row) return null;
    return {
      id: str(row['id']),
      sessionKey: str(row['session_key']),
      title: str(row['title']),
      status: str(row['status']),
      lastMessageAt: strOrNull(row['last_message_at']),
    };
  }

  listConversations(sessionKey: string, status: 'active' | 'archived' | 'all' = 'active'): {
    id: string;
    sessionKey: string;
    title: string;
    status: string;
    lastMessageAt: string | null;
  }[] {
    const rows = this.all(
      `SELECT * FROM conversation WHERE session_key = ? ${status === 'all' ? '' : 'AND status = ?'}
       ORDER BY created_at ASC, rowid ASC`,
      ...(status === 'all' ? [sessionKey] : [sessionKey, status]),
    );
    return rows.map((row) => ({
      id: str(row['id']),
      sessionKey: str(row['session_key']),
      title: str(row['title']),
      status: str(row['status']),
      lastMessageAt: strOrNull(row['last_message_at']),
    }));
  }

  /**
   * 把升级前的历史收进某个话题。
   *
   * 话题上线前 router_turn 没有 conversation_id；不收进来的话，升级后这些对话
   * 在任何话题里都查不到——用户会觉得"机器人突然失忆了"。
   * 按行数返回，便于日志与断言。
   */
  adoptOrphanRouterTurns(sessionKey: string, conversationId: string): number {
    this.assertUsable();
    const result = this.db
      .prepare('UPDATE router_turn SET conversation_id = ? WHERE session_key = ? AND conversation_id IS NULL')
      .run(conversationId, sessionKey);
    return Number(result.changes ?? 0);
  }

  renameConversation(id: string, title: string): void {
    this.run('UPDATE conversation SET title = ?, updated_at = ? WHERE id = ?', title, nowIso(), id);
  }

  setConversationStatus(id: string, status: 'active' | 'archived'): void {
    this.run('UPDATE conversation SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  touchConversation(id: string): void {
    const now = nowIso();
    this.run('UPDATE conversation SET last_message_at = ?, updated_at = ? WHERE id = ?', now, now, id);
  }

  /** 当前话题：聊天会话行上的指针。没有行或指针指空都返回 null。 */
  currentConversationId(sessionKey: string): string | null {
    const row = this.get('SELECT current_conversation_id FROM channel_session WHERE session_key = ?', sessionKey);
    return row ? strOrNull(row['current_conversation_id']) : null;
  }

  setCurrentConversation(sessionKey: string, conversationId: string): void {
    this.run(
      'UPDATE channel_session SET current_conversation_id = ?, updated_at = ? WHERE session_key = ?',
      conversationId, nowIso(), sessionKey,
    );
  }

  listChannelSessions(): {
    sessionKey: string;
    channel: string;
    accountId: string;
    peerId: string;
    hasContextToken: boolean;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
  }[] {
    return this.all('SELECT * FROM channel_session ORDER BY updated_at DESC').map((row) => ({
      sessionKey: str(row['session_key']),
      channel: str(row['channel']),
      accountId: str(row['account_id']),
      peerId: str(row['peer_id']),
      hasContextToken: strOrNull(row['context_token']) !== null,
      lastInboundAt: strOrNull(row['last_inbound_at']),
      lastOutboundAt: strOrNull(row['last_outbound_at']),
    }));
  }

  newWaitId(): string {
    return newWaitId();
  }

  newReviewId(): string {
    return newReviewId();
  }
}
