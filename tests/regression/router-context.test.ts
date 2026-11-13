/**
 * Router 的上下文预算：超阈值压缩成摘要、摘要进 system、续接也受同一预算约束。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { allText, createHarness, systemText } from '../helpers.ts';
import { mockError, mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import type { ChatRequest } from '../../src/model/types.ts';
import { boundRouterHistory } from '../../src/runtime/router-context.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });
const isNoteCall = (request: ChatRequest): boolean =>
  (request.messages[0]?.content ?? '').includes('Maintain a traceable conversation note');

test('Router 用量：按会话和话题隔离并计入缓存写入', async () => {
  const h = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    h.store.startModelCall({ id: 'mc_scope_a', purpose: 'router', model: 'm', sessionId: 'rs_a', routerSessionKey: TG_KEY, conversationId: 'topic_a' });
    h.store.finishModelCall({ id: 'mc_scope_a', status: 'ok', usage: { promptTokens: 10, completionTokens: 2, cacheReadTokens: 80, cacheWriteTokens: 8 } });
    assert.equal(h.store.latestContextUsage({ purpose: 'router', routerSessionKey: TG_KEY, conversationId: 'topic_a' })?.tokens, 100);
    assert.equal(h.store.latestContextUsage({ purpose: 'router', routerSessionKey: TG_KEY, conversationId: 'topic_b' }), null);
    assert.equal(h.store.latestContextUsage({ purpose: 'router', routerSessionKey: null, conversationId: null }), null);
  } finally { await h.cleanup(); }
});

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
    const system = allText(last);
    assert.match(system, /SUMMARY_MARK/, '摘要要注入 system，否则等于丢了旧对话');
    assert.match(system, /Earlier conversation note/);
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


test('Router 请求：状态在历史后且不会写入持久对话', async () => {
  const calls: ChatRequest[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: ({ request }) => { calls.push(request); return mockReply({ text: '好的' }); },
  });
  try {
    await harness.router.handleUserMessage('第一句话', { sessionKey: TG_KEY });
    harness.runtime.createTask({ title: '状态变化标记', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY, conversationId: harness.store.currentConversationId(TG_KEY) } });
    await harness.router.handleUserMessage('第二句话', { sessionKey: TG_KEY });
    const first = calls[0]!.messages;
    const second = calls[1]!.messages;
    assert.equal(second[0]!.content, first[0]!.content);
    const historyIndex = second.findIndex((message) => message.content === '第一句话');
    const stateIndex = second.findIndex((message) => (message.content ?? '').includes('Current system state'));
    assert.ok(historyIndex > 0 && stateIndex > historyIndex);
    assert.match(second[stateIndex]!.content ?? '', /状态变化标记/);
    const stored = harness.store.listRouterTurns(100, TG_KEY);
    assert.ok(stored.some((turn) => turn.content === '第一句话'));
    assert.ok(stored.every((turn) => !(turn.content ?? '').includes('Current system state')));
  } finally {
    await harness.cleanup();
  }
});

test('Router 摘要：成功时本轮只注入新的累计记录，旧记录和重复系统消息不再并存', async () => {
  const calls: ChatRequest[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    limits: { contextWindowTokens: 2_000, routerReserveTokens: 100, routerKeepRecentTokens: 300 },
    router: ({ request }) => {
      calls.push(request);
      if (isNoteCall(request)) return mockReply({ text: 'NEW_CUMULATIVE_NOTE' });
      return mockReply({ text: '好的' });
    },
  });
  try {
    harness.store.insertRouterNote({
      id: 'rn_old',
      sessionKey: TG_KEY,
      conversationId: null,
      fromSeq: 1,
      toSeq: 2,
      coveredSeq: 2,
      content: 'OLD_CUMULATIVE_NOTE',
      sourceTurns: 2,
      sourceChars: 800,
    });
    for (let index = 0; index < 18; index += 1) {
      harness.store.appendRouterTurn({
        id: `rt_seed_u_${index}`,
        role: 'user',
        content: `用户历史 ${index}：${'内容'.repeat(200)}`,
        sessionKey: TG_KEY,
        conversationId: null,
        createdAt: new Date(Date.UTC(2026, 10, 13, 0, 0, index)).toISOString(),
      });
      harness.store.appendRouterTurn({
        id: `rt_seed_a_${index}`,
        role: 'assistant',
        content: `助手历史 ${index}：${'回复'.repeat(200)}`,
        sessionKey: TG_KEY,
        conversationId: null,
        createdAt: new Date(Date.UTC(2026, 10, 13, 0, 1, index)).toISOString(),
      });
    }

    await harness.router.handleUserMessage('最新用户输入', { sessionKey: TG_KEY });
    const actual = calls.filter((request) => !isNoteCall(request)).at(-1)!;
    const text = allText(actual);
    assert.equal((text.match(/NEW_CUMULATIVE_NOTE/g) ?? []).length, 1);
    assert.doesNotMatch(text, /OLD_CUMULATIVE_NOTE/);
    assert.doesNotMatch(systemText(actual), /NEW_CUMULATIVE_NOTE|OLD_CUMULATIVE_NOTE/);
    const lastUser = actual.messages.filter((message) => message.role === 'user').at(-1)!;
    assert.match(lastUser.content ?? '', /NEW_CUMULATIVE_NOTE/);
    assert.equal(harness.store.latestRouterNote(null, TG_KEY)?.content, 'NEW_CUMULATIVE_NOTE');
  } finally {
    await harness.cleanup();
  }
});

test('Router 摘要：生成失败时本轮继续使用旧累计记录', async () => {
  const calls: ChatRequest[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    limits: { contextWindowTokens: 2_000, routerReserveTokens: 100, routerKeepRecentTokens: 300 },
    router: ({ request }) => {
      calls.push(request);
      if (isNoteCall(request)) mockError('模拟摘要失败');
      return mockReply({ text: '好的' });
    },
  });
  try {
    harness.store.insertRouterNote({
      id: 'rn_old_failed',
      sessionKey: TG_KEY,
      conversationId: null,
      fromSeq: 1,
      toSeq: 2,
      coveredSeq: 2,
      content: 'OLD_NOTE_STILL_VALID',
      sourceTurns: 2,
      sourceChars: 800,
    });
    for (let index = 0; index < 18; index += 1) {
      harness.store.appendRouterTurn({
        id: `rt_failed_u_${index}`,
        role: 'user',
        content: `失败史 ${index}：${'内容'.repeat(200)}`,
        sessionKey: TG_KEY,
        conversationId: null,
        createdAt: new Date(Date.UTC(2026, 10, 13, 1, 0, index)).toISOString(),
      });
      harness.store.appendRouterTurn({
        id: `rt_failed_a_${index}`,
        role: 'assistant',
        content: `失败回复 ${index}：${'回复'.repeat(200)}`,
        sessionKey: TG_KEY,
        conversationId: null,
        createdAt: new Date(Date.UTC(2026, 10, 13, 1, 1, index)).toISOString(),
      });
    }

    await harness.router.handleUserMessage('摘要失败后的输入', { sessionKey: TG_KEY });
    const actual = calls.filter((request) => !isNoteCall(request)).at(-1)!;
    const text = allText(actual);
    assert.equal((text.match(/OLD_NOTE_STILL_VALID/g) ?? []).length, 1);
    assert.doesNotMatch(systemText(actual), /OLD_NOTE_STILL_VALID/);
    assert.equal(harness.store.latestRouterNote(null, TG_KEY)?.content, 'OLD_NOTE_STILL_VALID');
  } finally {
    await harness.cleanup();
  }
});
