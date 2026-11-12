import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../../src/storage/store.ts';

function withStore(body: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sa-intercom-'));
  const store = new Store(join(dir, 'agent.db'));
  try {
    body(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('通道：发给某一层的消息只出现在那一层的待办里', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_a', fromLayer: 'router', kind: 'notice', body: '用户说系统卡了' });
    store.insertIntercom({ id: 'ic_b', fromLayer: 'watchdog', kind: 'notice', body: '我重启过主系统' });

    assert.deepEqual(store.listPendingIntercom('watchdog').map((m) => m.id), ['ic_a']);
    assert.deepEqual(store.listPendingIntercom('router').map((m) => m.id), ['ic_b']);
  });
});

test('通道：投递过一次就不再出现在待办里，避免重复注入撑爆上下文', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_a', fromLayer: 'router', kind: 'notice', body: '一条通报' });
    assert.equal(store.listPendingIntercom('watchdog').length, 1);

    store.markIntercomDelivered('ic_a');
    assert.equal(store.listPendingIntercom('watchdog').length, 0, '已投递的不再重复给');
    // notice 投递即终结：没人会回复它，留在 delivered 只会被反复注入。
    assert.equal(store.getIntercom('ic_a')?.status, 'consumed');
  });
});

test('通道：回复把原消息标记为已答复，且 reply 带上跳数与话题', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_q', fromLayer: 'router', kind: 'question', body: '重启过吗', topicId: 'ic_q' });
    const original = store.getIntercom('ic_q')!;

    store.insertIntercom({
      id: 'ic_r',
      fromLayer: 'watchdog',
      kind: 'reply',
      body: '重启过，两次',
      topicId: original.topicId ?? original.id,
      replyTo: original.id,
      hops: original.hops + 1,
    });
    store.consumeIntercom(original.id);

    const reply = store.getIntercom('ic_r')!;
    assert.equal(reply.replyTo, 'ic_q');
    assert.equal(reply.topicId, 'ic_q', '同一话题串成一条链');
    assert.equal(reply.hops, 1);
    assert.equal(store.getIntercom('ic_q')?.status, 'answered');
  });
});

test('通道：过期的消息不再投递', () => {
  withStore((store) => {
    // 负数 TTL 让它当场过期。
    store.insertIntercom({ id: 'ic_old', fromLayer: 'router', kind: 'notice', body: '旧消息', ttlMs: -1000 });
    assert.equal(store.listPendingIntercom('watchdog').length, 0, '过期的不该被取出来');
    store.expireIntercom();
    assert.equal(store.getIntercom('ic_old')?.status, 'expired');
  });
});

test('维护者状态：只给可核对的事实，不给推测', () => {
  withStore((store) => {
    store.appendWdAction({
      id: 'wda_1',
      issueId: 'wdi_1',
      commandId: null,
      action: 'restart_main',
      reason: '代码需要生效',
      expected: '主系统重启',
      result: '成功',
    } as never);
    const status = store.maintainerStatus();
    assert.ok(status.lastRestartAt !== null, '重启记录要能读到');
    assert.deepEqual(status.openIssues, [], '没有未解决事件时是空数组，不是 null');
    assert.ok(Array.isArray(status.recentCommands));
  });
});

test('通信：路由筛选先于批次限制，定向消息保留话题且不能被 CLI 窃取', async () => {
  const { createHarness, allText } = await import('../helpers.ts');
  const { mockReply } = await import('../../src/model/mock.ts');
  const { ConversationService } = await import('../../src/channels/conversations.ts');
  const seen: string[] = [];
  const events: { type: string; sessionKey?: string | null; conversationId?: string | null; text?: string }[] = [];
  const h = await createHarness({ worker: () => mockReply({ text: 'x' }), router: (ctx) => {
    const text = allText(ctx.request); seen.push(text);
    return mockReply({ text: text.includes('原话题答复') ? '原话题答复' : '普通回复' });
  } });
  h.runtime.on((event) => events.push(event));
  try {
    const key = 'telegram|bot|owner';
    const conversations = new ConversationService(h.store);
    const first = conversations.ensureCurrent(key, '一');
    const second = conversations.create(key, '二');
    for (let i = 0; i < 6; i++) h.store.insertIntercom({ id: `ic_global_${i}`, fromLayer: 'watchdog', kind: 'notice', body: '全局' });
    h.store.insertIntercom({ id: 'ic_target', fromLayer: 'watchdog', kind: 'reply', body: '原话题答复', sessionKey: key, conversationId: first.id, routeKnown: true });
    await h.router.handleUserMessage('CLI');
    assert.ok(!seen.at(-1)!.includes('原话题答复'));
    await h.router.handleUserMessage('另一个用户', { sessionKey: 'telegram|bot|other', conversationId: second.id });
    assert.ok(!seen.at(-1)!.includes('原话题答复'));
    await h.router.notify();
    const out = events.find((event) => event.type === 'channel.outbound' && event.text === '原话题答复');
    assert.equal(out?.sessionKey, key);
    assert.equal(out?.conversationId, first.id);
    assert.equal(h.store.getIntercom('ic_target')?.status, 'consumed');
  } finally { await h.cleanup(); }
});

test('通信：维护者未答问题保持可见，回复只产生一次且保留原话题', async () => {
  const { createHarness } = await import('../helpers.ts');
  const { MockModel, mockReply } = await import('../../src/model/mock.ts');
  const { WatchdogSession } = await import('../../src/watchdog/session.ts');
  const h = await createHarness({ worker: () => mockReply({ text: 'x' }) });
  const inputs: string[] = [];
  try {
    h.store.insertIntercom({ id: 'ic_q', fromLayer: 'router', kind: 'question', body: '查明原因', sessionKey: 'peer', conversationId: 'topic', routeKnown: true });
    const session = new WatchdogSession({ store: h.store, config: h.config, modelName: 'mock', model: new MockModel((ctx) => {
      inputs.push(JSON.stringify(ctx.request.messages)); return mockReply({ text: '暂未查明' });
    }) });
    await session.runOnce(1);
    await session.runOnce(1);
    assert.ok(inputs[0]!.includes('查明原因'));
    assert.ok(inputs[1]!.includes('查明原因'));
    assert.equal(h.store.getIntercom('ic_q')?.status, 'delivered');
    const question = h.store.getIntercom('ic_q')!;
    assert.equal(h.store.replyIntercom(question, 'ic_reply', '已查明'), true);
    assert.equal(h.store.replyIntercom(question, 'ic_duplicate', '重复'), false);
    assert.equal(h.store.getIntercom('ic_duplicate'), null);
    assert.equal(h.store.getIntercom('ic_q')?.status, 'answered');
    assert.equal(h.store.getIntercom('ic_reply')?.conversationId, 'topic');
  } finally { await h.cleanup(); }
});

test('通信：维护者提问可从管理入口回复，重复回复不生成第二条', async () => {
  const { createHarness, allText } = await import('../helpers.ts');
  const { MockModel, mockReply } = await import('../../src/model/mock.ts');
  const { WatchdogSession } = await import('../../src/watchdog/session.ts');
  let step = 0;
  const h = await createHarness({ worker: () => mockReply({ text: 'x' }), router: (ctx) => {
    const prompt = allText(ctx.request);
    if (step++ === 0) return mockReply({ toolCalls: [{ name: 'read_maintainer_status', arguments: {} }] });
    if (step === 2) {
      const id = prompt.match(/ic_[a-f0-9]{8}/)?.[0];
      assert.ok(id);
      return mockReply({ toolCalls: [{ name: 'reply_intercom', arguments: { message_id: id, body: '用户反馈是卡住' } }] });
    }
    return mockReply({ text: '已回复' });
  } });
  try {
    let wdStep = 0;
    const session = new WatchdogSession({ store: h.store, config: h.config, modelName: 'mock', model: new MockModel(() =>
      wdStep++ === 0 ? mockReply({ toolCalls: [{ name: 'ask_router', arguments: { question: '用户反馈是什么' } }] }) : mockReply({ text: '等回复' })) });
    await session.runOnce(1);
    const question = h.store.listOpenIntercom('router')[0]!;
    assert.equal(question.kind, 'question');
    await h.router.handleUserMessage('查看维护消息');
    assert.equal(h.store.getIntercom(question.id)?.status, 'answered');
    const replies = h.store.listPendingIntercom('watchdog').filter((m) => m.replyTo === question.id);
    assert.equal(replies.length, 1);
    const result = await (h.router as any).executeTool('reply_intercom', JSON.stringify({ message_id: question.id, body: '重复' }));
    assert.match(result, /已回复/);
    assert.equal(h.store.listPendingIntercom('watchdog').filter((m) => m.replyTo === question.id).length, 1);
  } finally { await h.cleanup(); }
});

test('通信：Router 首次模型失败后续接仍收到原维护答复', async () => {
  const { createHarness, allText } = await import('../helpers.ts');
  const { mockReply } = await import('../../src/model/mock.ts');
  let attempts = 0; const seen: string[] = [];
  const h = await createHarness({ worker: () => mockReply({ text: 'x' }), router: (ctx) => {
    seen.push(allText(ctx.request));
    if (++attempts === 1) throw new Error('模拟失败');
    return mockReply({ text: '已恢复' });
  } });
  try {
    h.store.insertIntercom({ id: 'ic_recover', fromLayer: 'watchdog', kind: 'reply', body: '需要恢复的答复', routeKnown: true, sessionKey: 'telegram|bot|peer', conversationId: 'topic' });
    await h.router.notify();
    assert.equal(h.store.getIntercom('ic_recover')?.status, 'consumed');
    assert.ok(h.store.pendingRouterSession('telegram|bot|peer', 'topic'));
    await h.router.resume();
    assert.ok(seen[1]!.includes('需要恢复的答复'));
  } finally { await h.cleanup(); }
});

test('通信：维护者模型失败后重新启动仍能看到未答问题', async () => {
  const { createHarness } = await import('../helpers.ts');
  const { MockModel, mockReply } = await import('../../src/model/mock.ts');
  const { WatchdogSession } = await import('../../src/watchdog/session.ts');
  const h = await createHarness({ worker: () => mockReply({ text: 'x' }) });
  try {
    h.store.insertIntercom({ id: 'ic_failure', fromLayer: 'router', kind: 'question', body: '失败后恢复的问题' });
    const failed = new WatchdogSession({ store: h.store, config: h.config, modelName: 'mock', model: new MockModel(() => { throw new Error('模拟失败'); }) });
    await failed.runOnce(1);
    let seen = '';
    const restarted = new WatchdogSession({ store: h.store, config: h.config, modelName: 'mock', model: new MockModel((ctx) => { seen = JSON.stringify(ctx.request.messages); return mockReply({ text: '恢复' }); }) });
    await restarted.runOnce(1);
    assert.match(seen, /失败后恢复的问题/);
    assert.equal(h.store.getIntercom('ic_failure')?.status, 'delivered');
  } finally { await h.cleanup(); }
});

test('通信：回复事务失败不留下半条答复或错误确认', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_original', fromLayer: 'router', kind: 'question', body: '问题' });
    store.insertIntercom({ id: 'ic_duplicate', fromLayer: 'watchdog', kind: 'notice', body: '已有消息' });
    assert.throws(() => store.replyIntercom(store.getIntercom('ic_original')!, 'ic_duplicate', '答复'));
    assert.equal(store.getIntercom('ic_original')?.status, 'pending');
    assert.equal(store.getIntercom('ic_duplicate')?.body, '已有消息');
  });
});
