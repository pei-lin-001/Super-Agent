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
  });

  const kept = plan.kept.map((item) => item.turn);
  const dropped = plan.dropped.map((item) => item.turn);
  const tokens = plan.keptTokens + estimateTokens((note?.content.length ?? 0));

  return {
    history: kept.map((turn): ChatMessage => ({ role: turn.role, content: turn.content })),
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
      content:
        '你是 Super-Agent 的对话摘要器，为一个聊天话题维护累计记录。' +
        '你的输出会成为 Router 后续唯一可见的旧对话记忆，必须准确、可追溯，不能编造，也不要继续对话。',
    },
    {
      role: 'user',
      content: `# 上一份记录
${input.previous ?? '（这是第一次整理，之前没有记录）'}

# 本次需要并入的对话
${body}

# 输出要求
1. 输出一份累计记录：保留上一份里仍然有效的内容，再并入这次的新内容。
2. 只记事实：用户说明过的背景与偏好、明确做出的决定、约定好的下一步、尚未解决的问题、需要提醒的编号或路径。
3. 不要写客套话、不要复述寒暄、不要写"用户询问了 X"这种流水账；直接写结论和状态。
4. 冲突的旧内容写成「已失效：<原因>」。
5. 不确定的写「未确认」，不要猜测补齐。
6. 全文不超过 ${input.maxChars} 字符。只输出记录正文，不要前言，不要代码块围栏。

建议小节：## 用户背景与偏好 / ## 已确认的事实 / ## 已作出的决定 / ## 约定但未完成 / ## 待解决问题`,
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
  const plan = planWindow({
    items: input.messages.map((message) => ({ message, chars: (message.content ?? '').length })),
    keepRecentTokens: input.limits.routerKeepRecentTokens,
    contextWindowTokens: input.limits.contextWindowTokens,
    reserveTokens: input.limits.routerReserveTokens,
  });
  return plan.kept.map((item) => item.message);
}
