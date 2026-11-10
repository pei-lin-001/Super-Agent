/**
 * 决策模型客户端：clef 这类模型的接口和 chat 完全不同，必须真打一次 HTTP 形状。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { DecisionClient, shouldTrust } from '../../src/model/decision.ts';

async function server(handler: (body: Record<string, unknown>) => { status: number; payload: unknown }): Promise<{
  port: number;
  close: () => Promise<void>;
  lastBody: () => Record<string, unknown>;
}> {
  let last: Record<string, unknown> = {};
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk.toString()));
    req.on('end', () => {
      last = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const out = handler(last);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.payload));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    lastBody: () => last,
  };
}

test('决策客户端：走 /systemone，请求形状正确，返回概率分布', async () => {
  const srv = await server(() => ({
    status: 200,
    payload: {
      answers: { pick: { type: 'choice', choice: '2', confidence: 0.91, probabilities: { 1: 0.02, 2: 0.92, 3: 0.06 } } },
      usage: { input_tokens: 180, output_tokens: 0 },
    },
  }));
  try {
    const client = new DecisionClient({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'k' });
    const result = await client.choose({
      model: 'clef:27b',
      state: '新任务：改 Router',
      instructions: '选一个最像的空间',
      criteria: { 1: '网络', 2: '多模型', 3: '渠道' },
    });
    assert.equal(result.choice, '2');
    assert.equal(result.confidence, 0.91);
    assert.equal(result.probabilities['2'], 0.92);
    assert.deepEqual(result.usage, { inputTokens: 180, outputTokens: 0 });

    const body = srv.lastBody();
    assert.equal(body['model'], 'clef:27b');
    assert.equal(body['state'], '新任务：改 Router');
    const questions = body['questions'] as Record<string, { type: string; criteria: Record<string, string> }>;
    assert.equal(questions['pick']!.type, 'choice', 'type 必须是 choice，别的会被拒');
    assert.deepEqual(questions['pick']!.criteria, { 1: '网络', 2: '多模型', 3: '渠道' });
  } finally {
    await srv.close();
  }
});

test('决策客户端：没有选出结果时抛错，不返回兜底值', async () => {
  const srv = await server(() => ({ status: 200, payload: { answers: { pick: { type: 'choice' } } } }));
  try {
    const client = new DecisionClient({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'k' });
    await assert.rejects(
      () => client.choose({ model: 'clef:27b', state: 'x', instructions: 'y', criteria: { 1: 'a' } }),
      /没有选出结果/,
    );
  } finally {
    await srv.close();
  }
});

test('决策客户端：HTTP 错误要带上响应正文，便于定位', async () => {
  const srv = await server(() => ({ status: 400, payload: { error: 'model is required' } }));
  try {
    const client = new DecisionClient({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'k' });
    await assert.rejects(
      () => client.choose({ model: 'clef:27b', state: 'x', instructions: 'y', criteria: { 1: 'a' } }),
      /400.*model is required/s,
    );
  } finally {
    await srv.close();
  }
});

test('置信度闸门：低于阈值不采信', () => {
  assert.equal(shouldTrust(0.91), true);
  assert.equal(shouldTrust(0.6), true);
  assert.equal(shouldTrust(0.59), false);
  assert.equal(shouldTrust(Number.NaN), false);
});
