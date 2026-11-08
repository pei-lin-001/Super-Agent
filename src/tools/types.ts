import type { Artifact, MessageKind, MessageRefs, ReviewOutcome, Task, Worker } from '../domain/types.ts';

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
  /** 等待原因；provider 表示等模型提供方恢复，恢复时按持久化记录重排。 */
  reason?: 'reply' | 'provider' | 'user' | null;
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
  createCollaborator(parent: Worker, role: string, brief: string): CreateCollaboratorResult;
  sendMessage(input: SendMessageInput): SendMessageResult;
  registerWait(worker: Worker, options: WaitOptions): WaitResult;
  submitResult(worker: Worker, summary: string, artifactNames: string[]): Promise<SubmitResult>;
  report(worker: Worker, kind: 'progress' | 'fail' | 'question', body: string, refs?: MessageRefs): ReportResult;
  saveArtifact(worker: Worker, name: string, content: string): Artifact;
  listArtifacts(taskId: string): Artifact[];
  getArtifact(id: string): Artifact | null;
  readArtifactVersion(taskId: string, name: string, version?: number | null): Promise<{ artifact: Artifact; content: string }>;
  isCancelled(taskId: string): boolean;
}

export interface ToolContext {
  host: ToolHost;
  worker: Worker;
  task: Task;
  workDir: string;
  materialsDir: string;
}

export type ToolOutcome =
  | { type: 'ok'; content: string }
  | {
      type: 'wait';
      content: string;
      wait: { replyTo: string | null; from: string | null; kinds: MessageKind[] | null; timeoutMs: number };
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
