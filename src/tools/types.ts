import { ToolError } from './paths.ts';
import type { JobOutput } from '../runtime/process.ts';
import type {
  Artifact,
  ProcessJob,
  Message,
  MessageKind,
  MessageRefs,
  ReviewOutcome,
  Task,
  Worker,
  WorkerNote,
  WorkerTurn,
} from '../domain/types.ts';

export interface CreateCollaboratorResult {
  ok: boolean;
  workerId?: string;
  reason?: string;
}

export interface SendMessageInput {
  from: Worker;
  to: string;
  kind: MessageKind;
  body: string;
  replyTo?: string | null;
  refs?: MessageRefs | null;
  /** request 的用途：help（普通求助）或 review（正式检查，必须给出结论）。 */
  intent?: string | null;
  /** reply 的检查结论；只有 reply 允许携带。 */
  outcome?: ReviewOutcome | null;
  /** 同一群组内重复提交相同键时只保留第一条。 */
  dedupeKey?: string | null;
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  /** 广播会为每个接收者各生成一条消息。 */
  messageIds?: string[];
  reason?: string;
}

export interface WaitOptions {
  /** 等待原因；provider 表示等模型提供方恢复，job 表示等进程作业结束。 */
  reason?: 'reply' | 'provider' | 'user' | 'job' | 'maintenance' | null;
  /** 等某个进程作业结束时填写。 */
  jobId?: string | null;
  replyTo?: string | null;
  from?: string | null;
  kinds?: MessageKind[] | null;
  timeoutMs: number;
}

export interface WaitResult {
  /** 已有匹配消息，无需挂起。 */
  immediate: boolean;
  /** 已登记等待时的编号。 */
  waitId?: string;
  reason?: string;
}

export interface SubmitResult {
  ok: boolean;
  artifactIds?: string[];
  reason?: string;
}

export interface ReportResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
}

/** 工具层需要的运行时能力。由 Runtime 实现，避免工具直接依赖调度器。 */
export interface ToolHost {
  /** 未显式给出超时时的等待上限。 */
  readonly defaultWaitTimeoutMs: number;
  createCollaborator(
    parent: Worker,
    role: string,
    brief: string,
    options?: { model?: string | null },
  ): CreateCollaboratorResult;
  sendMessage(input: SendMessageInput): SendMessageResult;
  registerWait(worker: Worker, options: WaitOptions): WaitResult;
  submitResult(worker: Worker, summary: string, artifactNames: string[]): Promise<SubmitResult>;
  report(worker: Worker, kind: 'progress' | 'fail' | 'question', body: string, refs?: MessageRefs): ReportResult;
  /**
   * 叫醒一个休眠成员，接到当前任务上。
   *
   * 它记得上次在这个空间里读到什么、试过什么；但旧任务的结论作废，
   * 由 Runtime 在唤醒通知里写清楚。
   */
  wakeWorker(input: {
    worker: Worker;
    workerId: string;
    taskId: string;
    brief: string;
  }): { ok: boolean; reason?: string };
  /**
   * 向 Watchdog 提维护申请（目前只有 restart：让改动真正生效）。
   *
   * 与 report 分开：report 给 Router 是给用户看的话，这个是给独立进程的申请，
   * 由维护者自己核对 git/测试后决定做不做。执行者说的只是线索，不是结论。
   */
  requestMaintenance(input: {
    worker: Worker;
    kind: 'restart';
    reason: string;
    refs: string[];
  }): { ok: boolean; id: string; reason?: string };
  saveArtifact(worker: Worker, name: string, content: string): { artifact: Artifact; reused: boolean };
  listArtifacts(taskId: string): Artifact[];
  getArtifact(id: string): Artifact | null;
  readArtifactVersion(taskId: string, name: string, version?: number | null): Promise<{ artifact: Artifact; content: string }>;
  isCancelled(taskId: string): boolean;
  /** 只能查自己的历史；调用方已在工具层限定为当前 Worker。 */
  searchWorkerTurns(
    workerId: string,
    options: { fromSeq: number; toSeq: number; role: string | null; limit: number },
  ): WorkerTurn[];
  listWorkerTurnsRange(workerId: string, fromSeq: number, toSeq: number): WorkerTurn[];
  getMessageForWorker(workerId: string, messageId: string): Message | null;
  listWorkerNotes(workerId: string): WorkerNote[];

  // ---- 命令执行与作业 ----
  startJob(input: {
    worker: Worker;
    taskId: string;
    command: string;
    args: string[];
    cwd: string;
    stdin: string | null;
    timeoutMs: number;
    signal?: AbortSignal | null;
  }): ProcessJob;
  readJob(jobId: string, stream: 'stdout' | 'stderr', offset: number, limit: number): JobOutput | null;
  getJob(jobId: string): ProcessJob | null;
  listJobs(taskId: string): ProcessJob[];
  stopJob(jobId: string, reason: string): ProcessJob | null;
  /** 登记一次「等作业结束」，返回是否已经结束。 */
  waitJob(worker: Worker, jobId: string, timeoutMs: number): { immediate: boolean; job: ProcessJob | null };
  /** 把磁盘上的真实文件登记为产物（按字节快照）。 */
  importArtifact(worker: Worker, name: string, absolutePath: string): { artifact: Artifact; reused: boolean };
}

export interface ToolContext {
  host: ToolHost;
  worker: Worker;
  task: Task;
  workDir: string;
  materialsDir: string;
  /**
   * 只读根：Worker 能读到任务目录之外的地方（仓库源码、配置）。
   *
   * pi 的 read 工具按 cwd 解析任意路径；我们保留写操作在任务目录，
   * 但读取必须能到仓库根——否则分析代码的任务只能靠 shell 读文件，
   * 输出无界、还会被上下文窗口截断。
   */
  readRoot: string;
  /** 任务取消、Worker 停止或执行超时时触发；长操作必须响应它。 */
  signal?: AbortSignal | null;
}

export type ToolOutcome =
  | {
      type: 'ok';
      content: string;
      /**
       * 这一轮要交给模型看的图。
       *
       * 只有 user 消息能带图（工具的 wire 格式是纯文本），所以协议层会把它们
       * 折成紧随其后的一条 user 消息。不进历史：落库的是 content 里的文字，
       * 下一轮不会重发 base64。
       */
      images?: { mimeType: string; data: string }[];
    }
  | {
      type: 'wait';
      content: string;
      wait: {
        replyTo: string | null;
        from: string | null;
        kinds: MessageKind[] | null;
        timeoutMs: number;
        /** 等进程作业结束时填写；与消息匹配互斥。 */
        jobId?: string | null;
      };
    }
  | { type: 'finish'; content: string }
  | { type: 'failed'; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> | ToolOutcome;
}

export function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${name} 必须是非空字符串`);
  }
  return value;
}

export function argOptionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

export function argNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ToolError(`参数 ${name} 必须是数字`);
}

export function argOptionalNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new Error(`参数 ${name} 必须是数字`);
}

export function argStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`参数 ${name} 必须是字符串数组`);
  }
  return value as string[];
}
