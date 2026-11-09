/**
 * Router 的上下文预算：超阈值压缩成摘要、摘要进 system、续接也受同一预算约束。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, systemText } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import type { ChatRequest } from '../../src/model/types.ts';
import { boundRouterHistory } from '../../src/runtime/router-context.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });
const isNoteCall = (request: ChatRequest): boolean =>
  (request.messages[0]?.content ?? '').includes('对话摘要器');

test('Router：窗口内不压缩，超出才生成摘要', async () => {
  const calls: ChatRequest[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    limits: { contextWindowTokens: 2_000, routerReserveTokens: 100, routerKeepRecentTokens: 300 },
    router: (context) => {
      calls.push(context.request);
      if (isNoteCall(context.request)) return mockReply({ text: 'SUMMARY_MARK 用户在做 IM 会话系统' });
      return mockReply({ text: '好的' });
    },
  });
  try {
    // 20 轮、每轮 400 字符：约 8000 字符 = 2000 token，超过阈值 1500。
    for (let index = 0; index < 20; index += 1) {
      await harness.router.handleUserMessage(`第 ${index} 轮：${'内容'.repeat(200)}`, { sessionKey: TG_KEY });
    }

    const note = harness.store.latestRouterNote(null, TG_KEY);
    assert.ok(note, '超过阈值必须落一份摘要');
    assert.match(note!.content, /SUMMARY_MARK/);
    assert.ok(note!.coveredSeq > 0, '摘要要记住覆盖到哪一条');

    // 下一轮：摘要必须进 system，早期原文不再进上下文
    await harness.router.handleUserMessage('继续', { sessionKey: TG_KEY });
    const last = calls.filter((request) => !isNoteCall(request)).at(-1)!;
    const system = systemText(last);
    assert.match(system, /SUMMARY_MARK/, '摘要要注入 system，否则等于丢了旧对话');
    assert.match(system, /更早对话的累计记录/);
    const userTurns = last.messages.filter((message) => message.role === 'user');
    assert.ok(
      !userTurns.some((message) => (message.content ?? '').includes('第 0 轮')),
      '被摘要覆盖的早期原文不应再进上下文',
    );
  } finally {
    await harness.cleanup();
  }
});

test('Router：续接路径与正常轮受同一预算约束', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    limits: { contextWindowTokens: 2_000, routerReserveTokens: 100, routerKeepRecentTokens: 300 },
    router: () => mockReply({ text: '好的' }),
  });
  try {
    // 造一段很长的"中途消息"（模拟崩溃时保存的会话），远超预算。
    const long = Array.from({ length: 40 }, (_, index) => ({
      role: 'user' as const,
      content: `中途消息 ${index}：${'很长'.repeat(200)}`,
    }));
    const bounded = boundRouterHistory({ messages: long, limits: harness.config.limits });
    assert.ok(bounded.length < long.length, '续接也要裁，否则崩溃恢复时才爆窗口');
    assert.ok(bounded.at(-1)!.content!.includes('中途消息 39'), '保留最近的');
  } finally {
    await harness.cleanup();
  }
});
