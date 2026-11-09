import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertInsideRoot, normalizeRelativePath, resolveInside } from '../tools/paths.ts';

import type { Config } from '../config.ts';
import {
  isoAfter,
  newArtifactId,
  newMessageId,
  newReviewId,
  newTaskId,
  newWaitId,
  newWorkerId,
  nowIso,
} from '../domain/ids.ts';
import { isTerminalTask, isTerminalWorker } from '../domain/state.ts';
import { Execution, ExecutionRevoked } from './execution.ts';
import { runWorkerTurn, toStepResult } from './pi-worker.ts';
import type { AssistantMessage } from '../vendor/pi/types.ts';

/**
 * 进度汇报唤醒 Router 的最小间隔。
 *
 * 不节流的话，一个每步都汇报的 Worker 会把每条聊天刷成进度条；
 * 完全不唤醒又让用户以为任务卡死。3 分钟是"看得出在动"与"别刷屏"之间。
 */
const PROGRESS_NOTIFY_INTERVAL_MS = 3 * 60 * 1000;
import { ModelRegistry } from '../model/registry.ts';
import { stageMaterials, type StoredAttachment } from '../channels/storage.ts';
import { identifyProcess } from '../watchdog/observer.ts';
import type {
  Artifact,
  ProcessJob,
  Message,
  MessageKind,
  MessageRefs,
  RuntimeEvent,
  Task,
  Worker,
  WorkerNote,
  WorkerTurn,
} from '../domain/types.ts';
import { ModelError } from '../model/types.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { ChatMessage, ModelClient, StepResult, ToolCall } from '../model/types.ts';
import { artifactTools } from '../tools/artifacts.ts';
import { collabTools } from '../tools/collab.ts';
import { fileTools } from '../tools/files.ts';
import { historyTools } from '../tools/history.ts';
import { execTools } from '../tools/exec.ts';
import { editTools } from '../tools/edit.ts';
import { netTools } from '../tools/net.ts';
import { docTools } from '../tools/docs.ts';
import { capabilityTools } from '../tools/capabilities.ts';
import { ProcessService, type JobOutput } from './process.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type {
  CreateCollaboratorResult,
  ReportResult,
  SendMessageInput,
  SendMessageResult,
  SubmitResult,
  ToolContext,
  ToolHost,
  WaitOptions,
  WaitResult,
} from '../tools/types.ts';
import { workerSystemPrompt } from './prompts.ts';
import {
  collectArtifactLines,
  estimateTurnsChars,
  planHistory,
  renderArtifactTable,
  renderExecutionDirective,
  renderTaskFacts,
  type HistoryPlan,
} from './context.ts';
import { buildNotePrompt, decideNote, runNote, type NoteDecision } from './note.ts';
import type { Store } from '../storage/store.ts';

export interface CreateTaskInput {
  title: string;
  goal: string;
  brief?: string;
  doneCriteria?: string;
  requireReview?: boolean;
  ownerRole: string;
  ownerBrief: string;
  model?: string | null;
  /** 任务来源：由哪个聊天发起。后台结果按它送回原聊天。 */
  source?: {
    channel: string;
    accountId: string;
    peerId: string;
    sessionKey: string;
    /** 话题：任务归属到这个话题，历史与可见性都按它算。 */
    conversationId?: string | null;
  } | null;
}

/** 允许在线调整的覆盖项白名单。只接受已知 key，不做"任意 key 都报告已激活"。 */
export function validateOverride(key: string, content: string): { ok: boolean; message: string } {
  if (key === 'worker.check_rules') {
    if (content.trim() === '') return { ok: false, message: '内容不能为空' };
    if (content.length > 2000) return { ok: false, message: '内容过长（上限 2000 字符）' };
    return { ok: true, message: '' };
  }
  if (key === 'watchdog.interval') {
    const value = Number(content.trim());
    if (!Number.isFinite(value) || value < 10_000 || value > 3_600_000) {
      return { ok: false, message: '巡检间隔必须是 10000–3600000 之间的毫秒数' };
    }
    return { ok: true, message: '' };
  }
  return { ok: false, message: `不支持的覆盖项：${key}（可用：worker.check_rules、watchdog.interval）` };
}

export interface RouterBridge {
  notify(): void;
  handleUserMessage(
    text: string,
    options?: { sessionKey?: string | null; conversationId?: string | null; onAccepted?: () => void },
  ): Promise<void>;
  /** 有达到单轮额度后保存的协调进度。 */
  hasPendingSession?(): boolean;
  /** 继续上次保存的协调进度。 */
  resume?(): Promise<void>;
}

export class Runtime implements ToolHost {
  readonly store: Store;
  readonly config: Config;
  readonly workerModel: ModelClient;
  readonly models: ModelRegistry;
  readonly defaultWaitTimeoutMs: number;

  private readonly events = new EventEmitter();
  private readonly tools: ToolRegistry;
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  /** 本轮执行期间收到的调度请求，等本轮结束后各跑一次。 */
  private readonly rerunRequested = new Set<string>();
  private readonly jobs: ProcessService;
  /** 每个 Worker 当前的取消信号；停止任务或 Worker 失败时触发。 */
  /** 每个正在执行的 Worker 对应一个执行过程；撤销后它彻底失去写库资格。 */
  private readonly runs = new Map<string, Execution>();
  /** 进程级取消：覆盖不挂在单个 Worker 上的执行（Router、工作记录整理）。 */
  private readonly lifecycle = new AbortController();
  /** 所有登记过的执行过程（含 Router 与工作记录整理），停机时统一撤销。 */
  private readonly executions = new Set<Execution>();
  /** 启动时补报未送达的 Worker 消息，只做一次。 */
  private inboxCatchUpDone = false;
  /** 上次因进度唤醒 Router 的时间（按任务），用于节流。 */
  private readonly progressNotifyAt = new Map<string, number>();

  /** 登记一次执行过程：停机时会被统一撤销，之后不会再写库。 */
  track(execution: Execution): void {
    this.executions.add(execution);
  }

  untrack(execution: Execution): void {
    this.executions.delete(execution);
  }
  private readonly budgetNoted = new Set<string>();
  private runningCount = 0;
  private workerSequence = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private router: RouterBridge | null = null;

  /** 渠道层用它把聊天输入交给 Router；没有 Router 时视为未接入。 */
  get routerBridge(): RouterBridge | null {
    return this.router;
  }

  constructor(options: {
    store: Store;
    config: Config;
    workerModel: ModelClient;
    /** 模型目录；不传时退化为"单模型"，仍然按别名 default 解析。 */
    models?: ModelRegistry;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.workerModel = options.workerModel;
    this.models =
      options.models ??
      new ModelRegistry(
        [
          {
            alias: 'default',
            provider: options.config.provider,
            baseUrl: options.config.baseUrl,
            apiKey: options.config.apiKey,
            model: options.config.workerModel,
            note: null,
            costHint: null,
          },
        ],
        new Map([['default', options.workerModel]]),
      );
    this.defaultWaitTimeoutMs = options.config.limits.waitTimeoutMs;
    this.tools = new ToolRegistry('worker', [
      ...fileTools,
      ...editTools,
      ...artifactTools,
      ...collabTools,
      ...historyTools,
      ...execTools,
      ...netTools,
      ...docTools,
      ...capabilityTools,
    ]);
    this.jobs = new ProcessService({
      store: this.store,
      logRoot: resolve(this.config.workDir, '.jobs'),
      onFinished: (job) => this.onJobFinished(job),
    });
    // 上次进程遗留的 running 作业无法确认结果，统一标为未知，不重放、不误杀。
    this.jobs.recover();
  }

  // ---------------- 事件 ----------------

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  private emit(event: RuntimeEvent): void {
    this.events.emit('event', event);
  }

  /** 供 Router 等协作组件发布界面事件。 */
  publish(event: RuntimeEvent): void {
    this.emit(event);
  }

  attachRouter(router: RouterBridge): void {
    this.router = router;
  }

  /** 供 Router 等进程级执行使用的取消信号。 */
  get lifecycleSignal(): AbortSignal {
    return this.lifecycle.signal;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    // 1) 不再接受新调度
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.length = 0;
    this.rerunRequested.clear();
    // 2) 取消在途模型请求：不取消的话，等 15 秒也只是等到数据库被关掉
    this.lifecycle.abort();
    for (const run of this.runs.values()) {
      run.revoke('系统停机');
    }
    for (const execution of this.executions) {
      execution.revoke('系统停机');
    }
    // 3) 等在途执行收尾：撤销之后执行过程不会再写库，迟到结果只被观察
    await this.waitForIdle(15_000);
    // 4) 兜底：仍然没退出说明提供方忽略了取消。再等一小段，
    //    之后迟到的回调会因为 stopped 标记和 isClosed 检查而不再写库。
    if (this.runningCount > 0) {
      this.store.appendEvent(null, null, 'runtime.stop_slow', `${this.runningCount} 个执行在取消后仍未结束`);
      await this.waitForIdle(5_000);
    }
    // 5) 作业：终态任务不能留下继续运行的进程
    this.jobs.dispose();
  }

  // ---------------- 任务与 Worker ----------------

  /**
   * 建立任务与负责人。
   *
   * `options.onRecorded` 在同一个事务里执行：调用方（例如 Router）需要把
   * "这次操作已经完成"的回执和业务变更一起提交，避免业务生效但回执丢失。
   * 唤醒调度放在事务提交之后——事务里不应该启动后台执行。
   */
  createTask(
    input: CreateTaskInput,
    options: { onRecorded?: (task: Task, owner: Worker) => void } = {},
  ): { task: Task; owner: Worker } {
    const taskId = newTaskId();
    const groupId = `grp_${taskId.slice(5)}`;
    const now = nowIso();
    const task: Task = {
      id: taskId,
      groupId,
      title: input.title,
      goal: input.goal,
      brief: input.brief ?? '',
      doneCriteria: input.doneCriteria ?? '',
      requireReview: input.requireReview ?? false,
      reviewEpoch: 0,
      ownerWorkerId: null,
      sourceChannel: input.source?.channel ?? null,
      sourceAccountId: input.source?.accountId ?? null,
      sourcePeerId: input.source?.peerId ?? null,
      sourceSessionKey: input.source?.sessionKey ?? null,
      sourceConversationId: input.source?.conversationId ?? null,
      status: 'active',
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    // 聊天里发来的材料必须在建任务时就落到任务目录：Worker 的文件权限范围是
    // workDir/<taskId>，只给一个它读不到的缓存路径等于没给。
    const staged = input.source
      ? this.prepareSessionMaterials(taskId, input.source.sessionKey, input.source.conversationId ?? null)
      : { files: [], inboundIds: [], cleanup: (): void => {} };
    if (staged.files.length > 0) {
      task.brief = [
        task.brief,
        `随任务附带的材料（已放入 materials/）：`,
        ...staged.files.map((item) => `- ${item.path}（${item.bytes} 字节，sha256 ${item.sha256.slice(0, 16)}）`),
      ]
        .filter((line) => line !== '')
        .join('\n');
    }
    let owner!: Worker;
    try {
      this.store.tx(() => {
        this.store.createTask(task);
        owner = this.createWorkerRecord({
          groupId,
          parentId: null,
          role: input.ownerRole,
          brief: input.ownerBrief,
          modelAlias: input.model ?? this.config.defaultModelAlias,
        });
        this.store.setTaskOwner(taskId, owner.id);
        // 认领和建任务同一个事务：任务回滚了，附件不能被一个不存在的任务占着，
        // 否则用户重试建任务时材料已经"被用掉"，再也带不上。
        if (staged.inboundIds.length > 0) this.store.claimInboundAttachments(staged.inboundIds, taskId);
        options.onRecorded?.(task, owner);
      });
    } catch (error) {
      // 事务失败则清掉本次复制出来的孤立副本，任务目录里不留半份材料。
      staged.cleanup();
      throw error;
    }
    const created = this.store.getTask(taskId)!;
    this.store.appendEvent(taskId, owner.id, 'task.created', input.title);
    this.emit({ type: 'task.created', taskId, title: input.title });
    this.emit({ type: 'worker.created', workerId: owner.id, role: owner.role, parentId: null });
    this.enqueue(owner.id);
    return { task: created, owner };
  }

  /**
   * 把聊天里后来上传的材料补充给一个已有任务。
   *
   * 建任务之后用户又发来附件时必须有这个入口：否则材料一直挂在"未认领"，
   * Worker 永远看不到，用户也不知道自己的文件去哪了。
   */
  attachSessionMaterials(
    taskId: string,
    sessionKey: string,
    conversationId: string | null = null,
    note?: string,
  ): { ok: true; files: { path: string; bytes: number; sha256: string }[]; messageId: string | null } | { ok: false; message: string } {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, message: `任务不存在：${taskId}` };
    if (isTerminalTask(task.status)) {
      return { ok: false, message: `任务已是 ${task.status}，不能再补材料；需要继续请新建任务。` };
    }
    const staged = this.prepareSessionMaterials(taskId, sessionKey, conversationId);
    if (staged.inboundIds.length === 0) {
      return { ok: false, message: '这个会话没有待补充的材料：请先把文件发到聊天里。' };
    }
    if (staged.files.length === 0) {
      // 记录在、文件没了：不能假装补进去了。
      staged.cleanup();
      return { ok: false, message: '这些附件的文件已经不在了，没法补进任务；请重新发一次。' };
    }
    const added = staged.files
      .map((item) => `- ${item.path}（${item.bytes} 字节，sha256 ${item.sha256.slice(0, 16)}）`)
      .join('\n');
    // 材料进了任务就是一次"要求变更"：认领、材料清单、要求版本、通知负责人必须一起生效。
    // 之前只有填了 note 才发 update，于是不填 note 时负责人根本不知道有新材料，
    // 旧检查也不会失效——补材料变成了绕过验收的后门。
    const body = [
      '补充了新材料，请按最新材料重新核对。',
      ...(note === undefined || note.trim() === '' ? [] : [note.trim()]),
    ].join('\n');
    const message = this.buildRouterMessage(task, body, 'update');
    try {
      this.store.tx(() => {
        this.store.claimInboundAttachments(staged.inboundIds, taskId);
        this.store.updateTaskRequirements(taskId, {
          brief: `${task.brief}\n随后补充的材料（已放入 materials/）：\n${added}`.trim(),
        });
        this.store.bumpReviewEpoch(taskId);
        if (message) {
          this.store.insertMessage(message);
          this.store.setMessageStatus(message.id, 'delivered');
        }
        this.store.appendEvent(taskId, null, 'task.materials', `补充 ${staged.files.length} 份材料`);
      });
    } catch (error) {
      staged.cleanup();
      throw error;
    }
    // 事务提交后再唤醒负责人：回滚了就不该有人在跑。
    if (message) {
      this.emit({ type: 'message.sent', messageId: message.id, from: 'router', to: message.toId, kind: 'update' });
      this.onMessageDelivered(message);
    }
    return { ok: true, files: staged.files, messageId: message?.id ?? null };
  }

  /**
   * 构造一条 Router → 负责人 的消息，不落库。
   *
   * 抽出来是为了让"补材料"能在自己的事务里写通知：先落消息再建任务那种
   * 半截状态不能再出现。
   */
  private buildRouterMessage(
    task: Task,
    body: string,
    kind: 'update' | 'stop',
  ): Message | null {
    const ownerId = task.ownerWorkerId;
    if (!ownerId) return null;
    const worker = this.store.getWorker(ownerId);
    if (!worker || isTerminalWorker(worker.status)) return null;
    return {
      id: newMessageId(),
      groupId: task.groupId,
      taskId: task.id,
      fromKind: 'router',
      fromId: 'router',
      toKind: 'worker',
      toId: worker.id,
      kind,
      body,
      payload: null,
      replyTo: null,
      refs: null,
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    };
  }

  /**
   * 把该会话尚未归属任务的附件复制进任务目录。
   *
   * 这里只复制文件，不写数据库：认领必须和建任务在同一个事务里提交，
   * 否则事务回滚会留下"任务不存在，材料却已被占用"的孤儿归属。
   */
  private prepareSessionMaterials(
    taskId: string,
    sessionKey: string,
    conversationId: string | null = null,
  ): { files: { path: string; bytes: number; sha256: string }[]; inboundIds: string[]; cleanup: () => void } {
    const pending = this.store.listUnclaimedSessionAttachments(sessionKey, conversationId);
    if (pending.length === 0) return { files: [], inboundIds: [], cleanup: (): void => {} };
    const attachments = pending.flatMap(
      (item) => (Array.isArray(item.attachments) ? item.attachments : []) as StoredAttachment[],
    );
    const files = stageMaterials({ workDir: this.config.workDir, taskId, attachments });
    // 回滚只能删"本次新复制的文件"。
    // 之前这里 rm -rf 整个 work/<taskId>：给已有任务补材料失败时，会连它原有的
    // 全部成果一起删掉，而数据库里的任务还在——这是数据丢失，不是清理。
    const cleanup = (): void => {
      for (const file of files) {
        try {
          rmSync(resolve(this.config.workDir, file.path), { force: true });
        } catch {
          // 单个文件删不掉不掩盖原始错误，也不去删别的东西。
        }
      }
      // 只尝试删除空目录：非空说明里面还有别人的东西，rmdir 自己会失败。
      try {
        rmdirSync(resolve(this.config.workDir, taskId, 'materials'));
      } catch {
        // 目录里还有别的材料，保持原样。
      }
      try {
        rmdirSync(resolve(this.config.workDir, taskId));
      } catch {
        // 任务目录里还有原来的成果，不能动。
      }
    };
    return { files, inboundIds: pending.map((item) => item.id), cleanup };
  }

  private createWorkerRecord(input: {
    groupId: string;
    parentId: string | null;
    role: string;
    brief: string;
    /** 模型别名；必须是目录里已配置的别名。 */
    modelAlias: string;
    /**
     * 初始化状态。
     *
     * 协作者建出来时还没有任何消息，用 idle 表示"在等第一份活"；
     * 直接写成 queued 会让人以为它已经排进队列，实际上没有任何东西在推进它。
     */
    status?: 'queued' | 'idle';
  }): Worker {
    // 组内按「累计创建」计预算，防止一个任务无限拉人；全局按「当前活跃」计资源。
    const createdInGroup = this.store.countWorkersInGroup(input.groupId);
    if (createdInGroup >= this.config.limits.maxWorkersPerGroup) {
      throw new Error(`本任务已累计创建 ${createdInGroup} 个 Worker，达到上限 ${this.config.limits.maxWorkersPerGroup}`);
    }
    const active = this.store.countActiveWorkers();
    if (active >= this.config.limits.maxTotalWorkers) {
      throw new Error(`当前活跃 Worker 已达上限 ${this.config.limits.maxTotalWorkers}，请等待现有任务结束`);
    }
    this.workerSequence = Math.max(this.workerSequence, createdInGroup) + 1;
    const now = nowIso();
    const worker: Worker = {
      id: newWorkerId(this.workerSequence),
      groupId: input.groupId,
      parentId: input.parentId,
      role: input.role,
      brief: input.brief,
      status: input.status ?? 'queued',
      model: input.modelAlias,
      stepCount: 0,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.store.createWorker(worker);
    const task = this.store.getTaskByGroup(input.groupId);
    this.store.appendEvent(task?.id ?? null, worker.id, 'worker.created', input.role);
    this.emit({ type: 'worker.created', workerId: worker.id, role: worker.role, parentId: worker.parentId });
    return worker;
  }

  createCollaborator(
    parent: Worker,
    role: string,
    brief: string,
    options: { model?: string | null } = {},
  ): CreateCollaboratorResult {
    try {
      // 不指定就沿用它创建者的模型配置；指定时必须真实存在，不回退默认。
      const alias = options.model ?? parent.model ?? this.config.defaultModelAlias;
      if (!this.models.has(alias)) {
        return { ok: false, reason: `未配置的模型别名：${alias}；可用别名：${this.models.list().map((item) => item.alias).join(', ')}` };
      }
      const worker = this.createWorkerRecord({
        groupId: parent.groupId,
        parentId: parent.id,
        role,
        brief,
        modelAlias: alias,
        // 建出来就入队的话，协作者会在负责人把请求投出去之前就开始第一轮：
        // 它读到的收件箱是空的，只能凭"请开始你的工作"自己猜要做什么。
        // 交给消息投递来唤醒（onMessageDelivered 对 idle 的 Worker 会入队）。
        status: 'idle',
      });
      return { ok: true, workerId: worker.id };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  listGroupWorkers(groupId: string): Worker[] {
    return this.store.listGroupWorkers(groupId);
  }

  // ---------------- 消息 ----------------

  /**
   * 三件事在一处保证：
   * 1) 广播按接收者各投一条，消费状态天然隔离；
   * 2) 只有 intent=review 的请求才产生检查记录；
   * 3) 回复正式检查必须给出结构化结论，否则请求保持 pending。
   */
  sendMessage(input: SendMessageInput): SendMessageResult {
    const from = this.store.getWorker(input.from.id);
    if (!from) return { ok: false, reason: '发送者不存在' };
    const task = this.store.getTaskByGroup(from.groupId);
    if (!task) return { ok: false, reason: '任务不存在' };
    if (isTerminalTask(task.status)) return { ok: false, reason: `任务已处于 ${task.status}，不能再发消息` };

    const intent = typeof input.intent === 'string' ? input.intent : null;
    const outcome = input.outcome ?? null;

    if ((input.kind === 'update' || input.kind === 'stop') && task.ownerWorkerId !== from.id) {
      return { ok: false, reason: '只有任务负责人可以发送 update / stop' };
    }
    if (outcome !== null && input.kind !== 'reply') {
      return { ok: false, reason: 'outcome 只能出现在 reply 上' };
    }
    if (intent === 'review' && input.kind !== 'request') {
      return { ok: false, reason: 'intent=review 只能用于 request' };
    }
    if (outcome !== null && !['approved', 'changes_required', 'inconclusive'].includes(outcome)) {
      return { ok: false, reason: `未知的检查结论：${outcome}` };
    }

    if (input.kind === 'request') {
      const depth = this.requestChainDepth(input.replyTo ?? null);
      if (depth >= this.config.limits.maxRequestHops) {
        return { ok: false, reason: `请求链已达上限 ${this.config.limits.maxRequestHops} 跳，请直接向负责人汇总` };
      }
    }

    let origin: Message | null = null;
    if (input.kind === 'reply') {
      if (!input.replyTo) return { ok: false, reason: 'reply 必须带 reply_to' };
      origin = this.store.getMessage(input.replyTo);
      if (!origin) return { ok: false, reason: `被回复的消息不存在：${input.replyTo}` };
      if (origin.groupId !== from.groupId) return { ok: false, reason: '不能跨群组回复' };
      if (origin.kind !== 'request') return { ok: false, reason: `只能回复 request，不能回复 ${origin.kind}` };
      if (origin.toKind === 'worker' && origin.toId !== from.id) {
        return { ok: false, reason: '只能回复发给自己的请求' };
      }
      if (origin.fromId === from.id) return { ok: false, reason: '不能回复自己发出的请求' };
      const existing = this.store
        .listGroupMessages(from.groupId, 500)
        .some((message) => message.replyTo === origin!.id && message.kind === 'reply');
      if (existing) return { ok: false, reason: '该请求已经有回复，请作为新请求继续讨论' };
      const reviews = this.store.listReviewsByRequest(origin.id);
      if (reviews.length > 0 && (outcome === null || outcome === 'pending')) {
        return {
          ok: false,
          reason: '这是正式检查请求，回复必须给出 outcome：approved / changes_required / inconclusive',
        };
      }
    }

    if (intent === 'review') {
      // 正式检查必须有可登记的检查对象：本任务的产物 id。只写文件路径不算检查依据。
      const normalized = this.normalizeRefs(input.refs ?? null, task.id);
      const requested = normalized?.artifacts ?? [];
      if (requested.length === 0) {
        return {
          ok: false,
          reason:
            '正式检查必须用 refs.artifacts 指定本任务的产物 id（形如 art_xxxxxxxx）；只写文件路径不会被登记为检查对象。' +
            '先用 artifact_save 保存产物，再把它的 id 放进 refs。',
        };
      }
      for (const ref of requested) {
        const artifact = this.store.getArtifact(ref.artifactId);
        if (!artifact) return { ok: false, reason: `检查对象不存在：${ref.artifactId}` };
        if (artifact.taskId !== task.id) {
          return { ok: false, reason: `检查对象 ${ref.artifactId} 不属于本任务，不能作为检查依据` };
        }
      }
    }

    const broadcast = input.to === 'group' || input.to === from.groupId;
    let recipients: Worker[];
    if (broadcast) {
      if (task.ownerWorkerId !== from.id) return { ok: false, reason: '只有任务负责人可以向全组广播' };
      if (intent === 'review') return { ok: false, reason: '检查请求必须指定具体的检查者，不能广播' };
      recipients = this.store
        .listGroupWorkers(from.groupId)
        .filter((worker) => worker.id !== from.id && !isTerminalWorker(worker.status));
      if (recipients.length === 0) return { ok: false, reason: '群组内没有其他可接收的 Worker' };
    } else {
      const target = this.store.getWorker(input.to);
      if (!target) return { ok: false, reason: `接收者不存在：${input.to}` };
      if (target.id === from.id) return { ok: false, reason: '不能给自己发消息' };
      if (target.groupId !== from.groupId) return { ok: false, reason: '跨群组消息需要先由 Router 建立关联' };
      if (isTerminalWorker(target.status)) return { ok: false, reason: `接收者 ${target.id} 已处于 ${target.status}` };
      recipients = [target];
    }

    const baseDedupe = input.dedupeKey ?? null;
    const broadcastId = broadcast ? newMessageId() : null;
    const createdIds: string[] = [];
    let firstMessageId: string | null = null;

    for (const recipient of recipients) {
      const dedupeKey = baseDedupe ? (broadcast ? `${baseDedupe}#${recipient.id}` : baseDedupe) : null;
      if (dedupeKey) {
        const existing = this.store.findMessageByDedupeKey(from.groupId, dedupeKey);
        if (existing) {
          createdIds.push(existing.id);
          firstMessageId ??= existing.id;
          continue;
        }
      }
      const message = this.buildMessage({
        from,
        task,
        toId: recipient.id,
        kind: input.kind,
        body: input.body,
        intent,
        outcome,
        replyTo: input.replyTo ?? null,
        refs: input.refs ?? null,
        dedupeKey,
        broadcastId,
      });
      this.store.tx(() => {
        this.store.insertMessage(message);
        this.store.setMessageStatus(message.id, 'delivered');
        if (intent === 'review' && message.refs?.artifacts?.length) {
          const reviews = message.refs.artifacts.map((ref) => {
            const artifact = this.store.getArtifact(ref.artifactId);
            if (!artifact) throw new Error(`产物未登记：${ref.artifactId}`);
            return {
              id: newReviewId(),
              taskId: task.id,
              artifactId: artifact.id,
              artifactVersion: artifact.version,
              artifactSha256: artifact.sha256,
              epoch: task.reviewEpoch,
              requestedBy: from.id,
              reviewerId: recipient.id,
              requestMessageId: message.id,
              replyMessageId: null,
              outcome: 'pending' as const,
              createdAt: nowIso(),
            };
          });
          this.store.createReviews(reviews);
        }
      });
      createdIds.push(message.id);
      firstMessageId ??= message.id;
      this.store.appendEvent(task.id, from.id, `message.${input.kind}`, `${from.id} → ${recipient.id}`);
      this.emit({ type: 'message.sent', messageId: message.id, from: from.id, to: recipient.id, kind: input.kind });
      this.onMessageDelivered(message);
    }

    if (input.kind === 'reply' && origin && outcome) {
      this.store.answerReview(origin.id, firstMessageId!, from.id, outcome);
    }
    if (!broadcast && (input.kind === 'update' || input.kind === 'stop')) {
      this.store.appendEvent(task.id, from.id, `message.${input.kind}.direct`, input.body.slice(0, 120));
    }

    return { ok: true, messageId: firstMessageId ?? undefined, messageIds: createdIds };
  }

  private buildMessage(input: {
    from: Worker;
    task: Task;
    toId: string;
    kind: MessageKind;
    body: string;
    intent: string | null;
    outcome: string | null;
    replyTo: string | null;
    refs: MessageRefs | null;
    dedupeKey: string | null;
    broadcastId: string | null;
  }): Message {
    const payload: Record<string, unknown> = {};
    if (input.intent) payload['intent'] = input.intent;
    if (input.outcome) payload['outcome'] = input.outcome;
    return {
      id: newMessageId(),
      groupId: input.from.groupId,
      taskId: input.task.id,
      fromKind: 'worker',
      fromId: input.from.id,
      toKind: 'worker',
      toId: input.toId,
      kind: input.kind,
      body: input.body,
      payload: Object.keys(payload).length > 0 ? payload : null,
      replyTo: input.replyTo,
      refs: this.normalizeRefs(input.refs, input.task.id),
      dedupeKey: input.dedupeKey,
      broadcastId: input.broadcastId,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    };
  }

  private normalizeRefs(refs: MessageRefs | null, taskId: string): MessageRefs | null {
    if (!refs) return null;
    const artifacts = [...(refs.artifacts ?? [])];
    for (const file of refs.files ?? []) {
      if (!file.startsWith('art_')) continue;
      const artifact = this.store.getArtifact(file);
      if (!artifact || artifact.taskId !== taskId) continue;
      if (artifacts.some((item) => item.artifactId === artifact.id)) continue;
      artifacts.push({ artifactId: artifact.id, name: artifact.name, version: artifact.version });
    }
    return {
      files: refs.files ?? [],
      artifacts,
      messages: refs.messages ?? [],
    };
  }

  private requestChainDepth(messageId: string | null): number {
    let depth = 0;
    let cursor = messageId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const message = this.store.getMessage(cursor);
      if (!message) break;
      if (message.kind === 'request') depth += 1;
      cursor = message.replyTo;
    }
    return depth;
  }

  private onMessageDelivered(message: Message): void {
    if (message.toKind === 'group') {
      for (const worker of this.store.listGroupWorkers(message.groupId)) {
        if (worker.status === 'waiting' && this.store.listActiveWaitsForWorker(worker.id).length === 0) {
          this.enqueue(worker.id);
        }
      }
      return;
    }
    if (message.toKind !== 'worker') return;
    const target = this.store.getWorker(message.toId);
    if (!target || isTerminalWorker(target.status)) return;

    const waits = this.store.listActiveWaitsForWorker(target.id);
    const matched = waits.find((wait) => this.matchWait(message, wait));
    if (matched) {
      this.store.resolveWait(matched.id);
      this.enqueue(target.id);
      return;
    }
    const control = message.kind === 'update' || message.kind === 'stop';
    if (control) {
      this.store.clearWaitsForWorker(target.id);
      this.enqueue(target.id);
      return;
    }
    if (target.status === 'idle') {
      this.enqueue(target.id);
      return;
    }
    if (target.status === 'waiting' && waits.length === 0) {
      this.enqueue(target.id);
    }
  }

  private matchWait(message: Message, wait: { matchFrom: string | null; matchReplyTo: string | null; matchKinds: MessageKind[] | null }): boolean {
    if (wait.matchFrom && message.fromId !== wait.matchFrom) return false;
    if (wait.matchReplyTo && message.replyTo !== wait.matchReplyTo) return false;
    if (wait.matchKinds && !wait.matchKinds.includes(message.kind)) return false;
    return true;
  }

  registerWait(worker: Worker, options: WaitOptions): WaitResult {
    const inbox = this.store.listInbox(worker.id);
    const already = inbox.some((message) =>
      this.matchWait(message, {
        matchFrom: options.from ?? null,
        matchReplyTo: options.replyTo ?? null,
        matchKinds: options.kinds ?? null,
      }),
    );
    if (already) return { immediate: true };

    this.store.clearWaitsForWorker(worker.id);
    const waitId = newWaitId();
    this.store.createWait({
      id: waitId,
      workerId: worker.id,
      groupId: worker.groupId,
      reason: options.reason ?? 'reply',
      matchFrom: options.from ?? null,
      matchReplyTo: options.replyTo ?? null,
      matchKinds: options.kinds ?? null,
      matchJob: options.jobId ?? null,
      deadlineAt: isoAfter(options.timeoutMs),
      createdAt: nowIso(),
      resolvedAt: null,
    });
    return { immediate: false, waitId };
  }

  // ---------------- 产物 ----------------

  // ---------------- 进程作业 ----------------

  startJob(input: {
    worker: Worker;
    taskId: string;
    command: string;
    args: string[];
    cwd: string;
    stdin: string | null;
    timeoutMs: number;
    signal?: AbortSignal | null;
  }): ProcessJob {
    const job = this.jobs.start({
      taskId: input.taskId,
      workerId: input.worker.id,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      signal: input.signal ?? null,
      logRoot: resolve(this.config.workDir, '.jobs'),
    });
    this.store.appendEvent(input.taskId, input.worker.id, 'job.started', `${job.id} ${input.command}`);
    return job;
  }

  readJob(jobId: string, stream: 'stdout' | 'stderr', offset: number, limit: number): JobOutput | null {
    return this.jobs.read(jobId, stream, offset, limit);
  }

  getJob(jobId: string): ProcessJob | null {
    return this.store.getJob(jobId);
  }

  listJobs(taskId: string): ProcessJob[] {
    return this.store.listJobs(taskId);
  }

  stopJob(jobId: string, reason: string): ProcessJob | null {
    const job = this.jobs.stop(jobId, reason);
    if (job) this.store.appendEvent(job.taskId, job.workerId, 'job.stopped', `${job.id} ${reason}`);
    return job;
  }

  /** 作业结束：唤醒正在等它的 Worker，否则它只能靠反复查询推进。 */
  private onJobFinished(job: ProcessJob): void {
    this.store.appendEvent(
      job.taskId,
      job.workerId,
      'job.finished',
      `${job.id} ${job.status}${job.exitCode === null ? '' : ` exit=${job.exitCode}`}`,
    );
    const waits = this.store.listActiveWaits().filter((wait) => wait.matchJob === job.id);
    for (const wait of waits) {
      this.store.resolveWait(wait.id);
      const worker = this.store.getWorker(wait.workerId);
      if (!worker || isTerminalWorker(worker.status)) continue;
      this.pushSystemNotice(
        worker.id,
        `作业 ${job.id} 已结束：${job.status}${job.exitCode === null ? '' : `，退出码 ${job.exitCode}`}。用 proc_read 查看输出。`,
      );
      this.enqueue(worker.id);
    }
  }

  waitJob(worker: Worker, jobId: string, timeoutMs: number): { immediate: boolean; job: ProcessJob | null } {
    const job = this.store.getJob(jobId);
    if (!job) return { immediate: true, job: null };
    if (job.status !== 'running') return { immediate: true, job };
    this.store.clearWaitsForWorker(worker.id);
    this.store.createWait({
      id: newWaitId(),
      workerId: worker.id,
      groupId: worker.groupId,
      reason: 'job',
      matchFrom: null,
      matchReplyTo: null,
      matchKinds: null,
      matchJob: jobId,
      deadlineAt: isoAfter(timeoutMs),
      createdAt: nowIso(),
      resolvedAt: null,
    });
    return { immediate: false, job };
  }

  /** 把任务目录里的真实文件按字节登记为产物。 */
  importArtifact(worker: Worker, name: string, sourcePath: string): { artifact: Artifact; reused: boolean } {
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) throw new Error('任务不存在');
    if (isTerminalTask(task.status)) throw new Error(`任务已处于 ${task.status}，不能再保存产物`);
    const root = resolve(this.config.workDir, task.id);
    const absolute = resolveInside(root, sourcePath);
    assertInsideRoot(root, absolute);
    if (!existsSync(absolute)) throw new Error(`源文件不存在：${sourcePath}`);
    const info = statSync(absolute);
    if (!info.isFile()) throw new Error(`不是文件：${sourcePath}`);
    if (info.size > 100_000_000) throw new Error(`文件过大（${info.size} 字节），上限 100MB`);
    const bytes = readFileSync(absolute);
    const safeName = normalizeRelativePath(name, '产物文件名');
    const latest = this.store.latestArtifactByName(task.id, safeName);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (latest && latest.sha256 === digest) {
      this.store.appendEvent(task.id, worker.id, 'artifact.reused', `${safeName} v${latest.version}`);
      return { artifact: latest, reused: true };
    }
    const version = (latest?.version ?? 0) + 1;
    const relativePath = `${task.id}/artifacts/v${version}/${safeName}`;
    const target = resolveInside(this.config.workDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    assertInsideRoot(root, dirname(target));
    writeFileSyncSafe(target, bytes);
    const artifact: Artifact = {
      id: newArtifactId(),
      taskId: task.id,
      workerId: worker.id,
      name: safeName,
      path: relativePath,
      version,
      sha256: digest,
      bytes: info.size,
      createdAt: nowIso(),
    };
    try {
      this.store.insertArtifact(artifact);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
    this.store.appendEvent(task.id, worker.id, 'artifact.saved', `${safeName} v${version}（导入 ${sourcePath}）`);
    return { artifact, reused: false };
  }

  /**
   * 每个版本写独立路径，旧版本内容不再被覆盖；
   * 文件写成功但登记失败时删掉文件，不留下"看起来成功"的状态。
   */
  saveArtifact(worker: Worker, name: string, content: string): { artifact: Artifact; reused: boolean } {
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) throw new Error('任务不存在');
    if (isTerminalTask(task.status)) throw new Error(`任务已处于 ${task.status}，不能再保存产物`);
    const safeName = normalizeRelativePath(name, '产物文件名');
    const latest = this.store.latestArtifactByName(task.id, safeName);
    // 内容与最新版本完全相同时复用，不制造无意义的新版本；这不会改变检查状态。
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    if (latest && latest.sha256 === digest) {
      this.store.appendEvent(task.id, worker.id, 'artifact.reused', `${safeName} v${latest.version}`);
      return { artifact: latest, reused: true };
    }
    const version = (latest?.version ?? 0) + 1;
    const relativePath = `${task.id}/artifacts/v${version}/${safeName}`;
    const absolutePath = resolveInside(this.config.workDir, relativePath);
    const root = resolve(this.config.workDir, task.id);
    mkdirSync(dirname(absolutePath), { recursive: true });
    assertInsideRoot(root, dirname(absolutePath));

    const bytes = Buffer.from(content, 'utf8');
    writeFileSyncSafe(absolutePath, bytes);
    const artifact: Artifact = {
      id: newArtifactId(),
      taskId: task.id,
      workerId: worker.id,
      name: safeName,
      path: relativePath,
      version,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      createdAt: nowIso(),
    };
    try {
      this.store.insertArtifact(artifact);
    } catch (error) {
      try {
        rmSync(absolutePath, { force: true });
      } catch {
        // 清理失败不覆盖原始错误
      }
      throw error;
    }
    this.store.appendEvent(task.id, worker.id, 'artifact.saved', `${safeName} v${version}`);
    return { artifact, reused: false };
  }

  getArtifact(id: string): Artifact | null {
    return this.store.getArtifact(id);
  }

  /** 按版本读取产物内容，并校验登记时的指纹，防止文件被绕过改写。 */
  async readArtifactVersion(
    taskId: string,
    name: string,
    version?: number | null,
  ): Promise<{ artifact: Artifact; content: string }> {
    const safeName = normalizeRelativePath(name, '产物文件名');
    const artifact =
      version === null || version === undefined
        ? this.store.latestArtifactByName(taskId, safeName)
        : this.store.getArtifactVersion(taskId, safeName, version);
    if (!artifact) {
      throw new Error(version === null || version === undefined ? `产物不存在：${safeName}` : `产物不存在：${safeName} v${version}`);
    }
    const absolute = resolveInside(this.config.workDir, artifact.path);
    if (!existsSync(absolute)) throw new Error(`产物文件缺失：${safeName} v${artifact.version}`);
    const content = await readFile(absolute, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(`产物内容与登记不一致（${safeName} v${artifact.version}），拒绝按旧版本号读取`);
    }
    return { artifact, content };
  }

  listArtifacts(taskId: string): Artifact[] {
    return this.store.listArtifacts(taskId);
  }

  isCancelled(taskId: string): boolean {
    const task = this.store.getTask(taskId);
    return !task || task.status === 'cancelled';
  }

  // ---------------- 提交与汇报 ----------------

  /**
   * 交付校验。检查要求按「产物 id + 内容指纹 + 当前要求版本」精确匹配：
   * 检查旧版本、检查别的文件、结论不是通过、或者检查后又改了内容，都拿不到放行。
   */
  async submitResult(worker: Worker, summary: string, artifactNames: string[]): Promise<SubmitResult> {
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) return { ok: false, reason: '任务不存在' };
    if (isTerminalTask(task.status)) return { ok: false, reason: `任务已处于 ${task.status}` };
    if (task.ownerWorkerId !== worker.id) return { ok: false, reason: '只有任务负责人可以提交最终结果' };
    if (artifactNames.length === 0) return { ok: false, reason: '必须至少引用一个已保存的产物' };

    const resolved: Artifact[] = [];
    for (const name of artifactNames) {
      let safeName: string;
      try {
        safeName = normalizeRelativePath(name, '产物文件名');
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      const artifact = this.store.latestArtifactByName(task.id, safeName);
      if (!artifact) return { ok: false, reason: `产物未登记：${name}` };
      const absolute = resolveInside(this.config.workDir, artifact.path);
      if (!existsSync(absolute)) return { ok: false, reason: `产物文件不存在：${name}` };
      const content = await readFile(absolute);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== artifact.sha256) return { ok: false, reason: `产物内容与登记不一致：${name}` };
      resolved.push(artifact);
    }

    const pendingUpdates = this.store
      .listInbox(worker.id)
      .filter((message) => message.kind === 'update' || message.kind === 'stop');
    if (pendingUpdates.length > 0) {
      return { ok: false, reason: `还有 ${pendingUpdates.length} 条未处理的补充要求或停止指令` };
    }

    if (task.requireReview) {
      const reviews = this.store.listReviews(task.id);
      const current = reviews.filter((review) => review.epoch === task.reviewEpoch);
      const missing = resolved.filter(
        (artifact) =>
          !current.some(
            (review) =>
              review.artifactId === artifact.id &&
              review.artifactSha256 === artifact.sha256 &&
              review.outcome === 'approved',
          ),
      );
      if (missing.length > 0) {
        const stats = {
          pending: current.filter((review) => review.outcome === 'pending').length,
          changes: current.filter((review) => review.outcome === 'changes_required').length,
          inconclusive: current.filter((review) => review.outcome === 'inconclusive').length,
          stale: reviews.length - current.length,
        };
        const names = missing.map((artifact) => `${artifact.name} v${artifact.version}`).join('、');
        return {
          ok: false,
          reason:
            `以下产物没有当前要求（要求版本 ${task.reviewEpoch}）下明确的检查通过结论：${names}。` +
            `检查记录：待回复 ${stats.pending}、需修改 ${stats.changes}、无法判断 ${stats.inconclusive}、旧要求 ${stats.stale}。` +
            `请对最新版本重新取得 approved 结论。`,
        };
      }
    }

    const artifactIds = resolved.map((artifact) => artifact.id);
    const now = nowIso();
    this.store.tx(() => {
      this.store.insertMessage({
        id: newMessageId(),
        groupId: task.groupId,
        taskId: task.id,
        fromKind: 'worker',
        fromId: worker.id,
        toKind: 'router',
        toId: 'router',
        kind: 'result',
        body: summary,
        payload: null,
        replyTo: null,
        refs: { artifacts: resolved.map((artifact) => ({ artifactId: artifact.id, name: artifact.name, version: artifact.version })) },
        dedupeKey: null,
        broadcastId: null,
        status: 'queued',
        createdAt: now,
        deliveredAt: null,
        consumedAt: null,
        error: null,
      });
      this.store.setTaskStatus(task.id, 'completed', { reason: summary.slice(0, 400) });
      this.store.setWorkerStatus(worker.id, 'done');
    });
    // 正常完成与失败、取消使用同一套收尾：终态任务不应留下仍在执行的后台作业。
    this.stopTaskJobs(task.id, '任务已完成');
    this.store.appendEvent(task.id, worker.id, 'task.completed', summary.slice(0, 200));
    this.emit({ type: 'task.status', taskId: task.id, status: 'completed', reason: summary });
    // 协作者必须一起收敛：任务已完成，还在跑的协作者不能继续占着执行槽改业务。
    this.convergeGroup(task.groupId, '任务已完成，协作终止');
    this.router?.notify();
    return { ok: true, artifactIds };
  }

  report(worker: Worker, kind: 'progress' | 'fail' | 'question', body: string, refs?: MessageRefs): ReportResult {
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) return { ok: false, reason: '任务不存在' };
    const message: Message = {
      id: newMessageId(),
      groupId: task.groupId,
      taskId: task.id,
      fromKind: 'worker',
      fromId: worker.id,
      toKind: 'router',
      toId: 'router',
      kind,
      body,
      payload: null,
      replyTo: null,
      refs: this.normalizeRefs(refs ?? null, task.id),
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    };
    this.store.insertMessage(message);
    this.store.appendEvent(task.id, worker.id, `report.${kind}`, body.slice(0, 160));
    if (kind === 'fail' && task.ownerWorkerId === worker.id) {
      void this.failTask(task.id, `负责人报告失败：${body.slice(0, 200)}`);
    }
    // 进度也要唤醒 Router：Worker 报了进度却没人叫醒它，进度就一直躺在收件箱里，
    // 用户只能自己来问——在他眼里就是"跑完了你没发"。节流是为了不让话密的 Worker 刷屏。
    const now = Date.now();
    if (kind === 'fail' || kind === 'question') {
      this.router?.notify();
    } else if (now - (this.progressNotifyAt.get(task.id) ?? 0) >= PROGRESS_NOTIFY_INTERVAL_MS) {
      this.progressNotifyAt.set(task.id, now);
      this.router?.notify();
    }
    return { ok: true, messageId: message.id };
  }

  sendRouterMessage(input: {
    taskId: string;
    kind: 'update' | 'stop';
    workerId: string;
    body: string;
  }): { ok: boolean; messageId?: string; reason?: string } {
    const task = this.store.getTask(input.taskId);
    if (!task) return { ok: false, reason: '任务不存在' };
    if (isTerminalTask(task.status)) return { ok: false, reason: `任务已 ${task.status}，不接受新的指令` };
    const worker = this.store.getWorker(input.workerId);
    if (!worker) return { ok: false, reason: 'Worker 不存在' };
    if (worker.groupId !== task.groupId) return { ok: false, reason: 'Worker 不属于该任务' };
    if (isTerminalWorker(worker.status)) return { ok: false, reason: `Worker 已处于 ${worker.status}` };

    const message: Message = {
      id: newMessageId(),
      groupId: task.groupId,
      taskId: task.id,
      fromKind: 'router',
      fromId: 'router',
      toKind: 'worker',
      toId: worker.id,
      kind: input.kind,
      body: input.body,
      payload: null,
      replyTo: null,
      refs: null,
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    };
    this.store.insertMessage(message);
    this.store.setMessageStatus(message.id, 'delivered');
    this.store.appendEvent(task.id, null, `router.${input.kind}`, worker.id);
    if (input.kind === 'update') {
      // 补充要求写入任务定义，后续 Worker 的 system prompt 都能看到；
      // 同时抬升要求版本，旧检查结论不再作为新要求的验收依据。
      this.store.updateTaskRequirements(task.id, { brief: `${task.brief}\n[补充要求 ${nowIso()}] ${input.body}`.trim() });
      this.store.bumpReviewEpoch(task.id);
    }
    this.emit({ type: 'message.sent', messageId: message.id, from: 'router', to: worker.id, kind: input.kind });
    this.onMessageDelivered(message);
    return { ok: true, messageId: message.id };
  }

  async stopTask(taskId: string, reason: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    if (isTerminalTask(task.status)) return false;
    this.store.setTaskStatus(taskId, 'cancelled', { reason });
    this.store.appendEvent(taskId, null, 'task.cancelled', reason);
    this.emit({ type: 'task.status', taskId, status: 'cancelled', reason });
    this.stopTaskJobs(taskId, `任务已取消：${reason}`);
    this.closeGroup(task.groupId, `任务已取消：${reason}`);
    this.router?.notify();
    return true;
  }

  /** 任务进入终态时同时结束在途命令，避免交付后还有进程在改文件。 */
  private stopTaskJobs(taskId: string, reason: string): void {
    const stopped = this.jobs.stopAllForTask(taskId, reason);
    for (const jobId of stopped) {
      this.store.appendEvent(taskId, null, 'job.stopped', `${jobId} ${reason}`);
    }
  }

  async failTask(taskId: string, reason: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    if (isTerminalTask(task.status)) return false;
    this.stopTaskJobs(taskId, `任务失败：${reason}`);
    this.store.setTaskStatus(taskId, 'failed', { reason });
    this.store.appendEvent(taskId, null, 'task.failed', reason);
    this.emit({ type: 'task.status', taskId, status: 'failed', reason });
    this.store.insertMessage({
      id: newMessageId(),
      groupId: task.groupId,
      taskId,
      fromKind: 'system',
      fromId: 'system',
      toKind: 'router',
      toId: 'router',
      kind: 'fail',
      body: reason,
      payload: null,
      replyTo: null,
      refs: null,
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    });
    this.closeGroup(task.groupId, `任务失败：${reason}`);
    this.router?.notify();
    return true;
  }

  /**
   * 任务终结后收敛组内协作者。
   *
   * - 已经拿到真实结果的保留原状态（done / failed）；
   * - 还在执行或等待的，进入 cancelled 并写明原因；
   * - 取消它们正在进行的模型请求，阻止后续工具调用落地。
   *
   * 这不改变任务本身的结果：任务状态在调用前就已经定了。
   */
  private convergeGroup(groupId: string, reason: string): void {
    for (const worker of this.store.listGroupWorkers(groupId)) {
      if (isTerminalWorker(worker.status)) continue;
      this.store.clearWaitsForWorker(worker.id);
      this.runs.get(worker.id)?.revoke('任务已结束');
      this.store.setWorkerStatus(worker.id, 'cancelled', reason);
      this.emit({ type: 'worker.status', workerId: worker.id, status: 'cancelled' });
    }
  }

  private closeGroup(groupId: string, reason: string, exceptWorkerId?: string): void {
    for (const worker of this.store.listGroupWorkers(groupId)) {
      if (worker.id === exceptWorkerId) continue;
      if (isTerminalWorker(worker.status)) continue;
      this.store.clearWaitsForWorker(worker.id);
      // 正在运行的 Worker 会在下一个检查点自行退出，这里只处理空闲/等待中的。
      if (worker.status === 'running') continue;
      this.store.setWorkerStatus(worker.id, 'cancelled', reason);
      this.emit({ type: 'worker.status', workerId: worker.id, status: 'cancelled' });
    }
  }

  // ---------------- 调度 ----------------

  /**
   * 请求调度。运行中收到请求不会丢：记在 rerunRequested，等本轮结束后再跑一次。
   * 这样既保证「跑完再来」，又保证同一 Worker 同时只有一个执行过程。
   */
  enqueue(workerId: string): void {
    const target = this.store.getWorker(workerId);
    const targetTask = target ? this.store.getTaskByGroup(target.groupId) : null;
    if (targetTask && Number(targetTask.maintenance ?? 0) === 1) return;
    if (this.stopped) return;
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    if (this.running.has(workerId)) {
      this.rerunRequested.add(workerId);
      return;
    }
    if (this.queue.includes(workerId)) return;
    this.queue.push(workerId);
    this.pump();
  }

  private pump(): void {
    if (process.env['DEBUG_RUN']) console.error(`[pump] queue=${this.queue.length} running=${this.runningCount}`);
    while (!this.stopped && this.runningCount < this.config.limits.maxConcurrentRuns) {
      const workerId = this.queue.shift();
      if (!workerId) return;
      if (this.running.has(workerId)) continue;
      const worker = this.store.getWorker(workerId);
      if (!worker || isTerminalWorker(worker.status)) continue;
      this.running.add(workerId);
      this.runningCount += 1;
      void this.runWorker(workerId)
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(workerId);
          this.runs.delete(workerId);
          this.runningCount -= 1;
          if (this.rerunRequested.delete(workerId)) {
            const current = this.store.getWorker(workerId);
            if (current && !isTerminalWorker(current.status) && !this.queue.includes(workerId)) {
              this.queue.push(workerId);
            }
          }
          this.pump();
        });
    }
  }

  private async runWorker(workerId: string): Promise<void> {
    const execution = new Execution(`worker:${workerId}`);
    this.runs.set(workerId, execution);
    try {
      await execution.run(() => this.runWorkerBody(workerId));
    } catch (error) {
      if (error instanceof ExecutionRevoked || !execution.active) {
        // 执行已经被撤销（停机 / 任务终结 / 代次失效）：
        // 这条路径上不能再写库，也不能把业务判死。
        return;
      }
      await this.handleRunError(workerId, error);
    } finally {
      this.runs.delete(workerId);
    }
  }

  /**
   * Worker 的一次调度。
   *
   * 循环、工具批处理、输出被上限截断时的工具作废都交给 pi 的 agent-loop
   * （见 src/vendor/pi）；epoch 撤销、收件箱、步数计量、落库、等待/提交的终态
   * 仍然由这里决定——「模型表达意图，程序决定事实」不因为换了循环而改变。
   */
  private async runWorkerBody(workerId: string): Promise<void> {
    let worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    let task = this.store.getTaskByGroup(worker.groupId);
    if (!task) {
      await this.failWorker(workerId, '任务不存在');
      return;
    }
    if (isTerminalTask(task.status)) {
      this.store.setWorkerStatus(workerId, 'cancelled', '任务已结束');
      return;
    }

    this.store.setWorkerStatus(workerId, 'running');
    this.emit({ type: 'worker.status', workerId, status: 'running' });

    const epoch = this.store.getWorker(workerId)?.runEpoch ?? 0;
    const runController = this.runs.get(workerId);
    const staleReason = (): string | null => {
      const gate = this.canRun(workerId, epoch);
      return gate.ok ? null : gate.reason;
    };

    // 收件箱先落入历史再标记已读：模型后续步骤仍能看到消息原文与编号。
    const inbox = this.store.listInbox(workerId);
    if (inbox.length > 0) {
      this.recordInboxTurn(workerId, inbox);
      for (const message of inbox) this.markConsumed(message.id);
    }

    this.ensureOpeningTurn(workerId);
    const messages = await this.buildWorkerMessages(worker, task);
    const systemPrompt = messages.find((message) => message.role === 'system')?.content ?? '';
    const chat = messages.filter((message) => message.role !== 'system');
    const prompts = chat.slice(0, 1);
    const history = chat.slice(1);

    const beforeRequest = this.canRun(workerId, epoch);
    if (!beforeRequest.ok) {
      this.store.appendEvent(task.id, workerId, 'run.stale', `准备完成后停止：${beforeRequest.reason}`);
      this.settleWorker(workerId, beforeRequest.reason);
      return;
    }

    let nudges = 0;
    const resolved = this.models.resolve(worker.model ?? this.config.defaultModelAlias);

    const result = await runWorkerTurn({
      model: resolved.model,
      modelClient: new RecordingModel(resolved.client, this.store, 'worker', {
        taskId: task.id,
        workerId,
        modelAlias: resolved.alias,
      }),
      systemPrompt,
      prompts,
      history,
      tools: this.tools.schemas(),
      maxSteps: this.config.limits.maxStepsPerRun,
      signal: runController?.signal ?? null,
      reasoningEffort: this.config.reasoningEffort,
      canContinue: staleReason,
      stopOnPlainText: task.ownerWorkerId !== workerId,
      pullInbox: () => {
        const fresh = this.store.listInbox(workerId);
        if (fresh.length === 0) return [];
        this.recordInboxTurn(workerId, fresh);
        for (const message of fresh) this.markConsumed(message.id);
        return fresh.map((message) => ({ role: 'user' as const, content: message.body }));
      },
      onTerminate: (rest, reason) => {
        const current = this.store.getWorker(workerId);
        if (!current) return;
        this.recordUnexecuted(
          current,
          rest,
          reason.includes('等待') ? '本次运行因等待而提前结束，该调用未执行' : '本次运行因提交/停止而结束，该调用未执行',
        );
      },
      onStep: (message: AssistantMessage) => {
        // 模型响应回来之后、动手之前再核一次：暂停或取消后旧响应不得再落库。
        // 这里必须留痕——静默丢弃会让历史里出现「调用过但没有结果」的假象。
        const afterModel = this.canRun(workerId, epoch);
        if (!afterModel.ok) {
          const current = this.store.getWorker(workerId);
          if (current) this.recordStaleResult(current, toStepResult(message), afterModel.reason);
          return;
        }
        const stepResult = toStepResult(message);
        this.store.bumpWorkerStep(workerId);
        const current = this.store.getWorker(workerId);
        if (current) this.recordAssistantTurn(current, stepResult);
        if (stepResult.toolCalls.length === 0 && task && task.ownerWorkerId === workerId) {
          nudges += 1;
          if (nudges === this.config.limits.maxNudges + 1) {
            this.store.appendEvent(task.id, workerId, 'worker.text_only', `连续 ${nudges} 次只输出文本未调用工具`);
          }
          this.pushSystemNotice(workerId, '你还没有调用 submit_result。工作若已完成，请先 artifact_save 保存产物再提交；否则继续推进。');
        }
      },
      runTool: async (call: { id: string; name: string; arguments: string }) => {
        const current = this.store.getWorker(workerId);
        const ownerGroupId = this.store.getWorker(workerId)?.groupId;
        const budgetTask = ownerGroupId ? this.store.getTaskByGroup(ownerGroupId) : null;
        if (current && budgetTask) this.noteBudget(current, budgetTask);
        const before = this.canRun(workerId, epoch);
        if (!before.ok) {
          return { outcome: { type: 'failed', content: `未执行：${before.reason}` }, terminate: true };
        }
        const liveTask = ownerGroupId ? this.store.getTaskByGroup(ownerGroupId) : null;
        if (liveTask && Number(liveTask.maintenance ?? 0) === 1) {
          return { outcome: { type: 'failed', content: '未执行：任务处于维护挂起' }, terminate: true };
        }
        if (!liveTask || isTerminalTask(liveTask.status)) {
          return { outcome: { type: 'failed', content: '未执行：任务已结束' }, terminate: true };
        }
        const toolCall: ToolCall = { id: call.id, name: call.name, arguments: call.arguments };
        const outcome = await this.tools.execute(call.name, call.arguments, this.toolContext(workerId));
        const fresh = this.store.getWorker(workerId);
        if (fresh) this.recordToolTurn(fresh, toolCall, outcome.content);
        // wait / finish 改变 Worker 终态，交给外层统一结算，不在这里直接改。
        return { outcome, terminate: outcome.type === 'wait' || outcome.type === 'finish' };
      },
    });

    worker = this.store.getWorker(workerId) ?? worker;
    task = this.store.getTaskByGroup(worker.groupId) ?? task;

    if (result.stop === 'cancelled') {
      this.store.appendEvent(task.id, workerId, 'run.stale', `第 ${result.steps} 步后停止：${result.reason ?? '执行被取消'}`);
      this.settleWorker(workerId, result.reason ?? '执行被取消');
      return;
    }
    if (result.stop === 'error') {
      // 交给 runWorker 的 catch → handleRunError：失败判定的 revoke 会撤销当前
      // Execution，在这里直接写库会被自己的撤销挡住，落不进库。
      throw new Error(result.reason ?? '模型调用失败');
    }
    if (result.stop === 'wait') {
      this.store.setWorkerStatus(workerId, 'waiting');
      this.emit({ type: 'worker.status', workerId, status: 'waiting' });
      this.checkGroupDeadlock(worker.groupId);
      return;
    }
    if (result.stop === 'finish') return;

    // 单轮步数用完但整体预算还在：转回 queued 请求下一轮。
    const endState = this.store.getWorker(workerId);
    if (endState && endState.status === 'running') {
      this.store.setWorkerStatus(workerId, 'queued');
      this.emit({ type: 'worker.status', workerId, status: 'queued' });
      this.enqueue(workerId);
    }
  }

  /**
   * pi 的 AssistantMessage → 本项目的 StepResult（只用于落库与诊断）。
   * 两个形状的差别只在工具参数：pi 存对象，我们存原始 JSON 字符串。
   */
  /**
   * 预算提醒：达到软阈值只写事件，不改变执行。
   * 真正的资源约束是并发、执行时限和每轮调度额度。
   */
  private noteBudget(worker: Worker, task: Task): void {
    const workerLimit = this.config.limits.maxStepsPerWorker;
    // 每个阈值只提醒一次，避免之后每一步都写同样的事件。
    if (workerLimit > 0 && worker.stepCount >= workerLimit) {
      const band = Math.floor(worker.stepCount / workerLimit);
      const key = `budget.worker.${workerLimit}.${band}`;
      if (!this.budgetNoted.has(key)) {
        this.budgetNoted.add(key);
        this.store.appendEvent(task.id, worker.id, 'budget.worker', `已执行 ${worker.stepCount} 步（提醒阈值 ${workerLimit}）`);
      }
    }
    const groupLimit = this.config.limits.maxStepsPerGroup;
    if (groupLimit > 0) {
      const total = this.store.groupStepTotal(worker.groupId);
      if (total >= groupLimit) {
        const band = Math.floor(total / groupLimit);
        const key = `budget.group.${groupLimit}.${band}`;
        if (!this.budgetNoted.has(key)) {
          this.budgetNoted.add(key);
          this.store.appendEvent(task.id, worker.id, 'budget.group', `群组已执行 ${total} 步（提醒阈值 ${groupLimit}）`);
        }
      }
    }
  }

  /** Router 有保存的协调进度时自动继续，不等用户再说话。 */
  private pumpRouter(): void {
    const router = this.router;
    if (!router || this.stopped) return;
    if (!router.hasPendingSession?.()) {
      // 没有断点，但收件箱里有没送达的 Worker 消息：启动后补报一次，
      // 否则它们会一直躺着，直到用户自己来问"跑完了吗"。
      // 只做一次：汇报失败时消息仍留在收件箱，反复重试会变成无限模型调用。
      if (!this.inboxCatchUpDone) {
        this.inboxCatchUpDone = true;
        if (this.store.routerInboxTargets().length > 0) void this.router?.notify?.();
      }
      return;
    }
    void router.resume?.().catch((error: unknown) => {
      this.store.appendEvent(null, null, 'router.resume_failed', (error as Error).message);
    });
  }

  /**
   * 执行控制命令。命令由外部维护者写入，主系统在自己的调度里执行，
   * 这样维护动作走的是既有不变量，而不是直接改数据库。
   */
  private drainControls(): void {
    if (this.stopped) return;
    for (const command of this.store.listPendingControls()) {
      try {
        const payload = command.payload ? (JSON.parse(command.payload) as Record<string, unknown>) : {};
        const result = this.applyControl(command.command, payload);
        this.store.finishControl(command.id, result.ok ? 'done' : 'failed', result.message);
        this.store.appendEvent(null, null, 'control.applied', `${command.command}: ${result.message}`);
      } catch (error) {
        this.store.finishControl(command.id, 'failed', (error as Error).message);
      }
    }
  }

  private applyControl(command: string, payload: Record<string, unknown>): { ok: boolean; message: string } {
    const str = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '');
    switch (command) {
      case 'pause_task': {
        const taskId = str('taskId');
        const task = this.store.getTask(taskId);
        if (!task) return { ok: false, message: `任务不存在：${taskId}` };
        if (isTerminalTask(task.status)) return { ok: false, message: `任务已 ${task.status}` };
        this.store.setMaintenance(taskId, true);
        // 推进代次：挂起之前发出的模型响应从此不再有执行资格。
        this.store.bumpGroupEpoch(task.groupId);
        this.store.appendEvent(taskId, null, 'task.maintenance', str('reason') || '维护挂起');
        for (const job of this.store.listRunningJobs(taskId)) {
          this.store.appendEvent(taskId, job.workerId, 'job.kept', `${job.id} 维护挂起期间保留运行`);
        }
        return { ok: true, message: `任务 ${taskId} 已挂起，正在运行的作业保留` };
      }
      case 'resume_task': {
        const taskId = str('taskId');
        const task = this.store.getTask(taskId);
        if (!task) return { ok: false, message: `任务不存在：${taskId}` };
        this.store.setMaintenance(taskId, false);
        this.store.appendEvent(taskId, null, 'task.resumed', str('reason') || '维护恢复');
        for (const worker of this.store.listGroupWorkers(task.groupId)) {
          if (isTerminalWorker(worker.status)) continue;
          // 只解除维护造成的阻塞；provider / job / reply / user 等待保持原义。
          for (const wait of this.store.listActiveWaitsForWorker(worker.id)) {
            if (wait.reason === 'maintenance') this.store.resolveWait(wait.id);
          }
          const remaining = this.store.listActiveWaitsForWorker(worker.id);
          if (remaining.length > 0) {
            this.store.appendEvent(taskId, worker.id, 'task.resume_keep_wait', `保留 ${remaining.map((item) => item.reason).join(',')} 等待`);
            continue;
          }
          if (worker.status !== 'running') this.enqueue(worker.id);
        }
        return { ok: true, message: `任务 ${taskId} 已恢复调度` };
      }
      case 'stop_task': {
        // 运维停机：和 Router 的 stop_task 走同一条路径，终态与收尾规则一致。
        // stopTask 的实现全同步，所以这里不需要 await，命令状态如实反映结果。
        const taskId = str('taskId');
        const task = this.store.getTask(taskId);
        if (!task) return { ok: false, message: `任务不存在：${taskId}` };
        if (isTerminalTask(task.status)) return { ok: false, message: `任务已 ${task.status}` };
        void this.stopTask(taskId, str('reason') || '运维停机');
        return { ok: true, message: `任务 ${taskId} 已停机` };
      }
      case 'nudge_worker': {
        const workerId = str('workerId');
        const worker = this.store.getWorker(workerId);
        if (!worker) return { ok: false, message: `Worker 不存在：${workerId}` };
        if (isTerminalWorker(worker.status)) return { ok: false, message: `Worker 已 ${worker.status}` };
        this.pushSystemNotice(workerId, str('text') || '维护者提醒：请核对当前方向是否仍在推进任务目标。', {
          wake: 'force',
        });
        return { ok: true, message: `已提醒 ${workerId}` };
      }
      case 'set_override': {
        const key = str('key');
        if (key === '') return { ok: false, message: '缺少 key' };
        const content = str('content');
        const check = validateOverride(key, content);
        if (!check.ok) return check;
        const { version } = this.store.insertOverride({
          id: `ov_${newMessageId().slice(4)}`,
          key,
          content,
          reason: str('reason') || '未说明',
          author: str('author') || 'watchdog',
        });
        this.store.appendEvent(null, null, 'behavior.override', `${key} v${version} 已生效（下一次构建提示词时读取）`);
        return { ok: true, message: `${key} v${version} 已激活` };
      }
      case 'rollback_override': {
        const key = str('key');
        const version = Number(payload['version'] ?? 0);
        const ok = this.store.rollbackOverride(key, version);
        return ok
          ? { ok: true, message: `${key} 已回滚到 v${version}` }
          : { ok: false, message: `找不到 ${key} v${version}` };
      }
      default:
        return { ok: false, message: `未知控制命令：${command}` };
    }
  }

  /**
   * 统一执行资格：所有执行入口（出队、每轮开头、发起请求前、响应返回后、工具调用前）用同一套规则。
   * 代次负责识别旧响应，这里负责决定还能不能继续。
   */
  private canRun(workerId: string, epoch: number): { ok: true } | { ok: false; reason: string; terminal: boolean } {
    if (this.stopped) return { ok: false, reason: '系统已停止', terminal: false };
    const worker = this.store.getWorker(workerId);
    if (!worker) return { ok: false, reason: 'Worker 不存在', terminal: true };
    if (isTerminalWorker(worker.status)) return { ok: false, reason: `Worker 已 ${worker.status}`, terminal: true };
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) return { ok: false, reason: '任务不存在', terminal: true };
    if (isTerminalTask(task.status)) return { ok: false, reason: `任务已 ${task.status}`, terminal: true };
    if (Number(task.maintenance ?? 0) === 1) return { ok: false, reason: '任务处于维护挂起', terminal: false };
    if ((worker.runEpoch ?? 0) !== epoch) return { ok: false, reason: '运行代次已变化', terminal: false };
    return { ok: true };
  }

  /**
   * 执行过程结束时的统一收尾：把 Worker 落到一个能解释的状态。
   * 只有实际执行的过程可以把状态维持在 running；退出时必须说明它为什么继续、等待或结束。
   */
  private settleWorker(workerId: string, reason: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    if (worker.status !== 'running') return;
    const task = this.store.getTaskByGroup(worker.groupId);
    if (this.stopped) return;
    if (task && isTerminalTask(task.status)) {
      // 任务已经结束：仍在执行的协作者要收敛，不能一直挂在 running。
      this.store.setWorkerStatus(workerId, 'cancelled', `任务已 ${task.status}，协作终止`);
      return;
    }
    if (task && Number(task.maintenance ?? 0) === 1) {
      this.store.setWorkerStatus(workerId, 'waiting', reason);
      return;
    }
    const waits = this.store.listActiveWaitsForWorker(workerId);
    if (waits.length > 0) {
      this.store.setWorkerStatus(workerId, 'waiting', reason);
      return;
    }
    this.store.setWorkerStatus(workerId, 'waiting', reason);
    this.enqueue(workerId);
  }

  /** 迟到响应：只记程序事件，不伪造工具结果，也不冒充成功。 */
  private recordStaleResult(worker: Worker, result: { text: string | null; toolCalls: ToolCall[] }, reason: string): void {
    const task = this.store.getTaskByGroup(worker.groupId);
    // 不写成 tool 消息：没有对应调用的 tool 结果会让下一次请求结构不合法。
    // 这些调用从未派发，因此是"未执行"，不是"结果未知"。
    this.store.appendWorkerTurn({
      id: `turn_${worker.id}_${this.store.countWorkerTurns(worker.id) + 1}`,
      workerId: worker.id,
      seq: this.store.countWorkerTurns(worker.id) + 1,
      role: 'assistant',
      content:
        `（程序说明）上一次模型响应在${reason}之后才返回，其中的 ${result.toolCalls.length} 个工具调用**未执行**。` +
        `这不是执行结果，不要把它们当成已完成。`,
      toolCalls: null,
      toolCallId: null,
      createdAt: nowIso(),
    });
    this.store.appendEvent(task?.id ?? null, worker.id, 'run.stale', `${reason}；丢弃 ${result.toolCalls.length} 个未派发调用`);
  }

  /** 为未执行的调用补一条明确的 tool 记录，不伪造成功。 */
  private recordUnexecuted(worker: Worker, calls: ToolCall[], reason: string): void {
    for (const call of calls) {
      this.recordToolTurn(worker, call, `[未执行] ${call.name}：${reason}`);
    }
  }

  /** 当前生效的行为覆盖；每次构建提示词时读取，改了下一轮就生效。 */
  private currentOverride(): { content: string; version: number } | null {
    return this.store.activeOverride('worker.check_rules');
  }

  private planFor(worker: Worker): HistoryPlan {
    return planHistory({
      store: this.store,
      workerId: worker.id,
      windowChars: this.config.limits.contextWindowChars,
      overshootChars: this.config.limits.pairingOvershootChars,
    });
  }

  private latestUpdateFor(task: Task): string | null {
    const updates = this.store
      .listGroupMessages(task.groupId, 200)
      .filter((message) => message.kind === 'update')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return updates.at(-1)?.body ?? null;
  }

  /** 触发条件由 note.decideNote 判定；失败只记录，不影响本轮执行。 */
  private async maybeRefreshNote(worker: Worker, task: Task): Promise<void> {
    const decision: NoteDecision = decideNote({
      store: this.store,
      worker,
      task,
      history: this.planFor(worker),
      limits: this.config.limits,
    });
    if (decision.action === 'none') return;
    // 工作记录整理沿用这个 Worker 自己的模型，不为摘要另建路由。
    const noteModel = this.models.resolve(worker.model ?? this.config.defaultModelAlias);
    const result = await runNote({
      model: noteModel.client,
      modelName: noteModel.model,
      store: this.store,
      signal: this.lifecycle.signal,
      worker,
      task,
      decision,
      limits: this.config.limits,
    });
    if (result.ok) {
      this.store.appendEvent(task.id, worker.id, 'note.saved', `覆盖到 turn#${decision.toSeq}`);
    } else {
      this.store.appendEvent(task.id, worker.id, 'note.failed', result.reason ?? '未知原因');
      this.emit({ type: 'error', text: `工作记录整理失败（已保留原始历史）：${result.reason ?? '未知原因'}` });
    }
  }

  private async buildWorkerMessages(worker: Worker, task: Task): Promise<ChatMessage[]> {
    await this.maybeRefreshNote(worker, task);

    const plan = this.planFor(worker);
    const collaborators = this.store.listGroupWorkers(task.groupId).map((item) => ({
      id: item.id,
      role: item.role,
      status: item.status,
      parentId: item.parentId,
    }));
    const isOwner = task.ownerWorkerId === worker.id;
    const artifacts = this.store.listArtifacts(task.id);
    const reviews = this.store.listReviews(task.id);
    const note = this.store.latestSuccessfulNote(worker.id);

    const system = workerSystemPrompt({
      task,
      worker,
      collaborators,
      isOwner,
      taskFacts: renderTaskFacts({ task, isOwner, latestUpdate: this.latestUpdateFor(task) }),
      artifactTable: renderArtifactTable({ task, lines: collectArtifactLines(task, artifacts, reviews) }),
      noteText: note && note.epoch === task.reviewEpoch ? note.content : null,
      noteStaleEpoch: note && note.epoch !== task.reviewEpoch ? note.epoch : null,
      noteCoveredSeq: note?.coveredSeq ?? 0,
      windowSummary: `近期窗口含 ${plan.turns.length} 条，历史共 ${plan.totalTurns} 条（约 ${plan.totalChars} 字符）`,
      modelCatalog: { models: this.models.list(), currentAlias: worker.model ?? this.config.defaultModelAlias },
      override: this.currentOverride(),
    });
    const history = this.buildHistory(worker, plan);
    // 无论窗口怎么裁，请求里都必须有一条 user 轮次，否则提供方可能返回空结果。
    const directive: ChatMessage = {
      role: 'user',
      content: renderExecutionDirective({ task, worker, isOwner, stepCount: worker.stepCount }),
    };
    return [{ role: 'system', content: system }, directive, ...history];
  }

  /**
   * 取最近若干轮，但保证「工具调用」与「工具结果」成对出现：
   * 窗口起点落在 tool 上时向前扩展，缺结果的调用补一条明确的未执行记录。
   */
  private buildHistory(worker: Worker, plan: HistoryPlan): ChatMessage[] {
    const TOOL_LIMIT = 8000;
    const turns = plan.turns;
    void worker;

    const toToolMessage = (turn: (typeof turns)[number]): ChatMessage => {
      const content = turn.content ?? '';
      const clipped =
        content.length > TOOL_LIMIT
          ? `${content.slice(0, TOOL_LIMIT)}\n…（工具输出共 ${content.length} 字符，已截断；需要完整内容请用 offset 续读）`
          : content;
      return { role: 'tool', content: clipped, toolCallId: turn.toolCallId ?? undefined };
    };

    const messages: ChatMessage[] = [];
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      if (turn.role === 'assistant' && Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
        const calls = turn.toolCalls as ToolCall[];
        const following: (typeof turns)[number][] = [];
        let cursor = index + 1;
        while (cursor < turns.length && turns[cursor]!.role === 'tool') {
          following.push(turns[cursor]!);
          cursor += 1;
        }
        messages.push({ role: 'assistant', content: turn.content, toolCalls: calls });
        const seen = new Set(following.map((item) => item.toolCallId));
        for (const item of following) messages.push(toToolMessage(item));
        for (const call of calls) {
          if (!seen.has(call.id)) {
            messages.push({
              role: 'tool',
              content:
                `[执行结果未知] ${call.name}：历史只记录了这次调用，没有记录结果（可能是进程中断）。` +
                '不要当成未执行，也不要自动重做；先核对当前文件与消息再决定。',
              toolCallId: call.id,
            });
          }
        }
        index = cursor - 1;
        continue;
      }
      if (turn.role === 'tool') {
        messages.push(toToolMessage(turn));
        continue;
      }
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.content });
        continue;
      }
      messages.push({ role: 'assistant', content: turn.content });
    }
    return messages;
  }

  /** 第一个 user 消息必须落库，否则后续请求会缺少 user 轮次。 */
  private ensureOpeningTurn(workerId: string): void {
    if (this.store.countWorkerTurns(workerId) > 0) return;
    const seq = 1;
    this.store.appendWorkerTurn({
      id: `turn_${workerId}_${seq}`,
      workerId,
      seq,
      role: 'user',
      content:
        '请开始你的工作。材料在 materials/ 目录；读代码或文本用 fs_read（支持任务目录、materials/、仓库相对与绝对路径，超长会提示 offset 续读）。' +
        '产物写到任务目录（相对路径即可），完成后按规则交付。',
      toolCalls: null,
      toolCallId: null,
      createdAt: nowIso(),
    });
  }

  private recordInboxTurn(workerId: string, inbox: Message[]): void {
    const seq = this.store.countWorkerTurns(workerId) + 1;
    this.store.appendWorkerTurn({
      id: `turn_${workerId}_${seq}`,
      workerId,
      seq,
      role: 'user',
      content: this.renderInbox(inbox),
      toolCalls: null,
      toolCallId: null,
      createdAt: nowIso(),
    });
  }

  private renderInbox(messages: Message[]): string {
    const lines = ['<inbox>', '以下是你收到的新消息：'];
    for (const message of messages) {
      const origin =
        message.fromKind === 'worker' ? `${message.fromId}（同组 Worker）` : message.fromKind === 'router' ? 'Router' : '系统';
      lines.push(`- [${message.id}] 来自 ${origin}｜kind=${message.kind}${message.replyTo ? `｜回复 ${message.replyTo}` : ''}`);
      if (message.payload && typeof message.payload['intent'] === 'string') {
        lines.push(`  intent: ${String(message.payload['intent'])}`);
      }
      if (message.payload && typeof message.payload['outcome'] === 'string') {
        lines.push(`  outcome: ${String(message.payload['outcome'])}`);
      }
      lines.push(`  内容：${message.body}`);
      if (message.refs?.files && message.refs.files.length > 0) lines.push(`  引用文件：${message.refs.files.join(', ')}`);
      if (message.refs?.artifacts && message.refs.artifacts.length > 0) {
        lines.push(
          `  引用产物：${message.refs.artifacts.map((item) => `${item.name} v${item.version}（${item.artifactId}）`).join(', ')}`,
        );
      }
    }
    lines.push('</inbox>');
    return lines.join('\n');
  }

  searchWorkerTurns(
    workerId: string,
    options: { fromSeq: number; toSeq: number; role: string | null; limit: number },
  ): WorkerTurn[] {
    return this.store.searchWorkerTurns(workerId, options);
  }

  listWorkerTurnsRange(workerId: string, fromSeq: number, toSeq: number): WorkerTurn[] {
    return this.store.listWorkerTurnsRange(workerId, fromSeq, toSeq);
  }

  getMessageForWorker(workerId: string, messageId: string): Message | null {
    const message = this.store.getMessage(messageId);
    if (!message) return null;
    // 只能读自己收发的消息，避免跨 Worker 窥探过程细节。
    if (message.fromId !== workerId && message.toId !== workerId) return null;
    return message;
  }

  listWorkerNotes(workerId: string): WorkerNote[] {
    return this.store.listWorkerNotes(workerId, 5);
  }

  private toolContext(workerId: string): ToolContext {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker 不存在：${workerId}`);
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) throw new Error('任务不存在');
    return {
      host: this,
      worker,
      task,
      workDir: this.config.workDir,
      materialsDir: this.config.materialsDir,
      readRoot: this.config.readRoot,
      signal: this.runs.get(workerId)?.signal ?? null,
    };
  }

  // ---------------- 记录 ----------------

  private recordAssistantTurn(worker: Worker, result: StepResult): void {
    this.store.appendWorkerTurn({
      id: `turn_${worker.id}_${this.store.countWorkerTurns(worker.id) + 1}`,
      workerId: worker.id,
      seq: this.store.countWorkerTurns(worker.id) + 1,
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : null,
      toolCallId: null,
      createdAt: nowIso(),
    });
  }

  private recordToolTurn(worker: Worker, call: ToolCall, content: string): void {
    this.store.appendWorkerTurn({
      id: `turn_${worker.id}_${this.store.countWorkerTurns(worker.id) + 1}`,
      workerId: worker.id,
      seq: this.store.countWorkerTurns(worker.id) + 1,
      role: 'tool',
      content: `[${call.name}] ${content}`,
      toolCalls: null,
      toolCallId: call.id,
      createdAt: nowIso(),
    });
  }

  /** 供测试与外部组件投递系统通知。 */
  notifySystem(workerId: string, body: string, options: { wake?: 'none' | 'force' } = {}): void {
    this.pushSystemNotice(workerId, body, options);
  }

  /**
   * 投递系统通知。默认只投递，不解除等待：
   * 退避中的等待、作业等待、维护挂起都不应因为一条通知就恢复。
   * 只有明确「依赖对象已消失」时才用 wake='force'。
   */
  private pushSystemNotice(workerId: string, body: string, options: { wake?: 'none' | 'force' } = {}): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) return;
    const task = this.store.getTaskByGroup(worker.groupId);
    this.store.insertMessage({
      id: newMessageId(),
      groupId: worker.groupId,
      taskId: task?.id ?? null,
      fromKind: 'system',
      fromId: 'system',
      toKind: 'worker',
      toId: workerId,
      kind: 'notice',
      body,
      payload: null,
      replyTo: null,
      refs: null,
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    });
    if (options.wake !== 'force') return;
    const current = this.store.getWorker(workerId);
    if (!current || current.status !== 'waiting') return;
    for (const wait of this.store.listActiveWaitsForWorker(workerId)) {
      this.store.resolveWait(wait.id);
    }
    this.enqueue(workerId);
  }

  private markConsumed(messageId: string): void {
    const current = this.store.getMessage(messageId);
    if (!current) return;
    if (current.status === 'queued') this.store.setMessageStatus(messageId, 'delivered');
    const next = this.store.getMessage(messageId);
    if (next?.status === 'delivered') this.store.setMessageStatus(messageId, 'consumed');
  }

  // ---------------- 失败与定时检查 ----------------

  /** 提供方暂时不可用时保留任务，退避后重排；其它错误一律明确失败。 */
  private async handleRunError(workerId: string, error: unknown): Promise<void> {
    // 本地取消不是业务失败：停机、任务取消、代次失效都属于这一类。
    // 判活的唯一依据是结构化类别，不看错误文字。
    if (error instanceof ModelError && error.isCancelled) {
      this.settleCancelledRun(workerId, error.message);
      return;
    }
    if (this.stopped) {
      // 停机过程中出现的其它异常同样不判死：保留可恢复状态，交给下次启动。
      this.settleCancelledRun(workerId, `停机中断：${(error as Error).message}`);
      return;
    }
    const retryable = error instanceof ModelError && error.retryable;
    if (!retryable) {
      await this.failWorker(workerId, (error as Error).message);
      return;
    }
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    // 重试时间点写进数据库：进程重启后由 tick 继续这个等待，不依赖内存定时器。
    this.store.clearWaitsForWorker(workerId);
    this.store.setWorkerStatus(workerId, 'waiting');
    this.store.createWait({
      id: newWaitId(),
      workerId,
      groupId: worker.groupId,
      reason: 'provider',
      matchFrom: null,
      matchReplyTo: null,
      matchKinds: null,
      deadlineAt: isoAfter(60_000),
      createdAt: nowIso(),
      resolvedAt: null,
    });
    this.pushSystemNotice(workerId, `模型提供方暂时不可用：${(error as Error).message}。已安排 60 秒后自动重试。`);
    this.emit({ type: 'error', text: `Worker ${workerId} 等待模型恢复：${(error as Error).message}` });
  }

  /**
   * 一次执行被取消后的收尾：不判死，留下可解释、可恢复的状态。
   * - 任务已终结：Worker 直接收敛到终态；
   * - 系统停机：保持 queued，下次启动由 recover() 接管；
   * - 其它（代次失效）：交给 settleWorker 依据任务状态决定。
   */
  private settleCancelledRun(workerId: string, reason: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    const task = this.store.getTaskByGroup(worker.groupId);
    if (task) this.store.appendEvent(task.id, workerId, 'run.cancelled', reason);
    if (!task || isTerminalTask(task.status)) {
      this.store.setWorkerStatus(workerId, task ? 'done' : 'cancelled', task ? '任务已结束' : '任务不存在');
      return;
    }
    if (this.stopped) {
      // 停机：回到 queued，恢复时会被重新调度。
      this.store.setWorkerStatus(workerId, 'queued');
      return;
    }
    this.store.setWorkerStatus(workerId, 'waiting');
  }

  private async failWorker(workerId: string, reason: string): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    this.runs.get(workerId)?.revoke('Worker 失败');
    this.store.setWorkerStatus(workerId, 'failed', reason);
    this.store.appendEvent(this.store.getTaskByGroup(worker.groupId)?.id ?? null, workerId, 'worker.failed', reason);
    this.emit({ type: 'worker.status', workerId, status: 'failed' });
    this.emit({ type: 'error', text: `Worker ${workerId} 失败：${reason}` });
    const task = this.store.getTaskByGroup(worker.groupId);
    if (!task) return;
    if (task.ownerWorkerId === workerId) {
      await this.failTask(task.id, `负责人失败：${reason}`);
      return;
    }
    const owner = task.ownerWorkerId ? this.store.getWorker(task.ownerWorkerId) : null;
    if (owner && !isTerminalWorker(owner.status)) {
      this.pushSystemNotice(owner.id, `协作者 ${workerId} 失败：${reason}。请决定是否重试、改派或自己完成。`, {
        wake: 'force',
      });
      this.enqueue(owner.id);
    }
  }

  private checkGroupDeadlock(groupId: string): void {
    const workers = this.store.listGroupWorkers(groupId).filter((worker) => !isTerminalWorker(worker.status));
    if (workers.length < 2) return;
    const allWaiting = workers.every((worker) => {
      const waits = this.store.listActiveWaitsForWorker(worker.id);
      return worker.status === 'waiting' && waits.length > 0;
    });
    if (!allWaiting) return;
    const earliest = workers
      .map((worker) => ({ worker, wait: this.store.listActiveWaitsForWorker(worker.id)[0] }))
      .sort((a, b) => (a.wait!.createdAt < b.wait!.createdAt ? -1 : 1))[0];
    if (!earliest?.wait) return;
    this.store.resolveWait(earliest.wait.id);
    this.pushSystemNotice(
      earliest.worker.id,
      '检测到同组 Worker 全部处于互相等待。请根据已有信息自行决策：完成当前部分、改为直接汇报，或明确说明还缺什么。',
    );
    this.enqueue(earliest.worker.id);
  }

  tick(): void {
    this.drainControls();
    this.pumpRouter();
    // 接管数据库里排队的业务 Worker：任务可能由另一个进程（运维注入、验收脚本）
    // 创建，只写库不入本进程内存队列。enqueue 本身去重，重复扫描是安全的。
    if (!this.stopped) {
      for (const worker of this.store.listQueuedWorkers()) {
        if (this.queue.includes(worker.id)) continue;
        if (process.env['DEBUG_RUN']) console.error(`[tick] adopt queued ${worker.id}`);
        this.enqueue(worker.id);
      }
    }
    const now = Date.now();
    for (const wait of this.store.listActiveWaits()) {
      if (new Date(wait.deadlineAt).getTime() > now) continue;
      this.store.resolveWait(wait.id);
      const worker = this.store.getWorker(wait.workerId);
      if (!worker || isTerminalWorker(worker.status)) continue;
      if (wait.reason === 'provider') {
        // 提供方等待写在数据库里，进程重启后照样能续上。
        this.pushSystemNotice(worker.id, '模型提供方已恢复等待窗口，继续上次未完成的工作。');
        this.enqueue(worker.id);
        continue;
      }
      if (wait.reason === 'job') {
        this.pushSystemNotice(
          worker.id,
          `等待作业超时，作业可能仍在运行。用 proc_read 查看当前输出，或再次 proc_wait。`,
          { wake: 'force' },
        );
        this.enqueue(worker.id);
        continue;
      }
      this.pushSystemNotice(worker.id, '等待已超时，没有收到匹配回复。请决定继续等待、自己推进，或向 Router 说明阻塞。');
      this.enqueue(worker.id);
    }
    const ttl = this.config.limits.messageTtlMinutes;
    this.store.expireStaleMessages(new Date(now - ttl * 60_000).toISOString());
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** 当前运行与排队情况，用于验收与调试。 */
  stats(): { running: number; queued: number; runningWorkers: string[] } {
    return { running: this.runningCount, queued: this.queue.length, runningWorkers: [...this.running] };
  }

  async waitForIdle(timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.runningCount === 0 && this.queue.length === 0) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    return this.runningCount === 0 && this.queue.length === 0;
  }

  /**
   * 判断某个实例是否还活着。
   *
   * 只有"读到实例文件且进程身份能对上"才算活着；
   * 读不到或无法确认时一律当活，宁可留一条记录，也不误改别人的调用。
   */
  private isInstanceAlive(instanceId: string): boolean {
    const instancePath = `${this.config.workDir}/.runtime/instance.json`;
    const watchdogPath = `${this.config.workDir}/.runtime/watchdog.json`;
    for (const path of [instancePath, watchdogPath]) {
      try {
        const info = JSON.parse(readFileSync(path, 'utf8')) as { instanceId?: string; pid?: number | null; stopped?: boolean };
        if (info.instanceId !== instanceId) continue;
        if (info.stopped === true) return false;
        if (typeof info.pid !== 'number') return false;
        // 进程在、且命令行确实是本程序才算活着；身份不明按活处理，不误改。
        const verdict = identifyProcess(info.pid, path.includes('watchdog') ? 'watchdog/main.ts' : 'main.ts');
        return verdict !== 'mismatch';
      } catch {
        continue;
      }
    }
    return true;
  }

  /**
   * 重启恢复：按持久化状态分情况处理，而不是把所有 waiting 一律重跑。
   *
   * - running：上次进程在执行中被打断。转 queued 并写提示，由模型核对历史后决定下一步，
   *   程序不自动重放结果不明的工具调用。
   * - queued：已排队未执行，直接重新入队。
   * - waiting：读 wait_record 判断在等什么；等回复/等用户的保持不动，
   *   等提供方且已过期的重新入队，没有任何等待记录的（历史遗留）转 queued。
   * - 终态：忽略。
   *
   * 重复调用是幂等的：状态已归一，enqueue 本身也会去重。
   */
  recover(): { interrupted: number; requeued: number; waiting: number; recovered: number } {
    let interrupted = 0;
    let requeued = 0;
    let waiting = 0;
    // 调用记录先按实例归属收敛：崩溃实例留下的 running 不能永远挂着，
    // 但存活实例和归属未知的记录一律不动。
    this.store.recoverModelCalls((instanceId) => this.isInstanceAlive(instanceId));
    // 上个进程留下的 running 协调会话收回成待续接：同一时刻只有本进程在跑，
    // running 一定属于已退出进程。不收回就永远接不上；收成 pending 后只续接一次。
    this.store.resumeStaleRouterSessions();

    for (const worker of this.store.listWorkers()) {
      if (isTerminalWorker(worker.status)) continue;
      const task = this.store.getTaskByGroup(worker.groupId);
      if (!task || isTerminalTask(task.status)) {
        if (worker.status !== 'cancelled') this.store.setWorkerStatus(worker.id, 'cancelled', '任务已结束');
        continue;
      }

      if (worker.status === 'running') {
        this.store.setWorkerStatus(worker.id, 'queued');
        this.pushSystemNotice(
          worker.id,
          '检测到上次进程在执行中断。请核对已有文件与消息，只补做未完成的部分，不要重复已完成的外部动作。',
        );
        interrupted += 1;
        this.enqueue(worker.id);
        continue;
      }

      if (worker.status === 'queued' || worker.status === 'idle') {
        if (worker.status === 'idle') this.store.setWorkerStatus(worker.id, 'queued');
        requeued += 1;
        this.enqueue(worker.id);
        continue;
      }

      // waiting
      const waits = this.store.listActiveWaitsForWorker(worker.id);
      if (waits.length === 0) {
        this.store.setWorkerStatus(worker.id, 'queued');
        this.pushSystemNotice(worker.id, '重启后未发现有效的等待记录，请继续推进当前工作。');
        requeued += 1;
        this.enqueue(worker.id);
        continue;
      }
      waiting += 1;
      // provider 等待由 tick 按 deadline 恢复，其余保持原状等外部事件。
    }

    return { interrupted, requeued, waiting, recovered: interrupted + requeued };
  }
}

function writeFileSyncSafe(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  // 同步写入保证同一 Worker 的产物版本号与内容一致。
  writeFileSync(path, bytes);
}
