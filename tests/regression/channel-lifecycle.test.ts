/**
 * 渠道生命周期：鉴权失效、断网恢复、未启用时的兼容性。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { FakeAdapter, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import { ChannelAuthError } from '../../src/channels/types.ts';
import { createChannelService } from '../../src/channels/bootstrap.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });

test('生命周期：未启用 IM 时不做任何装配，原有行为不变', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  try {
    assert.equal(
      createChannelService({ runtime: harness.runtime, store: harness.store, config: harness.config }),
      null,
      '未启用时应返回 null，不创建空循环',
    );
  } finally {
    await harness.cleanup();
  }
});

test('生命周期：启用了但缺机器人令牌，只报问题并给出可执行的下一步', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  try {
    const config = {
      ...harness.config,
      channels: {
        ...harness.config.channels,
        telegram: { ...harness.config.channels.telegram, enabled: true, botToken: '' },
      },
    };
    const bootstrap = createChannelService({ runtime: harness.runtime, store: harness.store, config });
    assert.ok(bootstrap, '应返回装配结果以便打印提示');
    assert.equal(bootstrap!.summary.length, 0, '没有可用账号');
    assert.ok(
      bootstrap!.problems.some((problem) => problem.includes('TELEGRAM_BOT_TOKEN')),
      `应明确指出缺什么（实际 ${JSON.stringify(bootstrap!.problems)}）`,
    );
  } finally {
    await harness.cleanup();
  }
});

test('生命周期：启用了微信但还没扫码，提示先登录', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  try {
    const config = {
      ...harness.config,
      channels: {
        ...harness.config.channels,
        weixin: { ...harness.config.channels.weixin, enabled: true },
      },
    };
    const bootstrap = createChannelService({ runtime: harness.runtime, store: harness.store, config });
    assert.ok(
      bootstrap!.problems.some((problem) => problem.includes('weixin-login')),
      '应提示运行扫码命令',
    );
  } finally {
    await harness.cleanup();
  }
});

test('生命周期：登录失效后停止拉取但保留已产出的结果', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '这条回复必须留下' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    // 先产生一条待发内容
    await harness.router.handleUserMessage('问一句', { sessionKey: TG_KEY });
    adapter.sendPolicy = () => ({ status: 'failed', error: 'Unauthorized', retryable: false });
    await service.drainOutbound();
    const before = harness.store.listOutboundBySession(TG_KEY);
    assert.ok(before.length > 0, '应已有发件记录');

    // 平台判定登录失效
    adapter.failWith = new ChannelAuthError('telegram', 'Unauthorized');
    for (let i = 0; i < 6; i += 1) {
      await service.tick().catch(() => undefined);
    }
    const status = service.status();
    assert.equal(status.length, 1);
    assert.equal(status[0]!.blocked, null, 'tick 只推进一轮，不负责标记阻塞');

    // 走轮询循环才会进入阻塞状态
    const blocking = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
    const badAdapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
    badAdapter.failWith = new ChannelAuthError('telegram', 'Unauthorized');
    blocking.register(badAdapter);
    blocking.start();
    try {
      for (let i = 0; i < 100 && blocking.status()[0]?.blocked === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const blockedStatus = blocking.status()[0]!;
      assert.match(blockedStatus.blocked ?? '', /Unauthorized/, '登录失效应被标记为需要人工处理');
      const polls = badAdapter.polls;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(badAdapter.polls, polls, '阻塞后不再继续拉取');
    } finally {
      await blocking.stop();
    }

    // 结果仍在库里，业务状态没被推翻
    const after = harness.store.listOutboundBySession(TG_KEY);
    assert.equal(after.length, before.length, '登录失效不能丢掉已产出的内容');
    assert.ok(
      after.some((row) => row.status === 'failed' || row.status === 'pending'),
      '失败状态要如实保留，不能伪造成已发送',
    );
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('生命周期：断网后恢复，业务继续推进', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '恢复了' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.failWith = new Error('ECONNREFUSED');
    for (let i = 0; i < 4; i += 1) {
      await service.tick().catch(() => undefined);
    }
    assert.equal(harness.store.listTasks().length, 0, '断网期间不该有任务');

    adapter.failWith = null;
    adapter.batches.push({
      events: [
        {
          source: {
            channel: 'telegram',
            accountId: 'bot_1',
            peerId: 'owner-1',
            senderId: 'owner-1',
            platformMessageId: '11',
            eventId: 'update:11',
            threadId: null,
          },
          text: '恢复了吗',
          attachments: [],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '12',
    });
    await service.tick();
    await service.waitForIdle(6_000);
    assert.equal(harness.store.getChannelCursor('telegram', 'bot_1'), '12');
    assert.ok(
      harness.store.listRouterTurns(20, TG_KEY).some((turn) => turn.content === '恢复了吗'),
      '恢复后应继续处理消息',
    );
    await service.drainOutbound();
    assert.ok(adapter.sent.length > 0, '恢复后应能把回复发出去');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('群聊：只留痕、不进执行流程、也不在群里回话', async () => {
  let routerCalls = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      routerCalls += 1;
      return mockReply({ text: '好的' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.batches.push({
      events: [
        {
          source: {
            channel: 'telegram',
            accountId: 'bot_1',
            peerId: '-100777',
            senderId: 'owner-1',
            platformMessageId: '31',
            eventId: 'update:31',
            threadId: null,
          },
          text: '帮我在群里跑个命令',
          attachments: [],
          unsupported: '仅支持与机器人的私聊，group 里的消息不处理',
          receivedAt: new Date().toISOString(),
          silent: true,
        },
      ],
      cursor: '32',
    });
    await service.tick();
    await service.waitForIdle(3_000);

    assert.equal(routerCalls, 0, '群聊消息不能调用模型');
    assert.equal(adapter.sent.length, 0, '群聊里不能回话');
    const rows = harness.store.listPendingInbound(20);
    assert.equal(rows.length, 0, '记录已处理完，不留在队列里');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('Telegram 适配器：群聊消息标记为只读留痕', async () => {
  const { TelegramAdapter } = await import('../../src/channels/telegram.ts');
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 70,
            message: {
              message_id: 5,
              date: 1_700_000_000,
              chat: { id: -100777, type: 'group', title: '工作群' },
              from: { id: 777001 },
              text: '帮我跑一下',
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({
    token: '1:S',
    ownerIds: ['777001'],
    apiBase: 'http://127.0.0.1:9',
    workDir: '/tmp',
    pollTimeoutMs: 1000,
    maxInboundBytes: 1024,
    fetchImpl,
  });
  const result = await adapter.poll({ cursor: null, signal: new AbortController().signal });
  assert.equal(result.events.length, 1, '群消息也要留痕');
  assert.equal(result.events[0]!.silent, true, '不能回信');
  assert.match(result.events[0]!.unsupported ?? '', /私聊/);
  assert.equal(result.cursor, '71', '游标照常前移，避免卡住');
});
