/**
 * HTTP 尝试次数口径：一条 chat() 一条记录，http_attempts 是真正发出的请求数。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { RecordingModel } from '../../src/model/recorder.ts';
import { ModelError, type ModelClient } from '../../src/model/types.ts';
import { Store } from '../../src/storage/store.ts';

interface Fixture {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}

/** 按脚本逐次返回状态码；最后一个状态码会一直重复。 */
async function server(statuses: number[]): Promise<Fixture> {
  let count = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const index = Math.min(count, statuses.length - 1);
      count += 1;
      const status = statuses[index]!;
      if (status === 200) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `status ${status}` } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`,
    requests: () => count,
    close: async () => {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

function model(url: string, retry: number): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    baseUrl: url,
    apiKey: 'k',
    timeoutMs: 20_000,
    retry,
    reasoningEffort: 'low',
    maxTokens: 32,
  });
}

const req = (signal?: AbortSignal) => ({ model: 'm', messages: [], tools: [], ...(signal ? { signal } : {}) });

test('第一次 503、第二次成功：尝试次数为 2', async () => {
  const f = await server([503, 200]);
  try {
    const result = await model(f.url, 3).chat(req());
    assert.equal(result.httpAttempts, 2, '成功路径要带上自己的尝试次数');
    assert.equal(f.requests(), 2);
  } finally {
    await f.close();
  }
});

test('重试耗尽：次数与服务器实际收到的请求一致', async () => {
  const f = await server([500]);
  try {
    const error = await model(f.url, 3)
      .chat(req())
      .then(() => null)
      .catch((e: unknown) => e as ModelError);
    assert.ok(error instanceof ModelError, '耗尽应抛结构化错误');
    // retry=3 表示首次 + 3 次重试，共 4 次真实请求
    assert.equal(f.requests(), 4, `服务器应收到的请求数与尝试次数一致（实际 ${f.requests()}）`);
    assert.equal(error.status, 500);
  } finally {
    await f.close();
  }
});

test('不可重试错误：只发一次请求', async () => {
  const f = await server([401]);
  try {
    await model(f.url, 3)
      .chat(req())
      .catch(() => undefined);
    assert.equal(f.requests(), 1, '401 不应重试');
  } finally {
    await f.close();
  }
});

test('请求发出前取消：实际请求数为 0', async () => {
  const f = await server([200]);
  try {
    const controller = new AbortController();
    controller.abort();
    const error = await model(f.url, 3)
      .chat(req(controller.signal))
      .then(() => null)
      .catch((e: unknown) => e as ModelError);
    assert.ok(error instanceof ModelError);
    assert.equal(error.kind, 'cancelled');
    assert.equal(f.requests(), 0, '已取消的调用不能真的发出请求');
  } finally {
    await f.close();
  }
});

test('退避期间取消：不再发出下一次请求', async () => {
  const f = await server([503]);
  try {
    const controller = new AbortController();
    const pending = model(f.url, 4)
      .chat(req(controller.signal))
      .then(() => null)
      .catch((e: unknown) => e as ModelError);
    // 等第一次请求真的发出并进入退避
    for (let i = 0; i < 200 && f.requests() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(f.requests(), 1, '第一次请求应已发出');
    controller.abort();
    const error = await pending;
    assert.ok(error instanceof ModelError);
    assert.equal(error.kind, 'cancelled');
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(f.requests(), 1, `取消后不应再重试（实际 ${f.requests()}）`);
  } finally {
    await f.close();
  }
});

test('并发调用：各自的尝试次数不串账', async () => {
  const f = await server([503, 200]);
  try {
    const m = model(f.url, 3);
    const results = await Promise.all([m.chat(req()), m.chat(req()), m.chat(req())]);
    for (const result of results) {
      assert.ok(
        result.httpAttempts === 1 || result.httpAttempts === 2,
        `每次调用只能报自己的次数（实际 ${result.httpAttempts}）`,
      );
    }
  } finally {
    await f.close();
  }
});

test('错误文字含 cancel 但类别不是取消：不能被当成取消', async () => {
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request cancelled by upstream policy' } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
    const error = await model(url, 2)
      .chat(req())
      .then(() => null)
      .catch((e: unknown) => e as ModelError);
    assert.ok(error instanceof ModelError);
    assert.notEqual(error.kind, 'cancelled', '结构化类别不能被错误文字带偏');
  } finally {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// ---------------- 记账层：失败与取消也要带上真实请求数 ----------------

function lastCall(dir: string): { status: string; http_attempts: number | null; error: string | null } {
  const db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT status, http_attempts, error FROM model_call ORDER BY rowid DESC LIMIT 1').get() as
    | { status: string; http_attempts: number | null; error: string | null }
    | undefined;
  db.close();
  assert.ok(row, 'model_call 必须有落库记录');
  return row;
}

async function recordOne(
  dir: string,
  inner: ModelClient,
  request = req(),
): Promise<{ row: { status: string; http_attempts: number | null; error: string | null }; error: unknown }> {
  const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'inst_rec' });
  try {
    const recorder = new RecordingModel(inner, store, 'worker');
    const error = await recorder.chat(request).then(
      () => null,
      (e: unknown) => e,
    );
    return { row: lastCall(dir), error };
  } finally {
    store.close();
  }
}

test('记账层：重试耗尽落库的尝试次数等于真实请求数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  const f = await server([500]);
  try {
    const { row, error } = await recordOne(dir, model(f.url, 3));
    assert.ok(error instanceof ModelError, '耗尽应抛结构化错误');
    assert.equal(f.requests(), 4, `服务器应收到 4 次（实际 ${f.requests()}）`);
    assert.equal(row.status, 'failed');
    assert.equal(row.http_attempts, 4, `入库的尝试次数必须等于真实请求数（实际 ${row.http_attempts}）`);
    assert.equal(row.http_attempts, f.requests(), '记账值与服务器计数必须一致');
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：不可重试错误落库为 1 次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  const f = await server([401]);
  try {
    const { row } = await recordOne(dir, model(f.url, 3));
    assert.equal(row.status, 'failed');
    assert.equal(row.http_attempts, 1, `401 只应发一次（实际 ${row.http_attempts}）`);
    assert.equal(row.http_attempts, f.requests());
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：发请求前取消落库为 0 次且状态是 cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  const f = await server([200]);
  try {
    const controller = new AbortController();
    controller.abort();
    const { row, error } = await recordOne(dir, model(f.url, 3), req(controller.signal));
    assert.ok(error instanceof ModelError);
    assert.equal(row.status, 'cancelled', '本地取消必须记成 cancelled');
    assert.equal(row.http_attempts, 0, `没发出请求就是 0（实际 ${row.http_attempts}）`);
    assert.equal(f.requests(), 0);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：退避期间取消，落库的尝试次数等于已发出的次数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  const f = await server([503]);
  try {
    const controller = new AbortController();
    const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'inst_rec' });
    let outcome: unknown = null;
    try {
      const recorder = new RecordingModel(model(f.url, 4), store, 'worker');
      const pending = recorder.chat(req(controller.signal)).then(
        () => null,
        (e: unknown) => e,
      );
      for (let i = 0; i < 200 && f.requests() === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(f.requests(), 1, '第一次请求应已发出');
      controller.abort();
      outcome = await pending;
    } finally {
      store.close();
    }
    const row = lastCall(dir);
    assert.ok(outcome instanceof ModelError);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.http_attempts, 1, `取消时只发出过 1 次（实际 ${row.http_attempts}）`);
    assert.equal(row.http_attempts, f.requests());
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：错误文字含 cancel 但不是本地取消，仍记成 failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request cancelled by upstream policy' } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
    const { row, error } = await recordOne(dir, model(url, 2));
    assert.ok(error instanceof ModelError);
    assert.notEqual(error.kind, 'cancelled', '结构化类别不能被错误文字带偏');
    assert.equal(row.status, 'failed', `记账层也必须是 failed（实际 ${row.status}）`);
    assert.equal(row.http_attempts, 1, '只发了一次');
  } finally {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 网络/超时退避期间取消：取消的归类与计数都必须落到记账层 ----

/** 让底层抛指定错误，用来复现"第一次请求就失败、随后进入退避"的路径。 */
function failingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function networkModel(url: string, retry: number, error: Error): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    baseUrl: url,
    apiKey: 'k',
    timeoutMs: 30_000,
    retry,
    reasoningEffort: 'low',
    maxTokens: 32,
    fetchImpl: failingFetch(error),
  });
}

test('记账层：网络失败进入退避后取消，落库为 1 次 cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  try {
    const controller = new AbortController();
    const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'inst_rec' });
    let outcome: unknown = null;
    try {
      let calls = 0;
      const model = new OpenAICompatibleModel({
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'k',
        timeoutMs: 30_000,
        retry: 3,
        reasoningEffort: 'low',
        maxTokens: 32,
        fetchImpl: (async () => {
          calls += 1;
          throw new TypeError('network down');
        }) as unknown as typeof fetch,
      });
      const recorder = new RecordingModel(model, store, 'worker');
      const pending = recorder.chat(req(controller.signal)).then(
        () => null,
        (e: unknown) => e,
      );
      // 等到第一次请求真的发出（gate 可能被其它测试占用），再取消
      for (let i = 0; i < 300 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls, 1, '第一次请求应已发出');
      controller.abort();
      outcome = await pending;
    } finally {
      store.close();
    }
    const row = lastCall(dir);
    assert.ok(outcome instanceof ModelError, '应抛结构化错误');
    assert.equal(outcome.kind, 'cancelled', '退避中取消必须归为 cancelled');
    assert.equal(row.status, 'cancelled', `入库状态应为 cancelled（实际 ${row.status}）`);
    assert.equal(row.http_attempts, 1, `已经发出 1 次请求，入库必须是 1（实际 ${row.http_attempts}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：超时失败进入退避后取消，落库为 1 次 cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  try {
    const controller = new AbortController();
    const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'inst_rec' });
    let outcome: unknown = null;
    try {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      let calls = 0;
      const model = new OpenAICompatibleModel({
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'k',
        timeoutMs: 30_000,
        retry: 3,
        reasoningEffort: 'low',
        maxTokens: 32,
        fetchImpl: (async () => {
          calls += 1;
          throw timeoutError;
        }) as unknown as typeof fetch,
      });
      const recorder = new RecordingModel(model, store, 'worker');
      const pending = recorder.chat(req(controller.signal)).then(
        () => null,
        (e: unknown) => e,
      );
      for (let i = 0; i < 300 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls, 1, '第一次请求应已发出');
      controller.abort();
      outcome = await pending;
    } finally {
      store.close();
    }
    const row = lastCall(dir);
    assert.ok(outcome instanceof ModelError);
    assert.equal(outcome.kind, 'cancelled', `退避中取消必须归为 cancelled（实际 ${outcome.kind}）`);
    assert.equal(row.status, 'cancelled', `入库状态（实际 ${row.status}）`);
    assert.equal(
      row.http_attempts,
      1,
      `已经发出 1 次请求，入库必须是 1（实际 ${row.http_attempts}，错误 attempts=${outcome.httpAttempts}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账层：退避中取消后不再继续重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-rec-'));
  try {
    let calls = 0;
    const controller = new AbortController();
    const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'inst_rec' });
    try {
      const model = new OpenAICompatibleModel({
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'k',
        timeoutMs: 30_000,
        retry: 4,
        reasoningEffort: 'low',
        maxTokens: 32,
        fetchImpl: (async () => {
          calls += 1;
          throw new TypeError('network down');
        }) as unknown as typeof fetch,
      });
      const recorder = new RecordingModel(model, store, 'worker');
      const pending = recorder.chat(req(controller.signal)).catch(() => undefined);
      for (let i = 0; i < 300 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls, 1, '第一次请求应已发出');
      controller.abort();
      await pending;
      const afterCancel = calls;
      // 退避是 400ms 起指数增长，等足够久确认没有后续请求
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(calls, afterCancel, `取消后不应再发请求（取消时 ${afterCancel}，之后 ${calls}）`);
      assert.equal(calls, 1, '取消时只应发出过 1 次');
    } finally {
      store.close();
    }
    const all = (() => {
      const db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true });
      const rows = db.prepare('SELECT status, http_attempts FROM model_call').all();
      db.close();
      return JSON.stringify(rows);
    })();
    assert.equal(lastCall(dir).http_attempts, 1, `全部记录：${all}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
