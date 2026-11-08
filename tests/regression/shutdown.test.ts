/**
 * 停机与在途请求。
 *
 * 这里必须证明"请求真的已经发出去并在等待"，否则"停机没有报错"毫无意义。
 * 用真实 HTTP 服务控制响应时机，不用 mock 客户端。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';

interface ServerHandle {
  port: number;
  requests: () => number;
  close: () => Promise<void>;
}

function slowServer(options: { delayMs: number; respectAbort: boolean }): Promise<ServerHandle> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    req.resume();
    req.on('end', () => {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '迟到的响应' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        } catch {
          // 客户端已断开
        }
      }, options.delayMs);
      if (options.respectAbort) {
        req.on('aborted', () => clearTimeout(timer));
        res.on('close', () => clearTimeout(timer));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        requests: () => count,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function setup(port: number): Promise<{
  runtime: Runtime;
  store: Store;
  storePath: string;
  workDir: string;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-shutdown-'));
  const workDir = join(dir, 'work');
  // loadConfig 只从 process.env 读取，这里临时替换并在 cleanup 中还原。
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: workDir,
    OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OLLAMA_API_KEY: 'test',
    MODEL_NAME: 'slow-model',
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
    retry: 1,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  });
  const runtime = new Runtime({ store, config, workerModel: model });
  runtime.start();
  return {
    runtime,
    store,
    storePath: config.dbPath,
    workDir,
    dir,
    cleanup: async () => {
      // 关库之前先停调度：否则 tick 会继续访问已经关闭的数据库。
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

test('停机：模型请求已发出且仍在等待时，stop 取消并快速返回', async () => {
  const server = await slowServer({ delayMs: 30_000, respectAbort: true });
  const env = await setup(server.port);
  const errors: string[] = [];
  const onRejection = (reason: unknown): void => {
    errors.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);
  try {
    env.runtime.createTask({
      title: '慢任务',
      goal: '触发一次模型请求',
      ownerRole: '执行者',
      ownerBrief: '只需调用一次模型',
    });
    // 等到请求真的发出去：没有这一步，"停机成功"可能只是因为什么都没开始
    for (let i = 0; i < 200 && server.requests() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(server.requests(), 1, '必须先确认模型请求已经发出');
    assert.ok(env.runtime.stats().running > 0, '必须确认执行过程确实在运行');

    const started = Date.now();
    await env.runtime.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `取消后应快速返回，实际 ${elapsed}ms`);
    env.store.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(errors, [], '不应出现未处理的异步错误');
  } finally {
    process.off('unhandledRejection', onRejection);
    await server.close();
    await env.cleanup();
  }
});

test('停机：提供方忽略取消、迟到返回时，不访问已关闭的数据库', async () => {
  const server = await slowServer({ delayMs: 2_500, respectAbort: false });
  const env = await setup(server.port);
  const errors: string[] = [];
  const onRejection = (reason: unknown): void => {
    errors.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);
  let closed = false;
  try {
    env.runtime.createTask({ title: '被忽略的取消', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    for (let i = 0; i < 200 && server.requests() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(server.requests(), 1, '请求必须真的发出');

    await env.runtime.stop();
    env.store.close();
    closed = true;
    // 等到迟到响应真的回来（2.5 秒后）
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.deepEqual(errors, [], `迟到回调不应产生未处理错误：${errors.join(' | ')}`);
  } finally {
    process.off('unhandledRejection', onRejection);
    if (!closed) env.store.close();
    await server.close();
    await env.cleanup();
  }
});

test('停机：重复调用是幂等的，不会重复关闭资源', async () => {
  const server = await slowServer({ delayMs: 5_000, respectAbort: true });
  const env = await setup(server.port);
  try {
    env.runtime.createTask({ title: '重复停机', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    for (let i = 0; i < 200 && server.requests() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await Promise.all([env.runtime.stop(), env.runtime.stop(), env.runtime.stop()]);
    env.store.close();
    assert.equal(env.store.isClosed, true);
  } finally {
    await server.close();
    await env.cleanup();
  }
});

test('记账：工作记录整理与维护问答都留下调用记录，用途可区分', async () => {
  const server = await slowServer({ delayMs: 20, respectAbort: true });
  const env = await setup(server.port);
  try {
    const { RecordingModel } = await import('../../src/model/recorder.ts');
    const { MockModel } = await import('../../src/model/mock.ts');

    const note = new RecordingModel(new MockModel(() => ({
      text: '摘要', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: { promptTokens: 4, completionTokens: 2 },
    })), env.store, 'note', { taskId: 't1', workerId: 'w1' });
    await note.chat({ model: 'm', messages: [], tools: [] });

    const wd = new RecordingModel(new MockModel(() => ({
      text: '结论', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null,
    })), env.store, 'watchdog', {});
    await wd.chat({ model: 'm', messages: [], tools: [] });

    const stats = env.store.modelCallStats();
    const purposes = stats.map((item) => item.purpose).sort();
    assert.deepEqual(purposes, ['note', 'watchdog'], `用途必须分开记账：${purposes.join(',')}`);
    const noteStat = stats.find((item) => item.purpose === 'note')!;
    const wdStat = stats.find((item) => item.purpose === 'watchdog')!;
    assert.equal(noteStat.usageKnown, 1, 'note 有 usage 应记为已知');
    assert.equal(wdStat.usageKnown, 0, '没有 usage 必须是未知，不能补 0');
  } finally {
    env.store.close();
    await server.close();
    await env.cleanup();
  }
});

test('记账：并发调用各自计算重试次数，不互相串账', async () => {
  const server = await slowServer({ delayMs: 10, respectAbort: true });
  const env = await setup(server.port);
  try {
    const { RecordingModel } = await import('../../src/model/recorder.ts');
    const { OpenAICompatibleModel } = await import('../../src/model/openai.ts');
    // 每次调用都经过真实 HTTP，成功返回，httpAttempts 应为 1
    const inner = new OpenAICompatibleModel({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'k',
      timeoutMs: 30_000,
      retry: 1,
      reasoningEffort: 'low',
      maxTokens: 64,
    });
    const recorder = new RecordingModel(inner, env.store, 'worker', {});
    await Promise.all([
      recorder.chat({ model: 'm', messages: [], tools: [] }),
      recorder.chat({ model: 'm', messages: [], tools: [] }),
      recorder.chat({ model: 'm', messages: [], tools: [] }),
    ]);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(env.storePath, { readOnly: true });
    const rows = db.prepare('SELECT http_attempts FROM model_call ORDER BY started_at').all() as { http_attempts: number }[];
    db.close();
    assert.equal(rows.length, 3, '三次调用三条记录');
    for (const row of rows) {
      assert.equal(Number(row.http_attempts), 1, '每次成功调用只发一次请求，不应被并发串账');
    }
  } finally {
    env.store.close();
    await server.close();
    await env.cleanup();
  }
});
