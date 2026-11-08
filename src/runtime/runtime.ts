import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
}

export interface RouterBridge {
  notify(): void;
  handleUserMessage(text: string): Promise<void>;
}

export class Runtime implements ToolHost {
  readonly store: Store;
  readonly config: Config;
  readonly workerModel: ModelClient;
  readonly defaultWaitTimeoutMs: number;

  private readonly events = new EventEmitter();
  private readonly tools: ToolRegistry;
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  /** 本轮执行期间收到的调度请求，等本轮结束后各跑一次。 */
  private readonly rerunRequested = new Set<string>();
  private readonly jobs: ProcessService;
  /** 每个 Worker 当前的取消信号；停止任务或 Worker 失败时触发。 */
  private readonly aborts = new Map<string, AbortController>();
  private runningCount = 0;
  private workerSequence = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private router: RouterBridge | null = null;

  constructor(options: { store: Store; config: Config; workerModel: ModelClient }) {
    this.store = options.store;
    this.config = options.config;
    this.workerModel = options.workerModel;
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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 停止后不再执行排队中的工作，否则等待队列永远清不空。
    this.queue.length = 0;
    this.rerunRequested.clear();
    await this.waitForIdle(15_000);
    // 后台进程不随队列清空而结束，必须显式收掉，否则会继续改文件。
    this.jobs.dispose();
  }

  // ---------------- 任务与 Worker ----------------

  createTask(input: CreateTaskInput): { task: Task; owner: Worker } {
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
      status: 'active',
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    let owner!: Worker;
    this.store.tx(() => {
      this.store.createTask(task);
      owner = this.createWorkerRecord({
        groupId,
        parentId: null,
        role: input.ownerRole,
        brief: input.ownerBrief,
        model: input.model ?? null,
      });
      this.store.setTaskOwner(taskId, owner.id);
    });
    const created = this.store.getTask(taskId)!;
    this.store.appendEvent(taskId, owner.id, 'task.created', input.title);
    this.emit({ type: 'task.created', taskId, title: input.title });
    this.emit({ type: 'worker.created', workerId: owner.id, role: owner.role, parentId: null });
    this.enqueue(owner.id);
    return { task: created, owner };
  }

  private createWorkerRecord(input: {
    groupId: string;
    parentId: string | null;
    role: string;
    brief: string;
    model: string | null;
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
      status: 'queued',
      model: input.model,
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

  createCollaborator(parent: Worker, role: string, brief: string): CreateCollaboratorResult {
    try {
      const worker = this.createWorkerRecord({
        groupId: parent.groupId,
        parentId: parent.id,
        role,
        brief,
        model: parent.model,
      });
      this.enqueue(worker.id);
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
    this.store.appendEvent(task.id, worker.id, 'task.completed', summary.slice(0, 200));
    this.emit({ type: 'task.status', taskId: task.id, status: 'completed', reason: summary });
    this.closeGroup(task.groupId, '任务已完成', worker.id);
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
    if (kind === 'fail' || kind === 'question') this.router?.notify();
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
    while (!this.stopped && this.runningCount < this.config.limits.maxConcurrentRuns) {
      const workerId = this.queue.shift();
      if (!workerId) return;
      if (this.running.has(workerId)) continue;
      const worker = this.store.getWorker(workerId);
      if (!worker || isTerminalWorker(worker.status)) continue;
      this.running.add(workerId);
      this.runningCount += 1;
      void this.runWorker(workerId)
        .catch((error: unknown) => this.handleRunError(workerId, error))
        .finally(() => {
          this.running.delete(workerId);
          this.aborts.delete(workerId);
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
    const controller = new AbortController();
    this.aborts.set(workerId, controller);
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

    let nudges = 0;

    for (let stepIndex = 0; stepIndex < this.config.limits.maxStepsPerRun; stepIndex += 1) {
      worker = this.store.getWorker(workerId)!;
      task = this.store.getTaskByGroup(worker.groupId)!;
      if (isTerminalTask(task.status)) {
        this.store.setWorkerStatus(workerId, 'cancelled', `任务已 ${task.status}`);
        return;
      }
      if (worker.stepCount >= this.config.limits.maxStepsPerWorker) {
        await this.failWorker(workerId, `步数达到上限 ${this.config.limits.maxStepsPerWorker}`);
        return;
      }
      if (this.store.groupStepTotal(worker.groupId) >= this.config.limits.maxStepsPerGroup) {
        await this.failTask(task.id, `群组步数达到上限 ${this.config.limits.maxStepsPerGroup}`);
        return;
      }

      this.ensureOpeningTurn(workerId);
      const inbox = this.store.listInbox(workerId);
      if (inbox.length > 0) {
        // 先落入历史再标记已读：模型后续步骤仍能看到消息原文与编号。
        this.recordInboxTurn(workerId, inbox);
        for (const message of inbox) this.markConsumed(message.id);
      }
      const messages = await this.buildWorkerMessages(worker, task);
      const result = await this.workerModel.chat({
        model: worker.model ?? this.config.workerModel,
        messages,
        tools: this.tools.schemas(),
        reasoningEffort: this.config.reasoningEffort,
      });

      this.store.bumpWorkerStep(workerId);
      this.recordAssistantTurn(worker, result);

      if (result.toolCalls.length === 0) {
        if (task.ownerWorkerId === workerId) {
          nudges += 1;
          if (nudges > this.config.limits.maxNudges) {
            await this.failWorker(workerId, '连续多次只输出文本而未提交结果');
            return;
          }
          this.pushSystemNotice(workerId, '你还没有调用 submit_result。工作若已完成，请先 artifact_save 保存产物再提交；否则继续推进。');
          continue;
        }
        this.store.setWorkerStatus(workerId, 'waiting');
        this.emit({ type: 'worker.status', workerId, status: 'waiting' });
        return;
      }

      for (let index = 0; index < result.toolCalls.length; index += 1) {
        const call = result.toolCalls[index]!;
        const currentTask = this.store.getTaskByGroup(worker.groupId);
        if (!currentTask || isTerminalTask(currentTask.status)) {
          this.recordUnexecuted(worker, result.toolCalls.slice(index), '任务已结束，剩余调用未执行');
          this.store.setWorkerStatus(workerId, 'cancelled', '任务已结束');
          return;
        }
        const outcome = await this.tools.execute(call.name, call.arguments, this.toolContext(workerId));
        this.recordToolTurn(worker, call, outcome.content);
        if (outcome.type === 'wait' || outcome.type === 'finish') {
          // 一批调用里只执行到一半就挂起时，剩下的调用必须留下明确记录，
          // 否则对话里会出现没有结果的 tool_call，严格校验的端点会直接拒绝请求。
          const rest = result.toolCalls.slice(index + 1);
          if (rest.length > 0) {
            this.recordUnexecuted(
              worker,
              rest,
              outcome.type === 'wait' ? '本次运行因等待而提前结束，该调用未执行' : '本次运行因提交/停止而结束，该调用未执行',
            );
          }
        }
        if (outcome.type === 'wait') {
          this.store.setWorkerStatus(workerId, 'waiting');
          this.emit({ type: 'worker.status', workerId, status: 'waiting' });
          this.checkGroupDeadlock(worker.groupId);
          return;
        }
        if (outcome.type === 'finish') {
          return;
        }
      }
    }

    // 单轮步数用完但整体预算还在：转回 queued 并请求下一轮。
    const current = this.store.getWorker(workerId);
    if (current && current.status === 'running') {
      this.store.setWorkerStatus(workerId, 'queued');
      this.emit({ type: 'worker.status', workerId, status: 'queued' });
      this.enqueue(workerId);
    }
  }

  /** 为未执行的调用补一条明确的 tool 记录，不伪造成功。 */
  private recordUnexecuted(worker: Worker, calls: ToolCall[], reason: string): void {
    for (const call of calls) {
      this.recordToolTurn(worker, call, `[未执行] ${call.name}：${reason}`);
    }
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
    const result = await runNote({
      model: this.workerModel,
      modelName: worker.model ?? this.config.workerModel,
      store: this.store,
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
    });
    const history = this.buildHistory(worker, plan);
    // 无论窗口怎么裁，请求里都必须有一条 user 轮次，否则提供方可能返回空结果。
    const directive: ChatMessage = {
      role: 'user',
      content: renderExecutionDirective({ task, worker, isOwner }),
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
      content: '请开始你的工作。材料在 materials/ 目录，产物写到任务目录（相对路径即可）。完成后按规则交付。',
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
      signal: this.aborts.get(workerId)?.signal ?? null,
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

  private pushSystemNotice(workerId: string, body: string): void {
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

  private async failWorker(workerId: string, reason: string): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (!worker || isTerminalWorker(worker.status)) return;
    this.aborts.get(workerId)?.abort();
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
      this.pushSystemNotice(owner.id, `协作者 ${workerId} 失败：${reason}。请决定是否重试、改派或自己完成。`);
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
