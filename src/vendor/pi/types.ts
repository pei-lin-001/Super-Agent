/**
 * 移植自 pi @earendil-works/pi-coding-agent@1.5.0
 * 原文件：packages/ai/dist/types.d.ts（只保留本仓库用到的子集）
 *
 * 与上游相比删掉了 provider 专有字段（api/provider/deferred/rawStopReason 等），
 * 逻辑不变。上游改字段时需要重新对照。
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue };

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
}

/** 工具声明：模型能看到的形状。 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 可执行工具：声明 + 执行函数。agent loop 用声明，执行由宿主提供。 */
export interface Tool<TParameters extends object = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: TParameters;
}

export interface ToolReference {
  name: string;
}

export interface SystemMessage {
  role: 'system';
  content: string | TextContent[];
  /** 按名渲染的提示段落；后续消息按名覆盖，null 表示删除。 */
  sections?: Record<string, string | null>;
  /** 在此刻变为可用的完整工具定义。 */
  toolsAdded?: ToolDeclaration[];
  /** 在该时刻被移除的工具。 */
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** 请求开始时的毫秒时间戳。 */
  timestamp: number;
  durationMs?: number;
  thinkingLevel?: string;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: Record<string, JsonValue>;
  isError: boolean;
  timestamp: number;
  durationMs?: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** Agent 循环内部的消息：比 Message 多出宿主注入的自定义消息。 */
export interface CustomMessage {
  role: 'custom';
  content: string | TextContent[];
  customType: string;
  timestamp: number;
}

export type AgentMessage = Message | CustomMessage;

export interface TranscriptContext {
  messages: Message[];
}

export interface Context {
  systemPrompt?: string;
  tools?: ToolDeclaration[];
  messages: AgentMessage[];
}

// ---- 流事件 ----

export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: 'done'; reason: StopReason; message: AssistantMessage }
  | { type: 'error'; reason: StopReason; error: AssistantMessage };

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
