/**
 * 上下文预算：token 估算、压缩阈值、按预算切窗口。
 *
 * 三处来源，都是移植不是自创：
 * - token 估算 `chars / 4`：pi `packages/ai/dist/utils/...`（estimateTokens）
 * - 压缩阈值 `min(window - reserve, window * 0.75)`：OpenClaw
 *   `packages/agent-core/src/harness/compaction/compaction-threshold.ts`
 * - 按 keepRecentTokens 从尾部累计切点：pi `findCutPoint`
 *
 * 为什么阈值要取 0.75 上限：窗口越大，`window - reserve` 越接近窗口本身。
 * 256k 窗口配 16k reserve 就是 240k，等于永不压缩——上下文一路涨到提供方拒收。
 */

/** 粗估 token：4 字符 ≈ 1 token。和 pi 用的是同一个换算。 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/** 压缩触发点（token）。 */
export function compactionTrigger(input: {
  contextWindowTokens: number;
  reserveTokens: number;
  /** 额外下限；0 表示不设。 */
  minimumTokens?: number;
}): number {
  const window = Math.max(1, Math.floor(input.contextWindowTokens));
  const reserve = Math.max(0, Math.floor(input.reserveTokens));
  return Math.max(
    0,
    Math.min(window - reserve, Math.floor(window * 0.75)),
    Math.floor(input.minimumTokens ?? 0),
  );
}

export interface WindowItem {
  /** 估算用的字符数。 */
  chars: number;
}

export interface WindowPlan<T extends WindowItem> {
  /** 进入上下文的条目，按原顺序。 */
  kept: T[];
  /** 被挤出窗口、需要压进摘要的条目。 */
  dropped: T[];
  keptTokens: number;
  droppedTokens: number;
  totalTokens: number;
  /** 是否超过压缩触发点。 */
  shouldCompact: boolean;
}

/**
 * 按 token 预算从尾部保留最近的条目。
 *
 * 从最新往前累计，直到超过预算；`keepRecentTokens` 为 0 表示不保留（全压）。
 * 至少保留 1 条：空上下文会让提供方直接报错。
 */
export function planWindow<T extends WindowItem>(input: {
  items: T[];
  keepRecentTokens: number;
  contextWindowTokens: number;
  reserveTokens: number;
}): WindowPlan<T> {
  const trigger = compactionTrigger({
    contextWindowTokens: input.contextWindowTokens,
    reserveTokens: input.reserveTokens,
  });
  const totalTokens = input.items.reduce((sum, item) => sum + estimateTokens(item.chars), 0);
  const shouldCompact = totalTokens > trigger;

  let budget = Math.max(0, input.keepRecentTokens);
  if (!shouldCompact) {
    // 没到触发点就整段保留：不做无谓的摘要调用。
    return {
      kept: input.items,
      dropped: [],
      keptTokens: totalTokens,
      droppedTokens: 0,
      totalTokens,
      shouldCompact: false,
    };
  }

  let cut = input.items.length;
  let keptTokens = 0;
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const tokens = estimateTokens(input.items[index]!.chars);
    if (keptTokens + tokens > budget && cut < input.items.length) break;
    keptTokens += tokens;
    cut = index;
  }
  // 预算为 0 或全部装不下时，至少留最后一条。
  if (cut === input.items.length && input.items.length > 0) {
    cut = input.items.length - 1;
    keptTokens = estimateTokens(input.items[cut]!.chars);
  }

  const kept = input.items.slice(cut);
  const dropped = input.items.slice(0, cut);
  return {
    kept,
    dropped,
    keptTokens,
    droppedTokens: totalTokens - keptTokens,
    totalTokens,
    shouldCompact,
  };
}
