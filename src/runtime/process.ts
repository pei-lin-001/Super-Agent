import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { newJobId, nowIso } from '../domain/ids.ts';
import type { ProcessJob } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';

/** 传给子进程的环境变量白名单：不把模型密钥、搜索凭据等交给任意脚本。 */
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'SHELL', 'USER', 'LOGNAME',
  'PWD', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'TERM', 'TERMINFO',
];

export interface StartJobInput {
  taskId: string;
  workerId: string;
  command: string;
  args: string[];
  cwd: string;
  stdin?: string | null;
  timeoutMs: number;
  signal?: AbortSignal | null;
  logRoot: string;
}

export interface JobOutput {
  text: string;
  nextOffset: number;
  total: number;
  /** 还有没读完的内容。 */
  hasMore: boolean;
  /** 进程是否仍在运行。 */
  running: boolean;
}

export interface ProcessServiceOptions {
  store: Store;
  logRoot: string;
  /** 作业归属：biz（业务）或 watchdog（维护）。恢复只处理自己这一份。 */
  scope?: string;
  /** 作业结束时回调，用于唤醒等待它的 Worker。 */
  onFinished?: (job: ProcessJob) => void;
}

/**
 * 命令执行与作业管理。
 * 负责进程生命周期、日志落盘、超时、取消与重启后的状态判定；
 * 调度、唤醒和步数由 Runtime 负责。
 */
export class ProcessService {
  private readonly store: Store;
  private readonly logRoot: string;
  /** 作业归属：业务进程与维护进程各管各的，恢复时不会互相误标。 */
  private readonly scope: string;
  private readonly options: ProcessServiceOptions;
  private readonly alive = new Map<string, ChildProcess>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly abortCleanups = new Map<string, () => void>();
  private disposed = false;

  constructor(options: ProcessServiceOptions) {
    this.options = options;
    this.store = options.store;
    this.logRoot = options.logRoot;
    this.scope = options.scope ?? 'biz';
    mkdirSync(this.logRoot, { recursive: true });
  }

  private jobDir(taskId: string): string {
    const dir = join(this.logRoot, taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 启动一条命令。命令按「程序 + 参数数组」执行，不经过 shell，
   * 因此用户提供的文件名不会被当成 shell 语法解释。
   */
  start(input: StartJobInput): ProcessJob {
    const id = newJobId();
    const dir = this.jobDir(input.taskId);
    const stdoutPath = join(dir, `${id}.out`);
    const stderrPath = join(dir, `${id}.err`);
    const job: ProcessJob = {
      id,
      taskId: input.taskId,
      workerId: input.workerId,
      command: input.command,
      args: input.args,
      scope: this.scope,
      cwd: input.cwd,
      pid: null,
      status: 'running',
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
      timeoutMs: input.timeoutMs,
      startedAt: nowIso(),
      endedAt: null,
      error: null,
    };
    this.store.insertJob(job);

    const env: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }

    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env,
        // 独立进程组：停止时能连带子进程一起结束。
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      job.status = 'failed';
      job.error = `启动失败：${(error as Error).message}`;
      job.endedAt = nowIso();
      this.store.updateJob(job);
      return this.store.getJob(id) ?? job;
    }

    const outStream = createWriteStream(stdoutPath, { flags: 'a' });
    const errStream = createWriteStream(stderrPath, { flags: 'a' });
    child.stdout?.pipe(outStream);
    child.stderr?.pipe(errStream);

    job.pid = child.pid ?? null;
    this.store.updateJob(job);
    this.alive.set(id, child);

    const cleanup = (): void => {
      this.alive.delete(id);
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      this.abortCleanups.get(id)?.();
      this.abortCleanups.delete(id);
    };
    const finish = (status: ProcessJob['status'], extra: { exitCode?: number | null; signal?: string | null; error?: string | null }): void => {
      if (this.disposed) return;
      const current = this.store.getJob(id);
      if (!current || current.status !== 'running') { cleanup(); return; }
      current.status = status;
      current.exitCode = extra.exitCode ?? current.exitCode;
      current.signal = extra.signal ?? current.signal;
      current.endedAt = nowIso();
      if (extra.error !== undefined) current.error = extra.error;
      this.store.updateJob(current);
      cleanup();
      const settled = this.store.getJob(id) ?? current;
      this.options.onFinished?.(settled);
    };

    const deadline = Date.now() + Math.max(1000, input.timeoutMs);
    const scheduleTimeout = (): void => {
      const timer = setTimeout(() => {
        if (Date.now() < deadline) { scheduleTimeout(); return; }
        if (this.store.getJob(id)?.status !== 'running') { cleanup(); return; }
        this.killTree(id);
        finish('timeout', { error: `超过执行时限 ${Math.round(input.timeoutMs / 1000)} 秒，已终止` });
      }, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
      this.timers.set(id, timer);
    };
    scheduleTimeout();

    const onAbort = (): void => {
      if (!this.alive.has(id)) return;
      this.killTree(id);
      finish('killed', { error: '任务或 Worker 被取消，进程已终止' });
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else {
        input.signal.addEventListener('abort', onAbort, { once: true });
        this.abortCleanups.set(id, () => input.signal?.removeEventListener('abort', onAbort));
      }
    }

    child.on('error', (error: Error) => {
      finish('failed', { error: `进程错误：${error.message}` });
    });
    // 子进程可能先关闭 stdin，异步 EPIPE 不能让宿主进程崩溃。
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        this.killTree(id);
        finish('failed', { error: `写入标准输入失败：${error.message}` });
      }
    });
    child.stdin?.end(input.stdin ?? undefined);
    const onLogError = (error: Error): void => {
      this.killTree(id);
      finish('failed', { error: `写入作业日志失败：${error.message}` });
    };
    outStream.on('error', onLogError);
    errStream.on('error', onLogError);
    child.on('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      // close 表示子进程管道关闭，文件写入流仍可能在落盘。
      const complete = (): void => {
        if (!outStream.writableFinished || !errStream.writableFinished) return;
        finish(code === 0 ? 'exited' : 'failed', { exitCode: code, signal: signalName });
      };
      outStream.once('finish', complete);
      errStream.once('finish', complete);
      complete();
    });

    return this.store.getJob(id) ?? job;
  }

  /** 结束整棵进程树；只停外层命令会让真正干活的脚本继续跑。 */
  killTree(jobId: string): void {
    const child = this.alive.get(jobId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child?.pid ?? null;
    if (pid === null) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // 进程组不存在时退回单进程 kill。
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出或无权结束，交给状态判定。
    }
  }

  /** 停止作业：记录原因并终止进程树。 */
  stop(jobId: string, reason: string): ProcessJob | null {
    const job = this.store.getJob(jobId);
    if (!job) return null;
    if (job.status !== 'running') return job;
    if (!this.alive.has(jobId)) return job;
    this.killTree(jobId);
    job.status = 'killed';
    job.endedAt = nowIso();
    job.error = reason;
    this.store.updateJob(job);
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.alive.delete(jobId);
    this.abortCleanups.get(jobId)?.();
    this.abortCleanups.delete(jobId);
    const settled = this.store.getJob(jobId) ?? job;
    this.options.onFinished?.(settled);
    return settled;
  }

  /** 任务进入终态时清理它名下的作业，避免交付后还有进程在改文件。 */
  stopAllForTask(taskId: string, reason: string): string[] {
    const stopped: string[] = [];
    for (const job of this.store.listRunningJobs(taskId)) {
      if (this.alive.has(job.id)) {
        this.stop(job.id, reason);
        stopped.push(job.id);
      }
    }
    return stopped;
  }

  read(jobId: string, stream: 'stdout' | 'stderr', offset: number, limit: number): JobOutput | null {
    if (this.disposed) return null;
    const job = this.store.getJob(jobId);
    if (!job) return null;
    const path = stream === 'stdout' ? job.stdoutPath : job.stderrPath;
    let text = '';
    let total = 0;
    let actualOffset = offset;
    if (existsSync(path)) {
      const fd = openSync(path, 'r');
      try {
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let requestedEnd = offset + limit;
        const collect = (part: string): void => {
          let start = Math.max(0, offset - total);
          if (start > 0 && start < part.length && /[\uD800-\uDBFF]/.test(part[start - 1]!) && /[\uDC00-\uDFFF]/.test(part[start]!)) {
            start++;
            actualOffset++;
            requestedEnd++;
          }
          let end = Math.min(part.length, requestedEnd - total);
          // 不把 UTF-16 代理对拆到两个页面；下一次 offset 仍按 JS 字符串长度计算。
          if (end > start && end < part.length && /[\uD800-\uDBFF]/.test(part[end - 1]!) && /[\uDC00-\uDFFF]/.test(part[end]!)) {
            end++;
            requestedEnd++;
          }
          if (end > start) text += part.slice(start, end);
          total += part.length;
        };
        let bytes: number;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) collect(decoder.write(buffer.subarray(0, bytes)));
        if (job.status !== 'running') collect(decoder.end());
      } finally {
        closeSync(fd);
      }
    }
    const nextOffset = Math.min(actualOffset, total) + text.length;
    return {
      text,
      nextOffset,
      total,
      hasMore: nextOffset < total,
      running: job.status === 'running',
    };
  }

  /**
   * 重启后的判定：本进程启动前记录的 running 作业一律无法确认结果，
   * 标记为 unknown，既不当成功也不当失败，也不按 PID 去杀。
   */
  recover(): number {
    const jobs = this.store.listAllRunningJobs(this.scope);
    for (const job of jobs) {
      job.status = 'unknown';
      job.endedAt = nowIso();
      job.error = '程序重启前没有记录到结束，执行结果未知；不会自动重放';
      this.store.updateJob(job);
    }
    return jobs.length;
  }

  /** 关闭：结束所有仍存活的进程，并停止写库（进程退出事件可能晚于关闭）。 */
  dispose(): void {
    this.disposed = true;
    for (const jobId of [...this.alive.keys()]) {
      this.killTree(jobId);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const cleanup of this.abortCleanups.values()) cleanup();
    this.abortCleanups.clear();
    this.alive.clear();
  }

  /** 清空某个任务的日志目录（仅用于测试与显式清理）。 */
  purgeTaskLogs(taskId: string): void {
    const dir = join(this.logRoot, taskId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
