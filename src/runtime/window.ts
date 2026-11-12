/**
 * 上下文预算：规模测量、压缩阈值、按预算切窗口。
 *
 * ## 关键：必须用「真实 usage」当基准，不能只用字符估算
 *
 * pi 的 estimateTokens 是 `chars / 4`，但它**只用来估算上一次调用之后新增的几条**，
 * 判断要不要压缩用的是提供方回报的真实 usage（见 pi 的 estimateContextTokens）。
 * 我们早期只搬了 `/4` 这个比例、没搬这套算法，结果中文全量估算低了 2.2 倍：
 * 实测 400,151 字符被估成 100,037 token，实际发出去 226,023 token——
 * 阈值 150,000「远未达到」，安全阀从未打开，上下文一路涨到贴着模型窗口。
 *
 * 中文是约 1.7 字符 1 token（英文约 4），所以 `chars/4` 对中文是低估不是高估。
 *
 * 现在：触发判断用 `measuredTokens`（真实 usage + 尾部估算），
 * 并且用 `总字符 / 真实token` 反算出本段文本的真实比例，再用它把 keepRecentTokens
 * 换算成字符预算。这样中英混排都能自适应，不必猜换算常数。
 *
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
  /**
   * 当前上下文的真实规模（token），由调用方用「上次调用的 usage + 尾部估算」算好。
   * 不传则退回纯字符估算——**那对中文会低估一倍以上**，只适合没有 usage 可用时兜底。
   */
  measuredTokens?: number | null;
}): WindowPlan<T> {
  const trigger = compactionTrigger({
    contextWindowTokens: input.contextWindowTokens,
    reserveTokens: input.reserveTokens,
  });
  const totalChars = input.items.reduce((sum, item) => sum + item.chars, 0);
  // 有实测值就以它为准。估算只在没有 usage 时兜底（首次调用、usage 丢失）。
  const totalTokens = input.measuredTokens ?? estimateTokens(totalChars);
  const shouldCompact = totalTokens > trigger;
  // 本段文本真实的「字符 / token」。有 usage 才算得出；没有就退回英文经验值 4。
  const charsPerToken = totalTokens > 0 && totalChars > 0 ? totalChars / totalTokens : 4;

  // keepRecentTokens 是 token 预算，按实测比例换成字符预算再切。
  let budget = Math.max(0, input.keepRecentTokens) * charsPerToken;
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
  let keptChars = 0;
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const chars = input.items[index]!.chars;
    if (keptChars + chars > budget && cut < input.items.length) break;
    keptChars += chars;
    cut = index;
  }
  // 预算为 0 或全部装不下时，至少留最后一条。
  if (cut === input.items.length && input.items.length > 0) {
    cut = input.items.length - 1;
    keptChars = input.items[cut]!.chars;
  }
  const keptTokens = Math.ceil(keptChars / charsPerToken);

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
