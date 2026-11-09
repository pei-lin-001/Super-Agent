/**
 * HTTP 尝试次数口径：一条 chat() 一条记录，http_attempts 是真正发出的请求数。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { ModelError } from '../../src/model/types.ts';

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
