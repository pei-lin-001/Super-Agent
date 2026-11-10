/**
 * ChatMessage ↔ pi-al Message 的边界转换。
 *
 * 这一层是唯一允许知道 pi 形状的地方：存储、Router 历史、工具层都只用 ChatMessage，
 * 所以任何一处的漏转都会在这里暴露，而不是散落在业务代码里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromPiMessage, toPiMessage } from '../../src/model/pi.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';

test('用户消息：纯文本仍是字符串，带图才变数组', () => {
  const plain = toPiMessage({ role: 'user', content: '你好' }, 'm') as { role: string; content: unknown };
  assert.equal(plain.role, 'user');
  assert.equal(plain.content, '你好', '纯文本不该变成数组，有些兼容实现只认字符串');

  const withImage = toPiMessage(
    { role: 'user', content: '这是什么', images: [{ mimeType: 'image/png', data: 'AAA' }] },
    'm',
  ) as { content: { type: string; text?: string }[] };
  assert.ok(Array.isArray(withImage.content));
  assert.deepEqual(withImage.content[0], { type: 'text', text: '这是什么' });
  assert.equal(withImage.content[1]!.type, 'image');

  // 只有图没有字：不能产出一个以 image 开头、没有 text 的数组。
  const imageOnly = toPiMessage(
    { role: 'user', content: null, images: [{ mimeType: 'image/png', data: 'AAA' }] },
    'm',
  ) as { content: { type: string }[] };
  assert.equal(imageOnly.content[0]!.type, 'image', '没文字时不该塞空 text 块');
});

test('工具往返：调用参数是 JSON 字符串，结果带失败标记', () => {
  const assistant = toPiMessage(
    {
      role: 'assistant',
      content: '我来查',
      toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"a.txt"}' }],
    },
    'm',
  ) as { role: string; content: { type: string; name?: string; arguments?: unknown }[] };
  assert.equal(assistant.role, 'assistant');
  const call = assistant.content[1]!;
  assert.equal(call.type, 'toolCall');
  assert.equal(call.name, 'fs_read');
  assert.deepEqual(call.arguments, { path: 'a.txt' }, '字符串要解析成对象，pi 的 arguments 是结构化的');

  const result = toPiMessage(
    { role: 'tool', content: '文件不存在', toolCallId: 'c1', isError: true },
    'm',
  ) as { role: string; toolCallId: string; isError: boolean; content: { text: string }[] };
  assert.equal(result.role, 'toolResult');
  assert.equal(result.toolCallId, 'c1');
  assert.equal(result.isError, true, '失败状态必须带到协议层，否则模型会重试同一个错误操作');
  assert.equal(result.content[0]!.text, '文件不存在');
});

test('工具参数坏 JSON：降级成空对象，不让整轮挂掉', () => {
  const assistant = toPiMessage(
    { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'x', arguments: '{坏' }] },
    'm',
  ) as { content: { type: string; arguments?: unknown }[] };
  assert.deepEqual(assistant.content[0]!.arguments, {});
});

test('思考块：只出现在返回结果里，不进历史回放', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先看文件' },
      { type: 'text', text: '答案是 42' },
      { type: 'toolCall', id: 'c1', name: 'fs_read', arguments: { path: 'a' } },
    ],
    api: 'openai-completions',
    provider: 'x',
    model: 'm',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3 },
    stopReason: 'toolUse',
  } as unknown as AssistantMessage;

  const step = fromPiMessage(message);
  assert.equal(step.text, '答案是 42', '可见文本里不能混进思考内容');
  assert.equal(step.reasoning, '先看文件', '思考要单独给出，不能悄悄丢掉');
  assert.equal(step.toolCalls.length, 1);
  assert.equal(step.toolCalls[0]!.arguments, '{"path":"a"}', '回到本仓库的形状：原始 JSON 字符串');
  assert.equal(step.finishReason, 'toolUse');

  // 历史回放：思考块没有签名，重放会被提供方拒；只回放文本与调用。
  const replay = toPiMessage(
    { role: 'assistant', content: '答案是 42', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{}' }] },
    'm',
  ) as { content: { type: string }[] };
  assert.deepEqual(replay.content.map((block) => block.type), ['text', 'toolCall']);
});

test('搜索后端：ollama 走根路径 /api/web_search，复用模型凭据', async () => {
  const saved = { ...process.env };
  try {
    delete process.env['SEARCH_API_URL'];
    delete process.env['SEARCH_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    process.env['SEARCH_PROVIDER'] = 'ollama';
    process.env['OLLAMA_BASE_URL'] = 'https://ollama.com/v1';
    process.env['OLLAMA_API_KEY'] = 'k';

    const { netTools } = await import('../../src/tools/net.ts');
    const search = netTools.find((tool) => tool.name === 'net_search')!;
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://e.com', content: 'c' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const outcome = await search.run({ query: '测试' }, { signal: null } as never);
      assert.equal(outcome.type, 'ok');
      // 关键：不能拼成 /v1/web_search，那个路径 404。
      assert.equal(requested[0], 'https://ollama.com/api/web_search');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    process.env = saved;
  }
});
