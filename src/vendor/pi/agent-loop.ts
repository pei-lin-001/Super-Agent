/**
 * 移植自 pi @earendil-works/pi-coding-agent@1.5.0
 * 原文件：packages/agent-core/dist/agent-loop.js
 *
 * 与上游的差异：
 * - 去掉 pi-ai 的身份/归因字段（mergeClientIdentity、PI_ATTRIBUTION），宿主不需要
 * - 去掉 beforeToolCall/afterToolCall 钩子与参数 schema 校验（工具层自己解析 JSON 并给出可读错误）
 * - `executeToolCalls` 是改写而非删减：上游拆成 sequential/parallel 两个版本 + 独立的
 *   `prepareToolCall` / `executePreparedToolCall` / `finalizeExecutedToolCall` / `shouldTerminateToolBatch`
 *   一整组函数，这里内联成「一个 for 循环按顺序跑」，因此没有并行分支。
 *
 * 控制流骨架与上游逐函数比对（11 个同名函数）：其余 8 个完全一致，仅
 * `runLoop`（while→for）与 `streamAssistantResponse`（一处 await 提前到 result 分支）有形态差异，
 * 语义未变。比对脚本与本轮核对结论见 work/task_7c3fac59/。
 *
 * 保留：内外双层循环、steering/follow-up 队列、prepareNextTurn（compaction 挂载点）、
 * finishTurn 决策、事件流、输出被 token 上限截断时整批工具调用失败。
 */
import { EventStream } from './event-stream.ts';
import {
  getCurrentTools,
  getToolStateChanges,
  normalizeContext,
  toToolDeclaration,
} from './transcript.ts';
import type {
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ToolCall,
  ToolDeclaration,
  ToolResultMessage,
} from './types.ts';

export interface StreamFn {
  (context: { messages: AgentMessage[] }, options: { signal?: AbortSignal; thinkingLevel?: string }): AsyncIterable<AssistantMessageEvent> & {
    result(): Promise<AssistantMessage>;
  };
}

export interface AgentLoopConfig {
  model: string;
  /** 把内部消息转成模型可接受的消息；每轮调用一次。 */
  convertToLlm: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  /** 在转换前整体改写上下文。 */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** 下一轮开始前（compaction 就在这里做）。 */
  prepareNextTurn?: (
    turn: CompletedTurn,
  ) => Promise<{ context?: Context; messages?: AgentMessage[]; model?: string; thinkingLevel?: string } | undefined> | undefined;
  prepareRequest?: (
    input: { context: Context; model: string; thinkingLevel: string },
    signal?: AbortSignal,
  ) => Promise<{ context?: Context; model?: string; thinkingLevel?: string } | undefined> | undefined;
  finishTurn?: (turn: CompletedTurn, signal?: AbortSignal) => Promise<{ action: 'end' | 'continue' } | undefined> | undefined;
  getSteeringMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  getFollowUpMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  thinkingLevel?: string;
  /** 执行一次工具调用；宿主负责鉴权、落库、错误包装。 */
  executeToolCall: (input: {
    toolCall: ToolCall;
    assistantMessage: AssistantMessage;
    signal?: AbortSignal;
    emit: AgentEventSink;
  }) => Promise<ToolResultMessage>;
}

export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: Context;
  newMessages: AgentMessage[];
}

const NO_CHANGES = { toolsAdded: [] as ToolDeclaration[], toolsRemoved: [] as { name: string }[] };

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === 'agent_end',
    (event) => (event.type === 'agent_end' ? (event['messages'] as AgentMessage[]) : []),
  );
}

/** 开一轮新的 agent 循环。 */
export function agentLoop(
  prompts: AgentMessage[],
  context: Context,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void runAgentLoop(prompts, context, config, async (event) => stream.push(event), signal, streamFn).then(
    (messages) => stream.end(messages),
  );
  return stream;
}

/** 从现有上下文继续，不追加新的用户消息（重试、续接用）。 */
export function agentLoopContinue(
  context: Context,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) throw new Error('Cannot continue: no messages in context');
  if (context.messages[context.messages.length - 1]?.role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }
  const stream = createAgentStream();
  void runAgentLoopContinue(context, config, async (event) => stream.push(event), signal, streamFn).then(
    (messages) => stream.end(messages),
  );
  return stream;
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: Context,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const initialMessages = declareToolChanges(context, prompts);
  const newMessages: AgentMessage[] = [...initialMessages];
  const currentContext: Context = { ...context, messages: [...context.messages, ...initialMessages] };

  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  for (const message of initialMessages) {
    await emit({ type: 'message_start', message });
    await emit({ type: 'message_end', message });
  }
  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

export async function runAgentLoopContinue(
  context: Context,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) throw new Error('Cannot continue: no messages in context');
  if (context.messages[context.messages.length - 1]?.role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }
  const newMessages: AgentMessage[] = [];
  const currentContext: Context = { ...context };
  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/** 主循环：内层处理工具调用与 steering，外层处理 follow-up。 */
async function runLoop(
  initialContext: Context,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let lastCompletedTurn: CompletedTurn | undefined;
  let explicitContinuation = false;

  let pendingMessages = (await config.getSteeringMessages?.()) ?? [];

  for (;;) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      let preparedMessages: AgentMessage[] = [];
      if (lastCompletedTurn) {
        const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
        if (nextTurnSnapshot) {
          currentContext = nextTurnSnapshot.context ?? currentContext;
          preparedMessages = nextTurnSnapshot.messages ?? [];
          config = {
            ...config,
            model: nextTurnSnapshot.model ?? config.model,
            thinkingLevel:
              nextTurnSnapshot.thinkingLevel === undefined ? config.thinkingLevel : nextTurnSnapshot.thinkingLevel,
          };
        }
        if (pendingMessages.length === 0) {
          pendingMessages = (await config.getSteeringMessages?.()) ?? [];
        }
        await emit({ type: 'turn_start' });
      }

      for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
        await emit({ type: 'message_start', message });
        await emit({ type: 'message_end', message });
        currentContext.messages.push(message);
        newMessages.push(message);
      }
      pendingMessages = [];

      const requestUpdate = await config.prepareRequest?.(
        { context: currentContext, model: config.model, thinkingLevel: config.thinkingLevel ?? 'off' },
        signal,
      );
      if (requestUpdate) {
        currentContext = requestUpdate.context ?? currentContext;
        config = {
          ...config,
          model: requestUpdate.model ?? config.model,
          thinkingLevel: requestUpdate.thinkingLevel === undefined ? config.thinkingLevel : requestUpdate.thinkingLevel,
        };
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
      newMessages.push(message);

      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        lastCompletedTurn = { message, toolResults: [], context: currentContext, newMessages };
        await config.finishTurn?.(lastCompletedTurn, signal);
        await emit({ type: 'turn_end', message, toolResults: [] });
        await emit({ type: 'agent_end', messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter((content): content is ToolCall => content.type === 'toolCall');
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        // 输出被 token 上限截断时，工具参数可能被静默截掉，不能执行。
        const batch =
          message.stopReason === 'length'
            ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
            : await executeToolCalls(currentContext, message, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = true;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      lastCompletedTurn = { message, toolResults, context: currentContext, newMessages };
      const decision = await config.finishTurn?.(lastCompletedTurn, signal);
      await emit({ type: 'turn_end', message, toolResults });

      if (decision?.action === 'end') {
        await emit({ type: 'agent_end', messages: newMessages });
        return;
      }
      explicitContinuation = decision?.action === 'continue';

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
      if (hasMoreToolCalls || pendingMessages.length > 0) explicitContinuation = false;
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      explicitContinuation = false;
      pendingMessages = followUpMessages;
      continue;
    }
    if (explicitContinuation) {
      explicitContinuation = false;
      continue;
    }
    break;
  }

  await emit({ type: 'agent_end', messages: newMessages });
}

/**
 * 把工具集合的变化写成 system 消息声明给模型。
 * `context.tools` 是宿主能执行的集合；transcript 的 system 消息声明模型能调的集合。
 */
function declareToolChanges(context: Context, pendingMessages: AgentMessage[]): AgentMessage[] {
  let systemIndex = -1;
  for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
    if (pendingMessages[index]?.role === 'system') {
      systemIndex = index;
      break;
    }
  }
  const pending = systemIndex >= 0 ? pendingMessages[systemIndex] : undefined;
  const baseline = pending
    ? pendingMessages.map((message, index) => (index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message))
    : pendingMessages;

  const changes = getToolStateChanges(
    getCurrentTools([...context.messages, ...baseline]),
    (context.tools ?? []).map(toToolDeclaration),
  );
  const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

  if (pending) {
    const declared = 'toolsAdded' in pending || 'toolsRemoved' in pending;
    if (unchanged && !declared) return pendingMessages;
    return baseline.map((message, index) =>
      index === systemIndex ? withToolChanges(pending, changes) : message,
    );
  }
  if (unchanged) return pendingMessages;

  const update: AgentMessage = {
    role: 'system',
    content: '',
    timestamp: Date.now(),
    ...(changes.toolsAdded.length > 0 ? { toolsAdded: changes.toolsAdded } : {}),
    ...(changes.toolsRemoved.length > 0 ? { toolsRemoved: changes.toolsRemoved } : {}),
  };
  const insertAt = pendingMessages.findIndex((message) => message.role !== 'system');
  const index = insertAt === -1 ? pendingMessages.length : insertAt;
  return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

function withToolChanges(
  message: AgentMessage,
  changes: { toolsAdded: ToolDeclaration[]; toolsRemoved: { name: string }[] },
): AgentMessage {
  const { ...rest } = message as AgentMessage & { toolsAdded?: unknown; toolsRemoved?: unknown };
  delete (rest as { toolsAdded?: unknown }).toolsAdded;
  delete (rest as { toolsRemoved?: unknown }).toolsRemoved;
  return {
    ...rest,
    ...(changes.toolsAdded.length > 0 ? { toolsAdded: changes.toolsAdded } : {}),
    ...(changes.toolsRemoved.length > 0 ? { toolsRemoved: changes.toolsRemoved } : {}),
  } as AgentMessage;
}

/** 请求模型并流式收集助手消息。 */
async function streamAssistantResponse(
  context: Context,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<AssistantMessage> {
  let messages = context.messages;
  if (config.transformContext) messages = await config.transformContext(messages, signal);

  const llmMessages = await config.convertToLlm(messages);
  const llmContext = normalizeContext({ messages: llmMessages });

  const response = await streamFunction(llmContext as unknown as { messages: AgentMessage[] }, {
    signal,
    thinkingLevel: config.thinkingLevel,
  });
  const result = async (): Promise<AssistantMessage> => {
    const message = await response.result();
    return { ...message, thinkingLevel: config.thinkingLevel ?? 'off' };
  };

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: 'message_start', message: { ...partialMessage } });
        break;
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: 'message_update',
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;
      case 'done':
      case 'error': {
        const finalMessage = await result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) await emit({ type: 'message_start', message: { ...finalMessage } });
        await emit({ type: 'message_end', message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = await result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: 'message_start', message: { ...finalMessage } });
  }
  await emit({ type: 'message_end', message: finalMessage });
  return finalMessage;
}

/** 被输出上限截断的助手消息，其工具调用一律不执行。 */
async function failToolCallsFromTruncatedMessage(
  toolCalls: ToolCall[],
  emit: AgentEventSink,
): Promise<{ messages: ToolResultMessage[] }> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const toolResultMessage: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: 'text',
          text:
            `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, ` +
            'so its arguments may be truncated. Re-issue the tool call with complete arguments.',
        },
      ],
      isError: true,
      timestamp: Date.now(),
    };
    await emit({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: toolCall.name, isError: true });
    await emit({ type: 'message_start', message: toolResultMessage });
    await emit({ type: 'message_end', message: toolResultMessage });
    messages.push(toolResultMessage);
  }
  return { messages };
}

async function executeToolCalls(
  _context: Context,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ messages: ToolResultMessage[] }> {
  const toolCalls = assistantMessage.content.filter((content): content is ToolCall => content.type === 'toolCall');
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    let toolResultMessage: ToolResultMessage;
    if (signal?.aborted) {
      toolResultMessage = {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: 'Operation aborted' }],
        isError: true,
        timestamp: Date.now(),
      };
    } else {
      toolResultMessage = await config.executeToolCall({ toolCall, assistantMessage, signal, emit });
    }
    await emit({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: toolResultMessage.isError,
    });
    await emit({ type: 'message_start', message: toolResultMessage });
    await emit({ type: 'message_end', message: toolResultMessage });
    messages.push(toolResultMessage);
    if (signal?.aborted) break;
  }

  return { messages };
}

