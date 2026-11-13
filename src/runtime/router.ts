import type { Config } from '../config.ts';
import { parseSessionKey } from '../channels/types.ts';
import { ConversationService } from '../channels/conversations.ts';
import { randomBytes } from 'node:crypto';
import type { Store } from '../storage/store.ts';
import { beijingTime, nowIso } from '../domain/ids.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { OutboundArtifact, RuntimeEvent, Task } from '../domain/types.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import type { Runtime } from './runtime.ts';
import { Execution, ExecutionRevoked } from './execution.ts';

import { renderWorkspaces, routerStateBlock, routerSystemPrompt } from './prompts.ts';
import type { DecisionClient } from '../model/decision.ts';
import type { ImagePart } from '../model/types.ts';
import { isDormantWorker, isTerminalWorker } from '../domain/state.ts';
import { boundRouterHistory, planRouterContext, runRouterNote } from './router-context.ts';
import { runAgentLoop, type AgentContext, type AgentLoopConfig } from '@earendil-works/pi-agent-core';
import { makeStreamFn, strictToolArguments, toAgentMessages, toLlmMessages, toStepResult } from './pi-worker.ts';

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
        brief: { type: 'string', description: '背景材料、用户约束和输入位置；可调整的方法不要写成用户要求' },
        done_criteria: { type: 'string', description: '用户要求的结果与验收条件，不额外添加方法性门槛' },
        require_review: { type: 'boolean', description: '是否必须经过同组检查才能交付' },
        owner_role: { type: 'string', description: '负责人职责摘要' },
        owner_brief: { type: 'string', description: '负责人具体要做什么' },
        input_artifact_ids: { type: 'array', items: { type: 'string' }, description: '需作为输入的本会话既有产物 ID；用 read_task 查看具体版本，快照不继承检查结论' },
        model: {
          type: 'string',
          description:
            '负责人使用的模型别名（可选）。不填则沿用默认别名。填了必须是已配置的别名；未配置会明确报错，不会静默回退。',
        },
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
    name: 'attach_materials',
    description:
      '把用户在这条聊天里刚发来的文件补充给一个已有任务（不新建任务）。用户说"把这个文件也给它/补个材料"时用。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要补充材料的任务 id' },
        note: { type: 'string', description: '给负责人说明这份材料是什么，可为空' },
      },
      required: ['task_id'],
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
  {
    name: 'conversation_list',
    description: '列出当前聊天里的所有话题（编号、名字、是否当前）。用户问"有哪些话题/之前聊了什么话题"时用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'conversation_new',
    description: '在当前聊天里新建一个话题并切换过去。之后的消息、任务都归属新话题。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: '话题名，可为空' } },
      required: [],
    },
  },
  {
    name: 'notify_maintainer',
    description:
      '给维护者（Watchdog，独立进程）留一条通报，不要求它回应。' +
      '适合：用户报告了系统异常、你观察到某个 Worker 反复失败或卡住、你发现配置或环境有问题。' +
      '它会在下一次巡检里看到。不要用它转述用户的普通需求——那些用 create_task。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的事，一句话讲清现象和影响' },
        refs: { type: 'array', items: { type: 'string' }, description: '可核对的东西：任务 id、worker id、用户原话' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask_maintainer',
    description:
      '向维护者提问，只有它知道的事（例如：主系统最近重启过吗、某个 Worker 是不是被它挂起的、有什么未解决事件）。' +
      '它是异步的：这一轮先把问题发出去并告诉用户"我在核实"，回答到达后你会被重新唤醒。不要在同一轮里等它。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '具体问题，一次只问一件' },
      },
      required: ['question'],
    },
  },
  {
    name: 'reply_intercom',
    description: '回复维护者的问题或请求；只能回复当前会话和话题收到的消息。',
    parameters: { type: 'object', properties: {
      message_id: { type: 'string' }, body: { type: 'string' },
    }, required: ['message_id', 'body'] },
  },
  {
    name: 'read_maintainer_status',
    description:
      '只读查看维护者当前掌握的事实：未解决事件、最近的控制指令结果、上次重启时间。' +
      '回答"系统最近有什么问题""刚才为什么断了一下"之前先看它，不要猜。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'conversation_switch',
    description: '切换当前话题。用户说"回到刚才那个话题"时用它，引用 /list 里显示的编号或名字。',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: '话题编号或名字' } },
      required: ['ref'],
    },
  },
];

/**
 * 一次 Router 执行的可变作用域。
 *
 * 话题不是"本轮开始时拍一张快照"：模型可以在同一轮里新建或切换话题，
 * 之后的工具、任务归属、最终回信、崩溃续接都必须跟着新话题走。
 */
interface RunScope {
  sessionKey: string | null;
  conversationId: string | null;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${field}`);
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 建任务时 Router 指的模型别名。
 *
 * 三条边界都要硬：
 * 1) 没填 → undefined，由 createTask 落到默认别名（旧行为不变）；
 * 2) 填了目录里没有的 → 报错，不做拼写纠正、不回退默认；
 * 3) 填了非字符串（数字、对象等）→ 也报错。若当成"没填"，一次写错就会悄悄
 *    退化成默认模型，调用方还以为自己指派了强模型。
 */
function modelAliasArg(value: unknown, available: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`model 必须是模型别名字符串，收到 ${typeof value}；可用别名：${available.join(', ')}`);
  }
  const alias = value.trim();
  if (alias === '') return undefined;
  if (!available.includes(alias)) {
    throw new Error(`未配置的模型别名：${alias}；可用别名：${available.join(', ')}`);
  }
  return alias;
}

export class Router {
  /**
   * 每个会话一条串行链。
   *
   * 同一条聊天内保持顺序；不同聊天互不阻塞——否则一个长任务所在聊天的
   * 排队会把别的聊天一起卡住。
   */
  private readonly chains = new Map<string, Promise<void>>();
  /** 正在进行的自动汇报：并发调用共享它，避免重复跑。 */
  private notifyRun: Promise<void> | null = null;

  private readonly runtime: Runtime;
  private readonly model: ModelClient;
  private readonly modelName: string;
  private readonly classifier: { client: DecisionClient; model: string } | null;
  private readonly config: Config;
  /** 话题的确定性操作：新建/列出/切换都由代码做，模型只表达意图。 */
  private readonly conversations: ConversationService;

  private readonly readOnly: boolean;
  /** 正在续接的会话：防止定时 tick 把同一个会话排成一串重复执行。 */
  private readonly resuming = new Set<string>();
  /** 正在执行的协调会话：用于挡住同会话的重复唤醒。 */
  private readonly activeSessions = new Set<string>();
  /** 每条串行链当前会话的上下文：失败时据此把会话收回"待续接"。 */
  private readonly liveContexts = new Map<
    string,
    {
      sessionId: string;
      sessionKey: string | null;
      conversationId: string | null;
      messages: ChatMessage[];
      scope?: RunScope;
    }
  >();

  constructor(
    runtime: Runtime,
    model: ModelClient,
    config: Config,
    options: {
      readOnly?: boolean;
      modelName?: string;
      /** 决策模型：工作空间多到看不完时，用它来选，而不是把全部塞进上下文。 */
      classifier?: { client: DecisionClient; model: string } | null;
    } = {},
  ) {
    this.runtime = runtime;
    this.model = model;
    this.config = config;
    this.modelName = options.modelName ?? config.routerModel;
    this.conversations = new ConversationService(runtime.store);
    this.readOnly = options.readOnly ?? false;
    this.classifier = options.classifier ?? null;
  }

  /** 把一个执行请求排进所在会话的串行队列；返回这次执行的真实结果。 */
  private enqueue(
    userText: string | null,
    context: {
      sessionId?: string;
      history?: ChatMessage[];
      sessionKey?: string | null;
      /** 话题：历史、收件箱、任务卡、续接与回信归属都按它隔离。 */
      conversationId?: string | null;
      onAccepted?: () => void;
      /** 所在的串行链标识（= 会话键，CLI 为空串）。 */
      chainKey?: string;
      /** 本条消息自带的图：只在这一次请求里出现，不进历史。 */
      images?: ImagePart[];
    } = {},
  ): Promise<'done' | 'suspended' | 'failed'> {
    const key = context.sessionKey ?? '';
    context.chainKey = key;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.run(userText, context));
    // 内部串行链吞掉失败，避免一次故障让后续所有消息都直接失败。
    this.chains.set(
      key,
      run.then(
        () => {
          this.liveContexts.delete(key);
        },
        () => undefined,
      ),
    );
    return run.then(
      (outcome) => outcome,
      (error: unknown) => {
        this.publish({ type: 'router.notice', text: `Router 运行失败：${(error as Error).message}` });
        // 失败要回到"待续接"：运行中落库的状态是 running，不收回就再也续不上。
        const context = this.liveContexts.get(key);
        this.liveContexts.delete(key);
        if (context) {
          this.activeSessions.delete(context.sessionId);
          this.runtime.store.saveRouterSession({
            id: context.sessionId,
            sessionKey: context.sessionKey,
            conversationId: context.conversationId,
            taskId: null,
            messages: context.messages.filter((message) => message.role !== 'system'),
            reason: `执行失败，等待续接：${(error as Error).message}`,
            status: 'pending',
          });
        }
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
    options: {
      sessionKey?: string | null;
      conversationId?: string | null;
      onAccepted?: () => void;
      /** 当轮要看的图。只在本轮有效，落历史时会被剥掉（见 planRouterContext）。 */
      images?: ImagePart[];
    } = {},
  ): Promise<void> {
    return this.enqueue(content, {
      sessionKey: options.sessionKey ?? null,
      conversationId: options.conversationId ?? null,
      onAccepted: options.onAccepted,
      images: options.images,
    }).then(() => undefined);
  }

  /**
   * Worker 有结果/失败/提问时触发一次自动汇报；多次通知会合并。
   *
   * 返回的 Promise 在本次汇报真正结束后 resolve，便于调用方（和测试）等待；
   * 生产路径通常不 await 它。
   */
  notify(): Promise<void> {
    // 合并多次通知，但**返回同一个 Promise**：已经排过一次时，
    // 后来者要能等到这次汇报结束，而不是拿到一个立刻 resolve 的空承诺。
    if (this.notifyRun) return this.notifyRun;
    this.notifyRun = this.runNotifications();
    return this.notifyRun;
  }

  private async runNotifications(): Promise<void> {
    try {
      // 让同一 tick 内的多条汇报合并成一次。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.runtime.isStopped) return;
      // 按来源会话+话题分组汇报：多条聊天交错时，不能把别人的材料混进一次总结。
      const targets = [...this.runtime.store.routerInboxTargets()];
      // 维护者的通报同样需要一次 Router 轮次：没有 Worker 汇报时也得跑。
      for (const target of this.runtime.store.intercomRouterTargets()) {
        if (targets.some((item) => item.sessionKey === target.sessionKey && item.conversationId === target.conversationId)) continue;
        targets.push(target);
      }
      if (targets.length === 0) return;
      const outcome = await Promise.all(
        targets.map((target) =>
          this.enqueue(null, { sessionKey: target.sessionKey, conversationId: target.conversationId }),
        ),
      );
      if (outcome.some((item) => item === 'failed')) {
        this.publish({ type: 'router.notice', text: 'Router 自动汇报失败，已保留会话等待续接。' });
      }
    } catch {
      // 自动汇报失败不该把调用方（Worker 的报告路径）拖垮；状态已按待续接保存。
    } finally {
      this.notifyRun = null;
    }
  }

  /**
   * 维护者转来的消息。注入即标记已投递——不标记的话每轮都会重复出现，
   * 上下文会被"已经处理过的旧话"撑满。
   *
   * 消息按真实来源会话和话题筛选，无归属消息由管理入口单独查看。
   */
  private renderMaintainerMessages(pending: ReturnType<Store['listIntercomForRouter']>): string {
    const lines: string[] = [];
    for (const message of pending) {
      const kind = message.kind === 'question' ? '提问（需要回复）' : message.kind === 'request' ? '请求（需要判断）' : '通报';
      lines.push(`- [${message.id}] ${kind}｜${message.body}${message.replyTo ? `｜回复：${message.replyTo}` : ''}${message.refs?.length ? `｜引用：${message.refs.join('、')}` : ''}`);
    }
    return lines.join('\n');
  }

  private publish(event: RuntimeEvent): void {
    this.runtime.publish(event);
  }

  /** 只有 IM 会话才需要写发件记录；CLI 不经过渠道层。 */
  private publishOutbound(
    sessionKey: string | null,
    text: string,
    taskId: string | null,
    artifact: OutboundArtifact | null,
    conversationId: string | null = null,
  ): void {
    if (sessionKey === null || text.trim() === '') return;
    this.publish({ type: 'channel.outbound', sessionKey, text, taskId, artifact, conversationId });
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
      conversationId?: string | null;
      onAccepted?: () => void;
      chainKey?: string;
      images?: ImagePart[];
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
      // 无论正常结束、挂起还是抛错，会话都不能继续被当成"正在跑"。
      if (context.sessionId) this.activeSessions.delete(context.sessionId);
    }
  }

  private async runBody(
    userText: string | null,
    execution: Execution,
    context: {
      sessionId?: string;
      history?: ChatMessage[];
      sessionKey?: string | null;
      conversationId?: string | null;
      onAccepted?: () => void;
      chainKey?: string;
      images?: ImagePart[];
    } = {},
  ): Promise<'done' | 'suspended'> {
    if (this.runtime.isStopped) return 'done';
    const sessionKey = context.sessionKey ?? null;
    // 本次执行的作用域：话题在轮内可能被切换，后续读写必须以它为准。
    const scope: RunScope = { sessionKey, conversationId: context.conversationId ?? null };
    const conversationId = scope.conversationId;
    const inbox = this.runtime.store.listRouterInbox(sessionKey, conversationId);
    // 维护者的消息也要能单独撑起一轮：没有用户输入、也没有 Worker 汇报时，
    // 以前这里直接返回，导致「维护者发了消息但 Router 永远不跑」。
    const maintainerMessages = this.runtime.store.listIntercomForRouter(sessionKey, conversationId);
    const hasMaintainerMessage = maintainerMessages.some((message) => message.status === 'pending');
    if (userText === null && inbox.length === 0 && !hasMaintainerMessage) return 'done';

    const pending = inbox
      .map(
        (message) =>
          `- [${message.id}] 来自 ${message.fromId}｜kind=${message.kind}｜任务 ${message.taskId ?? '-'}：${message.body}`,
      )
      .join('\n');

    // 历史只从参数来：不再读共享字段，避免前后两个执行互相看到对方的上下文。
    //
    // 正常轮按 token 预算装配（超出触发摘要）；续接轮沿用会话里保存的中途消息，
    // 但走同一个预算裁剪——否则「崩溃恢复那一刻」才第一次爆窗口。
    const assembled = context.history ? null : planRouterContext({
      store: this.runtime.store,
      sessionKey,
      conversationId,
      limits: this.runtime.config.limits,
    });
    const history = context.history
      ? boundRouterHistory({ messages: context.history, limits: this.runtime.config.limits })
      : (assembled?.history ?? []);
    // system 只放不随时间变的东西（角色规则）。每轮都会变的表单与待处理消息
    // 挪到历史之后——提示缓存按前缀匹配，把易变内容摆在中间会让后面的历史每轮重算。
    const stateBlock = routerStateBlock({
      taskCards: this.renderWorkspaces(sessionKey, conversationId),
      pendingMessages: pending,
      conversationNote: assembled?.note ?? null,
      maintainerMessages: this.renderMaintainerMessages(maintainerMessages),
    });
    const messages: ChatMessage[] = [{ role: 'system', content: routerSystemPrompt() }, ...history];

    if (assembled?.toSummarize) {
      // 超阈值：先把被挤出去的旧对话压进摘要，再发请求。
      // 失败不阻断——旧摘要继续生效，窗口里少几条旧对话也比整轮失败好。
      const note = await runRouterNote({
        store: this.runtime.store,
        model: this.model,
        modelName: this.runtime.config.routerModel,
        sessionKey,
        conversationId,
        previous: assembled.note,
        turns: assembled.toSummarize.turns,
        limits: this.runtime.config.limits,
      });
      if (note.ok && note.content) {
        messages.push({ role: 'system', content: `# 更早对话的累计记录\n${note.content}` });
      } else {
        this.runtime.store.appendEvent(null, null, 'router.note_failed', note.reason ?? '摘要生成失败');
      }
    }

    if (userText !== null) {
      // 图片只挂在这一次请求上；落库的历史只有文字，下一轮不会重发 base64。
      // 状态块拼在本轮消息前面而不是放进 system：它每轮都变，放 system 里会
      // 让后面的历史全部失去缓存。落库的只有用户原话，不重复存表单。
      messages.push({
        role: 'user',
        content: userText,
        ...(context.images && context.images.length > 0 ? { images: context.images } : {}),
      });
      messages.push({ role: 'user', content: stateBlock });
      this.runtime.store.appendRouterTurn({
        id: `rt_${randomBytes(4).toString('hex')}_u`,
        role: 'user',
        content: userText,
        sessionKey,
        conversationId,
        createdAt: nowIso(),
      });
    } else {
      messages.push({
        role: 'user',
        content: `${stateBlock}\n\n# Trigger\nThese are the latest Worker messages. Decide whether to inform the user or take action.`,
      });
    }

    this.publish({ type: 'router.start', sessionKey });

    // 一条协调会话贯穿多轮调度与重试。
    const sessionId = context.sessionId ?? `rs_${randomBytes(4).toString('hex')}`;
    // 供上层在任意退出路径上清理"正在跑"标记。
    context.sessionId = sessionId;
    // 登记本次运行的会话上下文：失败时用它把会话收回"待续接"。
    this.liveContexts.set(context.chainKey ?? '', { sessionId, sessionKey, conversationId, messages, scope });
    // 会话在第一次模型请求前就落库：额度耗尽或失败时，续接入口始终存在。
    this.runtime.store.tx(() => {
      this.runtime.store.saveRouterSession({
        id: sessionId,
        sessionKey,
        conversationId,
        taskId: null,
        messages: messages.filter((message) => message.role !== 'system'),
        reason: '进行中',
        status: 'running',
      });
      for (const message of maintainerMessages) this.runtime.store.markIntercomDelivered(message.id);
    });
    // 用户输入此刻已经持久化：渠道层据此把入站记录标成"已交接"。
    // 之后再崩溃，走的是续接原会话，不会把同一条消息重新派一次工。
    context.onAccepted?.();
    this.activeSessions.add(sessionId);
    const maxRounds = Math.max(1, this.config.limits.maxRouterRounds);

    let step = 0;
    // 恢复未完成的决策时沿用原有身份与回执，绝不重新请求模型或重复已完成的动作。
    const pendingDecision = this.runtime.store.pendingRouterDecision(sessionId);
    if (pendingDecision) {
      const calls = (pendingDecision.toolCalls as { id: string; name: string; arguments: string }[]) ?? [];
      const recovered: ChatMessage[] = [{ role: 'assistant', content: pendingDecision.text, ...(pendingDecision.piMessage ? { piMessage: pendingDecision.piMessage } : {}), ...(calls.length ? { toolCalls: calls } : {}) }];
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index]!;
        const actionKey = `${pendingDecision.id}:${index}`;
        const cached = this.runtime.store.getRouterAction(sessionId, actionKey);
        const content = cached?.result ?? await this.executeTool(call.name, call.arguments, { sessionId, actionKey, sessionKey, scope });
        if (!cached) this.runtime.store.saveRouterAction({ id: `ra_${randomBytes(4).toString('hex')}`, sessionId, actionKey, tool: call.name, result: content });
        recovered.push({ role: 'tool', content, toolCallId: call.id });
      }
      this.commitDecision(pendingDecision.id, sessionId, [...messages, ...recovered]);
      messages.push(...recovered);
      step += 1;
    }

    let answer: string | null = null;
    let answerPiMessage: import('@earendil-works/pi-ai').AssistantMessage | undefined;
    if (step < maxRounds) {
      const tools = this.readOnly ? [] : ROUTER_TOOLS;
      let decision: { id: string; calls: ReturnType<typeof toStepResult>['toolCalls']; messages: ChatMessage[] } | null = null;
      let modelError: unknown;
      let toolError: unknown;
      const recordingModel: ModelClient = {
        kind: this.model.kind,
        label: this.model.label,
        chat: async (request) => {
          try {
            return await execution.attach(new RecordingModel(this.model, this.runtime.store, 'router', {
              sessionId, routerSessionKey: sessionKey, conversationId: scope.conversationId,
              modelAlias: this.config.defaultModelAlias,
            }).chat(request));
          } catch (error) {
            modelError = error;
            throw error;
          }
        },
      };
      const agentContext: AgentContext = {
        messages: [{ role: 'system', content: messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n\n'), timestamp: 0 }, ...toAgentMessages(messages)],
        tools: tools.map((tool) => ({
          ...tool, label: tool.name, prepareArguments: strictToolArguments(tool),
          execute: async (id: string, args: Record<string, unknown>) => {
            if (!decision) throw new Error('工具执行前缺少已保存的 Router 决策');
            const index = decision.calls.findIndex((call) => call.id === id);
            if (index < 0) throw new Error(`找不到 Router 工具调用 ${id}`);
            const call = decision.calls[index]!;
            const actionKey = `${decision.id}:${index}`;
            const cached = this.runtime.store.getRouterAction(sessionId, actionKey);
            try {
              const content = cached?.result ?? await this.executeTool(call.name, JSON.stringify(args), { sessionId, actionKey, sessionKey, scope });
              return { content: [{ type: 'text' as const, text: content }], details: undefined };
            } catch (error) {
              toolError = error;
              throw error;
            }
          },
        })),
      };
      const config: AgentLoopConfig = {
        model: { id: this.modelName, name: this.modelName, api: 'openai-completions', provider: 'super-agent', baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: true, contextWindow: 200_000, maxTokens: 8192 },
        toolExecution: 'sequential',
        convertToLlm: (agentMessages) => agentMessages,
        finishTurn: async (turn) => {
          if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') {
            throw modelError ?? new Error(turn.message.errorMessage ?? 'Router 模型调用失败');
          }
          step += 1;
          if (decision) {
            this.commitDecision(decision.id, sessionId, [...messages, ...decision.messages]);
            messages.push(...decision.messages);
            decision = null;
          } else {
            answer = toStepResult(turn.message).text?.trim() ?? '';
            answerPiMessage = turn.message;
            return { action: 'end' as const };
          }
          if (step >= maxRounds) return { action: 'end' as const };
          return undefined;
        },
      };
      await execution.attach(runAgentLoop([], agentContext, config, async (event) => {
        if (event.type === 'tool_execution_end' && toolError !== undefined) throw toolError;
        if (event.type !== 'message_end') return;
        if (event.message.role === 'assistant') {
          const result = toStepResult(event.message);
          if (!result.toolCalls.length || event.message.stopReason === 'error' || event.message.stopReason === 'aborted') return;
          const id = `rd_${randomBytes(4).toString('hex')}`;
          this.runtime.store.saveRouterDecision({ id, sessionId, turnNo: step, text: result.text, toolCalls: result.toolCalls, piMessage: result.piMessage });
          decision = { id, calls: result.toolCalls, messages: [{ role: 'assistant', content: result.text, toolCalls: result.toolCalls, piMessage: result.piMessage }] };
          this.publish({ type: 'router.progress', text: `正在执行：${result.toolCalls.map((call) => call.name).join('、')}`, sessionKey });
        } else if (event.message.role === 'toolResult' && decision) {
          const toolMessage = event.message;
          const index = decision.calls.findIndex((call) => call.id === toolMessage.toolCallId);
          if (index < 0) throw new Error(`找不到 Router 工具回执 ${event.message.toolCallId}`);
          const content = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
          this.runtime.store.saveRouterAction({ id: `ra_${randomBytes(4).toString('hex')}`, sessionId, actionKey: `${decision.id}:${index}`, tool: decision.calls[index]!.name, result: content });
          decision.messages.push(...toLlmMessages([event.message]).chat);
        }
      }, this.runtime.lifecycleSignal ?? undefined, makeStreamFn(recordingModel, tools, this.modelName, this.config.reasoningEffort)));
    }

    if (answer !== null) {
      if (answer === '') {
        this.publish({ type: 'router.notice', text: 'Router 没有输出内容，已忽略本轮。', sessionKey });
        this.finishSession(sessionId, 'done', messages, sessionKey, scope.conversationId);
        return 'done';
      }
      messages.push({ role: 'assistant', content: answer, ...(answerPiMessage ? { piMessage: answerPiMessage } : {}) });
      this.runtime.store.appendRouterTurn({ id: `rt_${randomBytes(4).toString('hex')}_a`, role: 'assistant', content: answer, piMessage: answerPiMessage, sessionKey, conversationId: scope.conversationId, createdAt: nowIso() });
      this.publish({ type: 'router.reply', text: answer, sessionKey });
      this.publishOutbound(sessionKey, answer, inbox[0]?.taskId ?? null, null, scope.conversationId);
      for (const message of inbox) this.consume(message.id);
      this.finishSession(sessionId, 'done', messages, sessionKey, scope.conversationId);
      return 'done';
    }

    // 挂起：保存最新进度，下一轮续接。这是唯一保留待续接状态的路径。
    this.runtime.store.saveRouterSession({
      id: sessionId,
      sessionKey,
      conversationId: scope.conversationId,
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
   * 一批工具调用结束后记录"这一步真的做完了"。
   *
   * 决策状态和会话检查点在同一个事务里提交：崩溃后要么整步重来（从决策记录里拿到
   * 同样的工具结果），要么整步已被记住，绝不会出现"决策说完成、检查点还停在动手之前"。
   */
  private commitDecision(decisionId: string, sessionId: string, messages: ChatMessage[]): void {
    this.runtime.store.finishRouterDecision({
      id: decisionId,
      sessionId,
      messages: messages.filter((message) => message.role !== 'system'),
    });
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
    conversationId: string | null = null,
  ): void {
    this.activeSessions.delete(sessionId);
    if (outcome === 'done') {
      this.runtime.store.closeRouterSession(sessionId, 'done');
      return;
    }
    this.runtime.store.saveRouterSession({
      id: sessionId,
      sessionKey,
      conversationId,
      taskId: null,
      messages: messages.filter((message) => message.role !== 'system'),
      reason: '执行失败，等待续接',
      status: 'pending',
    });
  }

  /** 是否存在待续接的协调过程：以持久化状态为准，重启后依然成立。 */
  hasPendingSession(): boolean {
    return this.runtime.store.pendingRouterSessionKeys().length > 0;
  }

  async resume(): Promise<void> {
    // 逐会话、逐话题恢复：只挑全库最后一条会让别的聊天永远停在待续接。
    for (const entry of this.runtime.store.pendingRouterSessions()) {
      await this.resumeOne(entry.sessionKey, entry.conversationId);
    }
  }

  private async resumeOne(sessionKey: string | null, conversationId: string | null = null): Promise<void> {
    const session = this.runtime.store.pendingRouterSession(sessionKey, conversationId);
    if (!session) return;
    // 内存里也挡一道：同一会话正在跑时，任何唤醒都只是合并，不新开一轮。
    if (this.activeSessions.has(session.id)) return;
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
          conversationId: session.conversationId,
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
    receipt?: {
      sessionId: string;
      actionKey: string;
      sessionKey?: string | null;
      /** 本次执行的作用域；话题在轮内被切换后就地更新，后续工具读到新值。 */
      scope?: RunScope;
    },
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
          const rawInputs = args['input_artifact_ids'];
          if (rawInputs !== undefined && (!Array.isArray(rawInputs) || rawInputs.some((id) => typeof id !== 'string' || !id.trim()))) {
            throw new Error('input_artifact_ids 必须是产物 ID 字符串数组');
          }
          const inputArtifacts = (rawInputs as string[] | undefined ?? []).map((id) => {
            const artifact = this.runtime.getArtifact(id);
            if (!artifact) throw new Error(`产物不存在：${id}`);
            const sourceTask = this.runtime.store.getTask(artifact.taskId);
            if (!sourceTask || (sourceTask.sourceSessionKey ?? null) !== (receipt?.sessionKey ?? null) ||
                (sourceTask.sourceConversationId ?? null) !== (receipt?.scope?.conversationId ?? null)) {
              throw new Error(`产物 ${id} 不属于当前会话和话题`);
            }
            return artifact;
          });
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
              // Router 可以指派负责人模型：别名先按目录校验，未配置直接拒绝，
              // 不静默回退——否则"指定了强模型"会变成一句空话，没人会发现。
              model: modelAliasArg(args['model'], this.modelAliases()),
              inputArtifacts,
              // 分类只决定「归到哪个空间」，失败不拦建任务——Router 自己看得见表单。
              workspaceId: await this.pickWorkspace({
                title: text(args['title'], 'title'),
                goal: text(args['goal'], 'goal'),
                sessionKey: receipt?.sessionKey ?? null,
                conversationId: receipt?.scope?.conversationId ?? null,
              }),
              // 来源与建任务同事务写入：崩溃后回信目标不会丢。
              source: this.sourceOfSession(receipt?.sessionKey ?? null, receipt?.scope?.conversationId ?? null),
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
          const allowed = this.taskForAction(
              text(args['task_id'], 'task_id'),
              receipt?.sessionKey ?? null,
              receipt?.scope?.conversationId ?? null,
            );
          if (!allowed.ok) return allowed.message;
          const result = this.runtime.sendRouterMessage({
            taskId: allowed.task.id,
            workerId: text(args['worker_id'], 'worker_id'),
            kind: text(args['kind'], 'kind') as 'update' | 'stop',
            body: text(args['body'], 'body'),
          });
          return result.ok ? `已投递消息 ${result.messageId}` : `投递失败：${result.reason}`;
        }
        case 'stop_task': {
          const allowed = this.taskForAction(
              text(args['task_id'], 'task_id'),
              receipt?.sessionKey ?? null,
              receipt?.scope?.conversationId ?? null,
            );
          if (!allowed.ok) return allowed.message;
          const ok = await this.runtime.stopTask(allowed.task.id, text(args['reason'], 'reason'));
          return ok ? '任务已取消' : '任务不存在或已结束';
        }
        case 'send_file': {
          const allowed = this.taskForAction(
              text(args['task_id'], 'task_id'),
              receipt?.sessionKey ?? null,
              receipt?.scope?.conversationId ?? null,
            );
          if (!allowed.ok) return allowed.message;
          const task = allowed.task;
          const taskId = task.id;
          const name = text(args['name'], 'name');
          const note = optional(args['note']) ?? '';
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
            // 版本在这句话里就固定下来：排队时是 v1，之后再有 v2 也不会被调包。
            artifact: {
              artifactId: artifact.id,
              name: artifact.name,
              version: artifact.version,
              sha256: artifact.sha256,
              bytes: artifact.bytes,
            },
            conversationId: receipt?.scope?.conversationId ?? null,
          });
          return `已把 ${artifact.name}（v${artifact.version}）加入发送队列`;
        }
        case 'conversation_list': {
          const sessionKey = receipt?.sessionKey ?? null;
          if (sessionKey === null) return 'CLI 会话没有话题，所有对话都在同一条历史里。';
          const list = this.conversations.list(sessionKey);
          if (list.length === 0) return '这个聊天还没有话题。';
          const currentId = this.conversations.ensureCurrent(sessionKey).id;
          return list
            .map((item, index) => `${item.id === currentId ? '●' : '○'} ${index + 1}. ${item.title}`)
            .join('\n');
        }
        case 'conversation_new': {
          const sessionKey = receipt?.sessionKey ?? null;
          if (sessionKey === null) return 'CLI 会话没有话题。';
          const title = optional(args['title']) ?? '新话题';
          const created = this.conversations.create(sessionKey, title);
          this.rebindConversation(receipt, created.id);
          return `已新建并切换到话题「${created.title}」（${created.id}）。后续操作都属于这个新话题。`;
        }
        case 'notify_maintainer': {
          const notice = text(args['text'], 'text').trim();
          if (notice === '') return '通报内容不能为空。';
          const refs = Array.isArray(args['refs'])
            ? (args['refs'] as unknown[]).filter((item): item is string => typeof item === 'string')
            : null;
          const id = `ic_${randomBytes(4).toString('hex')}`;
          this.runtime.store.insertIntercom({
            id,
            fromLayer: 'router',
            kind: 'notice',
            body: notice.slice(0, 2000),
            refs,
            sessionKey: receipt?.sessionKey ?? null,
            conversationId: receipt?.scope?.conversationId ?? null,
            routeKnown: true,
          });
          // 立刻叫醒维护者：它下一次巡检本来可能在半小时后。
          this.runtime.wakeMaintainer();
          return `已通报维护者（${id}），它会在下一次巡检看到。`;
        }
        case 'ask_maintainer': {
          const question = text(args['question'], 'question').trim();
          if (question === '') return '问题不能为空。';
          const id = `ic_${randomBytes(4).toString('hex')}`;
          this.runtime.store.insertIntercom({
            id,
            fromLayer: 'router',
            kind: 'question',
            body: question.slice(0, 2000),
            topicId: id,
            sessionKey: receipt?.sessionKey ?? null,
            conversationId: receipt?.scope?.conversationId ?? null,
            routeKnown: true,
          });
          this.runtime.wakeMaintainer();
          return `问题已发给维护者（${id}）。这是异步的：先告诉用户你在核实，回答到达后你会被重新唤醒。`;
        }
        case 'reply_intercom': {
          const id = text(args['message_id'], 'message_id');
          const body = text(args['body'], 'body').trim();
          if (!body) return '回复内容不能为空。';
          const original = this.runtime.store.getIntercom(id);
          const sessionKey = receipt?.sessionKey ?? null;
          const conversationId = receipt?.scope?.conversationId ?? null;
          if (!original || original.toLayer !== 'router' ||
              (original.routeKnown ? original.sessionKey !== sessionKey || original.conversationId !== conversationId : sessionKey !== null)) {
            return '找不到当前会话可回复的维护消息。';
          }
          if (!this.runtime.store.replyIntercom(original, `ic_${randomBytes(4).toString('hex')}`, body.slice(0, 2000))) {
            return '该消息已回复或不需要回复。';
          }
          this.runtime.wakeMaintainer();
          return '已回复维护者。';
        }
        case 'read_maintainer_status': {
          const status = this.runtime.store.maintainerStatus();
          const lines = [
            `上次重启：${status.lastRestartAt ? beijingTime(status.lastRestartAt) : '（没有重启记录）'}`,
            `未解决事件：${status.openIssues.length === 0 ? '无' : ''}`,
            ...status.openIssues.map(
              (issue) => `- ${issue.id}｜${issue.title}｜最后出现 ${beijingTime(issue.lastSeen)}${issue.note ? `｜${issue.note}` : ''}`,
            ),
            `最近控制指令：${status.recentCommands.length === 0 ? '无' : ''}`,
            ...status.recentCommands.map(
              (command) => `- ${beijingTime(command.createdAt)} ${command.command} → ${command.status}｜${command.result ?? ''}`,
            ),
            ...(receipt?.sessionKey == null ? this.runtime.store.listOpenIntercom('router', 50, true)
              .map((message) => `- 未指定会话 ${message.id}｜${message.kind}｜${message.body}`) : []),
          ];
          return lines.join('\n');
        }
        case 'conversation_switch': {
          const sessionKey = receipt?.sessionKey ?? null;
          if (sessionKey === null) return 'CLI 会话没有话题。';
          const target = this.conversations.switchTo(sessionKey, text(args['ref'], 'ref'));
          if (!target) return `没找到话题「${String(args['ref'])}」。先用 conversation_list 看看有哪些。`;
          this.rebindConversation(receipt, target.id);
          return `已切换到话题「${target.title}」（${target.id}）。后续操作都属于这个话题。`;
        }
        case 'attach_materials': {
          const taskId = text(args['task_id'], 'task_id');
          const allowed = this.taskForAction(
            taskId,
            receipt?.sessionKey ?? null,
            receipt?.scope?.conversationId ?? null,
          );
          if (!allowed.ok) return allowed.message;
          const sessionKey = receipt?.sessionKey ?? null;
          if (sessionKey === null) return 'CLI 会话没有聊天材料可补充。';
          // 通知与要求版本由 runtime 统一处理：note 只是附加说明，不决定是否通知。
          const attached = this.runtime.attachSessionMaterials(
            taskId,
            sessionKey,
            receipt?.scope?.conversationId ?? null,
            optional(args['note']),
          );
          if (!attached.ok) return attached.message;
          return `已把 ${attached.files.length} 份材料补充给任务 ${taskId}，已通知负责人重新核对，旧检查不再算数：\n${attached.files
            .map((item) => `- ${item.path}`)
            .join('\n')}`;
        }
        case 'list_tasks':
          return this.renderWorkspaces(receipt?.sessionKey ?? null, receipt?.scope?.conversationId ?? null);
        case 'read_task': {
          const allowed = this.taskForAction(
              text(args['task_id'], 'task_id'),
              receipt?.sessionKey ?? null,
              receipt?.scope?.conversationId ?? null,
            );
          if (!allowed.ok) return allowed.message;
          const task = allowed.task;
          const workers = this.runtime.listGroupWorkers(task.groupId);
          const recent = this.runtime.store.listGroupMessages(task.groupId, 20).slice(-10);
          const lines = [
            `任务 ${task.id}｜${task.title}｜状态 ${task.status}`,
            `目标：${task.goal}`,
            `完成条件：${task.doneCriteria || '（未设置）'}`,
            `要求检查：${task.requireReview ? '是' : '否'}`,
            `已登记产物：`,
            ...this.runtime.store.listArtifacts(task.id).map((artifact) => `  - ${artifact.id}｜${artifact.name}｜v${artifact.version}｜sha256 ${artifact.sha256}`),
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
   * 归属必须精确相等：CLI 会话只看到 CLI 建的任务，某个聊天只看到自己建的任务。
   * 以前把「没有来源的任务」对所有会话一律放行，结果是微信用户问一句话，
   * Router 拿到的任务卡是 CLI 留下的旧任务，而本聊天刚建的任务反而不在上下文里。
   */
  /**
   * 话题切换后的执行边界：把本轮的作用域、内存上下文和持久会话一起挪过去。
   *
   * 只改数据库里的"当前话题指针"不够：本轮剩下的工具、任务归属、最终回信，
   * 以及崩溃后续接，都在用本轮开始时的话题，于是任务会落进旧话题、用户在新话题里看不到。
   */
  private rebindConversation(
    receipt: { sessionId: string; scope?: RunScope } | undefined,
    conversationId: string,
  ): void {
    if (!receipt?.scope) return;
    receipt.scope.conversationId = conversationId;
    for (const entry of this.liveContexts.values()) {
      if (entry.sessionId !== receipt.sessionId) continue;
      entry.conversationId = conversationId;
    }
    // 持久会话也跟着走：重启续接时按话题恢复，不能续到旧话题里。
    this.runtime.store.setRouterSessionConversation(receipt.sessionId, conversationId);
  }

  /**
   * 任务是否属于当前会话（会话键 + 话题）。
   *
   * 老任务没有话题归属（source_conversation_id 为 NULL），仍按"本聊天可见"处理，
   * 否则升级后旧任务会突然全部消失。
   */
  private visibleTo(
    task: { sourceSessionKey?: string | null; sourceConversationId?: string | null },
    sessionKey: string | null,
    conversationId: string | null = null,
  ): boolean {
    if ((task.sourceSessionKey ?? null) !== sessionKey) return false;
    if (conversationId === null) return true;
    const owner = task.sourceConversationId ?? null;
    return owner === null || owner === conversationId;
  }

  /**
   * 任务类动作的唯一授权入口。
   *
   * 读取、改要求、停止、发文件必须走同一套判断：任务存在、且属于当前会话。
   * 之前只有读取做了校验，改要求的入口能凭任务编号操作别的聊天的任务。
   */
  private taskForAction(
    taskId: string,
    sessionKey: string | null,
    conversationId: string | null = null,
  ): { ok: true; task: Task } | { ok: false; message: string } {
    const task = this.runtime.store.getTask(taskId);
    if (!task) return { ok: false, message: `任务不存在：${taskId}` };
    if (!this.visibleTo(task, sessionKey, conversationId)) {
      return { ok: false, message: `任务 ${taskId} 属于另一个会话，这里不能读取也不能修改它。` };
    }
    return { ok: true, task };
  }

  /** 会话键还原成来源三元组，用于任务归属。 */
  private sourceOfSession(
    sessionKey: string | null,
    conversationId: string | null = null,
  ): {
    channel: string;
    accountId: string;
    peerId: string;
    sessionKey: string;
    conversationId: string | null;
  } | null {
    if (sessionKey === null) return null;
    const parts = parseSessionKey(sessionKey);
    if (!parts) return null;
    return {
      channel: parts.channel,
      accountId: parts.accountId,
      peerId: parts.peerId,
      sessionKey,
      conversationId,
    };
  }

  /** 交给工具层做别名校验：模型目录只有一处真相，不在 Router 里另存一份。 */
  private modelAliases(): string[] {
    return this.runtime.models.list().map((item) => item.alias);
  }

  /**
   * 工作空间表单：Router 不用调工具就能回答「现在在干什么」。
   *
   * 数据全部现成：「在干什么」取该成员最后一条 assistant 文本，
   * 「最近交付」取组里最后一条 result 消息，「待处理」数它收件箱里没消费的。
   */
  private renderWorkspaces(sessionKey: string | null = null, conversationId: string | null = null): string {
    const spaces = this.runtime.store.listWorkspacesForConversation(sessionKey, conversationId);
    if (spaces.length === 0) return '（暂无工作空间）';
    return renderWorkspaces(
      spaces.slice(0, 8).map((space) => {
        const workers = this.runtime.store.listGroupWorkers(space.id);
        const active = workers.filter((worker) => !isTerminalWorker(worker.status) && !isDormantWorker(worker.status));
        const dormantCount = workers.filter((worker) => isDormantWorker(worker.status)).length;
        const latestResult = [...this.runtime.store.listGroupMessages(space.id, 200)]
          .reverse()
          .find((message) => message.kind === 'result');
        return {
          id: space.id,
          title: space.title,
          status: space.status,
          currentTask: (() => {
            // 任务完成后成员休眠、currentTaskId 归空，所以这里取「最近一条任务」，
            // 而不是「谁现在挂在这个任务上」——Router 要靠它认产物归谁。
            const task = this.runtime.store.latestTaskForWorkspace(space.id);
            return task ? { id: task.id, title: task.title, status: task.status } : null;
          })(),
          active: active.slice(0, 6).map((worker) => ({
            workerId: worker.id,
            role: worker.role,
            status: worker.status,
            doing: this.lastAssistantText(worker.id),
            steps: Number(worker.stepCount ?? 0),
          })),
          dormantCount,
          dormant: workers
            .filter((worker) => isDormantWorker(worker.status))
            .slice(0, 6)
            .map((worker) => ({ workerId: worker.id, role: worker.role })),
          lastActiveAt: space.lastActiveAt ? space.lastActiveAt.slice(11, 16) : null,
          latestResult: latestResult?.body ?? null,
          pending: active.reduce((sum, worker) => sum + this.runtime.store.listInbox(worker.id).length, 0),
        };
      }),
    );
  }

  /**
   * 这个任务该归到哪个工作空间。
   *
   * 空间少的时候不值得多一次调用，直接把名字给 Router 自己看（它本来就有表单）；
   * 多了才用决策模型——它只吃名字列表，不占 Router 的上下文，而且返回概率，
   * 不确定时可以退回新建。
   */
  async pickWorkspace(input: {
    title: string;
    goal: string;
    sessionKey: string | null;
    conversationId: string | null;
  }): Promise<string | null> {
    const spaces = this.runtime.store.listWorkspacesForConversation(input.sessionKey, input.conversationId);
    if (!this.classifier || spaces.length < 4) return null;
    const criteria: Record<string, string> = {};
    for (const space of spaces.slice(0, 12)) criteria[space.id] = `${space.title}：${space.brief}`.slice(0, 160);
    criteria['new'] = '以上都不像，新建一个工作空间';
    try {
      const picked = await this.classifier.client.choose({
        model: this.classifier.model,
        state: `任务标题：${input.title}\n任务目标：${input.goal}\n\n它应该归入哪个工作空间？`,
        instructions:
          '判断这个新任务与哪个工作空间的主题最接近。只按主题判断，不要因为"最近用过"就选它；' +
          '确实都不像就选 new。',
        criteria,
      });
      if (picked.choice === 'new' || !spaces.some((item) => item.id === picked.choice)) return null;
      return picked.confidence >= 0.6 ? picked.choice : null;
    } catch {
      // 分类器不可用不该拦住建任务：退回让 Router 自己选（它看得见表单）。
      return null;
    }
  }

  /** 成员此刻在做什么：最后一条 assistant 的自然语言，截短。 */
  private lastAssistantText(workerId: string): string | null {
    const turns = this.runtime.store.listWorkerTurns(workerId, 6);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      if (turn.role !== 'assistant') continue;
      const text = (turn.content ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
    return null;
  }
}
