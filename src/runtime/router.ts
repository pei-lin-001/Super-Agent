import type { Config } from '../config.ts';
import { parseSessionKey } from '../channels/types.ts';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../domain/ids.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { RuntimeEvent } from '../domain/types.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import type { Runtime } from './runtime.ts';
import { Execution, ExecutionRevoked } from './execution.ts';

import { routerSystemPrompt, taskCardLine } from './prompts.ts';

const ROUTER_TOOLS: ToolSchema[] = [
  {
    name: 'create_task',
    description:
      '建立一项独立任务（同时建立对应群组），并指定负责人。只在确实需要实际执行时使用；普通问答直接回复用户。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，一句话' },
        goal: { type: 'string', description: '给全组看的共同目标' },
        brief: { type: 'string', description: '背景材料、约束、输入位置' },
        done_criteria: { type: 'string', description: '可验证的完成条件' },
        require_review: { type: 'boolean', description: '是否必须经过同组检查才能交付' },
        owner_role: { type: 'string', description: '负责人职责摘要' },
        owner_brief: { type: 'string', description: '负责人具体要做什么' },
      },
      required: ['title', 'goal', 'owner_role', 'owner_brief'],
    },
  },
  {
    name: 'send_to_worker',
    description: '向某个 Worker 补充要求（update）或要求停止（stop）。消息会直接进入它的收件箱。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        worker_id: { type: 'string' },
        kind: { type: 'string', enum: ['update', 'stop'] },
        body: { type: 'string', description: '补充要求或停止原因' },
      },
      required: ['task_id', 'worker_id', 'kind', 'body'],
    },
  },
  {
    name: 'stop_task',
    description: '取消整个任务，停止该组所有工作。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'send_file',
    description:
      '把某个任务已登记的产物文件发给当前聊天。只能取该任务里真实登记过的产物，不能读取任意服务器路径。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' },
        name: { type: 'string', description: '产物文件名（登记时使用的名字）' },
        note: { type: 'string', description: '随文件一起发的一句话说明，可为空' },
      },
      required: ['task_id', 'name'],
    },
  },
  {
    name: 'list_tasks',
    description: '列出所有任务及其状态、负责人和最新结论。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_task',
    description: '查看某个任务的详情：目标、完成条件、Worker 列表、最近消息。',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
];

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${field}`);
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export class Router {
  /**
   * 每个会话一条串行链。
   *
   * 同一条聊天内保持顺序；不同聊天互不阻塞——否则一个长任务所在聊天的
   * 排队会把别的聊天一起卡住。
   */
  private readonly chains = new Map<string, Promise<void>>();
  private notifyScheduled = false;

  private readonly runtime: Runtime;
  private readonly model: ModelClient;
  private readonly config: Config;

  private readonly readOnly: boolean;
  /** 正在续接的会话：防止定时 tick 把同一个会话排成一串重复执行。 */
  private readonly resuming = new Set<string>();

  constructor(runtime: Runtime, model: ModelClient, config: Config, options: { readOnly?: boolean } = {}) {
    this.runtime = runtime;
    this.model = model;
    this.config = config;
    this.readOnly = options.readOnly ?? false;
  }

  /** 把一个执行请求排进所在会话的串行队列；返回这次执行的真实结果。 */
  private enqueue(
    userText: string | null,
    context: {
      sessionId?: string;
      history?: ChatMessage[];
      sessionKey?: string | null;
      onAccepted?: () => void;
    } = {},
  ): Promise<'done' | 'suspended' | 'failed'> {
    const key = context.sessionKey ?? '';
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.run(userText, context));
    // 内部串行链吞掉失败，避免一次故障让后续所有消息都直接失败。
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run.then(
      (outcome) => outcome,
      (error: unknown) => {
        this.publish({ type: 'router.notice', text: `Router 运行失败：${(error as Error).message}` });
        return 'failed' as const;
      },
    );
  }

  /**
   * 接收一条用户输入。
   *
   * sessionKey 决定它属于哪条聊天：历史、收件箱、续接和回信都按它隔离。
   * 不传表示 CLI 会话，行为与之前一致。
   */
  handleUserMessage(
    content: string,
    options: { sessionKey?: string | null; onAccepted?: () => void } = {},
  ): Promise<void> {
    return this.enqueue(content, {
      sessionKey: options.sessionKey ?? null,
      onAccepted: options.onAccepted,
    }).then(() => undefined);
  }

  /**
   * Worker 有结果/失败/提问时触发一次自动汇报；多次通知会合并。
   *
   * 返回的 Promise 在本次汇报真正结束后 resolve，便于调用方（和测试）等待；
   * 生产路径通常不 await 它。
   */
  notify(): Promise<void> {
    if (this.notifyScheduled) return Promise.resolve();
    this.notifyScheduled = true;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.notifyScheduled = false;
        if (this.runtime.isStopped) {
          resolve();
          return;
        }
        // 按来源会话分组汇报：多条聊天交错时，不能把别人的材料混进一次总结。
        const keys = this.runtime.store.routerInboxSessionKeys();
        if (keys.length === 0) {
          resolve();
          return;
        }
        const runs = keys.map((sessionKey) => this.enqueue(null, { sessionKey }));
        void Promise.all(runs).then(
          (outcome) => {
            if (outcome.some((item) => item === 'failed')) {
              this.publish({ type: 'router.notice', text: 'Router 自动汇报失败，已保留会话等待续接。' });
            }
            resolve();
          },
          () => {
            resolve();
          },
        );
      }, 0);
    });
  }

  private publish(event: RuntimeEvent): void {
    this.runtime.publish(event);
  }

  /** 只有 IM 会话才需要写发件记录；CLI 不经过渠道层。 */
  private publishOutbound(
    sessionKey: string | null,
    text: string,
    taskId: string | null,
    artifact: string | null,
  ): void {
    if (sessionKey === null || text.trim() === '') return;
    this.publish({ type: 'channel.outbound', sessionKey, text, taskId, artifact });
  }

  /** 返回这次协调的结果：完成 / 额度用完待续接 / 失败。只有完成才关闭会话。 */
  /**
   * 一次协调执行。
   *
   * 整段流程在 Execution 里跑：停机撤销之后，任何一次存储访问都会被挡住，
   * 包括异常分支和 finally。底层模型即使忽略取消，迟到结果也只被观察。
   */
  private async run(
    userText: string | null,
    context: {
      sessionId?: string;
      history?: ChatMessage[];
      sessionKey?: string | null;
      onAccepted?: () => void;
    } = {},
  ): Promise<'done' | 'suspended'> {
    const execution = new Execution('router');
    this.runtime.track(execution);
    try {
      return await execution.run(() => this.runBody(userText, execution, context));
    } catch (error) {
      if (error instanceof ExecutionRevoked) return 'done';
      throw error;
    } finally {
      this.runtime.untrack(execution);
    }
  }

  private async runBody(
    userText: string | null,
    execution: Execution,
    context: {
      sessionId?: string;
      history?: ChatMessage[];
      sessionKey?: string | null;
      onAccepted?: () => void;
    } = {},
  ): Promise<'done' | 'suspended'> {
    if (this.runtime.isStopped) return 'done';
    const sessionKey = context.sessionKey ?? null;
    const inbox = this.runtime.store.listRouterInbox(sessionKey);
    if (userText === null && inbox.length === 0) return 'done';

    const pending = inbox
      .map(
        (message) =>
          `- [${message.id}] 来自 ${message.fromId}｜kind=${message.kind}｜任务 ${message.taskId ?? '-'}：${message.body}`,
      )
      .join('\n');

    // 历史只从参数来：不再读共享字段，避免前后两个执行互相看到对方的上下文。
    const history =
      context.history ??
      this.runtime.store
        .listRouterTurns(20, sessionKey)
        .map((turn): ChatMessage => ({ role: turn.role, content: turn.content }));
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: routerSystemPrompt({ taskCards: this.renderTaskCards(), pendingMessages: pending }),
      },
      ...history,
    ];

    if (userText !== null) {
      messages.push({ role: 'user', content: userText });
      this.runtime.store.appendRouterTurn({
        id: `rt_${randomBytes(4).toString('hex')}_u`,
        role: 'user',
        content: userText,
        sessionKey,
        createdAt: nowIso(),
      });
    } else {
      messages.push({ role: 'user', content: '以上是 Worker 的最新消息，请判断是否需要向用户汇报或采取动作。' });
    }

    this.publish({ type: 'router.start' });

    // 一条协调会话贯穿多轮调度与重试。
    const sessionId = context.sessionId ?? `rs_${randomBytes(4).toString('hex')}`;
    // 会话在第一次模型请求前就落库：额度耗尽或失败时，续接入口始终存在。
    this.runtime.store.saveRouterSession({
      id: sessionId,
      sessionKey,
      taskId: null,
      messages: messages.filter((message) => message.role !== 'system'),
      reason: '进行中',
    });
    // 用户输入此刻已经持久化：渠道层据此把入站记录标成"已交接"。
    // 之后再崩溃，走的是续接原会话，不会把同一条消息重新派一次工。
    context.onAccepted?.();
    const maxRounds = Math.max(1, this.config.limits.maxRouterRounds);

    const runOptions = (calls: unknown, results: Map<number, string>): string[] => {
      const list = Array.isArray(calls) ? (calls as { id: string; name: string }[]) : [];
      const outputs: string[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const saved = results.get(index);
        if (saved === undefined) return outputs;
        messages.push({ role: 'tool', content: saved, toolCallId: list[index]!.id });
        outputs.push(saved);
      }
      return outputs;
    };
    void runOptions;

    for (let step = 0; step < maxRounds; step += 1) {
      // 先消费上次保存、但尚未执行完的那次决策：恢复时不会重放已完成的动作。
      const pending = this.runtime.store.pendingRouterDecision(sessionId);
      if (pending) {
        const calls = (pending.toolCalls as { id: string; name: string; arguments: string }[]) ?? [];
        messages.push({
          role: 'assistant',
          content: pending.text,
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
        });
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index]!;
          const actionKey = `${pending.id}:${index}`;
          const cached = this.runtime.store.getRouterAction(sessionId, actionKey);
          if (cached) {
            messages.push({ role: 'tool', content: cached.result, toolCallId: call.id });
            continue;
          }
          const content = await this.executeTool(call.name, call.arguments, { sessionId, actionKey, sessionKey });
          // create_task 已经在事务里写过回执，这里用 INSERT OR IGNORE 保证不会重复。
          this.runtime.store.saveRouterAction({
            id: `ra_${randomBytes(4).toString('hex')}`,
            sessionId,
            actionKey,
            tool: call.name,
            result: content,
          });
          messages.push({ role: 'tool', content, toolCallId: call.id });
        }
        this.runtime.store.finishRouterDecision(pending.id);
        continue;
      }

      const result = await execution.attach(
        new RecordingModel(this.model, this.runtime.store, 'router', {
          sessionId,
          // Router 固定走默认模型配置；记下来，便于和 Worker 的调用区分核对。
          modelAlias: this.config.defaultModelAlias,
        }).chat({
        model: this.config.routerModel,
        messages,
        tools: this.readOnly ? [] : ROUTER_TOOLS,
          reasoningEffort: this.config.reasoningEffort,
          // 进程级取消：停机时 Router 的请求同样要停下，不能只在库里留下脏写。
          signal: this.runtime.lifecycleSignal,
        }),
      );

      if (result.toolCalls.length === 0) {
        const answer = result.text?.trim() ?? '';
        if (answer === '') {
          this.publish({ type: 'router.notice', text: 'Router 没有输出内容，已忽略本轮。', sessionKey });
          this.finishSession(sessionId, 'done', messages, sessionKey);
          return 'done';
        }
        messages.push({ role: 'assistant', content: answer });
        this.runtime.store.appendRouterTurn({
          id: `rt_${randomBytes(4).toString('hex')}_a`,
          role: 'assistant',
          content: answer,
          sessionKey,
          createdAt: nowIso(),
        });
        // 回信目标由程序按会话决定，不接受模型给出的 chatId。
        this.publish({ type: 'router.reply', text: answer, sessionKey });
        this.publishOutbound(sessionKey, answer, inbox[0]?.taskId ?? null, null);
        for (const message of inbox) this.consume(message.id);
        // 完成即收尾：会话不能停在"进行中"，否则 tick 会再续接一次并重复建任务。
        this.finishSession(sessionId, 'done', messages, sessionKey);
        return 'done';
      }

      // 决策先落库，工具调用身份从这条记录派生，不依赖每轮从 0 开始的循环位置。
      const decisionId = `rd_${randomBytes(4).toString('hex')}`;
      this.runtime.store.saveRouterDecision({
        id: decisionId,
        sessionId,
        turnNo: step,
        text: result.text,
        toolCalls: result.toolCalls,
      });
      messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      });
      for (let index = 0; index < result.toolCalls.length; index += 1) {
        const call = result.toolCalls[index]!;
        const actionKey = `${decisionId}:${index}`;
        const cached = this.runtime.store.getRouterAction(sessionId, actionKey);
        if (cached) {
          messages.push({ role: 'tool', content: cached.result, toolCallId: call.id });
          continue;
        }
        const content = await this.executeTool(call.name, call.arguments, { sessionId, actionKey, sessionKey });
        this.runtime.store.saveRouterAction({
          id: `ra_${randomBytes(4).toString('hex')}`,
          sessionId,
          actionKey,
          tool: call.name,
          result: content,
        });
        messages.push({ role: 'tool', content, toolCallId: call.id });
      }
      this.runtime.store.finishRouterDecision(decisionId);
    }

    // 挂起：保存最新进度，下一轮续接。这是唯一保留待续接状态的路径。
    this.runtime.store.saveRouterSession({
      id: sessionId,
      sessionKey,
      taskId: null,
      messages: messages.filter((message) => message.role !== 'system'),
      reason: `达到单轮调度额度 ${maxRounds}`,
    });
    this.runtime.store.appendEvent(null, null, 'router.suspended', `达到单轮调度额度 ${maxRounds}，已保存进度`);
    this.publish({
      type: 'router.notice',
      text: `Router 达到单轮调度额度 ${maxRounds}，已保存进度，稍后继续。`,
      sessionKey,
    });
    // 只在 IM 会话里告知用户"还在继续"；CLI 已有 notice，不重复。
    return 'suspended';
  }

  /**
   * 会话的唯一收尾入口。
   *
   * 完成与失败都由这里决定会话的去留：完成关闭，可恢复失败保留。
   * 之前只有 resume() 会关闭会话，普通请求走完一轮就停在"进行中"，
   * 下一次 tick 又把它当成未完成继续协调，于是同一个业务动作被执行两次。
   */
  private finishSession(
    sessionId: string,
    outcome: 'done' | 'failed',
    messages: ChatMessage[],
    sessionKey: string | null = null,
  ): void {
    if (outcome === 'done') {
      this.runtime.store.closeRouterSession(sessionId, 'done');
      return;
    }
    this.runtime.store.saveRouterSession({
      id: sessionId,
      sessionKey,
      taskId: null,
      messages: messages.filter((message) => message.role !== 'system'),
      reason: '执行失败，等待续接',
    });
  }

  /** 是否存在待续接的协调过程：以持久化状态为准，重启后依然成立。 */
  hasPendingSession(): boolean {
    return this.runtime.store.pendingRouterSessionKeys().length > 0;
  }

  async resume(): Promise<void> {
    // 逐会话恢复：只挑全库最后一条会让别的聊天永远停在待续接。
    for (const key of this.runtime.store.pendingRouterSessionKeys()) {
      await this.resumeOne(key);
    }
  }

  private async resumeOne(sessionKey: string | null): Promise<void> {
    const session = this.runtime.store.pendingRouterSession(sessionKey);
    if (!session) return;
    // 同一会话已经有续接在跑：本次唤醒直接合并，不排进串行队列再跑一遍。
    // 检查发生在任何 await 之前，所以同一 tick 内的多次唤醒都能被挡住。
    if (this.resuming.has(session.id)) return;
    this.resuming.add(session.id);
    try {
      const outcome = await this.enqueue(
        '（继续上次未完成的协调工作，不要重复已经完成的操作）',
        {
          sessionId: session.id,
          history: this.parseHistory(session.messages),
          sessionKey: session.sessionKey,
        },
      );
      // 会话的关闭与保留已经由 runBody 统一处理，这里不再重复决定。
      if (outcome === 'failed') {
        this.runtime.store.appendEvent(null, null, 'router.resume_failed', '这一轮协调没有完成');
      }
    } finally {
      this.resuming.delete(session.id);
    }
  }

  /** 会话里的历史只接受结构完整的消息，避免把半截记录塞进下一次请求。 */
  private parseHistory(raw: unknown): ChatMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (message): message is ChatMessage =>
        typeof message === 'object' && message !== null && (message as ChatMessage).role !== 'system',
    );
  }

  private consume(messageId: string): void {
    const message = this.runtime.store.getMessage(messageId);
    if (!message) return;
    if (message.status === 'queued') this.runtime.store.setMessageStatus(messageId, 'delivered');
    if (this.runtime.store.getMessage(messageId)?.status === 'delivered') {
      this.runtime.store.setMessageStatus(messageId, 'consumed');
    }
  }

  private async executeTool(
    name: string,
    rawArguments: string,
    receipt?: { sessionId: string; actionKey: string; sessionKey?: string | null },
  ): Promise<string> {
    if (this.readOnly && (name === 'create_task' || name === 'send_to_worker')) {
      return '只读模式：本次只做汇报，不能建立任务、修改要求或向 Worker 发消息。请基于现有事实回答用户。';
    }
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return '参数必须是 JSON 对象';
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      return `参数不是合法 JSON：${(error as Error).message}`;
    }

    try {
      switch (name) {
        case 'create_task': {
          // 业务变更与操作回执同一个事务：要么都生效，要么都不生效。
          // 这样"任务建好了、回执还没写"的崩溃点就不存在了。
          let recorded: string | null = null;
          const created = this.runtime.createTask(
            {
              title: text(args['title'], 'title'),
              goal: text(args['goal'], 'goal'),
              brief: optional(args['brief']) ?? '',
              doneCriteria: optional(args['done_criteria']) ?? '',
              requireReview: args['require_review'] === true,
              ownerRole: text(args['owner_role'], 'owner_role'),
              ownerBrief: text(args['owner_brief'], 'owner_brief'),
              // 来源与建任务同事务写入：崩溃后回信目标不会丢。
              source: this.sourceOfSession(receipt?.sessionKey ?? null),
            },
            {
              onRecorded: (task, owner) => {
                const text = `已创建任务 ${task.id}，负责人 ${owner.id}。任务在后台执行，你可以继续与用户交互。`;
                recorded = text;
                // 回执与业务变更同事务落库：崩溃后不会出现"任务在、回执不在"。
                if (receipt) {
                  this.runtime.store.saveRouterAction({
                    id: `ra_${randomBytes(4).toString('hex')}`,
                    sessionId: receipt.sessionId,
                    actionKey: receipt.actionKey,
                    tool: name,
                    result: text,
                  });
                }
              },
            },
          );
          void created;
          return recorded ?? `已创建任务 ${created.task.id}，负责人 ${created.owner.id}。`;
        }
        case 'send_to_worker': {
          const result = this.runtime.sendRouterMessage({
            taskId: text(args['task_id'], 'task_id'),
            workerId: text(args['worker_id'], 'worker_id'),
            kind: text(args['kind'], 'kind') as 'update' | 'stop',
            body: text(args['body'], 'body'),
          });
          return result.ok ? `已投递消息 ${result.messageId}` : `投递失败：${result.reason}`;
        }
        case 'stop_task': {
          const ok = await this.runtime.stopTask(text(args['task_id'], 'task_id'), text(args['reason'], 'reason'));
          return ok ? '任务已取消' : '任务不存在或已结束';
        }
        case 'send_file': {
          const taskId = text(args['task_id'], 'task_id');
          const name = text(args['name'], 'name');
          const note = optional(args['note']) ?? '';
          const task = this.runtime.store.getTask(taskId);
          if (!task) return `任务不存在：${taskId}`;
          if (!this.visibleTo(task, receipt?.sessionKey ?? null)) {
            return `任务 ${taskId} 属于另一个会话，不能从这里取文件。`;
          }
          const artifact = this.runtime.store
            .listArtifacts(taskId)
            .filter((item) => item.name === name)
            .at(-1);
          if (!artifact) {
            return `任务 ${taskId} 没有名为 ${name} 的产物；可用产物：${
              this.runtime.store.listArtifacts(taskId).map((item) => item.name).join('、') || '（暂无）'
            }`;
          }
          const sessionKey = receipt?.sessionKey ?? null;
          if (sessionKey === null) return `已找到产物 ${name}（CLI 会话不通过聊天发送文件）`;
          this.publish({
            type: 'channel.outbound',
            sessionKey,
            text: note,
            taskId,
            artifact: name,
          });
          return `已把 ${name}（v${artifact.version}）发给当前聊天`;
        }
        case 'list_tasks':
          return this.renderTaskCards(receipt?.sessionKey ?? null);
        case 'read_task': {
          const taskId = text(args['task_id'], 'task_id');
          const task = this.runtime.store.getTask(taskId);
          if (!task) return `任务不存在：${taskId}`;
          if (!this.visibleTo(task, receipt?.sessionKey ?? null)) {
            return `任务 ${taskId} 属于另一个会话，本轮不跨渠道读取。要了解它，请在发起它的那个聊天里询问。`;
          }
          const workers = this.runtime.listGroupWorkers(task.groupId);
          const recent = this.runtime.store.listGroupMessages(task.groupId, 20).slice(-10);
          const lines = [
            `任务 ${task.id}｜${task.title}｜状态 ${task.status}`,
            `目标：${task.goal}`,
            `完成条件：${task.doneCriteria || '（未设置）'}`,
            `要求检查：${task.requireReview ? '是' : '否'}`,
            `Worker：`,
            ...workers.map((worker) => `  - ${worker.id}｜${worker.role}｜${worker.status}｜步数 ${worker.stepCount}`),
            `最近消息：`,
            ...recent.map((message) => `  - [${message.id}] ${message.fromId}→${message.toId} ${message.kind} ${message.status}：${message.body.slice(0, 120)}`),
          ];
          return lines.join('\n');
        }
        default:
          return `未知工具：${name}`;
      }
    } catch (error) {
      return `执行失败：${(error as Error).message}`;
    }
  }

  /**
   * 任务是否对当前会话可见。
   *
   * 当前会话发起的任务、以及没有来源的 CLI 老任务可见；其余聊天的一律不可见，
   * 避免凭任务编号猜到别人的任务。
   */
  private visibleTo(task: { sourceSessionKey?: string | null }, sessionKey: string | null): boolean {
    const source = task.sourceSessionKey ?? null;
    if (source === null) return true;
    return source === sessionKey;
  }

  /** 会话键还原成来源三元组，用于任务归属。 */
  private sourceOfSession(sessionKey: string | null): {
    channel: string;
    accountId: string;
    peerId: string;
    sessionKey: string;
  } | null {
    if (sessionKey === null) return null;
    const parts = parseSessionKey(sessionKey);
    if (!parts) return null;
    return { channel: parts.channel, accountId: parts.accountId, peerId: parts.peerId, sessionKey };
  }

  private renderTaskCards(sessionKey: string | null = null): string {
    const tasks = this.runtime.store.listTasks().filter((task) => this.visibleTo(task, sessionKey));
    if (tasks.length === 0) return '（暂无任务）';
    return tasks
      .map((task) => {
        const workers = this.runtime.listGroupWorkers(task.groupId);
        const owner = task.ownerWorkerId ? this.runtime.store.getWorker(task.ownerWorkerId) : null;
        const latestResult = [...this.runtime.store.listGroupMessages(task.groupId, 200)]
          .reverse()
          .find((message) => message.kind === 'result');
        return taskCardLine({
          id: task.id,
          title: task.title,
          status: task.status,
          ownerId: task.ownerWorkerId,
          ownerRole: owner?.role ?? null,
          workerCount: workers.length,
          latestResult: latestResult?.body ?? null,
        });
      })
      .join('\n');
  }
}
