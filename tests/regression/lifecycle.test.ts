/**
 * 执行生命周期：底层模型客户端完全不理会取消时，迟到结果必须被挡在业务之外。
 *
 * 这里用可控的模型替身，而不是 HTTP 服务器：fetch 在收到 abort 时会自己结束，
 * 那个场景证明不了"应用里的调用真的在关库之后才返回"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { ModelError, type ChatRequest, type ModelClient, type StepResult } from '../../src/model/types.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';

/** 记录每次调用，由测试手动决定什么时候返回、返回什么。 */
class ControlledModel implements ModelClient {
  readonly kind = 'mock' as const;
  readonly label = 'controlled';
  readonly calls: { request: ChatRequest; resolve: (r: StepResult) => void; reject: (e: unknown) => void }[] = [];

  chat(request: ChatRequest): Promise<StepResult> {
    return new Promise<StepResult>((resolve, reject) => {
      this.calls.push({ request, resolve, reject });
    });
  }

  /** 返回一个"看起来正常"的结果，但完全无视 abort 信号。 */
  static reply(text: string): StepResult {
    return {
      text,
      reasoning: null,
      toolCalls: [],
      finishReason: 'stop',
      model: 'm',
      usage: { promptTokens: 3, completionTokens: 2 },
      httpAttempts: 1,
    };
  }
}

interface Ctx {
  runtime: Runtime;
  store: Store;
  model: ControlledModel;
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeCtx(model: ControlledModel, dir: string): Promise<Ctx> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: join(dir, 'work'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'k',
    MODEL_NAME: 'm',
    MODEL_TIMEOUT_MS: '600000',
    MODEL_RETRY: '1',
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const runtime = new Runtime({ store, config, workerModel: model });
  return {
    runtime,
    store,
    model,
    dir,
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

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
};

function captureRejections(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const handler = (reason: unknown): void => {
    errors.push(reason);
  };
  process.on('unhandledRejection', handler);
  return { errors, stop: () => process.off('unhandledRejection', handler) };
}

test('Worker：模型完全忽略取消，迟到成功后不再写库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-life-'));
  const model = new ControlledModel();
  const h = await makeCtx(model, dir);
  const watch = captureRejections();
  try {
    h.runtime.start();
    const { task } = h.runtime.createTask({ title: '迟到成功', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    assert.ok(await waitFor(() => model.calls.length === 1, 5_000), '必须先发出模型调用');

    await h.runtime.stop();
    h.store.close();
    assert.equal(h.store.isClosed, true, '数据库已关闭');

    // 明确在关库之后释放底层结果
    model.calls[0]!.resolve(ControlledModel.reply('迟到的成功响应'));
    await new Promise((r) => setTimeout(r, 200));

    watch.stop();
    assert.deepEqual(watch.errors, [], `不应有未处理异常：${watch.errors.map(String).join('|')}`);

    const db = new (await import('node:sqlite')).DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true });
    const taskRow = db.prepare('SELECT status FROM task WHERE id = ?').get(task.id) as { status: string };
    const calls = db.prepare('SELECT status FROM model_call').all() as { status: string }[];
    db.close();
    assert.notEqual(taskRow.status, 'failed', '迟到响应不能把任务改成失败');
    assert.ok(calls.every((row) => row.status !== 'ok'), '迟到成功不能把调用记成成功');
  } finally {
    watch.stop();
    await h.cleanup();
  }
});

test('Worker：模型完全忽略取消，迟到失败后不产生未处理拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-life-'));
  const model = new ControlledModel();
  const h = await makeCtx(model, dir);
  const watch = captureRejections();
  try {
    h.runtime.start();
    h.runtime.createTask({ title: '迟到失败', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    assert.ok(await waitFor(() => model.calls.length === 1, 5_000), '必须先发出模型调用');

    await h.runtime.stop();
    h.store.close();

    model.calls[0]!.reject(new ModelError('迟到的失败', { kind: 'provider', status: 500 }));
    await new Promise((r) => setTimeout(r, 200));

    watch.stop();
    assert.deepEqual(watch.errors, [], `不应有未处理异常：${watch.errors.map(String).join('|')}`);
  } finally {
    watch.stop();
    await h.cleanup();
  }
});

test('Router：模型忽略取消，迟到的响应不能写历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-life-'));
  const model = new ControlledModel();
  const h = await makeCtx(model, dir);
  const watch = captureRejections();
  try {
    const { Router } = await import('../../src/runtime/router.ts');
    const router = new Router(h.runtime, model, loadConfig());
    const pending = router.handleUserMessage('请汇报').catch(() => undefined);
    assert.ok(await waitFor(() => model.calls.length === 1, 5_000), 'Router 必须先发出调用');

    await h.runtime.stop();
    h.store.close();
    model.calls[0]!.resolve(ControlledModel.reply('迟到的协调结论'));
    await pending;
    await new Promise((r) => setTimeout(r, 200));

    watch.stop();
    assert.deepEqual(watch.errors, [], `不应有未处理异常：${watch.errors.map(String).join('|')}`);

    const db = new (await import('node:sqlite')).DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true });
    const sessions = db.prepare('SELECT messages, reason FROM router_session').all() as {
      messages: string;
      reason: string;
    }[];
    const decisions = db.prepare('SELECT COUNT(*) AS c FROM router_decision').get() as { c: number };
    db.close();
    // 会话在发请求前就会保存（这是设计），但迟到的结果不能进入历史，也不能产生新决策。
    assert.ok(
      sessions.every((row) => !row.messages.includes('迟到的协调结论')),
      '迟到响应不能写入会话历史',
    );
    assert.equal(decisions.c, 0, '迟到的 Router 响应不应产生决策记录');
  } finally {
    watch.stop();
    await h.cleanup();
  }
});

test('工作记录整理：停机后迟到的整理结果不能安装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-life-'));
  const model = new ControlledModel();
  const h = await makeCtx(model, dir);
  const watch = captureRejections();
  try {
    const { runNote } = await import('../../src/runtime/note.ts');
    const task = h.store.createTask({
      id: 'task_note',
      groupId: 'grp_note',
      title: '整理',
      goal: 'g',
      brief: '',
      doneCriteria: '',
      requireReview: false,
      reviewEpoch: 0,
      ownerWorkerId: null,
      status: 'active',
      closeReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    });
    const worker = h.store.createWorker({
      id: 'w1_note',
      groupId: task.groupId,
      parentId: null,
      role: 'r',
      brief: 'b',
      status: 'running',
      model: null,
      stepCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
    });

    const pending = runNote({
      model,
      modelName: 'm',
      store: h.store,
      signal: h.runtime.lifecycleSignal,
      worker,
      task,
      decision: { action: 'none', reason: '无事可做', fromSeq: 0, toSeq: 0, turns: [], chars: 0, coveredSeq: 0, previous: null },
      limits: loadConfig().limits,
    }).catch(() => undefined);

    assert.ok(await waitFor(() => model.calls.length === 1, 5_000), '整理必须先发出调用');
    await h.runtime.stop();
    h.store.close();
    model.calls[0]!.resolve(ControlledModel.reply('迟到的整理结果'));
    await pending;
    await new Promise((r) => setTimeout(r, 200));

    watch.stop();
    assert.deepEqual(watch.errors, [], `不应有未处理异常：${watch.errors.map(String).join('|')}`);
  } finally {
    watch.stop();
    await h.cleanup();
  }
});

test('用户取消任务后：迟到的响应不能把任务恢复成活动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-life-'));
  const model = new ControlledModel();
  const h = await makeCtx(model, dir);
  try {
    h.runtime.start();
    const { task } = h.runtime.createTask({ title: '取消后迟到', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    assert.ok(await waitFor(() => model.calls.length === 1, 5_000), '必须先发出模型调用');

    await h.runtime.stopTask(task.id, '用户取消');
    model.calls[0]!.resolve(ControlledModel.reply('迟到的成功'));
    await new Promise((r) => setTimeout(r, 300));

    const after = h.store.getTask(task.id);
    assert.equal(after?.status, 'cancelled', `取消不能被迟到响应覆盖（实际 ${after?.status}）`);
  } finally {
    await h.cleanup();
  }
});
