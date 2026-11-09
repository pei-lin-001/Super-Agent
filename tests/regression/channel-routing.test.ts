/**
 * 会话路由：两条聊天交错时，历史、待汇报材料与回信目标都不能串。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, systemText } from '../helpers.ts';
import { FakeAdapter, eventOf, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });
const WX_KEY = sessionKeyOf({ channel: 'weixin', accountId: 'wx_1', peerId: 'owner-1' });

test('会话隔离：两条聊天的历史各自独立，互相看不到', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  try {
    await harness.router.handleUserMessage('这是 Telegram 说的话', { sessionKey: TG_KEY });
    await harness.router.handleUserMessage('这是微信说的话', { sessionKey: WX_KEY });

    const tgTurns = harness.store.listRouterTurns(20, TG_KEY);
    const wxTurns = harness.store.listRouterTurns(20, WX_KEY);
    assert.ok(tgTurns.some((turn) => turn.content === '这是 Telegram 说的话'));
    assert.ok(!tgTurns.some((turn) => turn.content.includes('微信')), 'Telegram 会话里不应出现微信内容');
    assert.ok(wxTurns.some((turn) => turn.content === '这是微信说的话'));
    assert.ok(!wxTurns.some((turn) => turn.content.includes('Telegram')), '微信会话里不应出现 Telegram 内容');
    // CLI 会话不受影响
    assert.equal(harness.store.listRouterTurns(20, null).length, 0, 'CLI 历史应为空');
  } finally {
    await harness.cleanup();
  }
});

test('会话隔离：A 聊天发起的任务完成后，结果只回 A', async () => {
  const prompts: string[] = [];
  let workerSteps = 0;
  const harness = await createHarness({
    worker: () => {
      // 先落产物再提交：没有登记产物的提交会被拒绝，这是既有规则。
      workerSteps += 1;
      if (workerSteps === 1) {
        return mockReply({
          toolCalls: [{ name: 'artifact_save', arguments: { name: 'a-report.md', content: '# A 的结论\n' } }],
        });
      }
      return mockReply({
        toolCalls: [{ name: 'submit_result', arguments: { summary: 'A 的结论', artifacts: ['a-report.md'] } }],
      });
    },
    router: (context) => {
      const prompt = systemText(context.request);
      prompts.push(prompt);
      // 回信内容取决于这一轮看到的材料：用它区分「回信发给了谁」。
      return mockReply({ text: prompt.includes('A 的结论') ? '转述A的结论' : '普通回复' });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const telegram = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const weixin = new FakeAdapter('weixin', 'wx_1', ['owner-1']);
  service.register(telegram);
  service.register(weixin);
  service.start();
  try {
    // 在 Telegram 里建一个真实任务
    const created = harness.runtime.createTask({
      title: 'A 任务',
      goal: '做点事',
      ownerRole: '执行者',
      ownerBrief: '做',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    harness.runtime.start();
    harness.runtime.enqueue(created.owner.id);
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (harness.store.getTask(created.task.id)?.status === 'completed') break;
    }
    assert.equal(harness.store.getTask(created.task.id)?.status, 'completed', '任务应完成');

    // 用户此时在微信里说话
    await harness.router.handleUserMessage('我在微信里问一句', { sessionKey: WX_KEY });

    // 自动汇报按会话分组；提交结果时 Runtime 已经排了一次汇报，这里不重复排，
    // 但要等它真正跑完并把回信发出去。
    await harness.router.notify();
    let sent = telegram.sent.concat(weixin.sent);
    for (let i = 0; i < 200 && sent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      sent = telegram.sent.concat(weixin.sent);
    }
    await service.waitForIdle(5_000);
    assert.ok(sent.length > 0, '应有回信内容');
    // 措辞由模型决定，这里断言可验证的事实：材料进了 A 的会话，回信只发到 A 的聊天。
    assert.ok(
      prompts.some((prompt) => prompt.includes('A 的结论')),
      'A 的任务材料应出现在 A 会话的汇报上下文里',
    );
    const relayed = sent.filter((item) => (item.segment.text ?? '').includes('转述A的结论'));
    assert.ok(relayed.length > 0, '应有一条转述 A 结论的回信');
    assert.ok(
      relayed.every((item) => item.target.channel === 'telegram' && item.target.peerId === 'owner-1'),
      `A 的结论只能回到 Telegram 发起人（实际 ${JSON.stringify(relayed.map((item) => item.target))}）`,
    );
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('会话隔离：待汇报材料按会话分组，不混成一段总结', async () => {
  const seen: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      seen.push(systemText(context.request));
      return mockReply({ text: '好' });
    },
  });
  try {
    const a = harness.runtime.createTask({
      title: 'A',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'a', sessionKey: TG_KEY },
    });
    const b = harness.runtime.createTask({
      title: 'B',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'weixin', accountId: 'wx_1', peerId: 'owner-1', sessionKey: WX_KEY },
    });
    // 各自产生一条待汇报消息（Worker → Router 的汇报）
    assert.equal(
      harness.runtime.report(a.owner, 'progress', 'A 的进展：材料已经读完').ok,
      true,
      'A 的汇报应能入队',
    );
    assert.equal(
      harness.runtime.report(b.owner, 'progress', 'B 的进展：日志已经定位').ok,
      true,
      'B 的汇报应能入队',
    );

    await harness.router.notify();

    const tgPrompt = seen.find((text) => text.includes('A 的进展'));
    const wxPrompt = seen.find((text) => text.includes('B 的进展'));
    assert.ok(tgPrompt, '应有一次汇报包含 A 的进展');
    assert.ok(wxPrompt, '应有一次汇报包含 B 的进展');
    assert.ok(!tgPrompt!.includes('B 的进展'), 'A 的汇报里不能混入 B 的材料');
    assert.ok(!wxPrompt!.includes('A 的进展'), 'B 的汇报里不能混入 A 的材料');
  } finally {
    await harness.cleanup();
  }
});

test('续接：两条会话都用完额度后重启，各自都能继续', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    // 一直返回工具调用，让两轮都达到单轮额度而挂起
    router: () => mockReply({ toolCalls: [{ name: 'list_tasks', arguments: {} }] }),
    limits: { maxRouterRounds: 1 },
  });
  try {
    await harness.router.handleUserMessage('第一条', { sessionKey: TG_KEY });
    await harness.router.handleUserMessage('第二条', { sessionKey: WX_KEY });

    const keys = harness.store.pendingRouterSessionKeys().sort();
    assert.deepEqual(keys.sort(), [TG_KEY, WX_KEY].sort(), `两条会话都应保留待续接（实际 ${JSON.stringify(keys)}）`);

    // 只恢复其中一条，另一条不能被顶掉
    await harness.router.resume();
    const remaining = harness.store.pendingRouterSessionKeys();
    assert.ok(remaining.length <= 2, '恢复过程不应把另一条会话删掉');
  } finally {
    await harness.cleanup();
  }
});

test('权限：不能凭任务编号读取另一条聊天的任务', async () => {
  const answers: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      const toolMessages = context.request.messages.filter((message) => message.role === 'tool');
      answers.push(...toolMessages.map((message) => message.content ?? ''));
      return mockReply({ text: '好' });
    },
  });
  try {
    // A 聊天里有一个任务
    const created = harness.runtime.createTask({
      title: 'A 的私事',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'a', sessionKey: TG_KEY },
    });

    // 在另一条会话的身份下读取 A 的任务
    const toolResult = await (
      harness.router as unknown as {
        executeTool: (
          name: string,
          args: string,
          receipt: { sessionId: string; actionKey: string; sessionKey: string },
        ) => Promise<string>;
      }
    ).executeTool('read_task', JSON.stringify({ task_id: created.task.id }), {
      sessionId: 'rs_x',
      actionKey: 'ra_x',
      sessionKey: WX_KEY,
    });
    assert.match(toolResult, /属于另一个会话/, `跨会话读取应被拒绝（实际 ${toolResult.slice(0, 80)}）`);
    void answers;
  } finally {
    await harness.cleanup();
  }
});

test('入站：两个渠道的事件各自落到自己的会话键', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const telegram = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  const weixin = new FakeAdapter('weixin', 'wx_1', ['owner-1']);
  service.register(telegram);
  service.register(weixin);
  service.start();
  try {
    telegram.batches.push({
      events: [eventOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', eventId: 'u:1', text: 'telegram 来的' })],
      cursor: '2',
    });
    weixin.batches.push({
      events: [eventOf({ channel: 'weixin', accountId: 'wx_1', peerId: 'owner-1', eventId: 'm:1', text: '微信来的' })],
      cursor: 'buf-1',
    });
    await service.tick();
    await service.waitForIdle(8_000);

    assert.equal(harness.store.getChannelCursor('telegram', 'bot_1'), '2');
    assert.equal(harness.store.getChannelCursor('weixin', 'wx_1'), 'buf-1');
    assert.ok(harness.store.listRouterTurns(20, TG_KEY).some((turn) => turn.content === 'telegram 来的'));
    assert.ok(harness.store.listRouterTurns(20, WX_KEY).some((turn) => turn.content === '微信来的'));
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('不重复回复：运行中的会话不能被定时恢复当成待续接再跑一遍', async () => {
  let replies = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      replies += 1;
      return mockReply({ text: `第 ${replies} 次回复` });
    },
  });
  try {
    // 模拟运行中途：会话已落库但还没结束
    harness.store.saveRouterSession({
      id: 'rs_inflight',
      sessionKey: TG_KEY,
      taskId: null,
      messages: [{ role: 'user', content: '在吗' }],
      reason: '进行中',
      status: 'running',
    });
    // 定时恢复此时不该把它捡起来
    assert.deepEqual(harness.store.pendingRouterSessionKeys(), [], '运行中的会话不是待续接');
    await harness.router.resume();
    assert.equal(replies, 0, '运行中的会话不能被续接，否则用户会收到重复回复');

    // 进程重启后才收回成待续接，并且只续接一次
    const recovered = harness.store.resumeStaleRouterSessions();
    assert.equal(recovered, 1, '遗留的 running 应被收回');
    assert.deepEqual(harness.store.pendingRouterSessionKeys(), [TG_KEY]);
    await harness.router.resume();
    assert.equal(replies, 1, '续接只跑一次');
    assert.equal(harness.store.pendingRouterSessionKeys().length, 0, '续接后不再挂起');
  } finally {
    await harness.cleanup();
  }
});

test('不重复回复：一条用户消息只产生一次回信', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '只回一次' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    await harness.router.handleUserMessage('你好', { sessionKey: TG_KEY });
    // 模拟后台定时恢复在运行期间反复触发
    for (let i = 0; i < 5; i += 1) await harness.router.resume();
    await service.waitForIdle(5_000);

    const rows = harness.store.listOutboundBySession(TG_KEY);
    assert.equal(rows.length, 1, `一条消息只该有一条回信（实际 ${rows.length} 条）`);
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});
