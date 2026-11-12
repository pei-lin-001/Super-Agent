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
import { validPiAssistant } from '../model/pi.ts';
import { compile } from '@earendil-works/pi-schema';
import { formats } from '@earendil-works/pi-schema/formats';
import type { ToolOutcome } from '../tools/types.ts';
import { runAgentLoop, type AgentLoopConfig, type AgentContext, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { compactionTrigger } from './window.ts';
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type StopReason, type ToolCall as PiToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** 工具执行前严格校验原始值，避免官方默认类型转换改变业务语义。 */
export function strictToolArguments(tool: ToolSchema): (args: unknown) => Record<string, unknown> {
  const validator = compile(tool.parameters, { formats, unresolvedRefs: 'reject' });
  return (args) => {
    const result = validator.validate(args);
    if (!result.ok) throw new Error(`工具 ${tool.name} 参数校验失败：${result.errors.map((error) => `${error.path || '/'} ${error.message}`).join('；')}`);
    return args as Record<string, unknown>;
  };
}

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
  /** 初始对话中需要在轮内裁剪时保留的消息位置。 */
  protectedMessageIndexes?: number[];
  tools: ToolSchema[];
  /** 单轮调度最多几步。 */
  maxSteps: number;
  signal: AbortSignal | null;
  /**
   * 一轮内部的上下文压缩（pi 的 prepareNextTurn 挂载点）。
   *
   * 外层在调用本函数之前已经按预算裁剪过一次；但一轮里可能跑几十步工具，
   * 上下文在轮内还会涨。pi 把这个位置留成挂载点，宿主不接就等于自动压缩不存在。
   */
  compaction?: {
    contextWindowTokens: number;
    reserveTokens: number;
    keepRecentTokens: number;
    /** 真实压缩发生时回调一次，给宿主记事件。 */
    onCompact?: (info: { beforeTokens: number; afterTokens: number; droppedMessages: number }) => void;
  };
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
      if (validPiAssistant(message.piMessage)) { out.push(message.piMessage); continue; }
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
        api: 'openai-completions', provider: 'super-agent',
        model: '',
        usage: emptyUsage(),
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
      content: [{ type: 'text', text: message.content ?? '' }, ...(message.images ?? []).map((image) => ({ type: 'image' as const, ...image }))],
      // 必须透传：恒置 false 会让失败的工具结果在回放时变成成功。
      isError: message.isError ?? false,
      timestamp: Date.now(),
    });
  }
  return out;
}

function parseArguments(raw: string): PiToolCall['arguments'] {
  try {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PiToolCall['arguments'];
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
        piMessage: message,
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (message.role !== 'toolResult') continue;
    const text = textOf(message.content);
    const images = message.content.filter((block) => block.type === 'image').map((block) => ({ mimeType: block.mimeType, data: block.data }));
    chat.push({ role: 'tool', content: text, toolCallId: message.toolCallId,
      ...(message.isError ? { isError: true } : {}), ...(images.length ? { images } : {}) });
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
  return (_model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const timestamp = Date.now();
      const empty: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: 'openai-completions', provider: 'super-agent',
        model: '',
        usage: emptyUsage(),
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
        const message: AssistantMessage = result.piMessage ?? {
          role: 'assistant',
          content,
          api: 'openai-completions', provider: 'super-agent',
          model: result.model,
          usage: {
            ...emptyUsage(),
            input: result.usage?.promptTokens ?? 0,
            output: result.usage?.completionTokens ?? 0,
            cacheRead: result.usage?.cacheReadTokens ?? 0,
            cacheWrite: result.usage?.cacheWriteTokens ?? 0,
          },
          stopReason: mapStopReason(result.finishReason),
          timestamp,
        };
        stream.push({ type: 'start', partial: { ...empty } });
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse' | 'deferred', message });
        stream.end(message);
      } catch (error) {
        const aborted = options.signal?.aborted === true;
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'openai-completions', provider: 'super-agent',
          model: '',
          usage: emptyUsage(),
          stopReason: aborted ? 'aborted' : 'error',
          errorMessage: (error as Error).message,
          timestamp,
        };
        stream.push({ type: 'start', partial: { ...empty } });
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
        stream.end(message);
      }
    })();

    return stream;
  };
}

/** 一条 pi 消息的字符数：文本、思考、工具参数、工具结果都要算。 */
function agentMessageChars(message: AgentMessage): number {
  const anyMessage = message as unknown as { content?: unknown; toolName?: string };
  const content = anyMessage.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item['type'] === 'text' && typeof item['text'] === 'string') chars += item['text'].length;
    else if (item['type'] === 'thinking' && typeof item['thinking'] === 'string') chars += item['thinking'].length;
    else if (item['type'] === 'toolCall') chars += JSON.stringify(item['arguments'] ?? {}).length + 32;
    else if (item['type'] === 'image') chars += 4800; // 与 pi 的 ESTIMATED_IMAGE_CHARS 一致
    else if (typeof item['text'] === 'string') chars += item['text'].length;
  }
  return chars;
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
  const context: AgentContext = {
    // system 提示作为第一条消息进 transcript：agent-loop 只在工具集合变化时才插入
    // system 消息，提示本身必须由宿主提供，否则模型根本收不到角色说明。
    messages: [
      { role: 'system', content: input.systemPrompt, timestamp: 0 },
      ...toAgentMessages(input.history),
      ...toAgentMessages(input.prompts),
    ],
    tools: [],
  };
  const protectedMessages = new Set((input.protectedMessageIndexes ?? []).map((index) => context.messages[index + 1]).filter((message): message is AgentMessage => message !== undefined));

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
  let currentAssistant: AssistantMessage | null = null;
  context.tools = input.tools.map((tool) => ({
    ...tool,
    label: tool.name,
    prepareArguments: strictToolArguments(tool),
    execute: async (id: string, args: Record<string, unknown>) => {
      const executed = await input.runTool({ id, name: tool.name, arguments: JSON.stringify(args) });
      if (executed.terminate) {
        const calls = currentAssistant?.content.filter((block): block is PiToolCall => block.type === 'toolCall') ?? [];
        const rest = calls.slice(calls.findIndex((call) => call.id === id) + 1)
          .map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }));
        if (rest.length > 0) input.onTerminate?.(rest, executed.outcome.content);
        stopWith(executed.outcome.type as TurnStop, executed.outcome.content);
      }
      return { content: [{ type: 'text' as const, text: executed.outcome.content },
        ...(executed.outcome.type === 'ok' ? (executed.outcome.images ?? []).map((image) => ({ type: 'image' as const, ...image })) : [])],
        details: undefined, isError: executed.outcome.type === 'failed', terminate: executed.terminate };
    },
  }));

  const config: AgentLoopConfig = {
    model: { id: input.model, name: input.model, api: 'openai-completions', provider: 'super-agent', baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: true, contextWindow: 200_000, maxTokens: 8192 },
    toolExecution: 'sequential',
    convertToLlm: (messages) => messages,
    // pi 的 compaction 挂载点。不接这个回调 = 自动压缩不存在，上下文只能靠
    // 外层在调用前裁一次，轮内涨上去就没人管。
    prepareNextTurn: async (turn) => {
      const rule = input.compaction;
      if (!rule) return undefined;
      const usage = turn.message.usage;
      if (!usage) return undefined;
      // usage 是实数：input 已扣缓存，要把命中部分加回来；output 会成为下一轮历史。
      const beforeTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      const trigger = compactionTrigger({
        contextWindowTokens: rule.contextWindowTokens,
        reserveTokens: rule.reserveTokens,
      });
      if (beforeTokens <= trigger) return undefined;

      const messages = turn.context.messages;
      const totalChars = messages.reduce((sum, message) => sum + agentMessageChars(message), 0);
      // 本段文本真实的「字符 / token」：中文约 1.7，英文约 4，用实测值而不是猜。
      const charsPerToken = totalChars > 0 ? totalChars / beforeTokens : 4;
      const budget = Math.max(1, rule.keepRecentTokens) * charsPerToken;

      // 从尾部往前累计到预算；切点必须落在 user 消息之前，
      // 否则会把 assistant 的 toolCall 和它的 toolResult 拆开，提供方直接拒收。
      let cut = messages.length;
      let keptChars = 0;
      while (cut > 0) {
        const chars = agentMessageChars(messages[cut - 1]!);
        if (keptChars + chars > budget && cut < messages.length) break;
        keptChars += chars;
        cut -= 1;
      }
      // 系统提示和本轮输入的身份、状态始终保留；只裁剪历史与工具往返。
      const systemCount = messages.findIndex((message) => message.role !== 'system');
      const floor = systemCount < 0 ? messages.length : systemCount;
      cut = Math.max(cut, floor);
      // 切点回退到最近的 user 消息之前（不含 system 区）。
      while (cut > floor && messages[cut - 1]?.role !== 'user') cut -= 1;
      if (cut <= floor) return undefined;

      const dropped = cut - floor;
      if (dropped <= 0) return undefined;
      const notice = {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text:
              `（系统压缩：本轮更早的 ${dropped} 条对话（含工具输出）已略去以控制请求体积。` +
              '需要细节用 history_search 定位、history_read 读原文。不要因为看不到就重做已经做完的事。）',
          },
        ],
        timestamp: Date.now(),
      };
      const preserved = messages.slice(floor, cut).filter((message) => protectedMessages.has(message));
      const next = [...messages.slice(0, floor), ...preserved, notice, ...messages.slice(cut)];
      const afterTokens = Math.ceil(next.reduce((sum, message) => sum + agentMessageChars(message), 0) / charsPerToken);
      rule.onCompact?.({ beforeTokens, afterTokens, droppedMessages: dropped });
      return { context: { ...turn.context, messages: next } };
    },
    beforeToolCall: async ({ toolCall, assistantMessage }) => {
      // 每步之前再核一次资格：暂停/取消之后旧响应不得继续执行。
      const blocked = input.canContinue?.();
      if (blocked) {
        stopWith('cancelled', blocked);
        return { block: true, reason: `未执行：${blocked}`, terminate: true };
      }
      currentAssistant = assistantMessage as unknown as AssistantMessage;
      ensureStep(currentAssistant);
      return undefined;
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
    getSteeringMessages: async () => toAgentMessages(input.pullInbox?.() ?? []) as never,
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
  images?: { mimeType: string; data: string }[],
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    // 图片块放在工具结果里：pi 的适配器会把它拆成「tool 文本 + 一条带 image_url 的
    // user 消息」，正是协议允许的形状。历史里只落 content 里的文字。
    content: [
      { type: 'text', text },
      ...(images ?? []).map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
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
  piMessage: AssistantMessage;
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
    piMessage: message,
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
