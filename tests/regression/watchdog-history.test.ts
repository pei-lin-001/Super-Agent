/**
 * 维护者的连续会话：第二次请求必须结构合法。
 *
 * 程序曾经把"工具结果摘要"当正式 tool 消息重发，没有 toolCallId、没有配对的
 * assistant 调用。这里直接检查真实发出的请求体。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { mockReply, MockModel } from '../../src/model/mock.ts';
import { WatchdogSession } from '../../src/watchdog/session.ts';
import { Store } from '../../src/storage/store.ts';
import { createHarness } from '../helpers.ts';

interface Captured {
  messages: { role: string; content: string | null; toolCalls?: { id: string }[]; toolCallId?: string }[];
}

/** 校验一次真实请求的结构：每个 tool 消息都能找到发起它的 assistant 调用。 */
function assertWellFormed(messages: Captured['messages'], label: string): void {
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) seen.add(call.id);
      continue;
    }
    if (message.role === 'tool') {
      assert.ok(message.toolCallId, `${label}：第 ${index} 条 tool 消息缺少 toolCallId`);
      assert.ok(seen.has(message.toolCallId!), `${label}：工具结果 ${message.toolCallId} 没有配对的调用`);
    }
  }
}

async function makeStore(): Promise<{ store: Store; dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-wdhist-'));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: join(dir, 'work'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'k',
    MODEL_NAME: 'm',
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const store = new Store(join(dir, 'db.sqlite'));
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('连续两次问答都使用工具：第二次请求结构合法', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const captured: Captured[] = [];
    let round = 0;
    const model = new MockModel((context) => {
      captured.push({ messages: context.request.messages as Captured['messages'] });
      round += 1;
      // 每次问答：先用一个工具，再给结论
      return round % 2 === 1
        ? { text: null, reasoning: null, toolCalls: [{ id: `call_${round}`, name: 'check_main', arguments: '{}' }], finishReason: 'tool_calls', model: 'm', usage: null }
        : { text: `结论 ${round}`, reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
    });
    const config = loadConfig();
    config.limits.contextWindowTokens = 4_000;
    config.limits.routerReserveTokens = 100;
    config.limits.routerKeepRecentTokens = 500;
    const session = new WatchdogSession({
      store,
      config,
      model,
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });

    const first = await session.ask('第一次提问');
    assert.match(first, /结论/, '第一次问答要有结论');
    const second = await session.ask('第二次提问');
    assert.match(second, /结论/, '第二次问答要有结论');

    assert.ok(captured.length >= 4, `应有多次模型请求（实际 ${captured.length}）`);
    for (let i = 0; i < captured.length; i += 1) {
      assertWellFormed(captured[i]!.messages, `第 ${i + 1} 次请求`);
    }

    // 第二次问答的第一请求里必须带上第一次的对话，且没有孤立 tool
    const secondTurnFirst = captured[2]!;
    const text = secondTurnFirst.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /第一次提问/, '第二次问答应看到上一次的提问');
  } finally {
    cleanup();
  }
});

test('问答之后执行巡检，再问答：历史仍然合法', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const captured: Captured[] = [];
    let round = 0;
    const model = new MockModel((context) => {
      captured.push({ messages: context.request.messages as Captured['messages'] });
      round += 1;
      if (round === 1) {
        return { text: null, reasoning: null, toolCalls: [{ id: 'call_a', name: 'check_main', arguments: '{}' }], finishReason: 'tool_calls', model: 'm', usage: null };
      }
      if (round === 2) {
        return { text: '问答结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }
      if (round === 3) {
        return { text: null, reasoning: null, toolCalls: [{ id: 'call_b', name: 'inspect_task', arguments: '{}' }], finishReason: 'tool_calls', model: 'm', usage: null };
      }
      if (round === 4) {
        return { text: '巡检结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }
      if (round === 5) {
        return { text: null, reasoning: null, toolCalls: [{ id: 'call_c', name: 'check_main', arguments: '{}' }], finishReason: 'tool_calls', model: 'm', usage: null };
      }
      return { text: '第三轮结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
    });
    const config = loadConfig();
    config.limits.contextWindowTokens = 4_000;
    config.limits.routerReserveTokens = 100;
    config.limits.routerKeepRecentTokens = 500;
    const session = new WatchdogSession({
      store,
      config,
      model,
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });

    await session.ask('问题一');
    await session.runOnce(1);
    await session.ask('问题二');

    for (let i = 0; i < captured.length; i += 1) {
      assertWellFormed(captured[i]!.messages, `第 ${i + 1} 次请求`);
    }
  } finally {
    cleanup();
  }
});

test('重启维护进程后继续使用历史：仍然合法', async () => {
  const { store, cleanup } = await makeStore();
  try {
    let round = 0;
    const mkModel = (captured: Captured[]): MockModel =>
      new MockModel((context) => {
        captured.push({ messages: context.request.messages as Captured['messages'] });
        round += 1;
        return round % 2 === 1
          ? { text: null, reasoning: null, toolCalls: [{ id: `c${round}`, name: 'check_main', arguments: '{}' }], finishReason: 'tool_calls', model: 'm', usage: null }
          : { text: `结论${round}`, reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      });
    const config = loadConfig();
    const first = new WatchdogSession({
      store,
      config,
      model: mkModel([]),
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    await first.ask('重启前的问题');

    // 模拟进程重启：新会话对象，共用同一个数据库
    const captured: Captured[] = [];
    const second = new WatchdogSession({
      store,
      config,
      model: mkModel(captured),
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    const answer = await second.ask('重启后的问题');
    assert.match(answer, /结论/, '重启后仍能回答');
    for (let i = 0; i < captured.length; i += 1) {
      assertWellFormed(captured[i]!.messages, `重启后第 ${i + 1} 次请求`);
    }
    const text = captured[0]!.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /重启前的问题/, '重启后应能看到之前的问答');
  } finally {
    cleanup();
  }
});

test('历史选择：超出 token 预算时，最早的几轮被裁掉', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // 写 14 组问答，每条 6000 字符：总量远超 routerKeepRecentTokens（默认 40000 token ≈ 160000 字符）
    const filler = '细节'.repeat(250);
    for (let i = 1; i <= 14; i += 1) {
      store.appendWdTurn({
        id: `wdt_u${i}`,
        role: 'user',
        content: `问题-${i}｜${filler}`,
        createdAt: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      });
      store.appendWdTurn({
        id: `wdt_a${i}`,
        role: 'assistant',
        content: `回答-${i}｜${filler}`,
        createdAt: `2026-02-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      });
    }

    const captured: Captured[] = [];
    const model = new MockModel((context) => {
      captured.push({ messages: context.request.messages as Captured['messages'] });
      return { text: '结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
    });
    const config = loadConfig();
    config.limits.contextWindowTokens = 4_000;
    config.limits.routerReserveTokens = 100;
    config.limits.routerKeepRecentTokens = 500;
    const session = new WatchdogSession({
      store,
      config,
      model,
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    await session.ask('最新问题');

    // 触发压缩时会先有一次摘要调用，跳过它，看真正的回答请求。
    const answerCall = captured.find((call) => !(call.messages[0]?.content ?? '').includes('Maintain a traceable note of the Super-Agent maintenance session'))!;
    const text = answerCall.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /问题-14/, '最近的一组问答必须进入请求');
    assert.match(text, /回答-14/, '最近的一组回答必须进入请求');
    assert.doesNotMatch(text, /问题-1\b/, '最早的内容应被裁掉，不能挤占最近的历史');
    assertWellFormed(answerCall.messages, '最近历史请求');

    // 顺序必须是正序：问题在前、回答在后
    const body = answerCall.messages;
    const q14 = body.findIndex((m) => (m.content ?? '').includes('问题-14'));
    const a14 = body.findIndex((m) => (m.content ?? '').includes('回答-14'));
    assert.ok(q14 >= 0 && a14 >= 0 && q14 < a14, '同一组问答要按时间正序出现');
  } finally {
    cleanup();
  }
});

test('历史选择：重启维护进程后仍然选最近的记录', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const filler = '细节'.repeat(250);
    for (let i = 1; i <= 12; i += 1) {
      store.appendWdTurn({
        id: `wdt2_u${i}`,
        role: 'user',
        content: `重启问题-${i}｜${filler}`,
        createdAt: `2026-03-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      });
      store.appendWdTurn({
        id: `wdt2_a${i}`,
        role: 'assistant',
        content: `重启回答-${i}｜${filler}`,
        createdAt: `2026-03-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      });
    }
    const captured: Captured[] = [];
    const config = loadConfig();
    config.limits.contextWindowTokens = 4_000;
    config.limits.routerReserveTokens = 100;
    config.limits.routerKeepRecentTokens = 500;
    const session = new WatchdogSession({
      store,
      config,
      model: new MockModel((context) => {
        captured.push({ messages: context.request.messages as Captured['messages'] });
        return { text: '结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    await session.ask('重启后提问');
    const answerCall = captured.find((call) => !(call.messages[0]?.content ?? '').includes('Maintain a traceable note of the Super-Agent maintenance session'))!;
    const text = answerCall.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /重启问题-12/, '重启后仍要读到最近的问答');
    assert.doesNotMatch(text, /重启问题-1\b/, '重启后不应回退到最早的历史');
  } finally {
    cleanup();
  }
});

test('历史选择：按完整问答组裁剪，旧组进入摘要且不留下孤立 assistant', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.appendWdTurn({ id: 'leading', role: 'assistant', content: 'LEADING_INSPECTION' });
    for (let index = 1; index <= 3; index += 1) {
      store.appendWdTurn({ id: `group_u${index}`, role: 'user', content: `QUESTION_${index}` });
      store.appendWdTurn({ id: `group_a${index}`, role: 'assistant', content: `ANSWER_${index}` });
    }

    let summary = '';
    const answerCalls: Captured[] = [];
    const model = new MockModel(({ request }) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('Maintain a traceable note of the Super-Agent maintenance session')) {
        summary = request.messages.map((message) => message.content ?? '').join('\n');
        return mockReply({ text: '累计摘要-分组' });
      }
      answerCalls.push({ messages: request.messages as Captured['messages'] });
      return mockReply({ text: '最终回答' });
    });
    const config = loadConfig();
    config.limits.watchdogHistoryGroups = 2;
    config.limits.watchdogKeepRecentTokens = 10_000;
    await new WatchdogSession({ store, config, model, modelName: 'm' }).ask('当前问题');

    assert.match(summary, /LEADING_INSPECTION/);
    assert.match(summary, /QUESTION_1/);
    assert.match(summary, /ANSWER_1/);
    const answer = answerCalls[0];
    assert.ok(answer);
    const text = answer.messages.map((message) => message.content ?? '').join('\n');
    assert.doesNotMatch(text, /LEADING_INSPECTION|QUESTION_1|ANSWER_1/);
    assert.match(text, /QUESTION_2/);
    assert.match(text, /ANSWER_2/);
    assert.match(text, /QUESTION_3/);
    assert.match(text, /ANSWER_3/);

    const history = answer.messages.filter((message) =>
      message.role === 'user' || message.role === 'assistant'
    ).slice(0, -1);
    for (let index = 0; index < history.length; index += 1) {
      if (history[index]!.role === 'assistant') {
        assert.equal(history[index - 1]?.role, 'user', '历史起点不能是孤立 assistant');
      }
    }
  } finally {
    cleanup();
  }
});

test('摘要：noteInputChars 分批且每批继承上一份完整累计摘要', async () => {
  const { store, cleanup } = await makeStore();
  try {
    for (let index = 1; index <= 8; index += 1) {
      store.appendWdTurn({
        id: `batch_u${index}`,
        role: 'user',
        content: `BATCH_QUESTION_${index}｜${index}`.padEnd(900, 'u'),
      });
      store.appendWdTurn({
        id: `batch_a${index}`,
        role: 'assistant',
        content: `BATCH_ANSWER_${index}｜${index}`.padEnd(900, 'a'),
      });
    }

    const summaries: string[] = [];
    let answerText = '';
    const model = new MockModel(({ request }) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('Maintain a traceable note of the Super-Agent maintenance session')) {
        summaries.push(user);
        return mockReply({ text: `累计摘要-${summaries.length}` });
      }
      answerText = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '最终回答' });
    });
    const config = loadConfig();
    config.limits.watchdogHistoryGroups = 1;
    config.limits.watchdogKeepRecentTokens = 100;
    config.limits.noteInputChars = 2_000;
    await new WatchdogSession({ store, config, model, modelName: 'm' }).ask('分批后的当前问题');

    assert.ok(summaries.length >= 2, `应至少分成两次摘要，实际 ${summaries.length}`);
    assert.match(summaries[1]!, /# Previous note\n累计摘要-1/);
    assert.match(answerText, new RegExp(`累计摘要-${summaries.length}`));
    assert.equal(
      answerText.split('分批后的当前问题').length - 1,
      1,
      '当前问题不能同时出现在历史与本轮 prompt',
    );
    assert.ok(store.latestWatchdogNote());
  } finally {
    cleanup();
  }
});

test('摘要失败：明确告知早期历史未进入本轮，后续仍能重新压缩而不丢原文', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.appendWdTurn({ id: 'fail_u1', role: 'user', content: 'FAIL_OLD_QUESTION' });
    store.appendWdTurn({ id: 'fail_a1', role: 'assistant', content: 'FAIL_OLD_ANSWER' });
    store.appendWdTurn({ id: 'fail_u2', role: 'user', content: 'FAIL_RECENT_QUESTION' });
    store.appendWdTurn({ id: 'fail_a2', role: 'assistant', content: 'FAIL_RECENT_ANSWER' });

    let failSummary = true;
    let firstAnswer = '';
    let secondSummary = '';
    const model = new MockModel(({ request }) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('Maintain a traceable note of the Super-Agent maintenance session')) {
        if (failSummary) throw new Error('摘要模型暂时失败');
        secondSummary = user;
        return mockReply({ text: '第二次累计摘要' });
      }
      firstAnswer = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '失败后仍可回答' });
    });
    const config = loadConfig();
    config.limits.watchdogHistoryGroups = 1;
    config.limits.watchdogKeepRecentTokens = 100;
    const session = new WatchdogSession({ store, config, model, modelName: 'm' });

    await session.ask('第一次当前问题');
    assert.match(firstAnswer, /早期维护历史压缩失败/);
    assert.match(firstAnswer, /当前结论可能缺少早期细节/);
    assert.doesNotMatch(firstAnswer, /FAIL_OLD_QUESTION|FAIL_OLD_ANSWER/);
    assert.equal(store.latestWatchdogNote(), null, '整批摘要失败不能推进覆盖水位');

    failSummary = false;
    await session.ask('第二次当前问题');
    assert.match(secondSummary, /FAIL_OLD_QUESTION/, '失败后原文仍在，后续可重新摘要');
  } finally {
    cleanup();
  }
});

test('维护申请式提问不继承问答历史，当前问题只在本轮出现一次', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.appendWdTurn({ id: 'old_u', role: 'user', content: 'MAINTENANCE_OLD_QUESTION' });
    store.appendWdTurn({ id: 'old_a', role: 'assistant', content: 'MAINTENANCE_OLD_ANSWER' });
    let requestText = '';
    const model = new MockModel(({ request }) => {
      requestText = request.messages.map((message) => message.content ?? '').join('\n');
      assert.equal(request.messages.length, 2, '维护申请只应发送稳定 system 与当前请求');
      return mockReply({ text: '申请处理结论' });
    });
    const config = loadConfig();
    await new WatchdogSession({ store, config, model, modelName: 'm' })
      .ask('请只根据任务授权处理本次维护申请', { history: false });

    assert.doesNotMatch(requestText, /MAINTENANCE_OLD_QUESTION|MAINTENANCE_OLD_ANSWER/);
    assert.equal(
      requestText.split('请只根据任务授权处理本次维护申请').length - 1,
      1,
      '当前申请问题不能重复进入 history 与 prompt',
    );
  } finally {
    cleanup();
  }
});

test('历史查询先过滤 tool 日志，400 条日志不会挤掉最新问答', async () => {
  const { store, cleanup } = await makeStore();
  try {
    for (let index = 0; index < 400; index += 1) {
      store.appendWdTurn({
        id: `tool_noise_${index}`,
        role: 'tool',
        content: `TOOL_NOISE_${index}`,
      });
    }
    store.appendWdTurn({ id: 'latest_q', role: 'user', content: 'LATEST_QUESTION' });
    store.appendWdTurn({ id: 'latest_a', role: 'assistant', content: 'LATEST_ANSWER' });
    let requestText = '';
    const config = loadConfig();
    config.limits.watchdogHistoryGroups = 12;
    config.limits.watchdogKeepRecentTokens = 4_000;
    await new WatchdogSession({
      store,
      config,
      model: new MockModel(({ request }) => {
        requestText = request.messages.map((message) => message.content ?? '').join('\n');
        return mockReply({ text: '已读取最新问答' });
      }),
      modelName: 'm',
    }).ask('当前问题');
    assert.match(requestText, /LATEST_QUESTION/);
    assert.match(requestText, /LATEST_ANSWER/);
    assert.doesNotMatch(requestText, /TOOL_NOISE_/);
  } finally {
    cleanup();
  }
});

test('分页读取超过 400 组未摘要问答，最近组不因单页上限漏掉', async () => {
  const { store, cleanup } = await makeStore();
  try {
    for (let index = 1; index <= 405; index += 1) {
      store.appendWdTurn({ id: `page_u${index}`, role: 'user', content: `PAGE_QUESTION_${index}` });
      store.appendWdTurn({ id: `page_a${index}`, role: 'assistant', content: `PAGE_ANSWER_${index}` });
    }
    let summaryText = '';
    const answers: Captured[] = [];
    const model = new MockModel(({ request }) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('Maintain a traceable note of the Super-Agent maintenance session')) {
        summaryText = request.messages.map((message) => message.content ?? '').join('\n');
        return mockReply({ text: '分页累计摘要' });
      }
      answers.push({ messages: request.messages as Captured['messages'] });
      return mockReply({ text: '分页读取完成' });
    });
    const config = loadConfig();
    config.limits.watchdogHistoryGroups = 12;
    config.limits.watchdogKeepRecentTokens = 4_000;
    await new WatchdogSession({ store, config, model, modelName: 'm' }).ask('分页当前问题');

    const answer = answers[0]!;
    const text = answer.messages.map((message) => message.content ?? '').join('\n');
    assert.match(text, /PAGE_QUESTION_405/);
    assert.match(text, /PAGE_ANSWER_405/);
    assert.doesNotMatch(text, /PAGE_QUESTION_1\b/);
    assert.match(summaryText, /PAGE_QUESTION_1\b/, '第 400 条之前的旧问答应全部进入摘要，不能无痕遗漏');
  } finally {
    cleanup();
  }
});

test('任务绑定提问：Router 消息继承任务来源，未知归属不伪造路由，跨任务改投被拒绝', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const scoped = harness.runtime.createTask({
      title: '定向维护',
      goal: '核对任务',
      ownerRole: '负责人',
      ownerBrief: '执行',
      source: {
        channel: 'telegram',
        accountId: 'bot',
        peerId: 'owner',
        sessionKey: 'telegram|bot|owner',
        conversationId: 'topic-scoped',
      },
    }).task;
    const other = harness.runtime.createTask({
      title: '另一个任务',
      goal: '不能串线',
      ownerRole: '负责人',
      ownerBrief: '执行',
    }).task;

    let step = 0;
    let finalToolText = '';
    const scopedModel = new MockModel(({ request }) => {
      if (step === 0) {
        step += 1;
        return mockReply({ toolCalls: [{ name: 'notify_router', arguments: { text: '定向通报' } }] });
      }
      if (step === 1) {
        step += 1;
        return mockReply({ toolCalls: [{ name: 'ask_router', arguments: { question: '定向问题' } }] });
      }
      if (step === 2) {
        step += 1;
        return mockReply({
          toolCalls: [{
            name: 'notify_router',
            arguments: { text: '不应改投', task_id: other.id },
          }],
        });
      }
      finalToolText = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '定向处理完成' });
    });
    await new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: scopedModel,
      modelName: 'mock',
    }).ask('处理这个已授权任务', { taskId: scoped.id, history: false });

    const routed = harness.store.listOpenIntercom('router', 20);
    const notice = routed.find((message) => message.body === '定向通报');
    const question = routed.find((message) => message.body === '定向问题');
    for (const message of [notice, question]) {
      assert.ok(message);
      assert.equal(message.routeKnown, true);
      assert.equal(message.taskId, scoped.id);
      assert.equal(message.sessionKey, 'telegram|bot|owner');
      assert.equal(message.conversationId, 'topic-scoped');
    }
    assert.equal(routed.some((message) => message.body === '不应改投'), false);
    assert.match(finalToolText, /任务绑定的维护问答不能把 Router 消息改投到另一个任务/);

    let unscopedStep = 0;
    const unscopedModel = new MockModel(() => {
      if (unscopedStep++ === 0) {
        return mockReply({ toolCalls: [{ name: 'notify_router', arguments: { text: '无归属通报' } }] });
      }
      return mockReply({ text: '已保存管理入口消息' });
    });
    await new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: unscopedModel,
      modelName: 'mock',
    }).ask('没有明确任务归属', { history: false });
    const unknown = harness.store.listOpenIntercom('router', 20).find((message) => message.body === '无归属通报');
    assert.ok(unknown);
    assert.equal(unknown.routeKnown, false);
    assert.equal(unknown.taskId, null);
    assert.equal(unknown.sessionKey, null);
    assert.equal(unknown.conversationId, null);
  } finally {
    await harness.cleanup();
  }
});

test('任务绑定 record 和 CLI task-bound ask_router 保留明确任务归属', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const task = harness.runtime.createTask({
      title: 'CLI 定向',
      goal: '核对维护问题',
      ownerRole: '负责人',
      ownerBrief: '执行',
    }).task;
    let step = 0;
    const model = new MockModel(() => {
      if (step++ === 0) {
        return mockReply({
          toolCalls: [
            { name: 'record', arguments: { title: '缺少任务归属的事件' } },
            { name: 'ask_router', arguments: { question: 'CLI 任务需要 Router 回答' } },
          ],
        });
      }
      return mockReply({ text: '已登记并提问' });
    });
    await new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model,
      modelName: 'mock',
    }).ask('处理 CLI 任务', { taskId: task.id, history: false });

    const issue = harness.store.listOpenIssues()[0];
    assert.equal(issue?.taskId, task.id, 'record 未显式给 task_id 时应继承绑定任务');
    const question = harness.store.listOpenIntercom('router', 20)
      .find((message) => message.body === 'CLI 任务需要 Router 回答');
    assert.ok(question);
    assert.equal(question.routeKnown, true);
    assert.equal(question.taskId, task.id);
    assert.equal(question.sessionKey, null);
    assert.equal(question.conversationId, null);
  } finally {
    await harness.cleanup();
  }
});

test('周期巡检失败时 Router 消息保持 pending，成功处理后才会投递', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.insertIntercom({
      id: 'ic_pending_on_failure',
      fromLayer: 'router',
      kind: 'question',
      body: '必须保留到成功处理',
    });
    const config = loadConfig();
    const failed = new WatchdogSession({
      store,
      config,
      model: new MockModel(() => {
        throw new Error('模型暂时失败');
      }),
      modelName: 'm',
    });
    await assert.rejects(() => failed.runOnce(10), /模型暂时失败/);
    assert.equal(store.getIntercom('ic_pending_on_failure')?.status, 'pending');

    const succeeded = new WatchdogSession({
      store,
      config,
      model: new MockModel(() => mockReply({ text: '已处理' })),
      modelName: 'm',
    });
    await succeeded.runOnce(10);
    assert.equal(store.getIntercom('ic_pending_on_failure')?.status, 'delivered');
  } finally {
    cleanup();
  }
});
