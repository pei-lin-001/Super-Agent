/**
 * pi agent-loop 与本项目的衔接层。
 *
 * 只做四件事，业务判断全部留在 Runtime：
 * 1. 把我们存的历史（ChatMessage 形状）转成 pi 的 AgentMessage
 * 2. 把 pi 的 StreamFn 接到现有 ModelClient
 * 3. 把 pi 的工具调用接到现有 ToolRegistry
 * 4. 把 pi 的事件流折成「这一步有没有结果」的信号
 */
import type { ChatMessage, ModelClient, ToolSchema } from '../model/types.ts';
import type { ToolOutcome } from '../tools/types.ts';
import { runAgentLoop, type AgentLoopConfig, type StreamFn } from '../vendor/pi/agent-loop.ts';
import { EventStream } from '../vendor/pi/event-stream.ts';
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  StopReason,
  ToolCall as PiToolCall,
  ToolDeclaration,
  ToolResultMessage,
} from '../vendor/pi/types.ts';

export type TurnStop = 'wait' | 'finish' | 'steps' | 'cancelled' | 'error';

export interface ToolRunResult {
  outcome: ToolOutcome;
  /** 该调用是否让本轮立刻结束（等待或提交）。 */
  terminate: boolean;
}

export interface WorkerTurnInput {
  model: string;
  modelClient: ModelClient;
  /** 已经渲染好的 system 提示。 */
  systemPrompt: string;
  /** 本轮开头的用户消息（开题语/收件箱消息）。 */
  prompts: ChatMessage[];
  /** 之前的历史。 */
  history: ChatMessage[];
  tools: ToolSchema[];
  /** 单轮调度最多几步。 */
  maxSteps: number;
  signal: AbortSignal | null;
  /** 执行一次工具；返回业务结果与是否终止本轮。 */
  runTool: (call: { id: string; name: string; arguments: string }) => Promise<ToolRunResult>;
  /** 每完成一次模型调用（=一步）。有工具调用时在动手之前触发。 */
  onStep?: (message: AssistantMessage) => void;
  /** 工具调用触发终止（等待/提交）时，报告同一条消息里还没执行的调用。 */
  onTerminate?: (rest: { id: string; name: string; arguments: string }[], reason: string) => void;
  /** 发请求前的资格检查；返回非空字符串表示不再继续，内容是原因。 */
  canContinue?: () => string | null;
  /**
   * 只输出文本、没有工具调用时是否结束本轮并进入等待。
   * 协作者适用：它没有活干就是在等下一步，不该空转到把步数耗完。
   */
  stopOnPlainText?: boolean;
  /**
   * 拉取新到的消息（协作者回复、Router 指令）。
   * 每轮开始前调用一次，和原循环"每步先注入收件箱"的语义一致。
   */
  pullInbox?: () => ChatMessage[];
  reasoningEffort?: string;
}

export interface WorkerTurnResult {
  stop: TurnStop;
  reason?: string;
  /** 本轮的助手文本（最后一条）。 */
  assistantText: string | null;
  steps: number;
}

/** ChatMessage → pi 的消息。 */
export function toAgentMessages(messages: ChatMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      // 带图时按 pi 的多模态形状给：字符串 + 图片块分开，内核转 wire 时再合并。
      out.push({
        role: 'user',
        content:
          message.images && message.images.length > 0
            ? [
                ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
                ...message.images.map((image) => ({
                  type: 'image' as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              ]
            : message.content ?? '',
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'toolCall',
          id: call.id,
          name: call.name,
          arguments: parseArguments(call.arguments),
        });
      }
      out.push({
        role: 'assistant',
        content,
        model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: message.toolCalls && message.toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role !== 'tool') continue;
    out.push({
      role: 'toolResult',
      toolCallId: message.toolCallId ?? '',
      // pi 用 toolName 做事件标注，本地历史只存 toolCallId；留空不影响配对。
      toolName: '',
      content: [{ type: 'text', text: message.content ?? '' }],
      // 必须透传：恒置 false 会让失败的工具结果在回放时变成成功。
      isError: message.isError ?? false,
      timestamp: Date.now(),
    });
  }
  return out;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 参数不是合法 JSON：交给工具层报可读错误，这里给空对象。
  }
  return {};
}

/** 把 pi 的消息渲染成发给模型的 ChatMessage（system 单独返回）。 */
export function toLlmMessages(messages: AgentMessage[]): { system: string; chat: ChatMessage[] } {
  const systemParts: string[] = [];
  const chat: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content.length > 0) systemParts.push(message.content);
      for (const section of Object.values(message.sections ?? {})) {
        if (section) systemParts.push(section);
      }
      continue;
    }
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : textOf(message.content);
      const images = typeof message.content === 'string'
        ? []
        : message.content
            .filter((block): block is { type: 'image'; data: string; mimeType: string } => block.type === 'image')
            .map((block) => ({ mimeType: block.mimeType, data: block.data }));
      chat.push({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = message.content
        .filter((block): block is PiToolCall => block.type === 'toolCall')
        .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }));
      chat.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (message.role !== 'toolResult') continue;
    const text = textOf(message.content);
    // 模型侧 tool 消息只有 content，失败状态只能落在文本上；
    // 内容里已经写了「失败 / 未执行」的不重复加前缀。
    const flagged =
      message.isError && !/失败|未执行|不可用|拒绝/.test(text) ? `[执行失败] ${text}` : text;
    chat.push({
      role: 'tool',
      content: flagged,
      toolCallId: message.toolCallId,
      ...(message.isError ? { isError: true } : {}),
    });
  }
  return { system: systemParts.join('\n\n'), chat };
}

function textOf(content: { type: string; text?: string }[] | string): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** 把现有 ModelClient 包装成 pi 的 StreamFn。 */
export function makeStreamFn(
  modelClient: ModelClient,
  tools: ToolSchema[],
  model: string,
  reasoningEffort?: string,
): StreamFn {
  return (context, options) => {
    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message;
        if (event.type === 'error') return event.error;
        throw new Error('Unexpected event type');
      },
    );

    void (async () => {
      const timestamp = Date.now();
      const empty: AssistantMessage = {
        role: 'assistant',
        content: [],
        model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'pending',
        timestamp,
      };
      try {
        const { system, chat } = toLlmMessages(context.messages as AgentMessage[]);
        const result = await modelClient.chat({
          model,
          messages: [{ role: 'system', content: system }, ...chat],
          tools,
          reasoningEffort,
          signal: options.signal ?? null,
        });
        const content: AssistantMessage['content'] = [];
        if (result.text) content.push({ type: 'text', text: result.text });
        for (const call of result.toolCalls) {
          content.push({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: parseArguments(call.arguments),
          });
        }
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          model: result.model,
          usage: {
            input: result.usage?.promptTokens ?? 0,
            output: result.usage?.completionTokens ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          stopReason: mapStopReason(result.finishReason),
          timestamp,
        };
        stream.push({ type: 'start', partial: { ...empty } });
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      } catch (error) {
        const aborted = options.signal?.aborted === true;
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          model: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: aborted ? 'aborted' : 'error',
          errorMessage: (error as Error).message,
          timestamp,
        };
        stream.push({ type: 'start', partial: { ...empty } });
        stream.push({ type: 'error', reason: message.stopReason, error: message });
        stream.end(message);
      }
    })();

    return stream;
  };
}

function mapStopReason(finishReason: string): StopReason {
  const value = finishReason.toLowerCase();
  if (value.includes('length') || value.includes('max_tokens')) return 'length';
  if (value.includes('tool')) return 'toolUse';
  if (value.includes('abort') || value.includes('cancel')) return 'aborted';
  if (value.includes('error')) return 'error';
  return 'stop';
}

/**
 * 用 pi 的 agent-loop 跑一轮 Worker 调度。
 *
 * 返回 stop 表示这一轮为什么停下：等待依赖、已提交、步数用完、被取消。
 */
export async function runWorkerTurn(input: WorkerTurnInput): Promise<WorkerTurnResult> {
  const context: Context = {
    // system 提示作为第一条消息进 transcript：agent-loop 只在工具集合变化时才插入
    // system 消息，提示本身必须由宿主提供，否则模型根本收不到角色说明。
    messages: [
      { role: 'system', content: input.systemPrompt, timestamp: 0 },
      ...toAgentMessages(input.history),
      ...toAgentMessages(input.prompts),
    ],
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };

  let stop: TurnStop = 'steps';
  let reason: string | undefined;
  let steps = 0;
  let assistantText: string | null = null;
  const controller = new AbortController();
  const outer = input.signal;
  const onAbort = (): void => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }

  const stopWith = (next: TurnStop, why?: string): void => {
    stop = next;
    reason = why;
    controller.abort();
  };

  // 步数 = 模型调用次数。工具执行可能改变任务终态（提交），所以必须在动手之前计，
  // 否则最后一轮会被"任务已完成"挡住而不计数。
  let steppedMessage: AssistantMessage | null = null;
  const ensureStep = (message: AssistantMessage): void => {
    if (steppedMessage === message) return;
    steppedMessage = message;
    steps += 1;
    input.onStep?.(message);
  };

  const config: AgentLoopConfig = {
    model: input.model,
    convertToLlm: (messages) => messages,
    executeToolCall: async ({ toolCall, assistantMessage }) => {
      // 每步之前再核一次资格：暂停/取消之后旧响应不得继续执行。
      const blocked = input.canContinue?.();
      if (blocked) {
        stopWith('cancelled', blocked);
        return toolResultMessage(toolCall, `未执行：${blocked}`, true);
      }
      ensureStep(assistantMessage);
      const executed = await input.runTool({
        id: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      });
      if (executed.terminate) {
        // 同一批里后面的调用没有结果，必须留下明确记录，否则历史里会出现无结果的 tool_call。
        const rest = assistantMessage.content
          .filter((block): block is PiToolCall => block.type === 'toolCall')
          .slice(
            assistantMessage.content
              .filter((block): block is PiToolCall => block.type === 'toolCall')
              .findIndex((block) => block.id === toolCall.id) + 1,
          )
          .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }));
        if (rest.length > 0) input.onTerminate?.(rest, executed.outcome.content);
        stopWith(executed.outcome.type as TurnStop, executed.outcome.content);
      }
      return toolResultMessage(
        toolCall,
        executed.outcome.content,
        executed.outcome.type === 'failed',
      );
    },
    finishTurn: async (turn) => {
      // 模型层报错/被取消要如实反映，不能当成"步数用完"。
      if (turn.message.stopReason === 'error') {
        stopWith('error', turn.message.errorMessage ?? '模型调用失败');
        return { action: 'end' as const };
      }
      if (turn.message.stopReason === 'aborted') {
        stopWith('cancelled', turn.message.errorMessage ?? '执行被取消');
        return { action: 'end' as const };
      }
      const text = turn.message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text.length > 0) assistantText = text;
      ensureStep(turn.message);
      const blocked = input.canContinue?.();
      if (blocked) {
        stopWith('cancelled', blocked);
        return { action: 'end' as const };
      }
      if (input.stopOnPlainText && turn.toolResults.length === 0) {
        stopWith('wait', '只输出了文本，没有工具调用，等待下一步');
        return { action: 'end' as const };
      }
      if (stop !== 'steps' || steps >= input.maxSteps) return { action: 'end' as const };
      return undefined;
    },
    // 每轮开始前把新到的消息注入对话：协作者的回复不能等到下一轮调度才看见。
    getSteeringMessages: () => toAgentMessages(input.pullInbox?.() ?? []),
  };

  try {
    await runAgentLoop(
      [],
      context,
      config,
      () => undefined,
      controller.signal,
      makeStreamFn(input.modelClient, input.tools, input.model, input.reasoningEffort),
    );
  } catch (error) {
    return { stop: 'error', reason: (error as Error).message, assistantText, steps };
  } finally {
    outer?.removeEventListener('abort', onAbort);
  }

  if (outer?.aborted && stop === 'steps') return { stop: 'cancelled', reason: '执行被取消', assistantText, steps };
  return { stop, reason, assistantText, steps };
}

function toolResultMessage(
  call: PiToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

/** pi 的 AssistantMessage → 本项目的 StepResult（落库与诊断用）。 */
export function toStepResult(message: AssistantMessage): {
  text: string | null;
  reasoning: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
} {
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const reasoning = message.content
    .filter((block): block is { type: 'thinking'; thinking: string } => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('');
  return {
    text: text.length > 0 ? text : null,
    reasoning: reasoning.length > 0 ? reasoning : null,
    toolCalls: message.content
      .filter((block): block is PiToolCall => block.type === 'toolCall')
      .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) })),
    finishReason: message.stopReason,
    model: message.model,
    usage:
      message.usage.input === 0 && message.usage.output === 0
        ? null
        : { promptTokens: message.usage.input, completionTokens: message.usage.output },
  };
}
