import { existsSync } from 'node:fs';
import { beijingTime } from '../domain/ids.ts';
import { resolve } from 'node:path';
import { assertInsideRoot, resolveInside, ToolError } from './paths.ts';
import {
  argNumber,
  argOptionalNumber,
  argOptionalString,
  argString,
  argStringArray,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';
import { taskDir } from './files.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from '../vendor/pi/truncate.ts';

const MAX_READ = 20_000;
const DEFAULT_READ = 8_000;
/** wait=true 时一次最多取回的输出量：够看完整的报错结尾，又不至于撑爆上下文。 */
const WAIT_READ_BYTES = DEFAULT_MAX_BYTES;

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

function resolveCwd(context: ToolContext, logical: string | null): string {
  const root = taskDir(context);
  const target = logical ? resolveInside(root, logical) : root;
  if (!existsSync(target)) throw new ToolError(`工作目录不存在：${logical ?? '.'}（相对任务目录）`);
  assertInsideRoot(root, target);
  return target;
}

function describeJob(job: { id: string; status: string; pid: number | null; command: string; args: string[] }): string {
  return `${job.id}｜${job.status}｜pid=${job.pid ?? '-'}｜${[job.command, ...job.args].join(' ')}`;
}

export const execTools: ToolDefinition[] = [
  {
    name: 'proc_run',
    description:
      '执行一条外部命令（程序名 + 参数数组，不经过 shell）。用于运行 python3 / node / 测试 / 构建 / git 等。' +
      '默认立即返回作业 ID，命令在后台继续；用 proc_read 看输出、proc_wait 等结束、proc_stop 终止。' +
      'wait=true 时会在 wait_seconds 内等待结束并直接返回输出。工作目录相对任务目录，默认任务目录。' +
      '子进程只继承 PATH/HOME/LANG 等基础环境变量，不会拿到模型或搜索凭据。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '程序名或可执行文件路径，例如 python3、node、git' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组，逐项传递，不拼接 shell 字符串' },
        cwd: { type: 'string', description: '工作目录（相对任务目录），默认任务目录' },
        stdin: { type: 'string', description: '标准输入内容；给出后写入并关闭' },
        timeout_seconds: { type: 'number', description: '执行时限（秒），到时强制终止，默认 120' },
        wait: { type: 'boolean', description: '是否等待结束再返回，默认 false' },
        wait_seconds: { type: 'number', description: 'wait=true 时的等待上限（秒），默认 30' },
      },
      required: ['command'],
    },
    async run(args, context) {
      const command = argString(args, 'command');
      const argv = argStringArray(args, 'args');
      const cwd = resolveCwd(context, argOptionalString(args, 'cwd'));
      const stdin = args['stdin'];
      if (stdin !== undefined && stdin !== null && typeof stdin !== 'string') {
        throw new ToolError('参数 stdin 必须是字符串');
      }
      const timeoutSeconds = Math.max(1, argOptionalNumber(args, 'timeout_seconds') ?? 120);
      const wait = args['wait'] === true;
      const waitSeconds = Math.max(1, Math.min(600, argOptionalNumber(args, 'wait_seconds') ?? 30));

      const job = context.host.startJob({
        worker: context.worker,
        taskId: context.task.id,
        command,
        args: argv,
        cwd,
        stdin: (stdin as string | null | undefined) ?? null,
        timeoutMs: timeoutSeconds * 1000,
        signal: context.signal ?? null,
      });

      if (job.status !== 'running') {
        return ok(
          `作业 ${job.id} 未能启动：${job.status}${job.error ? `｜${job.error}` : ''}\n` +
            '常见原因：程序不存在或没有执行权限。请改用 `command` 指定可用解释器（python3 / node），或先确认依赖。',
        );
      }

      if (!wait) {
        return ok(
          `已启动 ${describeJob(job)}\n执行时限 ${timeoutSeconds} 秒。` +
            `用 proc_read(job_id="${job.id}") 查看输出，proc_wait 等结束，proc_stop 终止。`,
        );
      }

      const deadline = Date.now() + waitSeconds * 1000;
      let current = context.host.getJob(job.id);
      while (current && current.status === 'running' && Date.now() < deadline) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
        current = context.host.getJob(job.id);
      }
      // 取输出的**尾部**：报错和最终结论在结尾，只给开头等于让人猜。
      const stdout = context.host.readJob(job.id, 'stdout', 0, Math.max(WAIT_READ_BYTES, DEFAULT_READ));
      const stderr = context.host.readJob(job.id, 'stderr', 0, Math.max(WAIT_READ_BYTES, DEFAULT_READ));
      const stillRunning = current?.status === 'running';
      const render = (label: string, stream: { text: string; hasMore: boolean; total: number } | null): string => {
        if (!stream?.text) return `--- ${label} ---\n(空)`;
        const clipped = truncateTail(stream.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const hint = clipped.truncated
          ? `\n…（${label} 共 ${stream.total} 字符，这里只给末尾 ${formatSize(clipped.outputBytes)}；` +
            `要看开头用 proc_read offset=0）`
          : stream.hasMore
            ? `\n…（${label} 共 ${stream.total} 字符，继续用 proc_read offset=（从头部读））`
            : '';
        return `--- ${label} ---\n${clipped.content}${hint}`;
      };
      const lines = [
        `作业 ${job.id}｜${current?.status ?? 'unknown'}｜退出码 ${current?.exitCode ?? '-'}`,
        render('stdout', stdout),
        stderr?.text ? render('stderr', stderr) : '',
      ];
      if (stillRunning) {
        lines.push(`命令仍在运行，已等待 ${waitSeconds} 秒。用 proc_wait 继续等，或 proc_read 看进度。`);
      }
      return ok(lines.filter(Boolean).join('\n'));
    },
  },
  {
    name: 'proc_read',
    description:
      '分段读取作业的标准输出或错误输出（按字符偏移）。返回是否还有剩余内容以及下一次的 offset。' +
      '进程仍在运行时也可以读，已产生的输出不会丢失。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'proc_run 返回的作业 ID' },
        stream: { type: 'string', enum: ['stdout', 'stderr'], description: '默认 stdout' },
        offset: { type: 'number', description: '字符偏移，默认 0' },
        limit: { type: 'number', description: '本次读取字符数，默认 8000，上限 20000' },
      },
      required: ['job_id'],
    },
    run(args, context) {
      const jobId = argString(args, 'job_id');
      const stream = (argOptionalString(args, 'stream') ?? 'stdout') as 'stdout' | 'stderr';
      const offset = Math.max(0, argOptionalNumber(args, 'offset') ?? 0);
      const limit = Math.max(1, Math.min(MAX_READ, argOptionalNumber(args, 'limit') ?? DEFAULT_READ));
      const job = context.host.getJob(jobId);
      if (!job) throw new ToolError(`作业不存在：${jobId}`);
      if (job.taskId !== context.task.id) throw new ToolError(`作业 ${jobId} 不属于本任务`);
      const output = context.host.readJob(jobId, stream, offset, limit);
      if (!output) throw new ToolError(`作业不存在：${jobId}`);
      const head =
        `${jobId} ${stream}｜状态 ${job.status}｜退出码 ${job.exitCode ?? '-'}｜` +
        `已读 ${output.nextOffset}/${output.total} 字符`;
      const tail = output.hasMore ? `\n…继续请用 offset=${output.nextOffset}` : '';
      return ok(`${head}\n${output.text || '(空)'}${tail}`);
    },
  },
  {
    name: 'proc_wait',
    description:
      '等待作业结束。会挂起当前 Worker 并让出执行槽，作业结束时自动唤醒，不消耗业务步数。' +
      '等待超时只结束本次等待，作业仍在运行；执行时限由 proc_run 的 timeout_seconds 控制。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '作业 ID' },
        timeout_seconds: { type: 'number', description: '本次等待上限（秒），默认 300' },
      },
      required: ['job_id'],
    },
    run(args, context) {
      const jobId = argString(args, 'job_id');
      const job = context.host.getJob(jobId);
      if (!job) throw new ToolError(`作业不存在：${jobId}`);
      if (job.taskId !== context.task.id) throw new ToolError(`作业 ${jobId} 不属于本任务`);
      if (job.status !== 'running') {
        return ok(`作业 ${jobId} 已结束：${job.status}｜退出码 ${job.exitCode ?? '-'}${job.error ? `｜${job.error}` : ''}`);
      }
      const timeoutSeconds = Math.max(1, Math.min(3600, argOptionalNumber(args, 'timeout_seconds') ?? 300));
      const result = context.host.waitJob(context.worker, jobId, timeoutSeconds * 1000);
      if (result.immediate) {
        const current = result.job ?? job;
        return ok(`作业 ${jobId} 已结束：${current.status}｜退出码 ${current.exitCode ?? '-'}`);
      }
      return {
        type: 'wait',
        content: `开始等待作业 ${jobId} 结束（最多 ${timeoutSeconds} 秒）。结束后会自动唤醒。`,
        wait: { replyTo: null, from: null, kinds: null, timeoutMs: timeoutSeconds * 1000, jobId },
      };
    },
  },
  {
    name: 'proc_stop',
    description: '终止作业及其子进程。用于命令跑飞、输出异常或不再需要结果时。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '作业 ID' },
        reason: { type: 'string', description: '停止原因，会记录在作业上' },
      },
      required: ['job_id'],
    },
    run(args, context) {
      const jobId = argString(args, 'job_id');
      const job = context.host.getJob(jobId);
      if (!job) throw new ToolError(`作业不存在：${jobId}`);
      if (job.taskId !== context.task.id) throw new ToolError(`作业 ${jobId} 不属于本任务`);
      const stopped = context.host.stopJob(jobId, argOptionalString(args, 'reason') ?? 'Worker 主动停止');
      return ok(`作业 ${jobId} 当前状态：${stopped?.status ?? 'unknown'}${stopped?.error ? `｜${stopped.error}` : ''}`);
    },
  },
  {
    name: 'proc_list',
    description: '列出本任务的作业及其状态、退出码与启动时间。',
    parameters: { type: 'object', properties: {}, required: [] },
    run(_args, context) {
      const jobs = context.host.listJobs(context.task.id);
      if (jobs.length === 0) return ok('(本任务还没有作业)');
      return ok(
        jobs
          .map(
            (job) =>
              `${describeJob(job)}｜退出码 ${job.exitCode ?? '-'}｜${beijingTime(job.startedAt)}` +
              `${job.error ? `｜${job.error}` : ''}`,
          )
          .join('\n'),
      );
    },
  },
];
