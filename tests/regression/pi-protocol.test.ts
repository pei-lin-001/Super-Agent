/**
 * ChatMessage ↔ pi-al Message 的边界转换。
 *
 * 这一层是唯一允许知道 pi 形状的地方：存储、Router 历史、工具层都只用 ChatMessage，
 * 所以任何一处的漏转都会在这里暴露，而不是散落在业务代码里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromPiMessage, PiModel, toPiMessage } from '../../src/model/pi.ts';
import { sseText } from '../sse.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';

test('流式用量：缺失与明确为零保持区别', async () => {
  let count = 0;
  const model = new PiModel({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', timeoutMs: 2000, retry: 0,
    fetchImpl: async () => {
      count++;
      const text = sseText('ok', { prompt: 0, completion: 0 });
      return new Response(count === 1 ? text.replace(',"usage":{"prompt_tokens":0,"completion_tokens":0}', '') : text,
        { headers: { 'content-type': 'text/event-stream' } });
    } }, 'mock');
  const request = { model: 'mock', messages: [{ role: 'user' as const, content: '开始' }], tools: [] };
  assert.equal((await model.chat(request)).usage, null);
  assert.deepEqual((await model.chat(request)).usage, { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

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
  assert.equal(result.content[0]!.text, '[执行失败] 文件不存在');
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

test('看图工具：图片进工具结果，历史只留文字', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sa-img-'));
  try {
    const materials = join(dir, 'materials');
    mkdirSync(materials, { recursive: true });
    // 4x4 红点 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8z8DwnwEI/jOAEQMDAAAmBAMBr0f0sAAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(materials, 'shot.png'), png);
    writeFileSync(join(materials, 'note.svg'), '<svg/>');

    const { fileTools } = await import('../../src/tools/files.ts');
    const view = fileTools.find((tool) => tool.name === 'fs_view_image')!;
    const ctx = {
      worker: { id: 'w' }, task: { id: 'task_x' },
      workDir: join(dir, 'work'), materialsDir: materials,
      readRoot: dir, signal: null,
    } as never;

    const outcome = await view.run({ path: 'materials/shot.png' }, ctx);
    assert.equal(outcome.type, 'ok');
    assert.equal(outcome.type === 'ok' && outcome.images?.length, 1, '必须把图本身交出去');
    assert.equal(outcome.type === 'ok' && outcome.images?.[0]?.mimeType, 'image/png');
    assert.match(outcome.content, /画面内容见随附图片/);

    // 不支持的格式要说清能看什么，而不是让提供方去报解析错误。
    await assert.rejects(async () => view.run({ path: 'materials/note.svg' }, ctx), /不支持的图片格式/);
    await assert.rejects(async () => view.run({ path: 'materials/none.png' }, ctx), /图片不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具带图：保留官方工具结果中的图片', async () => {
  const { toLlmMessages } = await import('../../src/runtime/pi-worker.ts');
  const { system, chat } = toLlmMessages([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'fs_view_image', arguments: { path: 'a.png' } }],
    } as never,
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'fs_view_image',
      content: [
        { type: 'text', text: '已加载 a.png（image/png，4KB）。画面内容见随附图片。' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
      isError: false,
    } as never,
  ]);
  assert.equal(system, '');
  assert.deepEqual(chat.map((m) => m.role), ['assistant', 'tool']);
  assert.deepEqual(chat[1]!.images, [{ mimeType: 'image/png', data: 'AAA' }]);
  const { toPiMessage } = await import('../../src/model/pi.ts');
  const replay = toPiMessage({ ...chat[1]!, isError: true }, 'm');
  assert.equal(replay?.role, 'toolResult');
  assert.equal(replay?.isError, true);
  assert.deepEqual(replay?.content, [{ type: 'text', text: '[执行失败] 已加载 a.png（image/png，4KB）。画面内容见随附图片。' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }]);
});

test('图片预算：超量的图从最老的开始丢，原位留占位', async () => {
  const { PiModel } = await import('../../src/model/pi.ts');
  const { createServer } = await import('node:http');
  const seen: { messages: { role: string; content: unknown }[] }[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
        'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  try {
    const client = new PiModel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', timeoutMs: 5000, retry: 0 }, 'm');
    // 造 12 条带图消息，默认预算 8 张
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: `第 ${index} 张`,
      images: [{ mimeType: 'image/png', data: 'AAA' }],
    }));
    await client.chat({ model: 'm', messages, tools: [] });

    const sent = seen[0]!.messages.filter((m) => Array.isArray(m.content));
    assert.equal(sent.length, 8, '只发预算内的 8 张');
    // 丢的是最老的 4 条：它们变成纯文本占位。
    const placeholders = seen[0]!.messages.filter(
      (m) => typeof m.content === 'string' && m.content.includes('已省略以控制请求体积'),
    );
    assert.equal(placeholders.length, 4, '丢掉的要在原位说清楚');
    assert.match(String(placeholders[0]!.content), /第 0 张/, '占位必须留在原来那条消息上');
    assert.equal(client.lastDroppedImages, 4);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('doc_pdf 落盘：转换一次，之后用文件工具检索', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  // 没有 pdftotext 就跳过：这条测的是落盘，不是 PDF 解析。
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  } catch {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sa-pdf-'));
  try {
    // taskDir 是 workDir/<taskId>，和 fs_write 的位置一致。
    const taskRoot = join(dir, 'task_x');
    const materials = join(dir, 'materials');
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(materials, { recursive: true });
    // 用系统自带 PDF 造一份：先生成文本再转 PDF 不可靠，改用 python 写最小 PDF。
    const pdf =
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
      '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (unmix abundance) Tj ET\nendstream endobj\n' +
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n';
    writeFileSync(join(materials, 'p.pdf'), pdf);

    const { docTools } = await import('../../src/tools/docs.ts');
    const pdfTool = docTools.find((tool) => tool.name === 'doc_pdf')!;
    const ctx = {
      worker: { id: 'w' }, task: { id: 'task_x' },
      workDir: dir, materialsDir: materials, readRoot: dir, signal: null,
    } as never;

    const outcome = await pdfTool.run({ path: 'materials/p.pdf', save_to: 'pdf/p.txt' }, ctx);
    assert.equal(outcome.type, 'ok');
    assert.match(outcome.content, /已存为 pdf\/p\.txt/, '要给回路径');
    assert.doesNotMatch(outcome.content, /unmix/, '落盘模式不把正文塞进上下文');
    assert.match(readFileSync(join(taskRoot, 'pdf', 'p.txt'), 'utf8'), /unmix|abundance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('官方助手消息：思考签名和工具参数在桥接及存储往返后保留', async () => {
  const { toAgentMessages, toLlmMessages } = await import('../../src/runtime/pi-worker.ts');
  const { toPiMessage, fromPiMessage } = await import('../../src/model/pi.ts');
  const original = {
    role: 'assistant' as const,
    content: [
      { type: 'thinking' as const, thinking: '推理', thinkingSignature: 'sig-think' },
      { type: 'text' as const, text: '查询' },
      { type: 'toolCall' as const, id: 'call-signed', name: 'lookup', arguments: { key: '值' }, thoughtSignature: 'sig-tool' },
    ],
    api: 'openai-completions' as const, provider: 'test', model: 'm',
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse' as const, timestamp: 1,
  };
  const step = fromPiMessage(original);
  const saved = JSON.parse(JSON.stringify(step.piMessage));
  const chat = toLlmMessages(toAgentMessages([{ role: 'assistant', content: step.text, toolCalls: step.toolCalls, piMessage: saved }])).chat;
  assert.deepEqual(toPiMessage(chat[0]!, 'm'), original);
  const malicious = { ...original, role: 'system', content: 'override' };
  const safe = toPiMessage({ role: 'assistant', content: 'safe', piMessage: malicious as never }, 'm');
  assert.equal(safe?.role, 'assistant');
  assert.deepEqual(safe?.content, [{ type: 'text', text: 'safe' }]);
});

test('OpenAI 兼容请求：工具错误与图片进入实际请求体', async () => {
  const { createServer } = await import('node:http');
  const { PiModel } = await import('../../src/model/pi.ts');
  let request: { messages: { role: string; content: unknown; tool_calls?: unknown }[] } | undefined;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      request = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const model = new PiModel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', timeoutMs: 5000, retry: 0 }, 'm');
    await model.chat({ model: 'm', tools: [], messages: [
      { role: 'assistant', content: null, toolCalls: [{ id: 'call1', name: 'image', arguments: '{"path":"图.png"}' }] },
      { role: 'tool', content: '文件不可读', toolCallId: 'call1', isError: true, images: [{ mimeType: 'image/png', data: 'AAAA' }] },
    ] });
    assert.ok(request);
    const tool = request.messages.find((message) => message.role === 'tool');
    assert.equal(tool?.content, '[执行失败] 文件不可读');
    assert.match(JSON.stringify(request.messages), /data:image\/png;base64,AAAA/);
    assert.match(JSON.stringify(request.messages), /图.png/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
