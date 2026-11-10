/**
 * 决策模型客户端：`clef:27b` 这类只做分类的模型。
 *
 * 和 chat 模型完全不同的接口。走 `/v1/chat/completions` 会直接报错：
 *   "clef:27b is a decision model and only supports /v1/systemone"
 *
 * 形状（实测，2026-11-10）：
 *   请求 { model, state, questions: { <id>: { instructions, type: "choice", criteria: {值: 说明} } } }
 *   响应 { answers: { <id>: { type, choice, confidence, probabilities } }, usage: { input_tokens, output_tokens } }
 *
 * 为什么值得单独写一个客户端：它返回概率分布而不是一段文本。有了 confidence
 * 就能设闸门——不确定时问用户或新建空间，而不是让模型硬猜一个。
 */

export interface DecisionChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface DecisionRequest {
  model: string;
  /** 待判定的对象，纯文本。 */
  state: string;
  /** 给判定模型的指令，说清判据。 */
  instructions: string;
  /** 候选值 → 说明。键会被原样返回。 */
  criteria: Record<string, string>;
  signal?: AbortSignal | null;
}

export class DecisionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  readonly label: string;

  constructor(options: { baseUrl: string; apiKey: string; timeoutMs?: number; label?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.label = options.label ?? `decision:${this.baseUrl}`;
  }

  /**
   * 选一个候选项。
   *
   * 失败抛错，不返回兜底值——上游要能区分「模型说 X」和「模型没答上来」。
   */
  async choose(request: DecisionRequest): Promise<DecisionChoice> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const outer = request.signal;
    const onAbort = (): void => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetch(`${this.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          state: request.state,
          questions: {
            pick: {
              instructions: request.instructions,
              type: 'choice',
              criteria: request.criteria,
            },
          },
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`决策模型返回 ${response.status}：${text.slice(0, 200)}`);
      }
      let parsed: {
        answers?: { pick?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new Error(`决策模型返回的不是 JSON：${text.slice(0, 200)}`);
      }
      const answer = parsed.answers?.pick;
      const choice = typeof answer?.choice === 'string' ? answer.choice : String(answer?.choice ?? '');
      if (choice === '' || choice === 'undefined' || choice === 'null') {
        throw new Error(`决策模型没有选出结果：${text.slice(0, 200)}`);
      }
      const probabilities: Record<string, number> = {};
      if (answer?.probabilities && typeof answer.probabilities === 'object') {
        for (const [key, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
          const num = typeof value === 'number' ? value : Number(value);
          if (Number.isFinite(num)) probabilities[key] = num;
        }
      }
      return {
        choice,
        confidence: typeof answer?.confidence === 'number' ? answer.confidence : 0,
        probabilities,
        usage:
          parsed.usage && typeof parsed.usage.input_tokens === 'number'
            ? {
                inputTokens: parsed.usage.input_tokens,
                outputTokens: Number(parsed.usage.output_tokens ?? 0),
              }
            : null,
      };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }
}

/** 置信度闸门：低于阈值就不要用这个答案。 */
export function shouldTrust(confidence: number, threshold = 0.6): boolean {
  return Number.isFinite(confidence) && confidence >= threshold;
}
