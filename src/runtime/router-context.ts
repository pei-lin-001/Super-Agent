/**
 * Router 的上下文装配：按 token 预算保留近期对话，超出的压进一份累计摘要。
 *
 * 和 Worker 的区别：Router 的历史只有 user/assistant 两种角色、没有工具结果，
 * 所以摘要不需要文件清单那套，只需要"用户说过什么、决定了什么、还没做什么"。
 *
 * 阈值与切点来自移植（见 window.ts）；摘要格式参照 pi / OpenClaw 的结构化小节。
 */
import { randomBytes } from 'node:crypto';
import type { Limits } from '../config.ts';
import type { RouterTurn } from '../domain/types.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { ChatMessage, ModelClient } from '../model/types.ts';
import type { Store } from '../storage/store.ts';
import { estimateTokens, planWindow } from './window.ts';

/** 装配结果：进上下文的近期对话 + 已覆盖部分的摘要。 */
export interface RouterContext {
  history: ChatMessage[];
  /** 上一份摘要（已覆盖的旧对话）。没有就是 null。 */
  note: string | null;
  /** 本次装配估算的 token。 */
  tokens: number;
  /** 需要生成新摘要时，这里是要压进摘要的对话。 */
  toSummarize: { turns: (RouterTurn & { seq: number })[]; fromSeq: number; toSeq: number } | null;
}

function charsOf(turn: RouterTurn): number {
  return turn.content.length;
}

/**
 * 装配 Router 的对话上下文。
 *
 * 水位线（已摘要到哪一条）来自 router_note；水位线之后、窗口之内的原文保留。
 */
export function planRouterContext(input: {
  store: Store;
  sessionKey: string | null;
  conversationId: string | null;
  limits: Limits;
}): RouterContext {
  const { store, sessionKey, conversationId, limits } = input;
  const note = store.latestRouterNote(conversationId, sessionKey);
  const coveredSeq = note?.coveredSeq ?? 0;
  const turns = store.listRouterTurnsSince(conversationId, sessionKey, coveredSeq);

  const plan = planWindow({
    items: turns.map((turn) => ({ turn, chars: charsOf(turn) })),
    keepRecentTokens: limits.routerKeepRecentTokens,
    contextWindowTokens: limits.contextWindowTokens,
    reserveTokens: limits.routerReserveTokens,
    // 真实 usage 当基准：纯字符估算对中文低估一倍以上，阈值会永远打不开。
    measuredTokens: store.measureContextTokens({ purpose: 'router', routerSessionKey: sessionKey, conversationId }),
  });

  const kept = plan.kept.map((item) => item.turn);
  const dropped = plan.dropped.map((item) => item.turn);
  const tokens = plan.keptTokens + estimateTokens((note?.content.length ?? 0));

  return {
    history: kept.map((turn): ChatMessage => ({ role: turn.role, content: turn.content, ...(turn.piMessage ? { piMessage: turn.piMessage } : {}) })),
    note: note?.content ?? null,
    tokens,
    toSummarize:
      plan.shouldCompact && dropped.length > 0
        ? {
            turns: dropped,
            fromSeq: dropped[0]!.seq,
            toSeq: dropped[dropped.length - 1]!.seq,
          }
        : null,
  };
}

/** 摘要提示：保留事实、决定、未完成项，不编造、不续聊。 */
export function buildRouterNotePrompt(input: {
  previous: string | null;
  turns: RouterTurn[];
  maxChars: number;
}): ChatMessage[] {
  const body = input.turns
    .map((turn) => `[${turn.role === 'user' ? '用户' : 'Router'}] ${turn.content}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: 'Maintain a traceable conversation note for the Super-Agent Router. It will replace older visible dialogue; do not invent facts or continue the conversation.',
    },
    {
      role: 'user',
      content: `# Previous note
${input.previous ?? '(first note)'}

# New conversation
${body}

# Output
Keep still-valid user goals, constraints, authorizations, decisions, relevant evidence and its scope, open questions, unfinished work and references. Update superseded material. Distinguish claims, observations, assumptions, recommendations, completed actions and proposals; preserve uncertainty and limitations rather than strengthening them. A limited search or extraction does not establish absence, and a proposed threshold is not a user requirement. Preserve whether a deliverable was actually produced and verified. Record uncertainty where details are unavailable. Output only the updated note, at most ${input.maxChars} characters.`,
    },
  ];
}

/**
 * 生成并落库一份新摘要。
 *
 * 失败不影响本轮：返回 null，旧摘要继续生效，下一轮再试。
 */
export async function runRouterNote(input: {
  store: Store;
  model: ModelClient;
  modelName: string;
  sessionKey: string | null;
  conversationId: string | null;
  previous: string | null;
  turns: (RouterTurn & { seq: number })[];
  limits: Limits;
  signal?: AbortSignal | null;
}): Promise<{ ok: boolean; content?: string; reason?: string }> {
  if (input.turns.length === 0) return { ok: false, reason: '没有需要整理的对话' };
  try {
    const result = await new RecordingModel(input.model, input.store, 'router-note', {
      taskId: null,
      workerId: null,
    }).chat({
      model: input.modelName,
      messages: buildRouterNotePrompt({
        previous: input.previous,
        turns: input.turns,
        maxChars: input.limits.routerNoteMaxChars,
      }),
      tools: [],
      reasoningEffort: 'low',
      signal: input.signal ?? null,
    });
    const content = (result.text ?? '').trim();
    if (content === '') return { ok: false, reason: '模型返回空内容' };
    input.store.insertRouterNote({
      id: `rn_${randomBytes(4).toString('hex')}`,
      sessionKey: input.sessionKey,
      conversationId: input.conversationId,
      fromSeq: input.turns[0]!.seq,
      toSeq: input.turns[input.turns.length - 1]!.seq,
      coveredSeq: input.turns[input.turns.length - 1]!.seq,
      content,
      sourceTurns: input.turns.length,
      sourceChars: input.turns.reduce((sum, turn) => sum + turn.content.length, 0),
    });
    return { ok: true, content };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * 续接用的裁剪：session 里保存的中途消息可能很长，按同一套预算从尾部保留。
 *
 * 续接不生成新摘要（它本来就是一次没跑完的调度，通常很短），
 * 但必须和正常轮受同一个预算约束，否则「崩溃恢复时才爆窗口」。
 */
export function boundRouterHistory(input: {
  messages: ChatMessage[];
  limits: Limits;
}): ChatMessage[] {
  // 续接没有 store 可查 usage，只能按字符估算兜底。
  const plan = planWindow({
    items: input.messages.map((message) => ({ message, chars: (message.content ?? '').length })),
    keepRecentTokens: input.limits.routerKeepRecentTokens,
    contextWindowTokens: input.limits.contextWindowTokens,
    reserveTokens: input.limits.routerReserveTokens,
  });
  return plan.kept.map((item) => item.message);
}
