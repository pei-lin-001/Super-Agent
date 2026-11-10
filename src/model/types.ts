/** 模型层的最小契约：一次调用产出文本或工具调用，或两者都有。 */

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串，由工具层负责解析与校验。 */
  arguments: string;
}

/** 随消息带的一小段图片。base64，不带 data: 前缀。 */
export interface ImagePart {
  mimeType: string;
  data: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /**
   * 当轮要看的图。
   *
   * 和历史分开：图片进了历史就会每一轮重发一次，一张 50KB 的图 base64 后约 17k
   * token。所以历史装配会把它剥掉，只留 content 里的一句占位。
   */
  images?: ImagePart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * tool 消息专用：这次工具执行是否失败。
   *
   * 必须有：历史只存文本时，"执行失败"和"执行成功但没有输出"给模型的信号完全一样，
   * 模型会重复一个已经失败过的操作。
   */
  isError?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StepUsage {
  /** 这次真正参与计算的输入 token（已扣掉缓存命中部分）。 */
  promptTokens: number;
  completionTokens: number;
  /**
   * 命中提示缓存、因而不重新计算的输入 token。
   *
   * 必须单独记：提供方的 prompt_tokens 是「总量」，命中部分按折扣计价但**仍然占额度**。
   * 只记 promptTokens 会让账本看起来只有实际消耗的几分之一（实测同一前缀重复发，
   * 2373 总量里 2244 命中，账本里只剩 129）。
   */
  cacheReadTokens?: number;
  /** 这次写入缓存的 token（OpenAI 不报，部分兼容实现会）。 */
  cacheWriteTokens?: number;
}

export interface StepResult {
  text: string | null;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  model: string;
  usage: StepUsage | null;
  /** 本次逻辑调用内部的 HTTP 尝试次数（含重试），不属于请求正文。 */
  httpAttempts?: number;
}

export interface ChatRequest {
  model: string;
  /** 本地取消控制，不会进入发往提供方的请求正文。 */
  signal?: AbortSignal | null;
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

/**
 * 调用失败的类别。上游必须按类别分支，不能靠错误文字里有没有 abort/cancel 猜。
 *
 * - cancelled：本地主动取消（停机、任务取消、代次失效）。不是业务失败，不重试。
 * - timeout：单次请求超时。
 * - network：连接层错误。
 * - provider：提供方返回错误状态。
 * - protocol：响应结构不合法。
 * - unknown：兜底。
 */
export type ModelErrorKind = 'cancelled' | 'timeout' | 'network' | 'provider' | 'protocol' | 'unknown';

export class ModelError extends Error {
  readonly status: number | null;
  readonly body: string | null;
  /** true 表示提供方暂时不可用（例如模型正在装载），稍后可重试。 */
  readonly retryable: boolean;
  readonly kind: ModelErrorKind;
  /** 这次调用真实发出的 HTTP 请求数；失败路径同样要带上，否则记账会落成 NULL。 */
  httpAttempts: number | null = null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      body?: string | null;
      cause?: unknown;
      retryable?: boolean;
      kind?: ModelErrorKind;
      httpAttempts?: number | null;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelError';
    this.status = options.status ?? null;
    this.body = options.body ?? null;
    this.retryable = options.retryable ?? false;
    this.kind = options.kind ?? 'unknown';
    this.httpAttempts = options.httpAttempts ?? null;
  }

  /** 被本地取消：业务层应退出执行过程，而不是把它当成失败。 */
  get isCancelled(): boolean {
    return this.kind === 'cancelled';
  }
}

/** 给错误补上本次真实发出的请求数；已经有值就不覆盖。 */
export function withAttempts(error: ModelError, attempts: number): ModelError {
  if (error.httpAttempts !== null) return error;
  error.httpAttempts = attempts;
  return error;
}

/** 等待被取消时抛出的中性错误：只表示"等待结束了"，归类由调用方完成。 */
export function abortError(): Error {
  const error = new Error('等待已被取消');
  error.name = 'AbortError';
  return error;
}
