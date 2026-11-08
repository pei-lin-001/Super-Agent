import type { Artifact, MessageKind, MessageRefs, Task, Worker } from '../domain/types.ts';

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
  intent?: string | null;
  /** 同一群组内重复提交相同键时只保留第一条。 */
  dedupeKey?: string | null;
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
}

export interface WaitOptions {
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

export function argStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`参数 ${name} 必须是字符串数组`);
  }
  return value as string[];
}
