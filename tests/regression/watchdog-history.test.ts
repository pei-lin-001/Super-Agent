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
import { MockModel } from '../../src/model/mock.ts';
import { WatchdogSession } from '../../src/watchdog/session.ts';
import { Store } from '../../src/storage/store.ts';

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
    const session = new WatchdogSession({
      store,
      config: loadConfig(),
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
    const session = new WatchdogSession({
      store,
      config: loadConfig(),
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

test('历史选择：超过十组问答后，最新的几轮进入请求', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // 写 14 组问答
    for (let i = 1; i <= 14; i += 1) {
      store.appendWdTurn({
        id: `wdt_u${i}`,
        role: 'user',
        content: `问题-${i}`,
        createdAt: `2026-02-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      });
      store.appendWdTurn({
        id: `wdt_a${i}`,
        role: 'assistant',
        content: `回答-${i}`,
        createdAt: `2026-02-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      });
    }

    const captured: Captured[] = [];
    const model = new MockModel((context) => {
      captured.push({ messages: context.request.messages as Captured['messages'] });
      return { text: '结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
    });
    const session = new WatchdogSession({
      store,
      config: loadConfig(),
      model,
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    await session.ask('最新问题');

    const text = captured[0]!.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /问题-14/, '最近的一组问答必须进入请求');
    assert.match(text, /回答-14/, '最近的一组回答必须进入请求');
    assert.doesNotMatch(text, /问题-1\b/, '最早的内容应被裁掉，不能挤占最近的历史');
    assertWellFormed(captured[0]!.messages, '最近历史请求');

    // 顺序必须是正序：问题在前、回答在后
    const body = captured[0]!.messages;
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
    for (let i = 1; i <= 12; i += 1) {
      store.appendWdTurn({
        id: `wdt2_u${i}`,
        role: 'user',
        content: `重启问题-${i}`,
        createdAt: `2026-03-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      });
      store.appendWdTurn({
        id: `wdt2_a${i}`,
        role: 'assistant',
        content: `重启回答-${i}`,
        createdAt: `2026-03-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      });
    }
    const captured: Captured[] = [];
    const session = new WatchdogSession({
      store,
      config: loadConfig(),
      model: new MockModel((context) => {
        captured.push({ messages: context.request.messages as Captured['messages'] });
        return { text: '结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      modelName: 'm',
      restartMain: async () => ({ ok: true, message: 'ok' }),
      health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
    });
    await session.ask('重启后提问');
    const text = captured[0]!.messages.map((m) => m.content ?? '').join('\n');
    assert.match(text, /重启问题-12/, '重启后仍要读到最近的问答');
    assert.doesNotMatch(text, /重启问题-1\b/, '重启后不应回退到最早的历史');
  } finally {
    cleanup();
  }
});
