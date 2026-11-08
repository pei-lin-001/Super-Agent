import { randomBytes } from 'node:crypto';
import { nowIso } from '../domain/ids.ts';
import { isTerminalTask } from '../domain/state.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import type { Store } from '../storage/store.ts';
import type { Config } from '../config.ts';
import { observe, renderObservation } from './observer.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observationPrompt, WATCHDOG_SYSTEM } from './prompts.ts';

const WD_TOOLS: ToolSchema[] = [
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
    name: 'read_file',
    description: '读取主系统工作目录内的证据文件（日志、产物、作业输出）。只读，路径不能跳出工作目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'number' } },
      required: ['path'],
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
    const jobs = store.listJobs(task.id).slice(-8);
    if (jobs.length > 0) {
      lines.push('\n## 作业');
      for (const job of jobs) lines.push(`  ${job.id} ${job.status} exit=${job.exitCode ?? '-'} ${job.command}`);
    }
    return lines.join('\n');
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const store = this.deps.store;
    const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
    const num = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? (args[key] as number) : fallback;

    if (name === 'check_main') {
      const health = this.deps.health?.();
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
    if (name === 'read_file') {
      const relative = str('path');
      const limit = num('limit', 4000);
      const root = this.deps.config.workDir;
      const absolute = join(root, relative);
      if (!absolute.startsWith(root)) return '路径越界：只能读取工作目录内的文件';
      if (!existsSync(absolute)) return `文件不存在：${relative}`;
      try {
        const text = readFileSync(absolute, 'utf8');
        return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text;
      } catch (error) {
        return `读取失败：${(error as Error).message}`;
      }
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
        issueId: str('issue_id') || null,
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
    const messages: ChatMessage[] = [
      { role: 'system', content: WATCHDOG_SYSTEM },
      ...store.listWdTurns(10).map((turn): ChatMessage => ({ role: turn.role, content: turn.content })),
      {
        role: 'user',
        content:
          `# 维护者提问\n${question}\n\n## 当前观察\n${renderObservation(observation)}\n\n` +
          `## 主系统健康\n${health ? `${health.state}｜${health.detail}` : '未知'}\n\n` +
          `## 未解决事件\n${store.listOpenIssues().map((issue) => `- ${issue.id}｜${issue.title}｜${issue.note ?? ''}`).join('\n') || '（无）'}\n\n` +
          `先用工具核对证据再回答。说清楚哪些是已确认的事实、哪些还不确定。`,
      },
    ];
    store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'user', content: question });
    for (let index = 0; index < 8; index += 1) {
      const result = await model.chat({ model: modelName, messages, tools: WD_TOOLS, reasoningEffort: config.reasoningEffort });
      messages.push({ role: 'assistant', content: result.text, ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}) });
      if (result.toolCalls.length === 0) {
        const answer = result.text?.trim() ?? '';
        store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'assistant', content: answer });
        return answer;
      }
      for (const call of result.toolCalls) {
        let output: string;
        try {
          output = await this.executeTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>);
        } catch (error) {
          output = `执行失败：${(error as Error).message}`;
        }
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
    }
    return '（达到工具调用上限，未得出结论）';
  }

  async runOnce(intervalMinutes: number): Promise<WatchdogResult> {
    const { store, config, model, modelName } = this.deps;
    const observation = observe(store, config);
    const now = Date.now();
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
      .map((action) => `- ${action.createdAt} ${action.action}｜${action.reason}｜结果：${action.result}`)
      .join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: WATCHDOG_SYSTEM },
      ...store.listWdTurns(10).map((turn): ChatMessage => ({ role: turn.role, content: turn.content })),
      {
        role: 'user',
        content: observationPrompt({
          observation: renderObservation(observation),
          issues,
          lastActions: actions,
          now: nowIso(),
          intervalMinutes,
        }),
      },
    ];

    let steps = 0;
    let acted = false;
    const maxSteps = 8;
    for (let index = 0; index < maxSteps; index += 1) {
      const result = await model.chat({
        model: modelName,
        messages,
        tools: WD_TOOLS,
        reasoningEffort: config.reasoningEffort,
      });
      steps += 1;
      messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      });
      if (result.toolCalls.length === 0) {
        const answer = result.text?.trim() ?? '';
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
        return { acted, summary: answer, steps };
      }
      for (const call of result.toolCalls) {
        let output: string;
        try {
          const parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          output = await this.executeTool(call.name, parsed);
          if (call.name === 'maintain' || call.name === 'record') acted = true;
        } catch (error) {
          output = `执行失败：${(error as Error).message}`;
        }
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
    }
    const summary = '本轮达到工具调用上限，已记录当前观察';
    store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'assistant', content: summary });
    return { acted, summary, steps };
  }
}
