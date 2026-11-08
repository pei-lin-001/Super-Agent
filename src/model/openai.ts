import { ModelError, type ChatMessage, type ChatRequest, type ModelClient, type StepResult, type ToolCall } from './types.ts';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: number;
  maxTokens?: number;
  reasoningEffort?: string | undefined;
  label?: string;
  fetchImpl?: typeof fetch;
}

interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: RawToolCall[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

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
/** Ollama 在模型冷加载时返回 finish_reason=load 且没有内容，这类等待不计入失败重试。 */
const MAX_LOAD_WAITS = 3;

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
  }
  if (message.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: message.content ?? '' };
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire['tool_calls'] = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return wire;
  }
  return { role: message.role, content: message.content ?? '' };
}

function normalizeToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  if (!raw) return [];
  return raw.map((call, index) => ({
    id: call.id ?? `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
    name: call.function?.name ?? '',
    arguments: call.function?.arguments ?? '{}',
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI 兼容端点。Ollama Cloud 也走这套协议。
 * 真实调用失败一律抛错，不做任何降级或伪造结果。
 */
export class OpenAICompatibleModel implements ModelClient {
  readonly kind = 'real' as const;
  readonly label: string;
  /** 实际发出的 HTTP 尝试次数（含 load 与 5xx 的内部重试），与 chat() 调用次数不同。 */
  httpAttempts = 0;
  private readonly options: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.label = options.label ?? `openai:${options.baseUrl}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: ChatRequest): Promise<StepResult> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      stream: false,
    };
    if (request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (this.options.maxTokens) body['max_tokens'] = this.options.maxTokens;
    const effort = request.reasoningEffort ?? this.options.reasoningEffort;
    if (effort) body['reasoning_effort'] = effort;

    // 排查用：设置 MODEL_DUMP_DIR 后，把每次实际发送的请求体落盘（不含密钥）。
    const dumpDir = process.env['MODEL_DUMP_DIR'];
    if (dumpDir) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(dumpDir, { recursive: true });
      const roles = request.messages.map((message) => message.role).join(',');
      const name = `${Date.now()}-${request.messages.length}-${roles.replace(/[^a-z,]/g, '')}.json`;
      writeFileSync(join(dumpDir, name), JSON.stringify(body, null, 2), 'utf8');
    }

    const maxAttempts = Math.max(0, this.options.retry) + 1;
    let attempt = 0;
    let loadWaits = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      this.httpAttempts += 1;
      await gate.acquire();
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        const text = await response.text();
        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status);
          const error = new ModelError(`模型接口返回 ${response.status}`, {
            status: response.status,
            body: text.slice(0, 800),
          });
          if (retryable && attempt < maxAttempts - 1) {
            lastError = error;
            attempt += 1;
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw error;
        }

        let json: RawResponse;
        try {
          json = JSON.parse(text) as RawResponse;
        } catch {
          throw new ModelError('模型响应不是合法 JSON', { status: response.status, body: text.slice(0, 800) });
        }
        if (json.error) {
          throw new ModelError(`模型接口报错：${json.error.message ?? '未知错误'}`, {
            status: response.status,
            body: text.slice(0, 800),
          });
        }

        const choice = json.choices?.[0];
        if (!choice?.message) {
          throw new ModelError('模型响应缺少 choices[0].message', { status: response.status, body: text.slice(0, 800) });
        }

        // Ollama 冷加载：没有内容也没有用法统计，等模型就绪后重试。
        if (choice.finish_reason === 'load') {
          loadWaits += 1;
          if (loadWaits <= MAX_LOAD_WAITS) {
            await sleep(1_500 * loadWaits);
            continue;
          }
          throw new ModelError('模型长时间处于加载状态（finish_reason=load），请稍后重试', {
            status: response.status,
            retryable: true,
          });
        }

        const message = choice.message;
        const toolCalls = normalizeToolCalls(message.tool_calls);
        const content = message.content ?? null;
        if ((content === null || content.trim() === '') && toolCalls.length === 0) {
          const reasoning = message.reasoning ?? message.reasoning_content ?? '';
          const detail =
            `模型既没有输出文本也没有工具调用` +
            `（finish_reason=${choice.finish_reason ?? 'unknown'}，reasoning ${reasoning.length} 字符）`;
          if (attempt < maxAttempts - 1) {
            lastError = new ModelError(detail, { status: response.status });
            attempt += 1;
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw new ModelError(detail, { status: response.status, body: text.slice(0, 800) });
        }
        return {
          text: content,
          reasoning: message.reasoning ?? message.reasoning_content ?? null,
          toolCalls,
          finishReason: choice.finish_reason ?? 'unknown',
          model: json.model ?? request.model,
          usage: json.usage
            ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
            : null,
        };
      } catch (error) {
        const isAbort = error instanceof Error && error.name === 'TimeoutError';
        const isNetwork = error instanceof TypeError;
        if ((isAbort || isNetwork) && attempt < maxAttempts - 1) {
          lastError = error;
          attempt += 1;
          await sleep(400 * 2 ** attempt);
          continue;
        }
        if (error instanceof ModelError) throw error;
        throw new ModelError(isAbort ? `模型调用超时（>${this.options.timeoutMs}ms）` : '模型调用失败', {
          status: null,
          body: null,
          cause: error,
        });
      } finally {
        gate.release();
      }
    }

    throw lastError instanceof ModelError ? lastError : new ModelError('模型调用重试耗尽', { cause: lastError });
  }
}
