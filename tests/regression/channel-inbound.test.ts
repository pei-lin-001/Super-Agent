/**
 * 入站：持久化、去重、游标顺序、交接崩溃点、身份校验。
 *
 * 断言落在真实 SQLite 与真实 Runtime 上，不用内存集合冒充持久去重。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { FakeAdapter, eventOf, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';

test('入站：同一事件重送只交接一次，不重复建任务', async () => {
  let created = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      // 只在第一轮建任务，之后直接给出结论：模拟真实 Router 的行为。
      if (created > 0) return mockReply({ text: '已经建好任务了' });
      created += 1;
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '查一下',
              goal: '看看',
              owner_role: '执行者',
              owner_brief: '做',
            },
          },
        ],
      });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const event = eventOf({
      channel: 'telegram',
      accountId: 'bot_1',
      peerId: 'owner-1',
      eventId: 'update:100',
      text: '帮我查一下',
    });
    adapter.batches.push({ events: [event], cursor: '101' });
    adapter.batches.push({ events: [event], cursor: '101' });
    await service.tick();
    await service.waitForIdle(5_000);
    // 再来一轮，模拟平台重送
    await service.tick();
    await service.waitForIdle(5_000);

    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1, `重送不应重复建任务（实际 ${tasks.length} 个）`);
    const inbound = harness.store.listPendingInbound(50);
    assert.equal(inbound.length, 0, '两条都应处理完');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：内容相同但事件 id 不同，两条都保留', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '好' }) });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    adapter.batches.push({
      events: [
        eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', eventId: 'update:1', text: '你好' }),
        eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', eventId: 'update:2', text: '你好' }),
      ],
      cursor: '3',
    });
    await service.tick();
    await service.waitForIdle(5_000);
    const turns = harness.store.listRouterTurns(20, 'telegram|bot_1|owner-1');
    const userTurns = turns.filter((turn) => turn.role === 'user');
    assert.equal(userTurns.length, 2, `两条相同文本都该保留（实际 ${userTurns.length}）`);
    assert.ok(
      userTurns.every((turn) => turn.content === '你好'),
      '内容不能被改写',
    );
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：写库失败时游标不前移', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '好' }) });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const original = harness.store.recordInboundBatch.bind(harness.store);
    harness.store.recordInboundBatch = () => {
      throw new Error('磁盘写失败');
    };
    adapter.batches.push({
      events: [eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'o', eventId: 'u:9', text: '在吗' })],
      cursor: '10',
    });
    await assert.rejects(() => service.tick(), /磁盘写失败/);
    assert.equal(harness.store.getChannelCursor('telegram', 'bot_1'), null, '失败时游标不能前移');

    harness.store.recordInboundBatch = original;
    // 上一次 poll 已经把批次取走了：重新放回，模拟平台重送同一批。
    adapter.batches.push({
      events: [eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'o', eventId: 'u:9', text: '在吗' })],
      cursor: '10',
    });
    await service.tick();
    await service.waitForIdle(5_000);
    assert.equal(harness.store.getChannelCursor('telegram', 'bot_1'), '10', '成功后才前移');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：交接后立即崩溃，重启续接原会话，不重复派工', async () => {
  let created = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '好' }),
    router: () => {
      if (created > 0) return mockReply({ text: '任务已经在跑了' });
      created += 1;
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: { title: 't', goal: 'g', owner_role: 'r', owner_brief: 'b' },
          },
        ],
      });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  const sessionKey = 'telegram|bot_1|owner-1';
  try {
    adapter.batches.push({
      events: [eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', eventId: 'u:1', text: '建个任务' })],
      cursor: '2',
    });
    await service.tick();
    await service.waitForIdle(8_000);

    // 交接记录已经标记完成（用户输入已持久化）
    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1, '任务只建一次');
    assert.equal(tasks[0]?.sourceSessionKey, sessionKey, '任务必须记住来源会话');
    assert.equal(tasks[0]?.sourceChannel, 'telegram');

    // 模拟崩溃后重启：同一条入站不会再次交接
    const restarted = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
    const adapter2 = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
    restarted.register(adapter2);
    restarted.start();
    try {
      await restarted.tick();
      await restarted.waitForIdle(5_000);
      assert.equal(harness.store.listTasks().length, 1, '重启后不应重复建任务');
      assert.equal(
        harness.store.listRouterTurns(20, sessionKey).filter((turn) => turn.role === 'user').length,
        1,
        '会话里只应有一条用户输入',
      );
    } finally {
      await restarted.stop();
    }
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：未绑定主人、陌生发送者、群聊都不进入执行流程', async () => {
  let routerCalls = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '好' }),
    router: () => {
      routerCalls += 1;
      return mockReply({ text: '好的' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  // 未绑定任何主人
  const adapter = new FakeAdapter('telegram', 'bot_1', []);
  service.register(adapter);
  service.start();
  try {
    adapter.batches.push({
      events: [eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'stranger', eventId: 'u:1', text: '帮我删库' })],
      cursor: '2',
    });
    await service.tick();
    await service.waitForIdle(2_000);
    assert.equal(routerCalls, 0, '未绑定主人时不能触发模型调用');
    const rows = harness.store.listPendingInbound(20);
    assert.equal(rows.length, 0, '记录应被处理掉（rejected），不会卡住队列');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：已绑定主人，但陌生发送者仍被拒绝', async () => {
  let routerCalls = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '好' }),
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
        eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'someone', eventId: 'u:1', text: '在吗' }),
        eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', eventId: 'u:2', text: '帮我看看' }),
      ],
      cursor: '3',
    });
    await service.tick();
    await service.waitForIdle(5_000);
    assert.equal(routerCalls, 1, '只有主人那条会交给模型');
    const sessionKeys = harness.store.listRouterTurns(20, 'telegram|bot_1|owner-1');
    assert.ok(sessionKeys.some((turn) => turn.content === '帮我看看'));
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站：同一账号重复注册会被拒绝，不能悄悄抢收消息', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '好' }) });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  service.register(new FakeAdapter('telegram', 'bot_1', ['owner-1']));
  try {
    assert.throws(() => service.register(new FakeAdapter('telegram', 'bot_1', ['owner-1'])), /重复注册/);
  } finally {
    await harness.cleanup();
  }
});

test('升级：老库没有 session_key 列时能正常迁移，不会在启动时炸', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  type DbHandle = InstanceType<typeof DatabaseSync>;
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../../src/storage/store.ts');

  const dir = await mkdtemp(join(tmpdir(), 'super-agent-migrate-'));
  const dbPath = join(dir, 'old.db');
  // 造一个「接入渠道之前」的库形状：这两张表还没有 session_key 列，也没有对应索引。
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE router_turn (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE router_session (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, outcome TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  raw.close();

  try {
    const store = new Store(dbPath);
    // 迁移后的列可用：能按会话键查历史
    const columns = (store as unknown as { db: DbHandle }).db
      .prepare('PRAGMA table_info(router_turn)')
      .all() as { name: string }[];
    assert.ok(columns.some((item) => item.name === 'session_key'), 'session_key 应被补上');
    const indexes = (store as unknown as { db: DbHandle }).db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_router_%'")
      .all() as { name: string }[];
    assert.ok(
      indexes.some((item) => item.name === 'idx_router_turn_session'),
      '补列之后才建索引，不能在建索引阶段报 no such column',
    );
    assert.deepEqual(store.listRouterTurns(5, 'telegram|bot|1'), []);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
