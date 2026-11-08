import { ModelError, type ChatRequest, type ModelClient, type StepResult } from './types.ts';

export interface MockContext {
  /** 第几次调用（从 0 开始），跨全部角色累计。 */
  callIndex: number;
  request: ChatRequest;
}

/** 返回 StepResult，或抛出 ModelError 模拟失败。 */
export type MockHandler = (context: MockContext) => StepResult | Promise<StepResult>;

export interface MockReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> | string }[];
  finishReason?: string;
  model?: string;
}

/** 便捷构造：把对象参数序列化成工具调用。 */
export function mockReply(reply: MockReply): StepResult {
  return {
    text: reply.text ?? null,
    reasoning: reply.reasoning ?? null,
    toolCalls: (reply.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
    })),
    finishReason: reply.finishReason ?? ((reply.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'),
    model: reply.model ?? 'mock-model',
    usage: null,
  };
}

export function mockError(message: string): never {
  throw new ModelError(message, { status: 500, body: null });
}

/**
 * 测试专用。只允许在测试或显式 MODEL_PROVIDER=mock 时注入，
 * 真实运行路径不会回退到它。
 */
export class MockModel implements ModelClient {
  readonly kind = 'mock' as const;
  readonly label = 'mock';
  readonly calls: ChatRequest[] = [];
  private readonly handler: MockHandler;

  constructor(handler: MockHandler) {
    this.handler = handler;
  }

  async chat(request: ChatRequest): Promise<StepResult> {
    const callIndex = this.calls.length;
    this.calls.push(structuredClone(request));
    return this.handler({ callIndex, request });
  }

  /** 断言用：所有调用里出现的工具名序列。 */
  toolNameSequence(): string[] {
    return this.calls.flatMap((call) => {
      const last = call.messages.at(-1);
      if (last?.role === 'tool') return [`tool_result:${last.content?.slice(0, 20) ?? ''}`];
      return [];
    });
  }
}
