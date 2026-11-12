import { randomBytes } from 'node:crypto';
import { beijingTime, nowIso } from '../domain/ids.ts';
import { isTerminalTask } from '../domain/state.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { Store } from '../storage/store.ts';
import type { Config } from '../config.ts';
import { observe, renderObservation } from './observer.ts';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertInsideRoot, resolveInside } from '../tools/paths.ts';
import { fileTools } from '../tools/files.ts';
import { runWorkerTurn } from '../runtime/pi-worker.ts';
import type { ToolContext, ToolDefinition } from '../tools/types.ts';
import { planWindow } from '../runtime/window.ts';
import { observationPrompt, WATCHDOG_SYSTEM } from './prompts.ts';

/**
 * 单次调查的步数上限。原来是无限循环，「结束条件由模型给出」——但那意味着
 * 模型不收敛时没有任何东西能停住它（Worker 侧已经因为同样的设计跑飞过）。
 * 40 步足够查完一个卡住的任务；到顶就带着当前结论收尾。
 */
const MAX_WATCHDOG_STEPS = 40;

const WD_TOOLS: ToolSchema[] = [
  // 读文件不再自己造：直接用 Worker 那套 fs_*（行语义、2000 行/50KB 截断、能读仓库根）。
  // 维护专用的 run_command / job_output 保留——它们的作业 scope=watchdog，
  // 与业务作业分开恢复，套 Worker 的 proc_run 会把两套作业混在一起。
  // 只取只读的：fs_write 会把文件写进 work/__watchdog__/，维护者不该有写权限。
  ...fileTools
    .filter((tool) => tool.name !== 'fs_write')
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  {
    name: 'inspect_task',
    description: '读取一个任务的详细证据：Worker 分支、最近消息、最近工具调用与结果、作业、产物与检查。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        worker_id: { type: 'string', description: '只读某个 Worker 的历史' },
        limit: { type: 'number', description: '返回条数，默认 15' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'read_history',
    description: '读取某个 Worker 的近期原始历史（含工具调用与结果），用于判断是否在原地打转。',
    parameters: {
      type: 'object',
      properties: {
        worker_id: { type: 'string' },
        limit: { type: 'number', description: '默认 20 条' },
      },
      required: ['worker_id'],
    },
  },
  {
    name: 'maintain',
    description:
      '执行维护动作。action 取值：pause_task / resume_task / nudge_worker / set_override / rollback_override / restart_main。' +
      '动作走主系统维护接口，不直接改业务数据。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        task_id: { type: 'string' },
        worker_id: { type: 'string' },
        text: { type: 'string', description: '给 Worker 的纠偏信息或挂起原因' },
        key: { type: 'string', description: '覆盖项，例如 worker.check_rules' },
        content: { type: 'string' },
        reason: { type: 'string' },
        version: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'check_main',
    description: '读取主系统当前健康状态：不存在 / 已退出 / 身份无法确认 / 活着但主循环无响应。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'command_status',
    description: '查询维护命令的回执：pending（还没被主系统消费）、done（已执行）、failed（执行失败）及原因。',
    parameters: {
      type: 'object',
      properties: { command_id: { type: 'string', description: '不填则返回最近 10 条' } },
      required: [],
    },
  },
  {
    name: 'run_command',
    description:
      '在工作目录内执行一条命令（程序 + 参数数组，不经过 shell），用于查看进程、磁盘、日志等。' +
      '超时上限 60 秒；这是维护者自己的作业，与业务作业分开管理。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '程序名，例如 ps、ls、df' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: '相对工作目录的子路径，默认工作目录根' },
        timeout_seconds: { type: 'number', description: '默认 30，上限 60' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description: '读取维护者自己启动的命令输出。',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'notify_router',
    description:
      '给 Router 留一条通报，它下一次被唤醒时能看到。' +
      '适合：你刚重启过主系统、你挂起/恢复了某个任务、你发现某个 Worker 在原地打转。' +
      '用户看不到你，所有面向用户的表达都必须经过 Router——不要试图直接找用户。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的事：发生了什么、影响是什么、用户可能需要知道什么' },
        urgency: { type: 'string', enum: ['low', 'normal'], description: 'low 不会额外唤醒 Router' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask_router',
    description:
      '问 Router 一件只有它知道的事（用户最近抱怨什么、某次对话里用户说了什么要求）。' +
      '异步：发出后本轮结束，回答到达后你会被下一次巡检唤醒。不要在同一轮里等。',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: '具体问题，一次一件' } },
      required: ['question'],
    },
  },
  {
    name: 'reply_intercom',
    description: '回复 Router 之前发来的问题或请求。用消息 id 指认，一次回复一条。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'intercom 消息 id，形如 ic_xxxxxxxx' },
        body: { type: 'string', description: '回答内容，讲事实和依据，不要写"已处理"这类空话' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'record',
    description: '记录或关闭一个未解决事件。issue_id 为空表示新建；status=closed 表示已确认恢复。',
    parameters: {
      type: 'object',
      properties: {
        issue_id: { type: 'string' },
        task_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed'] },
        note: { type: 'string' },
        check_after_minutes: { type: 'number', description: '多少分钟后再复查' },
      },
      required: ['title'],
    },
  },
];

/**
 * 把 Router 发来的消息渲染成提示，并标记为已投递。
 *
 * 标记是必须的：不标记的话每轮巡检都会重复注入同一批消息，
 * 上下文会被这些"已经处理过的旧话"撑满。
 */
function renderRouterMessages(store: Store): string {
  const pending = store.listPendingIntercom('watchdog', 8);
  if (pending.length === 0) return '';
  const lines = pending.map((message) => {
    const kind = message.kind === 'question' ? '提问（需要回复）' : message.kind === 'request' ? '请求（需要判断）' : '通报';
    store.markIntercomDelivered(message.id);
    return `- [${message.id}] ${kind}｜${message.body}`;
  });
  lines.push('');
  lines.push('提问和请求请用 reply_intercom 回复（带上消息 id）；通报不需要回复。');
  return lines.join('\n');
}

export interface WatchdogDeps {
  store: Store;
  config: Config;
  model: ModelClient;
  modelName: string;
  /** 主系统重启：由外部提供，避免这里直接绑死进程管理细节。 */
  restartMain?: () => Promise<{ ok: boolean; message: string }>;
  /** 主系统健康：区分不存在、退出、身份不明、无响应。 */
  health?: () => { state: string; pid: number | null; detail: string; heartbeatAgeMs: number | null };
  /** 读取 Watchdog 自己的运行配置（含在线调整的巡检间隔）。 */
  runtimeConfig?: { intervalMs: number };
  /**
   * 维护者自己的作业服务（scope=watchdog）。
   * 与业务作业分开恢复，不会把主系统 running 作业标成 unknown。
   */
  processes?: {
    start: (input: { command: string; args: string[]; cwd: string; timeoutMs: number }) => { id: string; status: string };
    read: (id: string) => { text: string; hasMore: boolean; running: boolean } | null;
    get: (id: string) => { status: string; exitCode: number | null } | null;
    stop: (id: string) => void;
  };
}

export interface WatchdogResult {
  acted: boolean;
  summary: string;
  steps: number;
}

export class WatchdogSession {
  private readonly deps: WatchdogDeps;

  constructor(deps: WatchdogDeps) {
    this.deps = deps;
  }

  private issueId(): string {
    return `wdi_${randomBytes(4).toString('hex')}`;
  }

  /**
   * 维护者读文件：复用既有路径规整 + 真实路径校验。
   * 字符串前缀判断会把 work-leak 当成 work 的子目录，也会放过指向外部的符号链接。
   */
  private readInsideRoot(relative: string, offset: number, limit: number): string {
    const root = this.deps.config.workDir;
    let absolute: string;
    try {
      absolute = resolveInside(root, relative);
      assertInsideRoot(root, absolute);
    } catch (error) {
      return `拒绝读取：${(error as Error).message}`;
    }
    if (!existsSync(absolute)) return `文件不存在：${relative}`;
    let stat;
    try {
      stat = statSync(absolute);
    } catch (error) {
      return `无法读取文件属性：${(error as Error).message}`;
    }
    if (!stat.isFile()) return `不是普通文件：${relative}`;

    const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200_000) : 8000;
    const length = Math.min(size, Math.max(0, stat.size - start));
    const buffer = Buffer.alloc(length);
    let handle: number | null = null;
    try {
      handle = openSync(absolute, 'r');
      const read = readSync(handle, buffer, 0, length, start);
      const text = buffer.subarray(0, read).toString('utf8');
      const more = start + read < stat.size ? `\n…（已到本次上限，可用 offset=${start + read} 继续）` : '';
      return `${text}${more}`;
    } catch (error) {
      return `读取失败：${(error as Error).message}`;
    } finally {
      if (handle !== null) {
        try {
          closeSync(handle);
        } catch {
          // 关闭失败不影响结果。
        }
      }
    }
  }

  private describeTask(taskId: string, limit: number): string {
    const store = this.deps.store;
    const task = store.getTask(taskId);
    if (!task) return `任务不存在：${taskId}`;
    const lines: string[] = [];
    lines.push(`# ${task.title}（${task.id}）状态 ${task.status}｜要求版本 ${task.reviewEpoch}`);
    lines.push(`目标：${task.goal}`);
    lines.push(`完成条件：${task.doneCriteria || '(未填写)'}`);
    for (const worker of store.listGroupWorkers(task.groupId)) {
      lines.push(`\n## Worker ${worker.id}（${worker.role}）${worker.status}｜${worker.stepCount} 步`);
      const turns = store.listWorkerTurns(worker.id, limit);
      for (const turn of turns.slice(-limit)) {
        const calls = turn.toolCalls ? ` 调用:${(turn.toolCalls as { name: string }[]).map((call) => call.name).join(',')}` : '';
        const body = (turn.content ?? '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push(`  turn#${turn.seq} ${turn.role}${calls} ${body}`);
      }
    }
    // 产物与检查是判断"有没有真的交付"的直接证据，必须出现在观察结果里。
    const artifacts = store.listArtifacts(task.id);
    lines.push(
      `产物：${artifacts.length === 0 ? '无' : artifacts.map((item) => `${item.name} v${item.version}`).join('、')}`,
    );
    const reviews = store.listReviews(task.id);
    if (reviews.length > 0) {
      lines.push('## 检查');
      for (const review of reviews.slice(-5)) {
        lines.push(`  ${review.artifactId ?? '-'} ${review.outcome} 版本 ${review.epoch}`);
      }
    }
    const jobs = store.listJobs(task.id).slice(-8);
    if (jobs.length > 0) {
      lines.push('\n## 作业');
      for (const job of jobs) lines.push(`  ${job.id} ${job.status} exit=${job.exitCode ?? '-'} ${job.command}`);
    }
    return lines.join('\n');
  }

  /**
   * 文件工具要的上下文。Watchdog 没有业务任务，用占位 id：
   * resolveReadPath 找不到任务目录时会退到仓库根，正是维护者要读的地方。
   */
  private readContext(): ToolContext {
    return {
      host: null as unknown as ToolContext['host'],
      worker: null as unknown as ToolContext['worker'],
      task: { id: '__watchdog__' } as ToolContext['task'],
      workDir: this.deps.config.workDir,
      materialsDir: this.deps.config.materialsDir,
      readRoot: this.deps.config.readRoot,
      signal: null,
    };
  }

  /**
   * 维护对话的近期历史：按 token 预算从尾部取，超出阈值就压进累计摘要。
   *
   * 原来是硬编码 10 条——条数不等于规模，10 条长回答照样能把窗口塞满；
   * 而超过 200 条之后更早的记录会被直接丢掉，连痕迹都没有。
   */
  private dialogueHistory(): { history: ChatMessage[]; note: string | null; toSummarize: {
    turns: { row: number; role: 'user' | 'assistant'; content: string }[];
    fromRow: number;
    toRow: number;
  } | null } {
    const limits = this.deps.config.limits;
    const note = this.deps.store.latestWatchdogNote();
    // 只取问答：wd_turn 里的 tool 记录是给人看的摘要，没有 toolCallId，
    // 塞进请求会变成「没有归属的工具结果」，提供方直接拒绝。
    const turns = this.deps.store
      .listWdDialogueSince(note?.coveredRow ?? 0)
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant');
    const plan = planWindow({
      items: turns.map((turn) => ({ turn, chars: turn.content.length })),
      keepRecentTokens: limits.routerKeepRecentTokens,
      contextWindowTokens: limits.contextWindowTokens,
      reserveTokens: limits.routerReserveTokens,
      // 真实 usage 当基准。之前只用 chars/4 全量估算，中文低估 2.3 倍，
      // 400k 字符被当成 10 万 token，阈值 15 万永远够不到，上下文一路涨到 23 万。
      measuredTokens: this.deps.store.measureContextTokens({ purpose: 'watchdog' }),
    });
    const kept = plan.kept.map((item) => item.turn);
    const dropped = plan.dropped.map((item) => item.turn);
    return {
      history: kept.map((item): ChatMessage => ({ role: item.role, content: item.content })),
      note: note?.content ?? null,
      toSummarize:
        plan.shouldCompact && dropped.length > 0
          ? { turns: dropped, fromRow: dropped[0]!.row, toRow: dropped[dropped.length - 1]!.row }
          : null,
    };
  }

  /** 把被挤出窗口的旧对话压成一份累计摘要；失败不阻断本轮。 */
  private async runNote(input: {
    previous: string | null;
    turns: { row: number; role: 'user' | 'assistant'; content: string }[];
    fromRow: number;
    toRow: number;
  }): Promise<string | null> {
    const { store, model, modelName, config } = this.deps;
    try {
      const result = await new RecordingModel(model, store, 'watchdog', { sessionId: null }).chat({
        model: modelName,
        messages: [
          {
            role: 'system',
            content:
              '你是 Super-Agent 维护会话的摘要器。输出会成为 Watchdog 后续唯一可见的旧对话记忆，' +
              '必须准确、可追溯，不能编造，也不要继续对话。',
          },
          {
            role: 'user',
            content: `# 上一份记录\n${input.previous ?? '（这是第一次整理）'}\n\n` +
              `# 本次需要并入的对话\n${input.turns.map((turn) => `[${turn.role === 'user' ? '维护者' : 'Watchdog'}] ${turn.content}`).join('\n\n')}\n\n` +
              `# 输出要求\n1. 保留上一份里仍然有效的内容，并入这次的新内容。\n` +
              '2. 只记事实：观察到的现象、采取的维护动作、动作结果、未解决事件、下次复查条件。\n' +
              '3. 不写寒暄和流水账；冲突的旧内容写「已失效：<原因>」。\n' +
              `4. 全文不超过 ${config.limits.routerNoteMaxChars} 字符。只输出正文。\n\n` +
              '建议小节：## 已确认的事实 / ## 已采取的动作与结果 / ## 未解决事件 / ## 下次复查条件',
          },
        ],
        tools: [],
        reasoningEffort: 'low',
      });
      const content = (result.text ?? '').trim();
      if (content === '') return null;
      store.insertWatchdogNote({
        id: `wdn_${randomBytes(4).toString('hex')}`,
        fromRow: input.fromRow,
        toRow: input.toRow,
        coveredRow: input.toRow,
        content,
        sourceTurns: input.turns.length,
        sourceChars: input.turns.reduce((sum, turn) => sum + turn.content.length, 0),
      });
      return content;
    } catch {
      return null;
    }
  }

  /**
   * 本轮要用的 system 与历史。
   *
   * 顺序不能反：先判断要不要压缩、压完落水位线，再取历史——
   * 否则刚被压掉的那几条会同时出现在摘要和原文里。
   */
  private async contextForTurn(): Promise<{ system: string; history: ChatMessage[] }> {
    const { note, toSummarize } = this.dialogueHistory();
    let merged = note;
    if (toSummarize) merged = (await this.runNote({ previous: note, ...toSummarize })) ?? note;
    const system = merged ? `${WATCHDOG_SYSTEM}\n\n# 更早维护对话的累计记录\n${merged}` : WATCHDOG_SYSTEM;
    return { system, history: this.dialogueHistory().history };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    void 0;
    const store = this.deps.store;
    const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
    const num = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? (args[key] as number) : fallback;

    if (name === 'notify_router') {
      const body = str('text').trim();
      if (body === '') return '通报内容不能为空';
      const id = `ic_${randomBytes(4).toString('hex')}`;
      store.insertIntercom({
        id,
        fromLayer: 'watchdog',
        kind: 'notice',
        body: body.slice(0, 2000),
      });
      return `已通报 Router（${id}）。用户看不到你，面向用户的表达必须经它转述。`;
    }
    if (name === 'ask_router') {
      const question = str('question').trim();
      if (question === '') return '问题不能为空';
      const id = `ic_${randomBytes(4).toString('hex')}`;
      store.insertIntercom({ id, fromLayer: 'watchdog', kind: 'question', body: question.slice(0, 2000), topicId: id });
      return `问题已发给 Router（${id}）。异步：本轮先结束，回答到达后你会在下一次巡检看到。`;
    }
    if (name === 'reply_intercom') {
      const target = str('message_id').trim();
      const body = str('body').trim();
      if (target === '') return '需要 message_id';
      if (body === '') return '回复内容不能为空';
      const original = store.getIntercom(target);
      if (!original) return `找不到消息 ${target}`;
      if (original.toLayer !== 'watchdog') return `${target} 不是发给维护者的消息`;
      if (original.status === 'answered') return `${target} 已经回复过了，不要重复回复`;
      // reply 不能再 reply：否则两边会互相唤醒到天亮。
      if (original.hops >= (this.deps.config.limits.maxRequestHops ?? 4)) {
        return `这条消息已经来回 ${original.hops} 次，超过上限，请直接给出结论`;
      }
      store.insertIntercom({
        id: `ic_${randomBytes(4).toString('hex')}`,
        fromLayer: 'watchdog',
        kind: 'reply',
        body: body.slice(0, 2000),
        topicId: original.topicId ?? original.id,
        replyTo: original.id,
        sessionKey: original.sessionKey,
        hops: original.hops + 1,
      });
      store.consumeIntercom(original.id);
      return `已回复 ${target}。`;
    }
    if (name === 'check_main') {
      const health = this.deps.health?.();
    const toolLog = store.listWdToolLog(12);
      if (!health) return '当前环境没有配置主系统健康探测';
      return `${health.state}｜${health.detail}${health.pid ? `｜pid=${health.pid}` : ''}` +
        `${health.heartbeatAgeMs === null ? '' : `｜心跳 ${Math.round(health.heartbeatAgeMs / 1000)} 秒前`}`;
    }
    if (name === 'command_status') {
      const id = str('command_id');
      const records = id === '' ? store.listRecentControls(10) : store.listRecentControls(50).filter((item) => item.id === id);
      if (records.length === 0) return id === '' ? '（还没有维护命令）' : `找不到命令 ${id}`;
      return records
        .map((item) => `${item.id} ${item.command} ${item.status}${item.result ? `｜${item.result}` : ''}`)
        .join('\n');
    }
    if (name.startsWith('fs_')) {
      const tool = fileTools.find((item) => item.name === name && item.name !== 'fs_write');
      if (!tool) return `未知工具：${name}`;
      const outcome = await tool.run(args, this.readContext());
      return outcome.type === 'ok' ? outcome.content : (outcome as { content?: string }).content ?? '';
    }
    if (name === 'run_command') {
      if (!this.deps.processes) return '当前环境没有配置维护者作业服务';
      const command = str('command');
      if (command.trim() === '') return '缺少 command';
      const rawArgs = args['args'];
      const list = Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === 'string') : [];
      const cwdRel = str('cwd');
      let cwd = this.deps.config.workDir;
      if (cwdRel !== '') {
        try {
          cwd = resolveInside(this.deps.config.workDir, cwdRel);
          assertInsideRoot(this.deps.config.workDir, cwd);
        } catch (error) {
          return `拒绝执行：${(error as Error).message}`;
        }
      }
      const seconds = Math.min(Math.max(num('timeout_seconds', 30), 1), 60);
      const job = this.deps.processes.start({ command, args: list, cwd, timeoutMs: seconds * 1000 });
      const output = this.deps.processes.read(job.id);
      return `作业 ${job.id}｜${job.status}\n${output?.text ?? '（暂无输出）'}`;
    }
    if (name === 'job_output') {
      if (!this.deps.processes) return '当前环境没有配置维护者作业服务';
      const id = str('job_id');
      const job = this.deps.processes.get(id);
      if (!job) return `找不到作业 ${id}`;
      const output = this.deps.processes.read(id);
      return `${id}｜${job.status}｜退出码 ${job.exitCode ?? '-'}\n${output?.text ?? '（暂无输出）'}`;
    }
    if (name === 'inspect_task') {
      return this.describeTask(str('task_id'), num('limit', 15));
    }
    if (name === 'read_history') {
      const turns = store.listWorkerTurns(str('worker_id'), num('limit', 20));
      if (turns.length === 0) return '（没有历史）';
      return turns
        .map((turn) => {
          const calls = turn.toolCalls
            ? ` 调用:${(turn.toolCalls as { name: string; arguments: string }[])
                .map((call) => `${call.name}(${call.arguments.slice(0, 120)})`)
                .join(' ')}`
            : '';
          return `turn#${turn.seq} ${turn.role}${calls}\n${(turn.content ?? '').slice(0, 400)}`;
        })
        .join('\n---\n');
    }
    if (name === 'maintain') {
      const action = str('action');
      if (action === 'restart_main') {
        if (!this.deps.restartMain) return '当前环境没有配置主系统重启能力';
        const result = await this.deps.restartMain();
        store.appendWdAction({
          id: `wda_${randomBytes(4).toString('hex')}`,
          issueId: str('issue_id') || null,
          action: 'restart_main',
          reason: str('reason') || '',
          expected: '主系统恢复调度',
          result: result.message,
        });
        return result.message;
      }
      const payload: Record<string, unknown> = {
        taskId: str('task_id'),
        workerId: str('worker_id'),
        text: str('text') || str('reason'),
        key: str('key'),
        content: str('content'),
        reason: str('reason'),
        author: 'watchdog',
        version: num('version', 0),
      };
      const commandId = `cc_${randomBytes(4).toString('hex')}`;
      store.insertControlCommand({
        id: commandId,
        command: action,
        payload: JSON.stringify(payload),
        source: 'watchdog',
      });
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId: str('issue_id') || this.issueId(),
        commandId,
        action,
        reason: str('reason') || str('text') || '',
        expected: str('expected') || '',
        result: `命令 ${commandId} 已入队（尚未执行）`,
      });
      return `已提交维护命令 ${action}，命令 ID ${commandId}。状态为 pending：主系统消费后才会变成 done/failed，请用 command_status 复查。`;
    }
    if (name === 'record') {
      const status = str('status') || 'open';
      const issueId = str('issue_id') || this.issueId();
      if (status === 'closed') {
        store.closeWdIssue(issueId, str('note') || '已恢复');
        return `事件 ${issueId} 已标记解决`;
      }
      const minutes = num('check_after_minutes', 10);
      const checkAfter = new Date(Date.now() + minutes * 60_000).toISOString();
      store.upsertWdIssue({
        id: issueId,
        taskId: str('task_id') || null,
        title: str('title'),
        note: str('note') || '',
        checkAfter,
      });
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId,
        action: 'record',
        reason: str('note') || '',
        expected: `${minutes} 分钟后复查`,
        result: '已登记',
      });
      return `事件 ${issueId} 已记录，${minutes} 分钟后复查`;
    }
    return `未知工具：${name}`;
  }

  /** 维护者提问：用同一套会话与工具，主系统不可用时也能回答。 */
  async ask(question: string): Promise<string> {
    const { store, config, model, modelName } = this.deps;
    const observation = observe(store, config);
    const health = this.deps.health?.();
    const toolLog = store.listWdToolLog(12);
    store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'user', content: question });

    // 循环交给 pi 的 agent-loop（和 Worker 同一条路）：工具批处理、步数、截断作废都在内核里。
    const repeats = new Map<string, number>();
    const context = await this.contextForTurn();
    const result = await runWorkerTurn({
      model: modelName,
      modelClient: new RecordingModel(model, store, 'watchdog', { sessionId: null }),
      systemPrompt: context.system,
      history: context.history,
      prompts: [
        ...(toolLog.length > 0
          ? [
              {
                role: 'user' as const,
                content:
                  '# 上一次调查的工具记录（仅作背景，不是重新发起的调用）\n' +
                  toolLog.map((entry) => `- ${entry.tool}：${entry.summary}`).join('\n'),
              },
            ]
          : []),
        {
          role: 'user',
          content:
            `# 维护者提问\n${question}\n\n## 当前观察\n${renderObservation(observation)}\n\n` +
            `## 主系统健康\n${health ? `${health.state}｜${health.detail}` : '未知'}\n\n` +
            `## 未解决事件\n${store.listOpenIssues().map((issue) => `- ${issue.id}｜${issue.title}｜${issue.note ?? ''}`).join('\n') || '（无）'}\n\n` +
            `先用工具核对证据再回答。说清楚哪些是已确认的事实、哪些还不确定。`,
        },
      ],
      tools: WD_TOOLS,
      maxSteps: MAX_WATCHDOG_STEPS,
      signal: null,
      runTool: async (call) => {
        const key = `${call.name}|${call.arguments}`;
        const seen = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, seen);
        let output: string;
        try {
          output = await this.executeTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>);
        } catch (error) {
          output = `执行失败：${(error as Error).message}`;
        }
        // 只报告"相同参数第 N 次调用"。是否与上次结果一致需要真的比较返回值，
        // 不能凭调用名相同就断言——健康状态、作业输出本来就是会变的。
        if (seen > 1) {
          output += `\n\n（相同参数第 ${seen} 次调用。上面是本次的真实结果，请据此判断，不要假设它和上次一样。）`;
        }
        store.appendWdTurn({
          id: `wdt_${randomBytes(4).toString('hex')}`,
          role: 'tool',
          content: `${call.name}: ${output.slice(0, 300)}`,
        });
        return { outcome: { type: 'ok' as const, content: output }, terminate: false };
      },
    });

    const answer = (result.assistantText ?? '').trim();
    if (answer !== '') {
      store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'assistant', content: answer });
      return answer;
    }
    return `（本轮达到 ${result.steps} 步上限，没有得出结论；已记录当前观察）`;
  }

  async runOnce(intervalMinutes: number): Promise<WatchdogResult> {
    const { store, config, model, modelName } = this.deps;
    const observation = observe(store, config);
    const now = Date.now();
    const toolLog = store.listWdToolLog(12);
    const issues = store
      .listOpenIssues()
      .map((issue) => {
        const due = issue.checkAfter ? Date.parse(issue.checkAfter) <= now : true;
        return (
          `- ${issue.id}｜${issue.title}｜尝试 ${issue.attempts} 次｜${issue.note ?? ''}｜` +
          `复查时间 ${issue.checkAfter ?? '-'}｜${due ? '已到复查时间' : '未到复查时间，除非有新证据否则不要重复下同一动作'}`
        );
      })
      .join('\n');
    const actions = store
      .listWdActions(6)
      .map((action) => `- ${beijingTime(action.createdAt)} ${action.action}｜${action.reason}｜结果：${action.result}`)
      .join('\n');

    let acted = false;
    const context = await this.contextForTurn();
    const result = await runWorkerTurn({
      model: modelName,
      modelClient: new RecordingModel(model, store, 'watchdog', { sessionId: null }),
      systemPrompt: context.system,
      history: context.history,
      prompts: [
        ...(toolLog.length > 0
          ? [
              {
                role: 'user' as const,
                content:
                  '# 上一次调查的工具记录（仅作背景，不是重新发起的调用）\n' +
                  toolLog.map((entry) => `- ${entry.tool}：${entry.summary}`).join('\n'),
              },
            ]
          : []),
        {
          role: 'user',
          content: observationPrompt({
            observation: renderObservation(observation),
            issues,
            lastActions: actions,
            now: nowIso(),
            intervalMinutes,
            routerMessages: renderRouterMessages(store),
          }),
        },
      ],
      tools: WD_TOOLS,
      maxSteps: MAX_WATCHDOG_STEPS,
      signal: null,
      runTool: async (call) => {
        let output: string;
        try {
          output = await this.executeTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>);
          if (call.name === 'maintain' || call.name === 'record') acted = true;
        } catch (error) {
          output = `执行失败：${(error as Error).message}`;
        }
        return { outcome: { type: 'ok' as const, content: output }, terminate: false };
      },
    });

    const answer = (result.assistantText ?? '').trim();
    const summary = answer !== '' ? answer : `本轮达到 ${result.steps} 步上限，已记录当前观察`;
    if (answer !== '') {
      store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'assistant', content: answer });
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId: null,
        action: 'inspect',
        reason: '定时巡检',
        expected: '',
        result: answer.slice(0, 400),
      });
    }
    return { acted, summary, steps: result.steps };
  }
}
