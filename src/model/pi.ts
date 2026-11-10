/**
 * 聊天协议层：把请求交给 `@earendil-works/pi-ai`，只负责本仓库关心的那几件事。
 *
 * 上游 pi-ai 处理协议本身——多模态内容块、思考块与签名、工具调用的流式累积、
 * 各家的 reasoning 字段差异、usage 归一化。我们自己保留三样它管不了的：
 *
 *   1. 并发闸门：提供方对并发敏感，超了只返回 load 而不报错。
 *   2. 重试计数：`httpAttempts` 要精确到真正发出的请求数，所以 pi 的重试关掉，
 *      由这里重发。
 *   3. 错误归类：上游要按 kind 分支，不能靠错误文字里有没有 abort 猜。
 *
 * 移植说明：`stream`/`complete` 来自 `@earendil-works/pi-ai@1.5.1` 的 compat 入口，
 * 该入口内部做 normalizeContext，因此可以传普通 Context，不必碰它的品牌类型。
 */
import { stream, type Context, type Message, type Tool } from '@earendil-works/pi-ai/compat';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import {
  ModelError,
  withAttempts,
  type ChatMessage,
  type ChatRequest,
  type ModelClient,
  type StepResult,
  type ToolSchema,
} from './types.ts';

export interface PiModelOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: number;
  maxTokens?: number;
  /** pi 的思考档位：off/minimal/low/medium/high/xhigh/max。 */
  reasoningEffort?: string | undefined;
  label?: string;
  contextWindow?: number;
  fetchImpl?: typeof fetch;
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 全局并发闸门：提供方对并发敏感，超出时只会返回 load 而不报错。 */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly limit: number;
  private readonly minIntervalMs: number;
  private lastRelease = 0;

  constructor(limit: number, minIntervalMs: number) {
    this.limit = Math.max(1, limit);
    this.minIntervalMs = Math.max(0, minIntervalMs);
  }

  async acquire(): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    const wait = this.lastRelease + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  release(): void {
    this.lastRelease = Date.now();
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

const GLOBAL_LIMIT = Number(process.env['MODEL_CONCURRENCY'] ?? 2);
const MIN_INTERVAL = Number(process.env['MODEL_MIN_INTERVAL_MS'] ?? 1500);
const gate = new Semaphore(
  Number.isFinite(GLOBAL_LIMIT) ? GLOBAL_LIMIT : 2,
  Number.isFinite(MIN_INTERVAL) ? MIN_INTERVAL : 1500,
);

/** 把本仓库的消息形状转成 pi 的 Message。 */
export function toPiMessage(message: ChatMessage, model: string): Message | null {
  if (message.role === 'system') {
    return { role: 'system', content: message.content ?? '', timestamp: Date.now() };
  }
  if (message.role === 'user') {
    const withText = (message.content ?? '').length > 0;
    if (!message.images || message.images.length === 0) {
      return { role: 'user', content: message.content ?? '', timestamp: Date.now() };
    }
    // 只有图没有字时也要给一个文本块：部分提供方要求数组首块是 text。
    return {
      role: 'user',
      content: [
        ...(withText ? [{ type: 'text' as const, text: message.content ?? '' }] : []),
        ...message.images.map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
      timestamp: Date.now(),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId ?? '',
      // pi 的 toolResult 要 toolName，但我们历史里只存 toolCallId；
      // 提供方按 id 对应，留空不影响配对。
      toolName: '',
      content: [{ type: 'text', text: message.content ?? '' }],
      isError: message.isError === true,
      timestamp: Date.now(),
    };
  }
  // assistant：文本 + 工具调用。历史里的思考块没有签名，重放会被提供方拒；
  // 我们只回放「说了什么」和「要做什么」。
  const content: Extract<Message, { role: 'assistant' }>['content'] = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    });
  }
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'super-agent',
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

function toPiTools(tools: ToolSchema[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  }));
}

function parseArguments(raw: string): Record<string, never> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, never>;
  } catch {
    return {} as Record<string, never>;
  }
}

/** pi 的消息形状 → StepResult。文本只取可见的部分，思考块单独给出。 */
export function fromPiMessage(message: AssistantMessage): StepResult {
  const texts: string[] = [];
  const thoughts: string[] = [];
  const toolCalls: StepResult['toolCalls'] = [];
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'thinking') thoughts.push(block.thinking);
    else if (block.type === 'toolCall') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        // 本仓库的 ToolCall.arguments 是原始 JSON 字符串，工具层负责解析校验。
        arguments: JSON.stringify(block.arguments ?? {}),
      });
    }
  }
  return {
    text: texts.length > 0 ? texts.join('') : null,
    reasoning: thoughts.length > 0 ? thoughts.join('') : null,
    toolCalls,
    finishReason: message.stopReason,
    model: message.responseModel ?? message.model,
    // pi 已经把 usage.input 算成「扣掉缓存之后」的量，缓存命中数单独给出。
    // 两个都要往下传：只留 input 会让账本比真实消耗小一个数量级。
    usage: message.usage
      ? {
          promptTokens: message.usage.input,
          completionTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
        }
      : null,
  };
}

/**
 * 一次请求的图片预算。
 *
 * 上游对单次请求的体积是有限的，而我们这边的图片会沿对话累积：Router 一轮带几张、
 * Worker 连看几张，都会原样进同一个请求。光靠提示词说"不要反复看"没用——
 * 模型忘性大，而且它看不见字节数。
 *
 * 实测 ollama cloud：一张 49KB 的截图算约 500 token，288KB 与 1MB 的都是 1056 token
 * （它把图压到固定档位）。所以真正会撑爆的不是 token，而是上传体积：
 * 十几张未压缩的手机截图就能让请求体到几十 MB。
 *
 * 超预算时从最老的开始丢，并在原位留一句占位——不能让模型以为那里本来什么都没有。
 */
const MAX_IMAGES_PER_REQUEST = Number(process.env['MODEL_MAX_IMAGES'] ?? 8) || 8;
const MAX_IMAGE_BYTES_PER_REQUEST = Number(process.env['MODEL_MAX_IMAGE_BYTES'] ?? 16 * 1024 * 1024) || 16 * 1024 * 1024;

function budgetImages(messages: ChatMessage[]): { messages: ChatMessage[]; dropped: number } {
  // 先按从新到旧的顺序数出哪些留得下。
  const keep = new Set<number>();
  let count = 0;
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const images = messages[index]!.images;
    if (!images || images.length === 0) continue;
    const size = images.reduce((sum, image) => sum + image.data.length, 0);
    if (count + images.length > MAX_IMAGES_PER_REQUEST) continue;
    if (bytes + size > MAX_IMAGE_BYTES_PER_REQUEST) continue;
    keep.add(index);
    count += images.length;
    bytes += size;
  }
  if (keep.size === messages.filter((message) => message.images && message.images.length > 0).length) {
    return { messages, dropped: 0 };
  }
  let dropped = 0;
  const out = messages.map((message, index) => {
    if (!message.images || message.images.length === 0 || keep.has(index)) return message;
    dropped += message.images.length;
    return {
      ...message,
      images: undefined,
      // 原位留一句，别让模型以为这里从来没有图。
      content: `${message.content ?? ''}\n（此处的 ${message.images.length} 张图片已省略以控制请求体积；需要再看请重新调用看图工具）`.trim(),
    };
  });
  return { messages: out, dropped };
}

export class PiModel implements ModelClient {
  readonly kind = 'real' as const;
  readonly label: string;
  private readonly options: PiModelOptions;
  private readonly model: Model<'openai-completions'>;
  /** 上一次调用因为预算被丢掉的图片数，供记账/排障读取。 */
  lastDroppedImages = 0;

  constructor(options: PiModelOptions, modelId: string) {
    this.options = options;
    this.label = options.label ?? `pi:${options.baseUrl}`;
    this.model = {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      // 自定义 provider：pi 的内置目录里没有 ollama，但它允许任意字符串，
      // 适配器由 api 决定（openai-completions 是内置的）。
      provider: 'ollama-cloud',
      baseUrl: options.baseUrl,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true,
      contextWindow: options.contextWindow ?? 200_000,
      maxTokens: options.maxTokens ?? 8_192,
      // pi 会按 provider 推断是否把 system 换成 OpenAI 新方言的 `developer`。
      // 我们的目标都是自研的 OpenAI 兼容层，认 system 才稳妥；这里显式固定，
      // 免得换了 baseUrl 就悄悄改变指令的投递方式。
      compat: { supportsDeveloperRole: false },
    };
  }

  async chat(request: ChatRequest): Promise<StepResult> {
    const maxAttempts = Math.max(0, this.options.retry) + 1;
    let attempt = 0;
    let lastError: unknown = null;
    let callAttempts = 0;

    const thinkingLevel =
      request.reasoningEffort && THINKING_LEVELS.has(request.reasoningEffort)
        ? (request.reasoningEffort as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')
        : undefined;

    while (attempt < maxAttempts) {
      await gate.acquire();
      if (request.signal?.aborted === true) {
        gate.release();
        throw new ModelError('模型调用已被本地取消', { kind: 'cancelled', retryable: false, httpAttempts: callAttempts });
      }
      callAttempts += 1;
      try {
        const budgeted = budgetImages(request.messages);
        if (budgeted.dropped > 0) {
          this.lastDroppedImages = budgeted.dropped;
        }
        const messages: Message[] = [];
        for (const message of budgeted.messages) {
          const converted = toPiMessage(message, request.model);
          if (converted) messages.push(converted);
        }
        const context: Context = {
          messages,
          ...(request.tools.length > 0 ? { tools: toPiTools(request.tools) } : {}),
        };
        // pi 的适配器强制走流式（stream: true），HTTP 错误不抛异常而是落在
        // stopReason='error' + errorMessage 里，所以状态码要从 onResponse / 消息里取。
        let httpStatus: number | null = null;
        const events = stream(this.model, context, {
          apiKey: this.options.apiKey,
          signal: request.signal
            ? AbortSignal.any([request.signal, AbortSignal.timeout(this.options.timeoutMs)])
            : AbortSignal.timeout(this.options.timeoutMs),
          // 重试由本层负责：只有这样才能给出精确的 httpAttempts。
          maxRetries: 0,
          onResponse: (response) => {
            httpStatus = response.status;
          },
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
          ...(this.options.fetchImpl ? { fetch: this.options.fetchImpl } : {}),
        });

        const result = await events.result();
        if (result.stopReason === 'error' || result.stopReason === 'aborted') {
          // 本地取消优先：signal 已 abort 时不管上游报什么都算取消。
          if (request.signal?.aborted || result.stopReason === 'aborted') {
            throw new ModelError('模型调用已被本地取消', { kind: 'cancelled', retryable: false });
          }
          const message = result.errorMessage ?? '未知错误';
          const parsed = /^(\d{3}):\s*(.*)$/s.exec(message);
          const status = httpStatus ?? (parsed ? Number(parsed[1]) : null);
          // 没有状态码 = 网络层/超时，和 HTTP 错误一样值得重试；
          // 有状态码就只看它在不在可重试集合里（4xx 一律不重试）。
          const retryable = status === null ? true : RETRYABLE_STATUS.has(status);
          throw new ModelError(`模型调用失败：${message}`, {
            status,
            body: parsed ? (parsed[2]?.slice(0, 800) ?? null) : message.slice(0, 800),
            kind: status === null ? 'network' : 'provider',
            retryable,
          });
        }
        const step = fromPiMessage(result);
        if ((step.text === null || step.text.trim() === '') && step.toolCalls.length === 0) {
          const detail =
            `模型既没有输出文本也没有工具调用` +
            `（stopReason=${result.stopReason}，reasoning ${step.reasoning?.length ?? 0} 字符）`;
          if (attempt < maxAttempts - 1) {
            lastError = new ModelError(detail, { retryable: true });
            attempt += 1;
            await this.backoff(400 * 2 ** attempt, request.signal, callAttempts);
            continue;
          }
          throw new ModelError(detail, { retryable: true });
        }
        return { ...step, httpAttempts: callAttempts };
      } catch (error) {
        // 任何出口都要带上已经发出的请求次数，否则记账会落成 NULL。
        if (request.signal?.aborted) throw withAttempts(asModelError(error), callAttempts);
        if (error instanceof ModelError && !error.retryable) throw withAttempts(error, callAttempts);
        if (error instanceof ModelError && attempt < maxAttempts - 1) {
          lastError = error;
          attempt += 1;
          await this.backoff(400 * 2 ** attempt, request.signal, callAttempts);
          continue;
        }
        const classified = classify(error);
        if (classified.retryable && attempt < maxAttempts - 1) {
          lastError = classified;
          attempt += 1;
          await this.backoff(400 * 2 ** attempt, request.signal, callAttempts);
          continue;
        }
        throw withAttempts(classified, callAttempts);
      } finally {
        gate.release();
      }
    }

    throw lastError instanceof ModelError
      ? withAttempts(lastError, callAttempts)
      : new ModelError('模型调用重试耗尽', { cause: lastError, httpAttempts: callAttempts });
  }

  /** 退避；被取消时抛出带请求次数的 cancelled，避免记账落成 NULL。 */
  private async backoff(ms: number, signal: AbortSignal | null | undefined, attempts: number): Promise<void> {
    try {
      await this.sleepUnlessAborted(ms, signal);
    } catch (error) {
      throw withAttempts(asModelError(error), attempts);
    }
  }

  private async sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new ModelError('模型调用已被本地取消', { kind: 'cancelled', retryable: false }));
      };
      if (signal?.aborted === true) {
        clearTimeout(timer);
        reject(new ModelError('模型调用已被本地取消', { kind: 'cancelled', retryable: false }));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => signal?.removeEventListener('abort', onAbort), ms + 50);
    });
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function asModelError(error: unknown): ModelError {
  return error instanceof ModelError ? error : classify(error);
}

/** pi 的错误是它自己的类，这里统一归到 ModelError，上游只看 kind/status/retryable。 */
function classify(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new ModelError('模型调用已被本地取消', { kind: 'cancelled', retryable: false, cause: error });
    }
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status) && status > 0) {
      return new ModelError(`模型接口返回 ${status}`, {
        status,
        body: String((error as { body?: unknown }).body ?? '').slice(0, 800),
        retryable: RETRYABLE_STATUS.has(status),
      });
    }
    return new ModelError(`模型调用失败：${error.message}`, {
      kind: error instanceof TypeError ? 'network' : 'unknown',
      retryable: error instanceof TypeError,
      cause: error,
    });
  }
  return new ModelError('模型调用失败：未知错误', { cause: error });
}
