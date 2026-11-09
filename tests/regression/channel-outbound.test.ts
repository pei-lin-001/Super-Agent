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

test('正在输入：会话开始处理时发送，结束后停止；不支持的平台不发', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好了' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const supported = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const plain = new FakeAdapter('weixin', 'wx_1', ['owner-1']);
  const typingCalls: string[] = [];
  (supported as unknown as { capabilities: { typing: boolean; edit: boolean } }).capabilities = {
    typing: true,
    edit: false,
  };
  (supported as unknown as { typing: (input: { target: { channel: string } }) => Promise<void> }).typing = async (input) => {
    typingCalls.push(input.target.channel);
  };
  service.register(supported);
  service.register(plain);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: TG_KEY });
    await service.waitForIdle(3_000);
    assert.ok(typingCalls.length > 0, '支持正在输入的平台应收到提示');
    const before = typingCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(typingCalls.length, before, '回复发出后应停止心跳');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('流式：短回复不建占位消息，只发一条正常消息', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '这是快速答案' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const edits: string[] = [];
  (adapter as unknown as { capabilities: { typing: boolean; edit: boolean } }).capabilities = {
    typing: true,
    edit: true,
  };
  (adapter as unknown as { typing: () => Promise<void> }).typing = async () => undefined;
  (adapter as unknown as { edit: (input: { text: string }) => Promise<{ status: string; platformMessageId: string }> }).edit = async (input) => {
    edits.push(input.text);
    return { status: 'sent', platformMessageId: 'm1' };
  };
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: TG_KEY });
    await service.waitForIdle(3_000);
    await service.drainOutbound();

    assert.equal(adapter.sent.length, 1, '短任务只该有一条普通消息');
    assert.equal(adapter.sent[0]!.segment.text, '这是快速答案');
    assert.equal(edits.length, 0, '短任务不该出现占位消息与其改写');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('流式：任务确实慢时才建占位消息，最终被改写成答案', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return mockReply({ text: '这是慢任务的最终答案' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const edits: { messageId: string; text: string }[] = [];
  (adapter as unknown as { capabilities: { typing: boolean; edit: boolean } }).capabilities = {
    typing: true,
    edit: true,
  };
  (adapter as unknown as { typing: () => Promise<void> }).typing = async () => undefined;
  (adapter as unknown as { edit: (input: { messageId: string; text: string }) => Promise<{ status: string; platformMessageId: string }> }).edit = async (input) => {
    edits.push({ messageId: input.messageId, text: input.text });
    return { status: 'sent', platformMessageId: input.messageId };
  };
  adapter.sendPolicy = () => ({ status: 'sent', platformMessageId: 'm-placeholder' });
  service.register(adapter);
  service.start();
  try {
    const run = harness.router.handleUserMessage('帮我查一下', { sessionKey: TG_KEY });
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await run;
    await service.waitForIdle(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(adapter.sent.length, 1, `慢任务只发一条占位消息（实际 ${adapter.sent.length}）`);
    assert.equal(adapter.sent[0]!.segment.text, '正在处理…');
    assert.equal(edits.at(-1)?.text, '这是慢任务的最终答案', '占位消息应被改写成最终答案');
    assert.equal(edits.at(-1)?.messageId, 'm-placeholder', '改写的是同一条消息');
    assert.equal(harness.store.listOutboundBySession(TG_KEY).length, 0, '改写成功就不该再有独立发件记录');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('流式：不支持编辑的平台照常发新消息，不建占位', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '微信里的回答' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('weixin', 'wx_1', ['owner-1']);
  (adapter as unknown as { capabilities: { typing: boolean; edit: boolean } }).capabilities = {
    typing: true,
    edit: false,
  };
  (adapter as unknown as { typing: () => Promise<void> }).typing = async () => undefined;
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: 'weixin|wx_1|owner-1' });
    await service.waitForIdle(3_000);
    await service.drainOutbound();
    assert.equal(adapter.sent.length, 1, '不支持编辑就只发一条最终消息');
    assert.equal(adapter.sent[0]!.segment.text, '微信里的回答');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：一段结果未知，不冻结后面确定没发的段', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    // 9000 字符 → 三段（Telegram 单条上限 4000）
    router: () => mockReply({ text: '甲'.repeat(9_000) }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    let blocked = true;
    adapter.sendPolicy = (input) => {
      if (input.segment.index === 0) return { status: 'unknown', error: '请求超时' };
      // 第一次推进时第二段被限速，第三段因此还没轮到
      if (input.segment.index === 1 && blocked) return { status: 'failed', error: '限速', retryable: true };
      return { status: 'sent', platformMessageId: `m${input.segment.index}` };
    };
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    await service.drainOutbound();

    const first = harness.store.listOutboundBySession(TG_KEY)[0]!;
    assert.notEqual(first.status, 'unknown', '还有段没发完时不能整条标成 unknown，否则再也调不动');

    // 退避到期后继续推进：第二、三段必须还能发出去
    blocked = false;
    expireOutboundBackoff(harness.store, TG_KEY);
    await service.drainOutbound();

    const indexes = adapter.sent.map((item) => item.segment.index);
    assert.deepEqual(indexes, [0, 1, 1, 2], '第一段只尝试一次，其余段继续发');
    const final = harness.store.listOutboundBySession(TG_KEY)[0]!;
    const segments = (Array.isArray(final.segments) ? final.segments : []) as OutboundSegment[];
    assert.deepEqual(segments.map((segment) => segment.status), ['unknown', 'sent', 'sent']);
    assert.equal(final.status, 'unknown', '全部都有结论后，整条如实记 unknown');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：每段拿到回执就立刻落库，不等整轮结束', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '乙'.repeat(5000) }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    let calls = 0;
    let firstStatusDuringSecondSend = '';
    adapter.sendPolicy = () => {
      calls += 1;
      if (calls === 2) {
        // 第二段开始发送的瞬间（第一段已确认、整轮还没结束）读数据库
        const row = harness.store.listOutboundBySession(TG_KEY)[0]!;
        const segments = (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
        firstStatusDuringSecondSend = segments[0]!.status;
      }
      return { status: 'sent', platformMessageId: `m${calls}` };
    };
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    await service.drainOutbound();

    assert.equal(firstStatusDuringSecondSend, 'sent', '第一段确认后必须立刻落库，否则崩溃会重发');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站：发送途中进程中断（sending）按结果未知处理，不重发', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '只发一条' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('发吧', { sessionKey: TG_KEY });
    // 模拟"已经交给平台、还没拿到回执"时进程死掉
    const row = harness.store.listOutboundBySession(TG_KEY)[0]!;
    const segments = (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
    for (const segment of segments) segment.status = 'sending';
    harness.store.updateOutbound({
      id: row.id,
      segments,
      status: 'pending',
      attempts: row.attempts,
      lastError: null,
      nextAttemptAt: null,
    });

    const before = adapter.sent.length;
    await service.drainOutbound();

    assert.equal(adapter.sent.length, before, '结果未知的段不能重发');
    const after = harness.store.listOutboundBySession(TG_KEY).at(-1)!;
    assert.equal(after.status, 'unknown', '中断在发送途中的记录只能记 unknown');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('草稿：支持 sendMessageDraft 的平台不再发占位消息，进度走临时预览', async () => {
  let round = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      round += 1;
      if (round === 1) return mockReply({ toolCalls: [{ name: 'list_tasks', arguments: {} }] });
      return mockReply({ text: '最终答案' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const drafts: { draftId: number; text: string }[] = [];
  const edits: string[] = [];
  (adapter as unknown as { capabilities: object }).capabilities = { typing: true, edit: true, draft: true };
  (adapter as unknown as { typing: () => Promise<void> }).typing = async () => undefined;
  (adapter as unknown as {
    draft: (input: { draftId: number; text: string }) => Promise<{ status: string; platformMessageId: null }>;
  }).draft = async (input) => {
    drafts.push({ draftId: input.draftId, text: input.text });
    return { status: 'sent', platformMessageId: null };
  };
  (adapter as unknown as { edit: (input: { text: string }) => Promise<{ status: string; platformMessageId: string }> }).edit = async (input) => {
    edits.push(input.text);
    return { status: 'sent', platformMessageId: 'm1' };
  };
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: TG_KEY });
    await service.waitForIdle(5_000);
    await service.drainOutbound();

    assert.ok(drafts.length >= 1, `进度应走草稿（实际 ${drafts.length} 次）`);
    assert.match(drafts[0]!.text, /正在执行：/, '草稿内容是当前进展');
    assert.ok(drafts.every((item) => item.draftId !== 0), 'draft_id 必须非零，平台才会做动画');
    assert.ok(
      adapter.sent.every((item) => item.segment.text !== '正在处理…'),
      '不该再发"正在处理…"占位消息',
    );
    assert.equal(adapter.sent.length, 1, `最终答案只发一条普通消息（实际 ${adapter.sent.length}）`);
    assert.equal(adapter.sent[0]!.segment.text, '最终答案');
    assert.equal(edits.length, 0, '草稿路径不需要改写任何消息');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('草稿：平台不认这个接口时安静退回，答案照常发送', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '答案' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  let draftCalls = 0;
  (adapter as unknown as { capabilities: object }).capabilities = { typing: true, edit: true, draft: true };
  (adapter as unknown as { typing: () => Promise<void> }).typing = async () => undefined;
  (adapter as unknown as { draft: () => Promise<{ status: string; error: string; retryable: boolean }> }).draft = async () => {
    draftCalls += 1;
    return { status: 'failed', error: 'unknown method', retryable: false };
  };
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: TG_KEY });
    await service.waitForIdle(3_000);
    await service.drainOutbound();

    assert.equal(adapter.sent.length, 1, '答案必须照常发出去');
    assert.equal(adapter.sent[0]!.segment.text, '答案');
    assert.ok(draftCalls <= 1, `草稿失败后不该反复撞同一个接口（实际 ${draftCalls} 次）`);
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});
