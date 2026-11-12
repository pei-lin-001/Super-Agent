/**
 * 对话话题：同一个聊天窗口里的多个话题，历史、任务、续接、回信归属都要分清。
 *
 * 三层身份：聊天入口（session_key）/ 对话话题（conversation_id）/ 一次 Router 执行（router_session）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { allText, createHarness, systemText } from '../helpers.ts';
import { FakeAdapter, eventOf, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import { ConversationService, autoTitle, parseCommand } from '../../src/channels/conversations.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });

test('话题命令解析：只认明确的话题命令，其余交给模型', () => {
  assert.deepEqual(parseCommand('/new 季度报告'), { kind: 'new', title: '季度报告' });
  assert.deepEqual(parseCommand('/new'), { kind: 'new', title: null });
  assert.deepEqual(parseCommand('/list'), { kind: 'list' });
  assert.deepEqual(parseCommand('/use 2'), { kind: 'use', ref: '2' });
  assert.deepEqual(parseCommand('/name 改个名'), { kind: 'name', title: '改个名' });
  // 不是话题命令：不能被当成命令吃掉
  assert.equal(parseCommand('帮我做一份季度报告'), null);
  assert.equal(parseCommand('/help'), null);
  assert.equal(parseCommand('/use'), null);
});

test('自动起名：压掉换行，超过 20 字截断', () => {
  assert.equal(autoTitle('季度报告\n请帮我写'), '季度报告 请帮我写');
  assert.equal(autoTitle('   '), '新话题');
  assert.equal(autoTitle('一'.repeat(30)), `${'一'.repeat(20)}…`);
});

test('话题隔离：同一聊天里两个话题的历史互不可见', async () => {
  const prompts: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      prompts.push(allText(context.request));
      return mockReply({ text: '好的' });
    },
  });
  const conversations = new ConversationService(harness.store);
  try {
    const first = conversations.ensureCurrent(TG_KEY, '这是话题一说的秘密');
    await harness.router.handleUserMessage('这是话题一说的秘密', {
      sessionKey: TG_KEY,
      conversationId: first.id,
    });

    const second = conversations.create(TG_KEY, '话题二');
    await harness.router.handleUserMessage('这是话题二说的话', {
      sessionKey: TG_KEY,
      conversationId: second.id,
    });

    // 每个话题只装自己的问答，互不串
    const oneTurns = harness.store.listRouterTurns(20, TG_KEY, first.id);
    const twoTurns = harness.store.listRouterTurns(20, TG_KEY, second.id);
    assert.deepEqual(
      oneTurns.map((turn) => [turn.role, turn.content]),
      [['user', '这是话题一说的秘密'], ['assistant', '好的']],
      '用户消息与回答必须都落在同一个话题里',
    );
    assert.deepEqual(
      twoTurns.map((turn) => [turn.role, turn.content]),
      [['user', '这是话题二说的话'], ['assistant', '好的']],
    );

    // 话题二的 Router 请求里不能带上话题一的内容
    const lastPrompt = prompts[prompts.length - 1]!;
    assert.ok(!lastPrompt.includes('话题一说的秘密'), '话题二不能看到话题一的历史');
    // 本轮消息现在与「系统当前状态」拼在同一条 user 里，所以它必然出现；
    // 要验证的是「历史里没有重复一份」——只出现一次才对。
    const occurrences = lastPrompt.split('这是话题二说的话').length - 1;
    assert.equal(occurrences, 1, '历史里不该重复当前这条');
  } finally {
    await harness.cleanup();
  }
});

test('话题隔离：任务归属原话题，别的话题里看不到也改不了', async () => {
  const toolResults: string[] = [];
  let target: string | null = null;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      // 每轮都把工具回执原样当答案，便于断言模型实际看到了什么
      const tools = context.request.messages.filter((message) => message.role === 'tool');
      const last = tools[tools.length - 1];
      if (last) toolResults.push(last.content ?? '');
      const userMessages = context.request.messages.filter((message) => message.role === 'user');
      const state = userMessages.at(-1)?.content ?? '';
      assert.match(state, /系统当前状态/, '动态状态必须作为独立尾部消息');
      const userTurn = userMessages.at(-2)?.content ?? '';
      // 「停掉」这轮真的去调用工具：授权必须由代码拒绝，而不是靠模型自觉
      if (userTurn.includes('停掉') && target !== null) {
        return mockReply({ toolCalls: [{ name: 'stop_task', arguments: { task_id: target, reason: '用户要求' } }] });
      }
      return mockReply({ text: last?.content ?? '好的' });
    },
  });
  const conversations = new ConversationService(harness.store);
  try {
    const alpha = conversations.create(TG_KEY, '甲话题');
    const { task } = harness.runtime.createTask({
      title: '甲话题的任务',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: {
        channel: 'telegram',
        accountId: 'bot_1',
        peerId: 'owner-1',
        sessionKey: TG_KEY,
        conversationId: alpha.id,
      },
    });

    target = task.id;
    const beta = conversations.create(TG_KEY, '乙话题');
    await harness.router.handleUserMessage('看看有哪些任务', {
      sessionKey: TG_KEY,
      conversationId: beta.id,
    });

    assert.equal(harness.store.listTasks().length, 1, '任务本身仍然在库里');
    const prompts = toolResults.join('\n');
    assert.ok(!prompts.includes(task.id), `乙话题里不应出现甲话题的任务（实际回执：${prompts.slice(0, 200)}）`);

    // 换个话题也不能凭编号改它
    await harness.router.handleUserMessage(`把 ${task.id} 停掉`, {
      sessionKey: TG_KEY,
      conversationId: beta.id,
    });
    assert.equal(harness.store.getTask(task.id)!.status, 'active', '别的话题不能停掉本话题的任务');
    assert.ok(
      toolResults.some((text) => text.includes('属于另一个会话')),
      `拒绝要作为工具回执写清楚（实际回执：${toolResults.join(' | ').slice(0, 300)}）`,
    );
  } finally {
    await harness.cleanup();
  }
});

test('命令走代码：/new /list /use 不经过模型', async () => {
  let modelCalls = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      modelCalls += 1;
      return mockReply({ text: '模型不该被调用' });
    },
  });
  const conversations = new ConversationService(harness.store);
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    for (const [index, text] of ['第一条消息', '/new 新话题名', '/list', '/use 1'].entries()) {
      adapter.batches.push({
        events: [
          eventOf({
            channel: 'telegram',
            accountId: 'bot_1',
            peerId: 'owner-1',
            eventId: `update:${index + 1}`,
            text,
          }),
        ],
        cursor: String(index + 2),
      });
      await service.tick();
      await service.waitForIdle(5_000);
    }
    // 只有第一条普通消息进了模型
    assert.equal(modelCalls, 1, `话题命令不应该调用模型（实际 ${modelCalls} 次）`);
    const titles = conversations.list(TG_KEY).map((item) => item.title);
    assert.equal(titles.length, 2, `应有 2 个话题（实际 ${titles.join('、')}）`);
    assert.ok(titles.includes('第一条消息'), '首条消息自动成为默认话题名');
    assert.ok(titles.includes('新话题名'), '/new 指定的名字要生效');

    const sent = adapter.sent.map((item) => item.segment.text ?? '');
    assert.ok(
      sent.some((text) => text.includes('已新建并切换到话题「新话题名」')),
      `/new 要有确定性回复（实际：${JSON.stringify(sent)}）`,
    );
    assert.ok(sent.some((text) => text.includes('1. 第一条消息')), `/list 要列出编号（实际：${JSON.stringify(sent)}）`);
    assert.ok(sent.some((text) => text.includes('已切换到话题「第一条消息」')), '/use 1 要切回第一个话题');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('旧话题的回信：发到当前聊天并标注话题名，不写进当前话题的答案', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const conversations = new ConversationService(harness.store);
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const old = conversations.create(TG_KEY, '季度报告');
    conversations.create(TG_KEY, '另一个话题');
    harness.runtime.publish({
      type: 'channel.outbound',
      sessionKey: TG_KEY,
      text: '报告写完了',
      taskId: null,
      artifact: null,
      conversationId: old.id,
    });
    await service.drainOutbound();

    const sent = adapter.sent.map((item) => item.segment.text);
    assert.ok(
      sent.some((text) => text === '【季度报告】报告写完了'),
      `旧话题的回信要带话题名（实际：${JSON.stringify(sent)}）`,
    );
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('续接按话题：两个话题各自挂起，重启后都能继续', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ toolCalls: [{ name: 'list_tasks', arguments: {} }] }),
    limits: { maxRouterRounds: 1 },
  });
  const conversations = new ConversationService(harness.store);
  try {
    const alpha = conversations.create(TG_KEY, '甲');
    const beta = conversations.create(TG_KEY, '乙');
    await harness.router.handleUserMessage('甲的活', { sessionKey: TG_KEY, conversationId: alpha.id });
    await harness.router.handleUserMessage('乙的活', { sessionKey: TG_KEY, conversationId: beta.id });

    const pending = harness.store.pendingRouterSessions();
    assert.deepEqual(
      pending.map((item) => item.conversationId).sort(),
      [alpha.id, beta.id].sort(),
      `两个话题都应保留待续接（实际 ${JSON.stringify(pending)}）`,
    );

    await harness.router.resume();
    const after = harness.store.pendingRouterSessionKeys();
    assert.ok(after.length <= 1, `恢复后不应把另一个话题顶掉（剩余 ${after.length}）`);
  } finally {
    await harness.cleanup();
  }
});

test('第一句话就是 /new 时，当前话题指针也要落库（否则后面的 /use 会静悄悄失效）', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const conversations = new ConversationService(harness.store);
  try {
    const first = conversations.create(TG_KEY, '甲');
    conversations.create(TG_KEY, '乙');
    assert.equal(harness.store.currentConversationId(TG_KEY), conversations.list(TG_KEY).at(-1)!.id);

    const switched = conversations.switchTo(TG_KEY, '1');
    assert.equal(switched?.id, first.id);
    assert.equal(harness.store.currentConversationId(TG_KEY), first.id, '切换结果必须真的持久化');
  } finally {
    await harness.cleanup();
  }
});

test('升级兼容：话题上线前的历史会被收进第一个话题，不丢上下文', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const conversations = new ConversationService(harness.store);
  try {
    // 模拟升级前的数据：有会话键、没有话题归属
    await harness.router.handleUserMessage('升级前说过的话', { sessionKey: TG_KEY });
    const before = harness.store.listRouterTurns(20, TG_KEY, 'cv_nonexistent');
    assert.equal(before.length, 0, '按不存在的话题查不到东西');

    const first = conversations.ensureCurrent(TG_KEY, '升级后第一句');
    const turns = harness.store.listRouterTurns(20, TG_KEY, first.id);
    assert.ok(
      turns.some((turn) => turn.content === '升级前说过的话'),
      `升级前的历史应被收进第一个话题（实际 ${JSON.stringify(turns.map((t) => t.content))}）`,
    );
  } finally {
    await harness.cleanup();
  }
});

test('同一话题追问：第二轮请求必须包含上一轮的回答', async () => {
  const seen: string[][] = [];
  let round = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: (context) => {
      seen.push(
        context.request.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => `${message.role}:${message.content}`),
      );
      round += 1;
      return mockReply({ text: round === 1 ? '审查专用答案_ALPHA_739' : '解释完了' });
    },
  });
  const conversations = new ConversationService(harness.store);
  try {
    const topic = conversations.create(TG_KEY, '追问测试');
    await harness.router.handleUserMessage('请给一个答案', { sessionKey: TG_KEY, conversationId: topic.id });
    await harness.router.handleUserMessage('解释你刚才的答案', {
      sessionKey: TG_KEY,
      conversationId: topic.id,
    });

    const second = seen[1]!.join('\n');
    assert.ok(
      second.includes('审查专用答案_ALPHA_739'),
      `第二轮必须看到上一轮回答（实际：${second}）`,
    );
  } finally {
    await harness.cleanup();
  }
});

test('同轮新建话题：之后建立的任务属于新话题', async () => {
  let round = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      round += 1;
      if (round === 1) return mockReply({ toolCalls: [{ name: 'conversation_new', arguments: { title: '乙' } }] });
      if (round === 2) {
        return mockReply({
          toolCalls: [
            {
              name: 'create_task',
              arguments: { title: '乙任务', goal: 'g', owner_role: 'r', owner_brief: 'b' },
            },
          ],
        });
      }
      return mockReply({ text: '建好了' });
    },
  });
  const conversations = new ConversationService(harness.store);
  try {
    const alpha = conversations.create(TG_KEY, '甲');
    await harness.router.handleUserMessage('新开乙话题并建乙的任务', {
      sessionKey: TG_KEY,
      conversationId: alpha.id,
    });

    const beta = conversations.list(TG_KEY).at(-1)!;
    assert.notEqual(beta.id, alpha.id, '应有第二个话题');
    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1, '应建了一个任务');
    assert.equal(tasks[0]!.sourceConversationId, beta.id, '任务必须属于同轮新建的乙话题');
  } finally {
    await harness.cleanup();
  }
});

test('归档：编号不重排，归档话题可以通过 /use 恢复', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const conversations = new ConversationService(harness.store);
  try {
    const a = conversations.create(TG_KEY, '甲');
    const b = conversations.create(TG_KEY, '乙');
    const c = conversations.create(TG_KEY, '丙');

    // 归档乙：甲的编号仍是 1，丙仍是 3
    conversations.switchTo(TG_KEY, '2');
    assert.match(conversations.handleCommand(TG_KEY, '/archive') ?? '', /已归档话题「乙」/);
    const list = conversations.handleCommand(TG_KEY, '/list') ?? '';
    assert.match(list, /1\. 甲/, `甲的编号不能变（实际：${list}）`);
    assert.match(list, /3\. 丙/, `丙的编号不能变（实际：${list}）`);
    assert.match(list, /2\. 乙（已归档）/, '归档话题仍要出现在列表里');

    // 切回归档话题 = 恢复
    const restored = conversations.switchTo(TG_KEY, '2');
    assert.equal(restored?.id, b.id);
    assert.equal(harness.store.getConversation(b.id)?.status, 'active', '切到归档话题要恢复它');
    assert.equal(harness.store.currentConversationId(TG_KEY), b.id);
    assert.equal(harness.store.getConversation(a.id)?.status, 'active');
    assert.equal(harness.store.getConversation(c.id)?.status, 'active');
  } finally {
    await harness.cleanup();
  }
});
