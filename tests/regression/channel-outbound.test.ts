/**
 * 出站：分段、失败不重发已确认段、限速、业务拒绝、结果未知、重启不重发。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { FakeAdapter, expireOutboundBackoff, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf, type OutboundSegment } from '../../src/channels/types.ts';
import { splitText } from '../../src/channels/service.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });

function segmentsOf(row: { segments: unknown }): OutboundSegment[] {
  return (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
}

test('分段：超长文本按码点切开，不丢内容也不切坏代理对', () => {
  const text = '甲'.repeat(150) + '🙂'.repeat(120) + '乙'.repeat(100);
  const parts = splitText(text, 100);
  assert.equal(parts.join(''), text, '拼回来必须与原文完全一致');
  assert.ok(parts.every((part) => [...part].length <= 100), '每段都不超过上限');
  assert.ok(parts.length > 1, '应确实分段');
  for (const part of parts) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(part), '不能把代理对切成两半');
  }
});

test('分段：短文本不分段，空串不产生分段', () => {
  assert.deepEqual(splitText('你好', 100), ['你好']);
  assert.deepEqual(splitText('', 100), ['']);
});

test('出站：超长回复分成多条，按顺序发完，状态为已发送', async () => {
  const longText = `${'第一段内容。'.repeat(1000)}结尾标记`;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      // 只在用户那条消息上回长文；后续汇报短回
      const isUserTurn = context.request.messages.some((message) => message.role === 'user');
      return mockReply({ text: isUserTurn ? longText : '短回复' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    let order = 0;
    adapter.sendPolicy = () => {
      order += 1;
      return { status: 'sent', platformMessageId: `m${order}` };
    };
    await harness.router.handleUserMessage('讲长一点', { sessionKey: TG_KEY });
    await service.drainOutbound();

    assert.ok(adapter.sent.length >= 2, `长文应分段发送（实际 ${adapter.sent.length} 条）`);
    const joined = adapter.sent.map((item) => item.segment.text ?? '').join('');
    assert.ok(joined.includes('结尾标记'), '最后一段不能丢');
    assert.deepEqual(
      adapter.sent.map((item) => item.segment.index),
      adapter.sent.map((_, index) => index),
      '分段顺序必须保持',
    );
    const rows = harness.store.listOutboundBySession(TG_KEY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'sent');
    assert.ok(segmentsOf(rows[0]!).every((segment) => segment.status === 'sent'));
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：中间一段失败，已发出的段不重发', async () => {
  const longText = '甲'.repeat(5000);
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: longText }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    let calls = 0;
    adapter.sendPolicy = () => {
      calls += 1;
      if (calls === 2) return { status: 'failed', error: '网络抖动', retryable: true };
      return { status: 'sent', platformMessageId: `m${calls}` };
    };
    await harness.router.handleUserMessage('长一点', { sessionKey: TG_KEY });
    await service.drainOutbound();

    const first = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.equal(first.status, 'partial', `第一次应停在 partial（实际 ${first.status}）`);
    const sentBefore = adapter.sent.length;
    assert.equal(sentBefore, 2, '只发到第二段就停了');

    // 第二轮：等退避到期后只补未确认的段
    expireOutboundBackoff(harness.store, TG_KEY);
    await service.drainOutbound();
    const second = harness.store.listOutboundBySession(TG_KEY)[0]!;
    const segments = segmentsOf(second);
    assert.equal(second.status, 'sent', '全部确认后状态应转为 sent');
    const resentIndexes = adapter.sent.slice(sentBefore).map((item) => item.segment.index);
    assert.equal(resentIndexes[0], 1, '应从失败的那一段继续');
    assert.equal(
      resentIndexes.filter((index) => index === 0).length,
      0,
      '第一段已经确认发送，不能重发',
    );
    assert.ok(segments.every((segment) => segment.status === 'sent'));
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：平台限速时记录真实失败与建议等待时间，不假装已发送', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '限速测试' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.sendPolicy = () => ({
      status: 'failed',
      error: 'Too Many Requests: retry after 7',
      retryable: true,
      retryAfterMs: 7000,
    });
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    await service.drainOutbound();

    const row = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.equal(row.status, 'pending', '限速属于可重试失败，留在待发');
    const segment = segmentsOf(row)[0]!;
    assert.equal(segment.status, 'failed');
    assert.match(segment.error ?? '', /Too Many Requests/);
    assert.equal(row.attempts, 1);
    // 平台给了 7 秒，就必须等 7 秒，不能立刻再打一次
    assert.ok(row.nextAttemptAt, '应记录最早下次尝试时间');
    const waitMs = Date.parse(row.nextAttemptAt!) - Date.now();
    assert.ok(waitMs > 5_000 && waitMs <= 7_500, `等待时间应接近 retry_after（实际 ${waitMs}ms）`);

    // 等待期内再推进不会重发
    const sentBefore = adapter.sent.length;
    await service.drainOutbound();
    assert.equal(adapter.sent.length, sentBefore, '等待期内不能重试');
    assert.equal(harness.store.listPendingOutbound(10).length, 0, '未到时间的记录不进入待发队列');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('退避：没有 retry_after 时按尝试次数退避，不空转打接口', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '退避测试' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.sendPolicy = () => ({ status: 'failed', error: 'ECONNREFUSED', retryable: true });
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    await service.drainOutbound();
    const first = harness.store.listOutboundBySession(TG_KEY)[0]!;
    const wait1 = Date.parse(first.nextAttemptAt ?? '') - Date.now();
    assert.ok(wait1 > 1_000, `第一次失败后应退避（实际 ${wait1}ms）`);

    // 立刻再推进：不重发
    const sent = adapter.sent.length;
    await service.drainOutbound();
    assert.equal(adapter.sent.length, sent, '退避期内不能重试');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：结果未知时如实记 unknown，且不重复发送这一段', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '未知结果测试' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.sendPolicy = () => ({ status: 'unknown', error: '请求超时，无法确认是否已到达平台' });
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    await service.drainOutbound();

    const row = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.equal(row.status, 'unknown', `结果未知不能记成已发送（实际 ${row.status}）`);
    const sentCount = adapter.sent.length;

    // 再推进一轮：unknown 的记录不再重发
    await service.drainOutbound();
    const again = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.equal(again.status, 'unknown', 'unknown 不应被改写为 sent');
    assert.equal(adapter.sent.length, sentCount, 'unknown 的段不能重复发送');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：重启后已确认的段不重发，未确认的继续', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '乙'.repeat(5000) }),
  });
  const first = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const firstAdapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  first.register(firstAdapter);
  first.start();
  try {
    let calls = 0;
    firstAdapter.sendPolicy = () => {
      calls += 1;
      if (calls === 2) return { status: 'failed', error: '断网', retryable: true };
      return { status: 'sent', platformMessageId: `m${calls}` };
    };
    await harness.router.handleUserMessage('长文', { sessionKey: TG_KEY });
    await first.drainOutbound();
  } finally {
    await first.stop();
  }

  const second = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const secondAdapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  second.register(secondAdapter);
  second.start();
  try {
    expireOutboundBackoff(harness.store, TG_KEY);
    await second.drainOutbound();
    const indexes = secondAdapter.sent.map((item) => item.segment.index);
    assert.ok(!indexes.includes(0), '重启后不能重发第一段');
    assert.ok(indexes.includes(1), '未确认的第二段应继续发');
    const row = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.equal(row.status, 'sent');
  } finally {
    await second.stop();
    await harness.cleanup();
  }
});

test('停机：渠道停止后不再轮询，长轮询被取消', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const pollsBefore = adapter.polls;
    await service.stop();
    assert.equal(adapter.closed, true, '适配器应被关闭');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(adapter.polls, pollsBefore, '停机后不应再有新的轮询');
    assert.equal(service.isStarted, false);
  } finally {
    await harness.cleanup();
  }
});

test('停机：渠道拉取失败不会把已完成任务改回活动状态', async () => {
  const harness = await createHarness({
    worker: () => {
      return mockReply({
        toolCalls: [{ name: 'artifact_save', arguments: { name: 'out.md', content: '# 结果\n' } }],
      });
    },
    router: () => mockReply({ text: '收到' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const created = harness.runtime.createTask({
      title: 't',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    harness.runtime.start();
    harness.runtime.enqueue(created.owner.id);
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const status = harness.store.getWorker(created.owner.id)?.status;
      if (status === 'waiting') break;
    }
    const before = harness.store.getWorker(created.owner.id)?.status;

    // 平台整体不可用
    adapter.failWith = new Error('ECONNREFUSED');
    await service.tick().catch(() => undefined);
    for (let i = 0; i < 5; i += 1) {
      await service.tick().catch(() => undefined);
    }
    const after = harness.store.getWorker(created.owner.id)?.status;
    assert.equal(after, before, '渠道故障不能改变 Worker 状态');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});
