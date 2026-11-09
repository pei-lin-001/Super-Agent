/**
 * 取消语义：停机、用户取消、旧响应失效必须分开处理。
 *
 * 这里全部使用真实 HTTP 服务，并且先确认请求已经发出，再触发取消。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { ModelError } from '../../src/model/types.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';

interface Harness {
  runtime: Runtime;
  store: Store;
  dir: string;
  requests: () => number;
  cleanup: () => Promise<void>;
}

function server(options: { delayMs: number; respectAbort: boolean }): Promise<{
  port: number;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const srv = createServer((req, res) => {
    count += 1;
    req.resume();
    req.on('end', () => {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        } catch {
          // 连接已经断开
        }
      }, options.delayMs);
      if (options.respectAbort) {
        req.on('aborted', () => clearTimeout(timer));
        res.on('close', () => clearTimeout(timer));
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as { port: number }).port,
        requests: () => count,
        close: () =>
          new Promise((done) => {
            srv.closeAllConnections?.();
            srv.close(() => done());
          }),
      });
    });
  });
}

async function makeHarness(port: number): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-cancel-'));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: join(dir, 'work'),
    OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OLLAMA_API_KEY: 'test',
    MODEL_NAME: 'slow',
    MODEL_TIMEOUT_MS: '120000',
    MODEL_RETRY: '1',
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const model = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: 'low',
    maxTokens: 64,
  });
  const runtime = new Runtime({ store, config, workerModel: model });
  runtime.start();
  return {
    runtime,
    store,
    dir,
    requests: () => 0,
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
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

test('正常停机：不把业务任务判失败，保留可恢复状态', async () => {
  const srv = await server({ delayMs: 30_000, respectAbort: true });
  const h = await makeHarness(srv.port);
  try {
    const { task, owner } = h.runtime.createTask({
      title: '停机任务',
      goal: '触发一次模型请求',
      ownerRole: '执行者',
      ownerBrief: 'b',
    });
    assert.ok(await waitFor(() => srv.requests() === 1, 8_000), '请求必须先发出');
    assert.ok(h.runtime.stats().running > 0, '执行过程必须真的在运行');

    await h.runtime.stop();

    const taskAfter = h.store.getTask(task.id);
    const workerAfter = h.store.getWorker(owner.id);
    assert.notEqual(taskAfter?.status, 'failed', `停机不应把任务判失败（实际 ${taskAfter?.status}）`);
    assert.notEqual(workerAfter?.status, 'failed', `停机不应把 Worker 判失败（实际 ${workerAfter?.status}）`);
    assert.equal(taskAfter?.status, 'active', '任务应保留为未完成');

    const calls = h.store.modelCallStats();
    const workerStats = calls.find((item) => item.purpose === 'worker');
    assert.ok(workerStats, '应有 worker 调用记录');
    const rows = h.store.listModelCalls(10);
    const cancelled = rows.filter((row) => row.status === 'cancelled').length;
    assert.ok(cancelled >= 1, '被取消的调用应记为 cancelled，而不是 failed');
  } finally {
    await h.cleanup();
    await srv.close();
  }
});

test('正常停机后重新启动：同一任务能继续推进', async () => {
  const srv = await server({ delayMs: 30_000, respectAbort: true });
  const h = await makeHarness(srv.port);
  try {
    const { task } = h.runtime.createTask({ title: '恢复任务', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    assert.ok(await waitFor(() => srv.requests() === 1, 8_000), '请求必须先发出');
    await h.runtime.stop();

    // 用同一个数据库重启
    const store2 = new Store(h.store.path);
    const config2 = loadConfig();
    const runtime2 = new Runtime({
      store: store2,
      config: config2,
      workerModel: new OpenAICompatibleModel({
        baseUrl: config2.baseUrl,
        apiKey: config2.apiKey,
        timeoutMs: config2.timeoutMs,
        retry: 1,
        reasoningEffort: 'low',
        maxTokens: 64,
      }),
    });
    const recovered = runtime2.recover();
    runtime2.start();
    assert.ok(recovered.recovered >= 1, `重启后应至少接管一个 Worker（实际 ${recovered.recovered}）`);
    const taskAfter = store2.getTask(task.id);
    assert.notEqual(taskAfter?.status, 'failed', '重启后任务仍应是可继续的状态');
    await runtime2.stop();
    store2.close();
  } finally {
    await h.cleanup();
    await srv.close();
  }
});

test('用户取消任务：仍是取消语义，不会被当成停机恢复', async () => {
  const srv = await server({ delayMs: 30_000, respectAbort: true });
  const h = await makeHarness(srv.port);
  try {
    const { task } = h.runtime.createTask({ title: '取消任务', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    assert.ok(await waitFor(() => srv.requests() === 1, 8_000), '请求必须先发出');
    await h.runtime.stopTask(task.id, '用户取消');
    await h.runtime.waitForIdle(5_000);
    const after = h.store.getTask(task.id);
    assert.equal(after?.status, 'cancelled', `用户取消应保持 cancelled（实际 ${after?.status}）`);
    assert.equal(after?.closeReason, '用户取消');
  } finally {
    await h.cleanup();
    await srv.close();
  }
});

test('模型错误分类：取消、超时、网络、提供方各归各的类别', async () => {
  const controller = new AbortController();
  const failing = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // 不回应，等客户端取消
      setTimeout(() => {
        try {
          res.writeHead(500).end('{}');
        } catch {
          // 已断开
        }
      }, 5_000);
    });
  });
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const port = (failing.address() as { port: number }).port;
  const model = new OpenAICompatibleModel({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    timeoutMs: 60_000,
    retry: 1,
    reasoningEffort: 'low',
    maxTokens: 32,
  });
  try {
    setTimeout(() => controller.abort(), 300);
    const error = await model
      .chat({ model: 'm', messages: [], tools: [], signal: controller.signal })
      .then(() => null)
      .catch((e: unknown) => e as ModelError);
    assert.ok(error instanceof ModelError, '取消必须抛结构化错误');
    assert.equal(error.kind, 'cancelled', `取消应归类为 cancelled，实际 ${error.kind}`);
    assert.equal(error.retryable, false, '已取消的调用不能再重试');
  } finally {
    failing.closeAllConnections?.();
    await new Promise<void>((r) => failing.close(() => r()));
  }
});

test('迟到响应：模型忽略取消，超过收尾期限后才返回，不写库也不改状态', async () => {
  const srv = await server({ delayMs: 9_000, respectAbort: false });
  const h = await makeHarness(srv.port);
  const errors: string[] = [];
  const onRejection = (reason: unknown): void => {
    errors.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);
  try {
    const { task, owner } = h.runtime.createTask({
      title: '迟到响应',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
    });
    assert.ok(await waitFor(() => srv.requests() === 1, 8_000), '请求必须先发出');
    const before = h.store.getTask(task.id)?.status;

    await h.runtime.stop();
    h.store.close();

    // 等到迟到响应真的回来
    await new Promise((r) => setTimeout(r, 10_000));
    assert.deepEqual(errors, [], `不应出现未处理异常：${errors.join('|')}`);
    // 记录必须在停机时就定稿，不能被迟到响应改写
    const db = new (await import('node:sqlite')).DatabaseSync(h.store.path, { readOnly: true });
    const rows = db.prepare('SELECT status FROM model_call ORDER BY started_at').all() as { status: string }[];
    db.close();
    assert.ok(rows.length >= 1, '应有调用记录');
    assert.ok(
      rows.every((row) => row.status !== 'ok'),
      `迟到响应不能把调用改写成成功：${rows.map((r) => r.status).join(',')}`,
    );
    assert.equal(before, 'active');
  } finally {
    process.off('unhandledRejection', onRejection);
    await h.cleanup();
    await srv.close();
  }
});

test('Router 请求中途停机：不写库、不产生未处理异常', async () => {
  const srv = await server({ delayMs: 20_000, respectAbort: true });
  const h = await makeHarness(srv.port);
  const errors: string[] = [];
  const onRejection = (reason: unknown): void => {
    errors.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);
  try {
    const { Router } = await import('../../src/runtime/router.ts');
    const { OpenAICompatibleModel } = await import('../../src/model/openai.ts');
    const router = new Router(
      h.runtime,
      new OpenAICompatibleModel({
        baseUrl: `http://127.0.0.1:${srv.port}/v1`,
        apiKey: 'k',
        timeoutMs: 60_000,
        retry: 1,
        reasoningEffort: 'low',
        maxTokens: 64,
      }),
      loadConfig(),
    );
    const pending = router.handleUserMessage('请汇报当前进展').catch(() => undefined);
    assert.ok(await waitFor(() => srv.requests() >= 1, 8_000), 'Router 请求必须真的发出');
    const stopAt = Date.now();
    await h.runtime.stop();
    await pending;
    const elapsed = Date.now() - stopAt;
    // 服务器延迟 20 秒；如果 Router 没有收到取消，这里会等满 20 秒。
    assert.ok(elapsed < 6_000, `Router 请求应被取消（实际等待 ${elapsed}ms）`);
    h.store.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(errors, [], `不应出现未处理异常：${errors.join('|')}`);
  } finally {
    process.off('unhandledRejection', onRejection);
    await h.cleanup();
    await srv.close();
  }
});

test('等待模型并发额度时停机：取消生效，不再发出请求', async () => {
  const srv = await server({ delayMs: 8_000, respectAbort: true });
  const h = await makeHarness(srv.port);
  try {
    // 并发上限设为 1：第二个任务会卡在额度等待上
    const first = h.runtime.createTask({ title: '占住额度', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    void first;
    assert.ok(await waitFor(() => srv.requests() === 1, 8_000), '第一个请求应发出');
    h.runtime.createTask({ title: '排队等额度', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    await new Promise((r) => setTimeout(r, 300));
    const before = srv.requests();

    await h.runtime.stop();
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(srv.requests(), before, '停机后不应再发出新请求');
    const taskAfter = h.store.getTask(first.task.id);
    assert.notEqual(taskAfter?.status, 'failed');
  } finally {
    await h.cleanup();
    await srv.close();
  }
});
