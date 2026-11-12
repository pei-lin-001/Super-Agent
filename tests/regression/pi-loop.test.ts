/**
 * pi agent-loop 衔接层的单元测试：不碰数据库，只用假模型与假工具。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mockReply, MockModel } from '../../src/model/mock.ts';
import type { ChatRequest } from '../../src/model/types.ts';
import { runWorkerTurn, toAgentMessages, toLlmMessages } from '../../src/runtime/pi-worker.ts';
import { PiModel } from '../../src/model/pi.ts';
import { sseText, sseTools } from '../sse.ts';

const TOOLS = [
  {
    name: 'read_file',
    description: '读文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

test('轮内压缩：计入缓存并保留身份、当前任务和完整工具对', async () => {
  const requests: { messages: { role: string; content: string | null; tool_call_id?: string }[] }[] = [];
  const model = new PiModel({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', timeoutMs: 2000, retry: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const data = requests.length === 1
        ? sseTools([{ id: 'call_keep', name: 'read_file', args: { path: 'a' } }]).replace('"prompt_tokens":5,"completion_tokens":5', '"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":95}')
        : sseText('完成');
      return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
    } }, 'mock');
  let compact = 0;
  await runWorkerTurn({ model: 'mock', modelClient: model, systemPrompt: '规则', history: [],
    prompts: [{ role: 'user', content: '身份 ID' }, { role: 'user', content: '旧记录'.repeat(1000) }, { role: 'user', content: '目标与产物状态' }],
    protectedMessageIndexes: [0, 2], tools: TOOLS, maxSteps: 2, signal: null,
    compaction: { contextWindowTokens: 100, reserveTokens: 0, keepRecentTokens: 1, onCompact: () => { compact++; } },
    runTool: async () => ({ outcome: { type: 'ok', content: '结果' }, terminate: false }) });
  assert.equal(compact, 1);
  const next = requests[1]!.messages;
  assert.ok(next.some((item) => item.content === '身份 ID'));
  assert.ok(next.some((item) => item.content === '目标与产物状态'));
  assert.ok(next.some((item) => item.role === 'assistant'));
  assert.ok(next.some((item) => item.role === 'tool' && item.tool_call_id === 'call_keep'));
});

function makeModel(handler: (request: ChatRequest, callIndex: number) => ReturnType<typeof mockReply>): MockModel {
  let index = 0;
  return new MockModel((context) => {
    const result = handler(context.request, index);
    index += 1;
    return result;
  });
}

test('pi loop：工具调用 → 结果回填 → 再请求 → 结束', async () => {
  const seen: ChatRequest[] = [];
  const model = makeModel((request, index) => {
    seen.push(request);
    if (index === 0) {
      return mockReply({ toolCalls: [{ id: 'call_a', name: 'read_file', arguments: { path: 'a.md' } }] });
    }
    return mockReply({ text: '读完了，a.md 里是 hello' });
  });

  const ran: string[] = [];
  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: '你是 Worker',
    prompts: [{ role: 'user', content: '读一下 a.md' }],
    history: [],
    tools: TOOLS,
    maxSteps: 8,
    signal: null,
    runTool: async (call) => {
      ran.push(`${call.name}:${call.arguments}`);
      return { outcome: { type: 'ok', content: 'hello' }, terminate: false };
    },
  });

  assert.equal(result.stop, 'steps', '步数用完自然结束');
  assert.equal(result.steps, 2, '两次模型调用 = 两步');
  assert.deepEqual(ran, ['read_file:{"path":"a.md"}'], '工具只执行一次');
  assert.equal(result.assistantText, '读完了，a.md 里是 hello');

  // 第二次请求必须带上工具结果，否则模型看不到读到什么
  const second = seen[1]!;
  assert.ok(
    second.messages.some((message) => message.role === 'tool' && message.content === 'hello'),
    `第二次请求缺少工具结果：${JSON.stringify(second.messages)}`,
  );
  assert.equal(second.messages[0]?.role, 'system', 'system 提示在第一位');
  assert.match(second.messages[0]?.content ?? '', /你是 Worker/);
});

test('pi loop：工具要求终止（提交/等待）时本轮立刻结束', async () => {
  const model = makeModel((_request, index) =>
    index === 0
      ? mockReply({ toolCalls: [{ id: 'call_submit', name: 'read_file', arguments: { path: 'x' } }] })
      : mockReply({ text: '不该被调用' }),
  );

  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: 's',
    prompts: [{ role: 'user', content: '开始' }],
    history: [],
    tools: TOOLS,
    maxSteps: 8,
    signal: null,
    runTool: async () => ({ outcome: { type: 'finish', content: '已提交' }, terminate: true }),
  });

  assert.equal(result.stop, 'finish', '提交后应停止，不再请求模型');
  assert.equal(result.steps, 1);
});

test('pi loop：canContinue 失效后不再执行后续工具', async () => {
  const model = makeModel((_request, index) =>
    mockReply({ toolCalls: [{ id: `call_${index}`, name: 'read_file', arguments: { path: String(index) } }] }),
  );

  let executed = 0;
  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: 's',
    prompts: [{ role: 'user', content: '开始' }],
    history: [],
    tools: TOOLS,
    maxSteps: 8,
    signal: null,
    canContinue: () => (executed >= 1 ? '任务已被取消' : null),
    runTool: async () => {
      executed += 1;
      return { outcome: { type: 'ok', content: 'ok' }, terminate: false };
    },
  });

  assert.equal(result.stop, 'cancelled');
  assert.equal(executed, 1, '资格失效后不能再执行工具');
  assert.match(result.reason ?? '', /取消/);
});

test('pi loop：maxSteps 用满即停，不无限跑', async () => {
  const model = makeModel((_request, index) =>
    mockReply({ toolCalls: [{ id: `call_${index}`, name: 'read_file', arguments: { path: String(index) } }] }),
  );
  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: 's',
    prompts: [{ role: 'user', content: '开始' }],
    history: [],
    tools: TOOLS,
    maxSteps: 3,
    signal: null,
    runTool: async () => ({ outcome: { type: 'ok', content: 'ok' }, terminate: false }),
  });
  assert.equal(result.steps, 3);
});

test('pi loop：模型报错时如实返回 error，不吞掉', async () => {
  const model = new MockModel(() => {
    throw new Error('上游 500');
  });
  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: 's',
    prompts: [{ role: 'user', content: '开始' }],
    history: [],
    tools: TOOLS,
    maxSteps: 8,
    signal: null,
    runTool: async () => ({ outcome: { type: 'ok', content: 'ok' }, terminate: false }),
  });
  assert.equal(result.stop, 'error');
  assert.match(result.reason ?? '', /500/);
});

test('消息转换：历史里的工具调用与结果能原样往返', () => {
  const agent = toAgentMessages([
    { role: 'assistant', content: '我来读', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', content: '文件内容', toolCallId: 'c1' },
  ]);
  assert.equal(agent.length, 2);
  const back = toLlmMessages(agent);
  assert.equal(back.chat[0]?.toolCalls?.[0]?.name, 'read_file');
  assert.equal(back.chat[1]?.toolCallId, 'c1');
  assert.equal(back.chat[1]?.content, '文件内容');
});

test('pi loop：工具失败标记进 pi 消息，也进模型可见文本', async () => {
  const seen: ChatRequest[] = [];
  const model = makeModel((request, index) => {
    seen.push(request);
    if (index === 0) {
      return mockReply({ toolCalls: [{ id: 'call_bad', name: 'read_file', arguments: { path: 'nope.md' } }] });
    }
    return mockReply({ text: '读不到' });
  });

  const ran: string[] = [];
  const result = await runWorkerTurn({
    model: 'mock',
    modelClient: model,
    systemPrompt: 'x',
    tools: TOOLS,
    history: [
      { role: 'user', content: '读 nope.md' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_old', name: 'read_file', arguments: '{"path":"old.md"}' }] },
      { role: 'tool', content: '打开失败：文件不存在', toolCallId: 'call_old', isError: true },
    ],
    prompts: [],
    // 字段名必须是 runTool。写成别的名字时 input.runTool 为 undefined，
    // runWorkerTurn 会把 TypeError 吞成 stop='error' 后静默返回——下面的断言专拦这种情况。
    runTool: async (call) => {
      ran.push(`${call.name}:${call.arguments}`);
      return { outcome: { type: 'failed', content: '打开失败：文件不存在' }, terminate: false };
    },
    signal: null,
    maxSteps: 4,
  });

  // 0) 这一轮必须真的跑起来，且工具失败之后把结果回灌给模型继续下一步。
  assert.notEqual(result.stop, 'error', `本轮不应因内部错误中止：${result.reason ?? ''}`);
  assert.equal(result.stop, 'steps');
  assert.equal(result.steps, 2, '失败的工具结果也要回灌：第二次模型调用 = 第二步');
  assert.deepEqual(ran, ['read_file:{"path":"nope.md"}'], '失败的工具确实被执行过一次');

  // 1) 失败结果必须回流到模型：第二次请求带着它，且 isError 不能丢。
  const echoed = seen[1]!.messages.filter((message) => message.role === 'tool').at(-1);
  assert.ok(echoed, `第二次请求缺少工具结果：${JSON.stringify(seen[1]!.messages)}`);
  assert.match(echoed.content ?? '', /打开失败/);
  assert.equal(echoed.isError, true, '模型可见的失败标记不能丢');

  // 2) 历史里的失败状态不会被抹平
  const round = toAgentMessages([
    { role: 'tool', content: '打开失败：文件不存在', toolCallId: 'call_old', isError: true },
  ]);
  assert.equal(round[0]!.role, 'toolResult');
  assert.equal((round[0] as { isError?: boolean }).isError, true, 'isError 不能恒置 false');

  // 2) 模型侧看得见失败：内容本身没写「失败」时补前缀
  const { chat } = toLlmMessages([
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read_file', content: [{ type: 'text', text: '返回值为 0' }], isError: true, timestamp: 0 },
  ]);
  assert.equal(chat[0]!.role, 'tool');
  assert.equal(chat[0]!.content, '返回值为 0');
  assert.equal(chat[0]!.isError, true);
});

test('工具参数：数字不能转换成字符串后绕过原始类型校验', async () => {
  let executed = false;
  const seen: ChatRequest[] = [];
  const model = makeModel((request, index) => {
    seen.push(request);
    return index === 0 ? mockReply({ toolCalls: [{ name: 'read_file', arguments: { path: 42 } }] }) : mockReply({ text: '参数错误' });
  });
  await runWorkerTurn({ model: 'mock', modelClient: model, systemPrompt: '规则', history: [], prompts: [{ role: 'user', content: '读取文件' }], tools: TOOLS, maxSteps: 2, signal: null,
    runTool: async () => { executed = true; return { outcome: { type: 'ok', content: '不应执行' }, terminate: false }; } });
  assert.equal(executed, false);
  const tool = seen[1]!.messages.find((message) => message.role === 'tool');
  assert.equal(tool?.isError, true);
  assert.match(tool?.content ?? '', /path.*expected string/);
});
