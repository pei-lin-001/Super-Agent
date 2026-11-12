/**
 * Router 指派模型：create_task 的 model 参数真正决定负责人的模型别名。
 *
 * 三件事要有确定答案，而不是靠提示词：
 * 1) 传了合法别名 → 负责人落库的 model 就是这个别名；
 * 2) 传了未配置别名 → 明确失败，不建任务、不静默回退默认，且失败原因要回到模型上下文里；
 * 3) 不传 → 沿用 defaultModelAlias，旧行为不变。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Config } from '../../src/config.ts';
import { MockModel, mockReply } from '../../src/model/mock.ts';
import type { ChatMessage, ChatRequest, ModelClient } from '../../src/model/types.ts';
import { ModelRegistry } from '../../src/model/registry.ts';
import { Router } from '../../src/runtime/router.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';
import { testConfig } from '../helpers.ts';

/** 两个别名的目录：default（弱，执行）+ pro（强，规划检查）。 */
function twoAliasConfig(dir: string): Config {
  const base = testConfig(dir, { maxRouterRounds: 2, maxStepsPerRun: 1 });
  return {
    ...base,
    models: [
      { ...base.models[0]!, alias: 'default', model: 'mock-worker', note: '日常执行与协作' },
      {
        alias: 'pro',
        provider: 'mock',
        baseUrl: 'http://127.0.0.1:0/v1',
        apiKey: 'test-key',
        apiKeyEnv: null,
        model: 'mock-pro',
        reasoningEffort: 'max',
        kind: 'chat',
        contextWindow: null,
        note: '规划、检查、疑难判断',
        costHint: '按 token 计费，高于默认模型',
      },
    ],
    defaultModelAlias: 'default',
  };
}

function tracker(alias: string, model: string, seen: string[]): ModelClient {
  return new MockModel(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    seen.push(alias);
    return { text: '在跑', reasoning: null, toolCalls: [], finishReason: 'stop' as const, model, usage: null };
  });
}

async function withHarness<T>(
  modelArg: string | null,
  body: (ctx: { store: Store; router: Router; config: Config; runtime: Runtime; requests: ChatMessage[][]; seen: string[] }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-router-model-'));
  const config = twoAliasConfig(dir);
  const store = new Store(config.dbPath);
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
  const requests: ChatMessage[][] = [];
  const seen: string[] = [];
  // 每个别名一个客户端：用来证明"指派后请求真的发到了对应模型"。
  const clients = new Map<string, ModelClient>([
    ['default', tracker('default', 'mock-worker', seen)],
    ['pro', tracker('pro', 'mock-pro', seen)],
  ]);
  const runtime = new Runtime({
    store,
    config,
    workerModel: clients.get('default')!,
    models: new ModelRegistry(config.models, clients),
  });
  const router = new Router(
    runtime,
    new MockModel(async ({ request }: { request: ChatRequest }) => {
      await tick();
      requests.push([...request.messages]);
      const userMessages = request.messages.filter((message) => message.role === 'user');
      const state = userMessages.at(-1)?.content ?? '';
      const userText = userMessages.at(-2)?.content ?? '';
      // 已经拿到过 create_task 的回执就不再重复建：否则第二轮会再建一个。
      const alreadyCreated = request.messages.some(
        (message) => message.role === 'tool' && (message.content ?? '').includes('已创建任务'),
      );
      if (!state.includes('系统当前状态') || userText !== '建个任务' || alreadyCreated) {
        // 非法别名的失败也要能被观察到，所以这里不吞结果，只按普通回复收尾。
        return mockReply({ text: '收到。' });
      }
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '指派模型的任务',
              goal: '验证 Router 能指派模型',
              owner_role: '执行者',
              owner_brief: '把活干完',
              ...(modelArg === null ? {} : { model: modelArg }),
            },
          },
        ],
      });
    }),
    config,
  );
  runtime.attachRouter(router);
  try {
    return await body({ store, router, config, runtime, requests, seen });
  } finally {
    await runtime.stop();
    if (!store.isClosed) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const alias of ['pro', 'default']) {
  test(`Router 指派模型：create_task.model=${alias} 时负责人真的用该别名`, async () => {
    await withHarness(alias, async ({ store, router }) => {
      await router.handleUserMessage('建个任务').catch(() => undefined);
      const tasks = store.listTasks();
      assert.equal(tasks.length, 1, `应该只建一个任务（实际 ${tasks.length}）`);
      const owner = store.getWorker(tasks[0]!.ownerWorkerId!)!;
      assert.equal(owner.model, alias, `负责人应记录别名 ${alias}（实际 ${owner.model}）`);
    });
  });
}

test('Router 指派模型：指定的别名对应客户端真的收到请求', async () => {
  await withHarness('pro', async ({ router, runtime, seen }) => {
    await router.handleUserMessage('建个任务').catch(() => undefined);
    // Worker 由调度异步启动：一看到请求落到客户端就立刻继续，不白等固定时长。
    for (let i = 0; i < 400 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(seen.includes('pro'), `pro 客户端应收到请求（实际 ${JSON.stringify(seen)}）`);
    assert.ok(!seen.includes('default'), `default 客户端不应被这次指派用到（实际 ${JSON.stringify(seen)}）`);
  });
});

test('Router 指派模型：model 传非字符串时明确失败，不当成"没填"', async () => {
  // 若把数字当成"没填"，一次写错就会静默退回默认模型，调用方还以为指派了强模型。
  await withHarness(42 as unknown as string, async ({ store, router, requests }) => {
    await router.handleUserMessage('建个任务').catch(() => undefined);
    assert.equal(store.listTasks().length, 0, '类型不对时不应建出任务');
    const toolResults = requests.flatMap((messages) =>
      messages.filter((message) => message.role === 'tool').map((message) => message.content ?? ''),
    );
    assert.ok(
      toolResults.some((content) => content.includes('/model') && content.includes('expected string')),
      `类型错误要回到模型上下文（实际 ${JSON.stringify(toolResults).slice(0, 300)}）`,
    );
  });
});

test('Router 指派模型：未配置的别名明确失败，不建任务、不回退默认，原因回到上下文', async () => {
  await withHarness('不存在的别名', async ({ store, router, requests, seen }) => {
    await router.handleUserMessage('建个任务').catch(() => undefined);
    assert.equal(store.listTasks().length, 0, '别名非法时不应建出任务');
    assert.equal(seen.length, 0, '别名非法时不应发起任何 Worker 执行');
    // 失败必须以工具结果的形式回到模型上下文：静默失败会让 Router 以为已经派了强模型。
    const toolResults = requests.flatMap((messages) =>
      messages.filter((message) => message.role === 'tool').map((message) => message.content ?? ''),
    );
    assert.ok(
      toolResults.some((content) => content.includes('未配置的模型别名')),
      `失败原因要回到模型上下文（实际工具结果 ${JSON.stringify(toolResults).slice(0, 300)}）`,
    );
  });
});

test('Router 指派模型：不传 model 时沿用 defaultModelAlias', async () => {
  await withHarness(null, async ({ store, router, config }) => {
    await router.handleUserMessage('建个任务').catch(() => undefined);
    const tasks = store.listTasks();
    assert.equal(tasks.length, 1, `应该只建一个任务（实际 ${tasks.length}）`);
    const owner = store.getWorker(tasks[0]!.ownerWorkerId!)!;
    assert.equal(owner.model, config.defaultModelAlias, '不传时应落到默认别名');
  });
});
