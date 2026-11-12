import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionTrigger, estimateTokens, planWindow } from '../../src/runtime/window.ts';

const LIMITS = { contextWindowTokens: 256_000, reserveTokens: 16_384, keepRecentTokens: 40_000 };

/** 造一段中文历史：每 100 字符一条，模拟巡检记录那种体量。 */
function turns(totalChars: number, each = 100): { id: number; chars: number }[] {
  const count = Math.ceil(totalChars / each);
  return Array.from({ length: count }, (_, index) => ({ id: index, chars: each }));
}

test('窗口：触发点取 min(窗口-预留, 窗口*0.75)', () => {
  assert.equal(compactionTrigger({ contextWindowTokens: 256_000, reserveTokens: 16_384 }), 192_000);
  assert.equal(compactionTrigger({ contextWindowTokens: 100_000, reserveTokens: 16_384 }), 75_000);
});

test('窗口：只给字符时按 chars/4 估算——这正是中文明明超窗却不触发的原因', () => {
  // 400,151 字符是线上 watchdog 的真实体量，实际发出去 226,023 token。
  const items = turns(400_000, 1000);
  const plan = planWindow({ items, ...LIMITS });
  assert.equal(plan.totalTokens, estimateTokens(400_000));
  assert.equal(plan.shouldCompact, false, '估算值远低于触发点，于是从不压缩');
  assert.equal(plan.kept.length, items.length, '原样全量发出');
});

test('窗口：给出真实 usage 后按真实规模触发，并按实测比例裁到 token 预算', () => {
  const items = turns(400_000, 1000);
  // 实测：400,151 字符 → 231,987 token，比例约 1.72 字符/token。
  const plan = planWindow({ items, ...LIMITS, measuredTokens: 231_987 });

  assert.equal(plan.shouldCompact, true, '23 万超过 19.2 万的触发点');
  assert.equal(plan.totalTokens, 231_987, '对外报告的是真实规模，不是估算');
  assert.ok(plan.dropped.length > 0, '确实丢掉了旧内容');
  // 保留量应该落在 token 预算附近（允许单条 overshoot）。
  assert.ok(
    plan.keptTokens <= LIMITS.keepRecentTokens * 1.2,
    `保留约 ${plan.keptTokens} token，应接近预算 ${LIMITS.keepRecentTokens}`,
  );
  assert.ok(
    plan.keptTokens >= LIMITS.keepRecentTokens * 0.5,
    `保留约 ${plan.keptTokens} token，不该裁得比预算小太多`,
  );
});

test('窗口：真实比估算大时，裁剪量必须按真实比例算，不能沿用 4 字符/token', () => {
  const items = turns(400_000, 1000);
  // 若错用 chars/4 换算，40,000 token 预算 = 160,000 字符，只裁掉 60%。
  // 实测比例 1.72 时，预算 = 68,800 字符，应裁掉约 83%。
  const plan = planWindow({ items, ...LIMITS, measuredTokens: 231_987 });
  const keptChars = plan.kept.reduce((sum, item) => sum + item.chars, 0);
  assert.ok(keptChars < 160_000, `实际保留 ${keptChars} 字符，应明显少于按 4 字符/token 算出的 160,000`);
});

test('窗口：没有 usage 时退回估算，不崩也不误裁', () => {
  const items = turns(4000, 100);
  const plan = planWindow({ items, ...LIMITS, measuredTokens: null });
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.kept.length, items.length);
  assert.equal(plan.totalTokens, 1000);
});
