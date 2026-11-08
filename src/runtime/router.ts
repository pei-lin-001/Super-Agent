import type { Config } from '../config.ts';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../domain/ids.ts';
import type { RuntimeEvent } from '../domain/types.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import type { Runtime } from './runtime.ts';
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
  private chain: Promise<void> = Promise.resolve();
  private notifyScheduled = false;

  private readonly runtime: Runtime;
  private readonly model: ModelClient;
  private readonly config: Config;

  constructor(runtime: Runtime, model: ModelClient, config: Config) {
    this.runtime = runtime;
    this.model = model;
    this.config = config;
  }

  handleUserMessage(content: string): Promise<void> {
    this.chain = this.chain
      .then(() => this.run(content))
      .catch((error: unknown) => this.publish({ type: 'router.notice', text: `Router 运行失败：${(error as Error).message}` }));
    return this.chain;
  }

  /** Worker 有结果/失败/提问时触发一次自动汇报；多次通知会合并。 */
  notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      if (this.runtime.isStopped) return;
      if (this.runtime.store.listRouterInbox().length === 0) return;
      this.chain = this.chain
        .then(() => this.run(null))
        .catch((error: unknown) =>
          this.publish({ type: 'router.notice', text: `Router 自动汇报失败：${(error as Error).message}` }),
        );
    }, 0);
  }

  private publish(event: RuntimeEvent): void {
    this.runtime.publish(event);
  }

  private async run(userText: string | null): Promise<void> {
    if (this.runtime.isStopped) return;
    const inbox = this.runtime.store.listRouterInbox();
    if (userText === null && inbox.length === 0) return;

    const pending = inbox
      .map(
        (message) =>
          `- [${message.id}] 来自 ${message.fromId}｜kind=${message.kind}｜任务 ${message.taskId ?? '-'}：${message.body}`,
      )
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: routerSystemPrompt({ taskCards: this.renderTaskCards(), pendingMessages: pending }),
      },
      ...this.runtime.store.listRouterTurns(20).map(
        (turn): ChatMessage => ({ role: turn.role, content: turn.content }),
      ),
    ];

    if (userText !== null) {
      messages.push({ role: 'user', content: userText });
      this.runtime.store.appendRouterTurn({
        id: `rt_${randomBytes(4).toString('hex')}_u`,
        role: 'user',
        content: userText,
        createdAt: nowIso(),
      });
    } else {
      messages.push({ role: 'user', content: '以上是 Worker 的最新消息，请判断是否需要向用户汇报或采取动作。' });
    }

    this.publish({ type: 'router.start' });

    for (let step = 0; step < 6; step += 1) {
      const result = await this.model.chat({
        model: this.config.routerModel,
        messages,
        tools: ROUTER_TOOLS,
        reasoningEffort: this.config.reasoningEffort,
      });
      messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      });

      if (result.toolCalls.length === 0) {
        const answer = result.text?.trim() ?? '';
        if (answer === '') {
          this.publish({ type: 'router.notice', text: 'Router 没有输出内容，已忽略本轮。' });
          return;
        }
        this.runtime.store.appendRouterTurn({
          id: `rt_${randomBytes(4).toString('hex')}_a`,
          role: 'assistant',
          content: answer,
          createdAt: nowIso(),
        });
        this.publish({ type: 'router.reply', text: answer });
        for (const message of inbox) this.consume(message.id);
        return;
      }

      for (const call of result.toolCalls) {
        const content = await this.executeTool(call.name, call.arguments);
        messages.push({ role: 'tool', content, toolCallId: call.id });
      }
    }

    this.publish({ type: 'router.notice', text: 'Router 达到单轮步数上限，已结束本轮。' });
  }

  private consume(messageId: string): void {
    const message = this.runtime.store.getMessage(messageId);
    if (!message) return;
    if (message.status === 'queued') this.runtime.store.setMessageStatus(messageId, 'delivered');
    if (this.runtime.store.getMessage(messageId)?.status === 'delivered') {
      this.runtime.store.setMessageStatus(messageId, 'consumed');
    }
  }

  private async executeTool(name: string, rawArguments: string): Promise<string> {
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
          const created = this.runtime.createTask({
            title: text(args['title'], 'title'),
            goal: text(args['goal'], 'goal'),
            brief: optional(args['brief']) ?? '',
            doneCriteria: optional(args['done_criteria']) ?? '',
            requireReview: args['require_review'] === true,
            ownerRole: text(args['owner_role'], 'owner_role'),
            ownerBrief: text(args['owner_brief'], 'owner_brief'),
          });
          return `已创建任务 ${created.task.id}，负责人 ${created.owner.id}。任务在后台执行，你可以继续与用户交互。`;
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
        case 'list_tasks':
          return this.renderTaskCards();
        case 'read_task': {
          const taskId = text(args['task_id'], 'task_id');
          const task = this.runtime.store.getTask(taskId);
          if (!task) return `任务不存在：${taskId}`;
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

  private renderTaskCards(): string {
    const tasks = this.runtime.store.listTasks();
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
