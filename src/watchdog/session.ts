import { randomBytes } from 'node:crypto';
import { beijingTime, nowIso } from '../domain/ids.ts';
import { isTerminalTask } from '../domain/state.ts';
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { Store } from '../storage/store.ts';
import type { Config } from '../config.ts';
import { observe } from './observer.ts';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { assertInsideRoot, resolveInside } from '../tools/paths.ts';
import { fileTools } from '../tools/files.ts';
import { runWorkerTurn } from '../runtime/pi-worker.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from '../tools/types.ts';
import { observationPrompt, WATCHDOG_SYSTEM } from './prompts.ts';
import { createReviewState, renderReviewContext, type ReviewState } from './review-state.ts';

/**
 * 单次调查的步数上限。原来是无限循环，「结束条件由模型给出」——但那意味着
 * 模型不收敛时没有任何东西能停住它（Worker 侧已经因为同样的设计跑飞过）。
 * 40 步足够查完一个卡住的任务；到顶就带着当前结论收尾。
 */
const MAX_WATCHDOG_STEPS = 40;

interface DialogueTurnRow {
  row: number;
  role: 'user' | 'assistant';
  content: string;
  piMessage?: import('@earendil-works/pi-ai').AssistantMessage;
}

type DialogueTurn = Pick<DialogueTurnRow, 'row' | 'role' | 'content'>;

/**
 * 纯文本保守估算：ASCII 约 4 字符 1 token，非 ASCII 按 1 字符 1 token。
 * 中英混排会被高估而不是沿用旧实现的全段 chars/4 低估。
 */
function estimateDialogueTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars);
}

/**
 * 以 user 消息为组起点，确保裁剪不会留下孤立的 assistant 回复。
 * 首条 assistant（例如后台巡检结论前没有 user）单独作为可摘要旧事实。
 */
function groupDialogue(turns: DialogueTurnRow[]): {
  groups: DialogueTurnRow[][];
  leading: DialogueTurnRow[];
} {
  const groups: DialogueTurnRow[][] = [];
  const leading: DialogueTurnRow[] = [];
  let current: DialogueTurnRow[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (current.length > 0) groups.push(current);
      current = [turn];
    } else if (current.length > 0) {
      current.push(turn);
    } else {
      leading.push(turn);
    }
  }
  if (current.length > 0) groups.push(current);
  return { groups, leading };
}

/**
 * 摘要模型单次只处理 noteInputChars 范围内的新增问答。
 *
 * 正常情况按整条消息装箱；单条消息本身就超过上限时再切段，避免再次出现
 * “为了适配一次请求而永久截掉后半段”。所有分段共享原 row 编号，便于追查。
 */
function chunkDialogueTurns(turns: DialogueTurn[], maxChars: number): DialogueTurn[][] {
  const limit = Math.max(1, maxChars);
  const chunks: DialogueTurn[][] = [];
  let current: DialogueTurn[] = [];
  let currentChars = 0;
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentChars = 0;
  };

  for (const turn of turns) {
    if (turn.content.length > limit) {
      flush();
      for (let offset = 0; offset < turn.content.length; offset += limit) {
        chunks.push([{ ...turn, content: turn.content.slice(offset, offset + limit) }]);
      }
      continue;
    }
    if (currentChars > 0 && currentChars + turn.content.length > limit) flush();
    current.push(turn);
    currentChars += turn.content.length;
  }
  flush();
  return chunks;
}

/**
 * 按 rowid 分页读完水位线后的全部问答。
 *
 * Store 的单页上限保护普通调用，但维护会话不能在 400 条后只看历史前缀；
 * runNote 已按 noteInputChars 分批处理，所以这里需要完整读取再做组级裁剪。
 */
function listAllWdDialogueSince(
  store: Store,
  afterRow: number,
): ReturnType<Store['listWdDialogueSince']> {
  const pageSize = 400;
  const turns: ReturnType<Store['listWdDialogueSince']> = [];
  let cursor = afterRow;
  while (true) {
    const page = store.listWdDialogueSince(cursor, pageSize);
    turns.push(...page);
    if (page.length < pageSize) break;
    const next = page.at(-1)!.row;
    if (next <= cursor) {
      throw new Error(`wd_turn 分页没有前进：cursor=${cursor}, next=${next}`);
    }
    cursor = next;
  }
  return turns;
}

const WD_TOOLS: ToolSchema[] = [
  // 读文件不再自己造：直接用 Worker 那套 fs_*（行语义、2000 行/50KB 截断、能读仓库根）。
  // 维护专用的 run_command / job_output 保留——它们的作业 scope=watchdog，
  // 与业务作业分开恢复，套 Worker 的 proc_run 会把两套作业混在一起。
  // 只取只读的：fs_write 会把文件写进 work/__watchdog__/，维护者不该有写权限。
  ...fileTools
    .filter((tool) => tool.name !== 'fs_write')
    .map((tool) => ({
      name: tool.name,
      description: ({
        fs_list: '列出目录；路径规则同 fs_read。',
        fs_read: '读取文本；支持任务、仓库、绝对路径与 materials/ 只读材料；上限 2000 行或 50KB，超过用 offset。',
        fs_view_image: '查看本地 png/jpeg/gif/webp 图片；一次一张并计入本轮上下文。',
        fs_search: '在任务、材料和仓库可读路径按正则搜索文本；报告覆盖与跳过范围。',
      } as Record<string, string>)[tool.name] ?? tool.description,
      parameters: tool.parameters,
    })),
  {
    name: 'inspect_task',
    description: '读取任务成员、消息、历史、作业、产物和检查；result_id/review_id 返回正式结果全文和旧检查回复。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        result_id: { type: 'string' },
        review_id: { type: 'string' },
        worker_id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'read_history',
    description: '读取 Worker 近期原始历史，含工具调用与结果。',
    parameters: {
      type: 'object',
      properties: {
        worker_id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['worker_id'],
    },
  },
  {
    name: 'read_inspection',
    description: '按 inspection_id 读取巡检结论全文；省略则取最近一条。',
    parameters: {
      type: 'object',
      properties: {
        inspection_id: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'maintain',
    description:
      '通过主系统维护接口执行 pause_task / resume_task / nudge_worker / set_override / rollback_override / restart_main；不直接改业务数据。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        task_id: { type: 'string' },
        worker_id: { type: 'string' },
        text: { type: 'string' },
        key: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
        version: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'check_main',
    description: '检查主系统存活、身份和主循环。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'command_status',
    description: '查询维护命令回执及原因。',
    parameters: {
      type: 'object',
      properties: { command_id: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'run_command',
    description: '在工作目录内以程序+参数数组运行命令；无 shell，超时上限 60 秒，作业独立。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout_seconds: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description: '读取维护者命令输出。',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'notify_router',
    description:
      '向 Router 发送维护通报；已知 task_id 按来源会话定向，否则留管理入口。面向用户的表达必须经过 Router；urgency=low 不额外唤醒。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        task_id: { type: 'string' },
        urgency: { type: 'string', enum: ['low', 'normal'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask_router',
    description: '向 Router 提问；已知 task_id 定向来源会话，否则留管理入口。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        task_id: { type: 'string' },
      },
      required: ['question'],
    },
  },
  {
    name: 'reply_intercom',
    description: '按消息 id 回复 Router 的提问或请求。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'record',
    description: '新建或关闭未解决事件；status=closed 表示确认恢复。',
    parameters: {
      type: 'object',
      properties: {
        issue_id: { type: 'string' },
        task_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed'] },
        note: { type: 'string' },
        check_after_minutes: { type: 'number' },
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
  const pending = store.listOpenIntercom('watchdog', 8);
  if (pending.length === 0) return '';
  const lines = pending.map((message) => {
    const kind = message.kind === 'question' ? '提问（需要回复）' : message.kind === 'request' ? '请求（需要判断）' : '通报';
    return `- [${message.id}] ${kind}｜${message.body}` +
      `${message.taskId ? `｜任务：${message.taskId}` : ''}` +
      `｜路由：${message.routeKnown ? '已关联来源会话' : '未关联，等待管理入口'}` +
      `${message.replyTo ? `｜回复：${message.replyTo}` : ''}` +
      `${message.refs?.length ? `｜引用：${message.refs.join('、')}` : ''}`;
  });
  lines.push('');
  lines.push('提问和请求请用 reply_intercom 回复（带上消息 id）；通报不需要回复。');
  return lines.join('\n');
}

/**
 * 当前进程维护的是哪个实例，必须是程序事实，不能靠模型从路径猜。
 *
 * 文件工具允许读取整个仓库；其他目录中的日志、实例文件或数据库可能属于
 * 另一个实例，只能作为外部证据，不能拼成本轮观察或维护对象的当前状态。
 */
function renderInstanceScope(config: Config): string {
  return [
    '## 当前实例范围（程序事实）',
    `- 数据库：${config.dbPath}`,
    `- 工作目录：${config.workDir}`,
    `- 进程 cwd：${process.cwd()}`,
    '- 本轮的观察、健康判断和维护控制只绑定上述配置；其他路径读到的事实属于外部证据，不能拼成当前实例状态。',
  ].join('\n');
}

export interface WatchdogDeps {
  store: Store;
  config: Config;
  model: ModelClient;
  modelName: string;
  /** 主系统重启：由外部提供，避免这里直接绑死进程管理细节。 */
  restartMain?: () => Promise<{ ok: boolean; message: string }>;
  /** 主系统健康：区分不存在、退出、身份不明、无响应。 */
  health?: () => {
    state: string;
    pid: number | null;
    detail: string;
    heartbeatAgeMs: number | null;
    identity?: string | null;
    degraded?: boolean;
  };
  /** 读取 Watchdog 自己的运行配置（含在线调整的巡检间隔）。 */
  runtimeConfig?: { intervalMs: number };
  /**
   * 维护者自己的作业服务（scope=watchdog）。
   * 与业务作业分开恢复，不会把主系统 running 作业标成 unknown。
   */
  processes?: {
    start: (input: { command: string; args: string[]; cwd: string; timeoutMs: number }) => { id: string; status: string; error?: string | null };
    read: (id: string) => { text: string; hasMore: boolean; running: boolean } | null;
    get: (id: string) => { status: string; exitCode: number | null; error?: string | null } | null;
    stop: (id: string) => void;
  };
}

export interface WatchdogResult {
  acted: boolean;
  summary: string;
  steps: number;
}

export interface WatchdogAskOptions {
  /**
   * 人工问答默认保留短近期历史。维护申请等定向任务应传 false，
   * 只用任务授权、当前状态和本次问题建立独立上下文。
   *
   * false 只影响本轮输入；问答仍会写入 wd_turn，之后的人工 ask 在压缩时
   * 可能把这批问答纳入累计摘要。
   */
  history?: boolean;
  /** 已知任务时聚焦该任务，并让本轮 Router 消息默认关联它。 */
  taskId?: string | null;
}

function reviewStatePath(config: Config): string {
  return join(config.workDir, '.runtime', 'watchdog-review.json');
}

function loadReviewState(config: Config): { state: ReviewState | null; warning: string | null } {
  const path = reviewStatePath(config);
  if (!existsSync(path)) return { state: null, warning: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReviewState>;
    const tasks = parsed.baseline?.tasks;
    const validTask = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const task = value as Record<string, unknown>;
      if (typeof task['title'] !== 'string' || typeof task['status'] !== 'string') return false;
      return ['workers', 'jobs', 'artifacts', 'reviews', 'events'].every((key) => {
        const record = task[key];
        return record === undefined ||
          (record !== null && typeof record === 'object' && !Array.isArray(record) &&
            Object.values(record).every((item) => typeof item === 'string'));
      });
    };
    if (
      parsed.version !== 1 ||
      !parsed.baseline ||
      typeof parsed.baseline.generatedAt !== 'string' ||
      typeof parsed.baseline.mainAlive !== 'boolean' ||
      tasks === null ||
      typeof tasks !== 'object' ||
      Array.isArray(tasks) ||
      !Object.values(tasks).every(validTask)
    ) {
      return { state: null, warning: '上轮巡检基线结构无效，本轮按初始快照处理' };
    }
    const conclusion = parsed.conclusion;
    if (
      conclusion !== undefined &&
      conclusion !== null &&
      (typeof conclusion !== 'object' ||
        typeof conclusion.id !== 'string' ||
        typeof conclusion.createdAt !== 'string' ||
        typeof conclusion.excerpt !== 'string')
    ) {
      return { state: null, warning: '上轮巡检结论结构无效，本轮按初始快照处理' };
    }
    return { state: parsed as ReviewState, warning: null };
  } catch (error) {
    return { state: null, warning: `上轮巡检基线无法解析，本轮按初始快照处理：${(error as Error).message}` };
  }
}

function saveReviewState(config: Config, state: ReviewState): void {
  const path = reviewStatePath(config);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 清理临时文件失败不覆盖原始写盘错误。
    }
    throw error;
  }
}

/** 最近一次已落盘语义巡检时间；重启后据此避免再次立即做完整巡检。 */
export function latestReviewTimestamp(config: Config): number | null {
  const { state } = loadReviewState(config);
  if (!state) return null;
  const value = Date.parse(state.baseline.generatedAt);
  return Number.isFinite(value) ? value : null;
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

  /**
   * 定向维护只带原任务授权与当前状态，不继承整段维护问答。
   *
   * result 是负责人提交的正式报告，正文有助于判断原目标是否被覆盖；
   * 它仍只是报告，不能替代独立验证。
   */
  private taskFocus(taskId: string): string {
    const store = this.deps.store;
    const task = store.getTask(taskId);
    if (!task) return `任务不存在：${taskId}`;
    const lines: string[] = [];
    lines.push(`# ${task.title}（${task.id}）状态 ${task.status}｜要求版本 ${task.reviewEpoch}`);
    lines.push(`维护状态：${task.maintenance === 1 ? '已挂起' : '正常调度'}｜负责人 ${task.ownerWorkerId ?? '-'}`);
    lines.push(`目标：${task.goal}`);
    lines.push(`原始任务说明/授权：${task.brief || '(未填写)'}`);
    lines.push(`完成条件：${task.doneCriteria || '(未填写)'}`);
    const messages = store.listTaskMessages(task.id, 200);
    const result = messages.filter((message) => message.kind === 'result').at(-1);
    if (result) {
      const refs = result.refs?.artifacts?.map((artifact) =>
        `${artifact.name} v${artifact.version}(${artifact.artifactId})`,
      ) ?? [];
      lines.push(
        `最新正式结果 [${result.id}｜${result.createdAt}]：由负责人 ${result.fromId} 提交；` +
          '这只是负责人报告，不等于独立验证原目标。',
      );
      const body = result.body || '(空)';
      lines.push(body.slice(0, 3_000));
      if (body.length > 3_000) {
        lines.push(
          `（正式结果正文已截断 ${body.length - 3_000} 字符；` +
            `完整内容用 inspect_task(task_id="${task.id}", result_id="${result.id}") 查回）`,
        );
      }
      if (refs.length > 0) lines.push(`结果引用产物：${refs.join('、')}`);
    } else {
      lines.push('最新正式结果：无');
    }
    const workers = store.listTaskWorkers(task.id);
    if (workers.length === 0) lines.push('当前任务成员：无');
    for (const worker of workers) {
      lines.push(
        `Worker ${worker.id}（${worker.role}）${worker.status}｜${worker.stepCount} 步` +
          `${worker.lastError ? `｜错误 ${worker.lastError}` : ''}`,
      );
      const waits = store.listActiveWaitsForWorker(worker.id);
      for (const wait of waits) {
        lines.push(
          `  等待 ${wait.reason}${wait.matchReplyTo ? ` 请求:${wait.matchReplyTo}` : ''}` +
            `${wait.matchFrom ? ` 来源:${wait.matchFrom}` : ''}${wait.matchJob ? ` 作业:${wait.matchJob}` : ''}` +
            `｜截止 ${wait.deadlineAt}`,
        );
      }
    }
    const artifacts = store.listArtifacts(task.id);
    const latest = artifacts.reduce((map, artifact) => {
      const current = map.get(artifact.name);
      if (!current || artifact.version > current.version) map.set(artifact.name, artifact);
      return map;
    }, new Map<string, typeof artifacts[number]>());
    lines.push(
      `产物：${artifacts.length === 0
        ? '无'
        : [...latest.values()].map((item) => `${item.name} v${item.version}(${item.id})`).join('、')}`,
    );
    const reviews = store.listReviews(task.id);
    if (reviews.length > 0) {
      lines.push('当前检查：');
      for (const review of reviews.slice(-8)) {
        const artifact = artifacts.find((item) => item.id === review.artifactId);
        const latest = artifact && !artifacts.some((item) => item.name === artifact.name && item.version > artifact.version);
        const current = latest && artifact.sha256 === review.artifactSha256 && review.epoch === task.reviewEpoch;
        lines.push(
          `  ${review.id}｜${artifact?.name ?? '-'} v${review.artifactVersion}｜${review.outcome}` +
            `｜${current ? '当前产物及要求' : '历史/失效记录'}`,
        );
      }
      if (reviews.length > 8) {
        lines.push(
          `  另有 ${reviews.length - 8} 条较早检查未展开；` +
            `可按 review id 用 inspect_task(task_id="${task.id}", review_id="...") 查回。`,
        );
      }
    }
    const jobs = store.listJobs(task.id);
    const runningJobs = jobs.filter((job) => job.status === 'running');
    const focusedJobs = [
      ...runningJobs,
      ...jobs.filter((job) => job.status !== 'running' && job.exitCode !== 0).slice(-2),
      ...jobs.filter((job) => job.status !== 'running').slice(-1),
    ].filter((job, index, values) => values.findIndex((item) => item.id === job.id) === index);
    if (jobs.length > 0) {
      lines.push('作业重点：');
      for (const job of focusedJobs) lines.push(`  ${job.id} ${job.status} exit=${job.exitCode ?? '-'} ${job.command}`);
      if (jobs.length > focusedJobs.length) {
        lines.push(
          `  运行中作业 ${runningJobs.length} 个，已全部展开；` +
            `另有 ${jobs.length - focusedJobs.length} 个较早结束的非重点作业未展开。`,
        );
      }
    }
    return lines.join('\n');
  }

  private describeTask(
    taskId: string,
    limit: number,
    resultId: string | null = null,
    reviewId: string | null = null,
  ): string {
    const store = this.deps.store;
    const task = store.getTask(taskId);
    if (!task) return `任务不存在：${taskId}`;
    if (resultId) {
      const message = store.getMessage(resultId);
      if (!message || message.taskId !== task.id || message.kind !== 'result') {
        return `任务 ${task.id} 中找不到正式结果 ${resultId}`;
      }
      return `# 正式结果全文 ${message.id}｜${message.createdAt}\n${message.body || '(空)'}`;
    }
    if (reviewId) {
      const review = store.listReviews(task.id).find((item) => item.id === reviewId);
      if (!review) return `任务 ${task.id} 中找不到检查 ${reviewId}`;
      const reply = review.replyMessageId ? store.getMessage(review.replyMessageId) : null;
      return [
        `# 检查 ${review.id}｜产物 ${review.artifactId} v${review.artifactVersion}｜${review.outcome}`,
        `要求版本 ${review.epoch}｜请求消息 ${review.requestMessageId}｜回复消息 ${review.replyMessageId ?? '-'}`,
        reply ? `回复正文：\n${reply.body || '(空)'}` : '（还没有检查回复正文）',
      ].join('\n');
    }
    const lines = this.taskFocus(taskId).split('\n');
    lines.push('', '## 需进一步调查的 Worker 历史');
    const workers = store.listTaskWorkers(task.id);
    if (workers.length === 0) lines.push('无当前成员');
    for (const worker of workers) {
      const turns = store.listWorkerTurns(worker.id, limit);
      for (const turn of turns.slice(-limit)) {
        const calls = turn.toolCalls
          ? ` 调用:${(turn.toolCalls as { name: string }[]).map((call) => call.name).join(',')}`
          : '';
        const body = (turn.content ?? '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push(`  ${worker.id} turn#${turn.seq} ${turn.role}${calls} ${body}`);
      }
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
    const turns = listAllWdDialogueSince(this.deps.store, note?.coveredRow ?? 0);
    const grouped = groupDialogue(turns);
    const groupLimit = Math.max(1, limits.watchdogHistoryGroups);
    const recentGroups = grouped.groups.slice(-groupLimit);
    const olderGroups = grouped.groups.slice(0, Math.max(0, grouped.groups.length - groupLimit));

    // 从最新问答组向前装箱。一组只要超出剩余预算就整组退出近期历史，
    // 不会留下一个只有提问、没有回答的半组。
    const keepRecentTokens = Math.max(1, limits.watchdogKeepRecentTokens);
    let firstKeptGroup = recentGroups.length;
    let keptTokens = 0;
    for (let index = recentGroups.length - 1; index >= 0; index -= 1) {
      const groupTokens = recentGroups[index]!
        .reduce((sum, turn) => sum + estimateDialogueTokens(turn.content), 0);
      if (keptTokens + groupTokens > keepRecentTokens) break;
      keptTokens += groupTokens;
      firstKeptGroup = index;
    }
    const kept = recentGroups.slice(firstKeptGroup).flat();
    const dropped = [
      ...grouped.leading,
      ...olderGroups.flat(),
      ...recentGroups.slice(0, firstKeptGroup).flat(),
    ].sort((left, right) => left.row - right.row);
    return {
      history: kept.map((item): ChatMessage => ({ role: item.role, content: item.content, ...(item.piMessage ? { piMessage: item.piMessage } : {}) })),
      note: note?.content ?? null,
      toSummarize:
        dropped.length > 0
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
    const maxChars = Math.max(
      1_000,
      Math.min(
        config.limits.routerNoteMaxChars,
        config.limits.noteMaxChars,
        config.limits.watchdogKeepRecentTokens,
      ),
    );
    const chunks = chunkDialogueTurns(input.turns, config.limits.noteInputChars);
    if (chunks.length === 0) return null;
    let completedChunks = 0;
    const recordFailure = (reason: string): null => {
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId: null,
        action: 'note_compact_failed',
        reason: '维护会话早期历史压缩失败',
        expected: '更新可追溯的累计摘要并推进覆盖水位',
        result:
          `范围 row ${input.fromRow}-${input.toRow}，${input.turns.length} 条问答；` +
          `已完成 ${completedChunks}/${chunks.length} 批；原因：${reason.slice(0, 500)}`,
      });
      return null;
    };
    try {
      let previous = input.previous;
      for (const chunk of chunks) {
        const result = await new RecordingModel(model, store, 'watchdog', { sessionId: null }).chat({
          model: modelName,
          messages: [
            {
              role: 'system',
              content: 'Maintain a traceable note of the Super-Agent maintenance session for future Watchdog context. Preserve evidence and uncertainty without inventing facts or continuing the conversation.',
            },
            {
              role: 'user',
              content: `# Previous note\n${previous ?? '(first note)'}\n\n` +
                `# New conversation\n${chunk.map((turn) => `[${turn.role === 'user' ? 'Maintainer' : 'Watchdog'}] ${turn.content}`).join('\n\n')}\n\n` +
                `Maintain current observations, evidence and its scope, actions and results, unresolved issues and conditions for rechecking. ` +
                  `Keep the note complete enough to replace every summarized turn. Update superseded decisions and retain uncertainty. ` +
                  `Output only the note, at most ${maxChars} characters.`,
            },
          ],
          tools: [],
          reasoningEffort: 'low',
        });
        const content = (result.text ?? '').trim();
        if (content === '') return recordFailure('摘要模型返回空内容');
        previous = content;
        completedChunks += 1;
      }
      if (!previous) return recordFailure('没有可保存的累计摘要');
      store.insertWatchdogNote({
        id: `wdn_${randomBytes(4).toString('hex')}`,
        fromRow: input.fromRow,
        toRow: input.toRow,
        coveredRow: input.toRow,
        content: previous,
        sourceTurns: input.turns.length,
        sourceChars: input.turns.reduce((sum, turn) => sum + turn.content.length, 0),
      });
      return previous;
    } catch (error) {
      return recordFailure((error as Error).message);
    }
  }

  /**
   * 本轮要用的 system 与历史。
   *
   * 顺序不能反：先判断要不要压缩、压完落水位线，再取历史——
   * 否则刚被压掉的那几条会同时出现在摘要和原文里。
   */
  private async contextForTurn(): Promise<{ system: string; history: ChatMessage[] }> {
    const { history, note, toSummarize } = this.dialogueHistory();
    let merged = note;
    let noteFailed = false;
    if (toSummarize) {
      const next = await this.runNote({ previous: note, ...toSummarize });
      noteFailed = next === null;
      if (next !== null) merged = next;
    }
    let system = WATCHDOG_SYSTEM;
    if (noteFailed) {
      system += '\n\n# 早期维护历史压缩失败\n' +
        '本轮没有包含已退出近期窗口的早期问答，累计记录也未能更新；当前结论可能缺少早期细节。' +
        '只能从已有累计记录、read_inspection 或已存结论查回，不能把未包含的信息当作不存在。';
    }
    if (merged) {
      system += `\n\n# 更早维护对话的完整累计记录（替代已压缩的旧问答）\n${merged}`;
    }
    return { system, history };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: { defaultTaskId?: string | null } = {},
  ): Promise<string | ToolOutcome> {
    const store = this.deps.store;
    const failed = (content: string): ToolOutcome => ({ type: 'failed', content });
    const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
    const num = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? (args[key] as number) : fallback;

    if (name === 'notify_router') {
      const body = str('text').trim();
      if (body === '') return failed('通报内容不能为空');
      const id = `ic_${randomBytes(4).toString('hex')}`;
      const explicitTaskId = str('task_id').trim();
      if (context.defaultTaskId && explicitTaskId && explicitTaskId !== context.defaultTaskId) {
        return failed('任务绑定的维护问答不能把 Router 消息改投到另一个任务');
      }
      const taskId = explicitTaskId || context.defaultTaskId || null;
      if (taskId) {
        store.insertTaskIntercom({
          id,
          fromLayer: 'watchdog',
          kind: 'notice',
          body: body.slice(0, 2000),
          taskId,
        });
        return `已保存定向通报（${id}｜任务 ${taskId}），Router 会在该任务来源会话处理。`;
      }
      store.insertIntercom({ id, fromLayer: 'watchdog', kind: 'notice', body: body.slice(0, 2000) });
      return `已保存通报（${id}），没有明确任务归属，等待管理入口查看。`;
    }
    if (name === 'ask_router') {
      const question = str('question').trim();
      if (question === '') return failed('问题不能为空');
      const id = `ic_${randomBytes(4).toString('hex')}`;
      const explicitTaskId = str('task_id').trim();
      if (context.defaultTaskId && explicitTaskId && explicitTaskId !== context.defaultTaskId) {
        return failed('任务绑定的维护问答不能把 Router 消息改投到另一个任务');
      }
      const taskId = explicitTaskId || context.defaultTaskId || null;
      if (taskId) {
        store.insertTaskIntercom({
          id,
          fromLayer: 'watchdog',
          kind: 'question',
          body: question.slice(0, 2000),
          taskId,
          topicId: id,
        });
        return `问题已保存（${id}｜任务 ${taskId}），Router 会在该任务来源会话处理并回复。`;
      }
      store.insertIntercom({ id, fromLayer: 'watchdog', kind: 'question', body: question.slice(0, 2000), topicId: id });
      return `问题已保存（${id}），没有明确任务归属，等待管理入口查看并回复。`;
    }
    if (name === 'reply_intercom') {
      const target = str('message_id').trim();
      const body = str('body').trim();
      if (target === '') return failed('需要 message_id');
      if (body === '') return failed('回复内容不能为空');
      const original = store.getIntercom(target);
      if (!original) return failed(`找不到消息 ${target}`);
      if (original.toLayer !== 'watchdog') return failed(`${target} 不是发给维护者的消息`);
      return store.replyIntercom(original, `ic_${randomBytes(4).toString('hex')}`, body.slice(0, 2000))
        ? `已回复 ${target}。` : failed(`${target} 已回复或不需要回复`);
    }
    if (name === 'check_main') {
      const health = this.deps.health?.();
      if (!health) return failed('当前环境没有配置主系统健康探测');
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
      if (!tool) return failed(`未知工具：${name}`);
      return await tool.run(args, this.readContext());
    }
    if (name === 'run_command') {
      if (!this.deps.processes) return failed('当前环境没有配置维护者作业服务');
      const command = str('command');
      if (command.trim() === '') return failed('缺少 command');
      const rawArgs = args['args'];
      const list = Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === 'string') : [];
      const cwdRel = str('cwd');
      let cwd = this.deps.config.workDir;
      if (cwdRel !== '') {
        try {
          cwd = resolveInside(this.deps.config.workDir, cwdRel);
          assertInsideRoot(this.deps.config.workDir, cwd);
        } catch (error) {
          return failed(`拒绝执行：${(error as Error).message}`);
        }
      }
      const seconds = Math.min(Math.max(num('timeout_seconds', 30), 1), 60);
      const job = this.deps.processes.start({ command, args: list, cwd, timeoutMs: seconds * 1000 });
      const output = this.deps.processes.read(job.id);
      const text = `作业 ${job.id}｜${job.status}${job.error ? `｜${job.error}` : ''}\n${output?.text ?? '（暂无输出）'}`;
      return job.status === 'failed' || job.status === 'timeout' || job.status === 'killed' ? failed(text) : text;
    }
    if (name === 'job_output') {
      if (!this.deps.processes) return failed('当前环境没有配置维护者作业服务');
      const id = str('job_id');
      const job = this.deps.processes.get(id);
      if (!job) return failed(`找不到作业 ${id}`);
      const output = this.deps.processes.read(id);
      return `${id}｜${job.status}｜退出码 ${job.exitCode ?? '-'}${job.error ? `｜${job.error}` : ''}\n${output?.text ?? '（暂无输出）'}`;
    }
    if (name === 'inspect_task') {
      return this.describeTask(
        str('task_id'),
        num('limit', 15),
        str('result_id') || null,
        str('review_id') || null,
      );
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
    if (name === 'read_inspection') {
      const id = str('inspection_id').trim() || null;
      const conclusion = store.getWatchdogConclusion(id);
      if (!conclusion) return failed(id ? `找不到巡检结论 ${id}` : '还没有维护者结论');
      return `# 巡检结论 ${conclusion.id}｜${beijingTime(conclusion.createdAt)}\n${conclusion.content}`;
    }
    if (name === 'maintain') {
      const action = str('action');
      if (action === 'restart_main') {
        if (!this.deps.restartMain) return failed('当前环境没有配置主系统重启能力');
        const result = await this.deps.restartMain();
        store.appendWdAction({
          id: `wda_${randomBytes(4).toString('hex')}`,
          issueId: str('issue_id') || null,
          action: 'restart_main',
          reason: str('reason') || '',
          expected: '主系统恢复调度',
          result: result.message,
        });
        return result.ok ? result.message : failed(result.message);
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
        taskId: str('task_id') || context.defaultTaskId || null,
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
    return failed(`未知工具：${name}`);
  }

  /**
   * 维护者提问。
   *
   * 调用签名保持兼容；第二个参数只增加短历史范围与任务聚焦，不影响原
   * `ask(question)` 行为。当前问题在上下文装配之后才落库，因此不会同时
   * 出现在 history 与本轮 prompt 中。
   */
  async ask(question: string, options: WatchdogAskOptions = {}): Promise<string> {
    const { store, config, model, modelName } = this.deps;
    const includeHistory = options.history ?? true;
    const taskId = options.taskId?.trim() || null;
    const context = includeHistory
      ? await this.contextForTurn()
      : { system: WATCHDOG_SYSTEM, history: [] as ChatMessage[] };
    const observation = taskId ? null : observe(store, config);
    const health = this.deps.health?.();
    const openIssues = store.listOpenIssues();
    const scopedIssues = taskId ? openIssues.filter((issue) => issue.taskId === taskId) : openIssues;
    const prior = loadReviewState(config);
    store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'user', content: question });

    // 循环交给 pi 的 agent-loop（和 Worker 同一条路）：工具批处理、步数、截断作废都在内核里。
    const repeats = new Map<string, number>();
    let lastAssistant: import('@earendil-works/pi-ai').AssistantMessage | undefined;
    const evidence = taskId
      ? `## 当前任务授权与状态\n${this.taskFocus(taskId)}`
      : `## 当前观察\n${observation
          ? renderReviewContext(observation, prior.state, openIssues, prior.warning)
          : '(没有可用观察)'}`;
    const instanceScope = renderInstanceScope(config);
    const result = await runWorkerTurn({
      model: modelName,
      modelClient: new RecordingModel(model, store, 'watchdog', { sessionId: null }),
      systemPrompt: context.system,
      history: context.history,
      prompts: [{
        role: 'user',
        content:
          `# 维护者提问\n${question}\n\n${instanceScope}\n\n${evidence}\n\n` +
          `## 主系统健康\n${health
            ? `${health.state}｜${health.detail}${health.degraded ? '｜降级观察' : ''}`
            : '未知'}\n\n` +
          `## 相关未解决事件\n${scopedIssues
            .map((issue) => `- ${issue.id}｜${issue.title}｜${issue.note ?? ''}`)
            .join('\n') || '（无）'}\n\n` +
          '先复用上面已经成立的事实和有效证据；只有缺口可能改变当前决定时，才做最小范围的工具核对。' +
          '说清楚哪些是已确认事实、哪些仍不确定。',
      }],
      protectedMessageIndexes: [context.history.length],
      onStep: (message) => { if (!message.content.some((block) => block.type === 'toolCall')) lastAssistant = message; },
      tools: WD_TOOLS,
      maxSteps: MAX_WATCHDOG_STEPS,
      signal: null,
      runTool: async (call) => {
        const key = `${call.name}|${call.arguments}`;
        const seen = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, seen);
        let outcome: ToolOutcome;
        try {
          const result = await this.executeTool(
            call.name,
            JSON.parse(call.arguments || '{}') as Record<string, unknown>,
            { defaultTaskId: taskId },
          );
          outcome = typeof result === 'string' ? { type: 'ok', content: result } : result;
        } catch (error) {
          outcome = { type: 'failed', content: `执行失败：${(error as Error).message}` };
        }
        let output = outcome.content;
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
        return { outcome: { ...outcome, content: output }, terminate: false };
      },
    });

    const answer = (result.assistantText ?? '').trim();
    if (answer !== '') {
      store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'assistant', content: answer, ...(lastAssistant ? { piMessage: lastAssistant } : {}) });
      return answer;
    }
    return `（本轮达到 ${result.steps} 步上限，没有得出结论；已记录当前观察）`;
  }

  async runOnce(intervalMinutes: number): Promise<WatchdogResult> {
    const { store, config, model, modelName } = this.deps;
    const observation = observe(store, config);
    const now = Date.now();
    const openIssues = store.listOpenIssues();
    const prior = loadReviewState(config);
    const issues = openIssues
      .map((issue) => {
        const due = issue.checkAfter ? Date.parse(issue.checkAfter) <= now : true;
        return (
          `- ${issue.id}｜${issue.title}｜尝试 ${issue.attempts} 次｜${issue.note ?? ''}｜` +
          `复查时间 ${issue.checkAfter ?? '-'}｜${due ? '已到复查时间' : '未到复查时间，除非有新证据否则不要重复下同一动作'}`
        );
      })
      .join('\n');
    let acted = false;
    // 周期巡检不从旧问答历史开始：上轮结论有稳定 id，可按需读取全文；
    // 当前变化、open issues 和未答 intercom 已由本轮提示明确给出。
    // 人工 ask() 仍走 contextForTurn()，保留完整维护对话。
    const context = { system: WATCHDOG_SYSTEM, history: [] as ChatMessage[] };
    const instanceScope = renderInstanceScope(config);
    const routerMessages = renderRouterMessages(store);
    const newMessages = store.listPendingIntercom('watchdog', 8);
    let lastAssistant: import('@earendil-works/pi-ai').AssistantMessage | undefined;
    const result = await runWorkerTurn({
      model: modelName,
      modelClient: new RecordingModel(model, store, 'watchdog', { sessionId: null }),
      systemPrompt: context.system,
      history: context.history,
      prompts: [{
        role: 'user',
        content: observationPrompt({
          observation:
            `${instanceScope}\n\n` +
            renderReviewContext(observation, prior.state, openIssues, prior.warning),
          issues,
          lastActions: '',
          now: nowIso(),
          intervalMinutes,
          routerMessages,
        }),
      }],
      protectedMessageIndexes: [context.history.length],
      onStep: (message) => { if (!message.content.some((block) => block.type === 'toolCall')) lastAssistant = message; },
      tools: WD_TOOLS,
      maxSteps: MAX_WATCHDOG_STEPS,
      signal: null,
      runTool: async (call) => {
        try {
          const result = await this.executeTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>);
          const outcome: ToolOutcome = typeof result === 'string' ? { type: 'ok', content: result } : result;
          // 重启可能在停止旧进程或创建新进程后失败；失败不代表没有产生动作。
          if ((call.name === 'maintain' || call.name === 'record') && outcome.type === 'ok') acted = true;
          if (call.name === 'maintain' && this.deps.restartMain &&
              (JSON.parse(call.arguments || '{}') as Record<string, unknown>)['action'] === 'restart_main') acted = true;
          return { outcome, terminate: false };
        } catch (error) {
          return { outcome: { type: 'failed' as const, content: `执行失败：${(error as Error).message}` }, terminate: false };
        }
      },
    });

    if (result.stop === 'error') {
      throw new Error(result.reason || '维护模型执行失败');
    }

    // 只有模型循环成功返回后才记投递。若提供方或循环在收到消息后失败，
    // intercom 保持 pending，下一轮仍能重新注入；主进程对同一批失败消息退避。
    if (newMessages.length > 0) {
      store.tx(() => {
        const content = newMessages
          .map((message) =>
            `[${message.id}] ${message.kind}｜${message.body}` +
              `${message.refs?.length ? `｜引用：${message.refs.join('、')}` : ''}`
          )
          .join('\n');
        store.appendWdTurn({ id: `wdt_${randomBytes(4).toString('hex')}`, role: 'user', content });
        for (const message of newMessages) store.markIntercomDelivered(message.id);
      });
    }

    const answer = (result.assistantText ?? '').trim();
    const summary = answer !== '' ? answer : `本轮达到 ${result.steps} 步上限，已记录当前观察`;
    if (answer !== '') {
      const inspectionId = `wdt_${randomBytes(4).toString('hex')}`;
      store.appendWdTurn({ id: inspectionId, role: 'assistant', content: answer, ...(lastAssistant ? { piMessage: lastAssistant } : {}) });
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId: null,
        action: 'inspect',
        reason: '定时巡检',
        expected: '',
        result: `完整结论 ${inspectionId}｜${answer.slice(0, 160)}`,
      });
      saveReviewState(config, createReviewState(observation, store.getWatchdogConclusion(inspectionId)));
    } else {
      store.appendWdAction({
        id: `wda_${randomBytes(4).toString('hex')}`,
        issueId: null,
        action: 'inspect_incomplete',
        reason: '定时巡检',
        expected: '',
        result: `本轮达到 ${result.steps} 步上限，没有形成可定位结论`,
      });
      saveReviewState(config, createReviewState(observation, null));
    }
    return { acted, summary, steps: result.steps };
  }
}
