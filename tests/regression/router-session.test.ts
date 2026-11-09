/**
 * Router 会话：历史不能倒退，唤醒不能重复，操作与回执不能错位。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { MockModel } from '../../src/model/mock.ts';
import type { ChatMessage } from '../../src/model/types.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Router } from '../../src/runtime/router.ts';
import { Store } from '../../src/storage/store.ts';

async function makeHarness(rounds = 1): Promise<{
  runtime: Runtime;
  store: Store;
  config: ReturnType<typeof loadConfig>;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rs-'));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: join(dir, 'work'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'k',
    MODEL_NAME: 'm',
    MAX_ROUTER_ROUNDS: String(rounds),
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const runtime = new Runtime({
    store,
    config,
    workerModel: new MockModel(() => ({
      text: null,
      reasoning: null,
      toolCalls: [],
      finishReason: 'stop',
      model: 'm',
      usage: null,
    })),
  });
  return {
    runtime,
    store,
    config,
    cleanup: async () => {
      await runtime.stop();
      if (!store.isClosed) store.close();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const createTaskCall = (title: string, id: string) => ({
  id,
  name: 'create_task',
  arguments: JSON.stringify({ title, goal: 'g', owner_role: 'r', owner_brief: 'b' }),
});

test('会话历史：续接建 B 之后，下一次请求里能看到 A 和 B 的完整调用与结果', async () => {
  const h = await makeHarness(1);
  try {
    const requests: ChatMessage[][] = [];
    let round = 0;
    const router = new Router(
      h.runtime,
      new MockModel((context) => {
        requests.push([...(context.request.messages as ChatMessage[])]);
        round += 1;
        if (round === 1) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('任务A', 'a1')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        if (round === 2) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('任务B', 'b1')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        return { text: '两个任务都建好了', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      h.config,
    );

    await router.handleUserMessage('建两个任务').catch(() => undefined);
    assert.equal(h.store.listTasks().length, 1, '第一轮只建了 A');
    assert.ok(h.store.pendingRouterSession(), '额度用完应保留会话');

    await router.resume().catch(() => undefined);
    assert.equal(h.store.listTasks().length, 2, '续接建了 B');

    await router.resume().catch(() => undefined);
    assert.equal(h.store.listTasks().length, 2, '第三轮不再新建任务');

    // 第三次请求必须同时包含 A 与 B 的调用和结果
    assert.ok(requests.length >= 3, `应有至少三次请求（实际 ${requests.length}）`);
    const third = requests[2]!;
    const toolIds = new Set(
      third.filter((m) => m.role === 'assistant' && m.toolCalls).flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)),
    );
    const toolResults = third.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    assert.ok(toolIds.has('a1'), '第三次请求应包含任务 A 的调用');
    assert.ok(toolIds.has('b1'), '第三次请求应包含任务 B 的调用');
    assert.deepEqual(
      toolResults.sort(),
      [...toolIds].sort(),
      '每个调用都要有配对的结果，不能缺也不能多',
    );

    // 会话在真正完成后关闭，不留下 pending 让 tick 再跑一次
    assert.equal(h.store.pendingRouterSession(), null, '完成后不应遗留待续接会话');
  } finally {
    await h.cleanup();
  }
});

test('重复唤醒：同一会话并发 resume 三次，只产生一次续接执行', async () => {
  const h = await makeHarness(1);
  try {
    let calls = 0;
    const router = new Router(
      h.runtime,
      new MockModel(() => {
        calls += 1;
        if (calls === 1) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('并发任务', 'c1')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        return { text: '完成', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      h.config,
    );
    await router.handleUserMessage('开始').catch(() => undefined);
    const afterFirst = calls;
    assert.equal(afterFirst, 1, '第一轮一次调用');

    await Promise.all([router.resume(), router.resume(), router.resume()].map((p) => p.catch(() => undefined)));
    const extra = calls - afterFirst;
    assert.ok(extra <= 1, `并发续接不应重复调用模型（额外 ${extra} 次）`);
    assert.equal(h.store.listTasks().length, 1, '业务效果只有一份');
  } finally {
    await h.cleanup();
  }
});

test('操作与回执：业务变更后回执保存失败，恢复时不会重复建任务', async () => {
  const h = await makeHarness(1);
  try {
    let calls = 0;
    const router = new Router(
      h.runtime,
      new MockModel(() => {
        calls += 1;
        if (calls === 1) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('只应有一个', 'x1')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        return { text: '完成', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      h.config,
    );
    await router.handleUserMessage('建一个任务').catch(() => undefined);
    assert.equal(h.store.listTasks().length, 1);

    // 模拟"业务已生效、回执丢失"：删掉操作回执，保留会话进度
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(h.store.path);
    db.prepare('DELETE FROM router_action').run();
    db.close();

    await router.resume().catch(() => undefined);
    const titles = h.store.listTasks().map((t) => t.title);
    assert.equal(titles.filter((t) => t === '只应有一个').length, 1, `恢复后不能重复建任务（实际 ${titles.join(',')}）`);
  } finally {
    await h.cleanup();
  }
});

test('事务边界：事务内写回执失败时，任务不会被建出来', async () => {
  const h = await makeHarness(1);
  try {
    // 让回执写入在事务内直接抛错，模拟"业务变更成功、回执保存失败"的崩溃点
    const original = h.store.saveRouterAction.bind(h.store);
    let shouldFail = true;
    h.store.saveRouterAction = ((input: Parameters<Store['saveRouterAction']>[0]) => {
      if (shouldFail) throw new Error('注入：回执写入失败');
      return original(input);
    }) as Store['saveRouterAction'];

    const router = new Router(
      h.runtime,
      new MockModel(() => ({
        text: null,
        reasoning: null,
        toolCalls: [createTaskCall('事务任务', 't1')],
        finishReason: 'tool_calls',
        model: 'm',
        usage: null,
      })),
      h.config,
    );

    await router.handleUserMessage('建一个任务').catch(() => undefined);
    assert.equal(h.store.listTasks().length, 0, '回执失败时任务不应残留');

    // 恢复执行：不应该出现"半成品"重复
    shouldFail = false;
    await router.resume().catch(() => undefined);
    const titles = h.store.listTasks().map((t) => t.title);
    assert.equal(titles.filter((t) => t === '事务任务').length, 1, `恢复后只应有一个任务（实际 ${titles.join(',')}）`);
  } finally {
    await h.cleanup();
  }
});

test('新决策同名同参数：仍然产生第二次合法操作', async () => {
  const h = await makeHarness(6);
  try {
    let call = 0;
    const router = new Router(
      h.runtime,
      new MockModel(() => {
        call += 1;
        if (call === 1) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('同名任务', 's1')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        if (call === 2) {
          return { text: null, reasoning: null, toolCalls: [createTaskCall('同名任务', 's2')], finishReason: 'tool_calls', model: 'm', usage: null };
        }
        return { text: '两个都建好了', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
      }),
      h.config,
    );
    await router.handleUserMessage('建两个同名任务').catch(() => undefined);
    const same = h.store.listTasks().filter((t) => t.title === '同名任务');
    assert.equal(same.length, 2, `参数相同的两次合法操作都应生效（实际 ${same.length}）`);
  } finally {
    await h.cleanup();
  }
});
