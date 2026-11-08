/** 模型层的最小契约：一次调用产出文本或工具调用，或两者都有。 */

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串，由工具层负责解析与校验。 */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StepUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StepResult {
  text: string | null;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  model: string;
  usage: StepUsage | null;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  reasoningEffort?: string;
  temperature?: number;
}

export interface ModelClient {
  /** real 表示真实提供方；mock 只允许测试显式注入。 */
  readonly kind: 'real' | 'mock';
  readonly label: string;
  chat(request: ChatRequest): Promise<StepResult>;
}

export class ModelError extends Error {
  readonly status: number | null;
  readonly body: string | null;
  /** true 表示提供方暂时不可用（例如模型正在装载），稍后可重试。 */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; body?: string | null; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelError';
    this.status = options.status ?? null;
    this.body = options.body ?? null;
    this.retryable = options.retryable ?? false;
  }
}
