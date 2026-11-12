/**
 * 多模型 Worker：别名真的决定客户端与请求模型，未配置别名不静默回退。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, type Config } from '../../src/config.ts';
import { MockModel } from '../../src/model/mock.ts';
import { ModelRegistry } from '../../src/model/registry.ts';
import type { ModelClient } from '../../src/model/types.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';
import { workerStateBlock, workerSystemPrompt } from '../../src/runtime/prompts.ts';
import { testConfig } from '../helpers.ts';

interface Seen {
  alias: string;
  model: string;
}

/** 记录"哪个客户端收到了什么模型名"，用来证明请求真的路由到了对应配置。 */
function tracking(alias: string, seen: Seen[]): ModelClient {
  return new MockModel(async (context) => {
    seen.push({ alias, model: context.request.model });
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { text: '已收到', reasoning: null, toolCalls: [], finishReason: 'stop' as const, model: alias, usage: null };
  });
}

function harness(dir: string, config: Config, clients: Map<string, ModelClient>) {
  const store = new Store(join(dir, 'db.sqlite'), { instanceId: 'models' });
  const registry = new ModelRegistry(config.models, clients);
  const runtime = new Runtime({ store, config, workerModel: clients.get(config.defaultModelAlias)!, models: registry });
  return { store, runtime, registry };
}

function twoModels(config: Config): Config {
  return {
    ...config,
    models: [
      { alias: 'default', provider: 'mock', baseUrl: 'http://a', apiKey: 'k', apiKeyEnv: null, model: 'mock-worker', reasoningEffort: null, kind: 'chat', contextWindow: null, note: '日常执行', costHint: '较低' },
      { alias: 'strong', provider: 'mock', baseUrl: 'http://b', apiKey: 'k', apiKeyEnv: null, model: 'glm-5.3-flash', reasoningEffort: 'max', kind: 'chat', contextWindow: null, note: '复杂推理', costHint: '较高' },
    ],
    defaultModelAlias: 'default',
  };
}

test('多模型：指定别名时请求真的发往对应客户端与模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  // 单轮只允许一步：避免负责人的循环把记账记录挤出取样范围。
  const config = twoModels(testConfig(dir, { maxStepsPerRun: 1 }));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  const { store, runtime } = harness(dir, config, clients);
  try {
    const { task, owner } = runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    void task;
    const created = runtime.createCollaborator(owner, '助手', '帮忙', { model: 'strong' });
    assert.equal(created.ok, true, `创建应成功：${created.reason ?? ''}`);
    const collaboratorId = (created as { workerId: string }).workerId;

    runtime.enqueue(collaboratorId);
    for (let i = 0; i < 300 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await runtime.waitForIdle(5_000);

    assert.ok(seen.length >= 1, '协作者应真的发起请求');
    // 两个客户端各自收到的模型名必须与自己的配置一致，说明别名真的决定了路由。
    const strongCalls = seen.filter((item) => item.alias === 'strong');
    const defaultCalls = seen.filter((item) => item.alias === 'default');
    assert.ok(
      strongCalls.length >= 1,
      `strong 客户端应收到请求（实际 ${JSON.stringify(seen.slice(0, 5))}）`,
    );
    assert.ok(
      strongCalls.every((item) => item.model === 'glm-5.3-flash'),
      `strong 客户端只能收到 glm-5.3-flash（实际 ${JSON.stringify(strongCalls.slice(0, 3))}）`,
    );
    assert.ok(
      defaultCalls.every((item) => item.model === 'mock-worker'),
      'default 客户端只能收到 mock-worker',
    );

    // 别名要持久化：重启后仍能识别
    const worker = store.getWorker(collaboratorId)!;
    assert.equal(worker.model, 'strong');

    // 记账要能核对：别名、请求模型、用途、关联 Worker
    const calls = store.listModelCalls(2000).filter((row) => row.workerId === collaboratorId);
    assert.ok(calls.length > 0, '协作者的调用应被记账');
    const call = calls.at(-1)!;
    assert.equal(call.purpose, 'worker', `记账要写明用途（实际 ${call.purpose}）`);
    assert.equal(call.model, 'glm-5.3-flash', `请求模型要记录（实际 ${call.model}）`);
    assert.equal(call.modelAlias, 'strong', `模型配置别名要记录（实际 ${call.modelAlias}）`);
    assert.equal(call.taskId, task.id, '关联任务要记录');
    assert.equal(call.status, 'ok', '调用结果要记录');
  } finally {
    await runtime.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：未指定时沿用创建者的模型配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  const config = twoModels(testConfig(dir));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  const { store, runtime } = harness(dir, config, clients);
  try {
    const { owner } = runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b', model: 'strong' });
    assert.equal(store.getWorker(owner.id)?.model, 'strong', '负责人按指定别名创建');
    const created = runtime.createCollaborator(owner, '助手', '帮忙');
    assert.equal(created.ok, true);
    const worker = store.getWorker((created as { workerId: string }).workerId)!;
    assert.equal(worker.model, 'strong', '不指定时沿用创建者');
  } finally {
    await runtime.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：未知别名明确报错，不回退默认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  const config = twoModels(testConfig(dir));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  const { store, runtime } = harness(dir, config, clients);
  try {
    const { owner } = runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const created = runtime.createCollaborator(owner, '助手', '帮忙', { model: '不存在' });
    assert.equal(created.ok, false, '未知别名必须失败');
    assert.match((created as { reason: string }).reason, /未配置/, '错误要说明未配置');
    assert.equal(store.listGroupWorkers(owner.groupId).length, 1, '失败时不应创建出 Worker');
  } finally {
    await runtime.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：单模型旧配置仍然可用，别名退化为 default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const saved = { ...process.env };
  try {
    process.env['OLLAMA_BASE_URL'] = 'http://x/v1';
    process.env['OLLAMA_API_KEY'] = 'k';
    process.env['MODEL_NAME'] = 'only-model';
    delete process.env['MODEL_CATALOG'];
    const config = loadConfig();
    assert.equal(config.models.length, 1);
    assert.equal(config.models[0]?.alias, 'default');
    assert.equal(config.models[0]?.model, 'only-model');
    assert.equal(config.defaultModelAlias, 'default');
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：目录里不能出现重复别名，凭据不来自配置', () => {
  const saved = { ...process.env };
  try {
    process.env['OLLAMA_BASE_URL'] = 'http://x/v1';
    process.env['OLLAMA_API_KEY'] = 'secret-key';
    process.env['MODEL_NAME'] = 'base';
    process.env['MODEL_CATALOG'] = JSON.stringify([
      { alias: 'a', model: 'm1', apiKey: 'written-in-config' },
      { alias: 'a', model: 'm2' },
    ]);
    assert.throws(() => loadConfig(), /别名重复/, '重复别名必须报错');

    process.env['MODEL_CATALOG'] = JSON.stringify([{ alias: 'a', model: 'm1', apiKey: 'written-in-config' }]);
    const config = loadConfig();
    assert.equal(config.models[0]?.apiKey, 'secret-key', '凭据只能来自环境');
  } finally {
    process.env = saved;
  }
});

test('多模型：重启恢复后仍能识别 Worker 原本选择的模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  const config = twoModels(testConfig(dir, { maxStepsPerRun: 1 }));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  try {
    const first = harness(dir, config, clients);
    const { owner } = first.runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const created = first.runtime.createCollaborator(owner, '助手', '帮忙', { model: 'strong' });
    const collaboratorId = (created as { workerId: string }).workerId;
    await first.runtime.stop();
    first.store.close();

    // 重新打开同一个库：别名必须还在，并且后续请求仍走 strong
    const second = harness(dir, config, clients);
    try {
      const restored = second.store.getWorker(collaboratorId);
      assert.ok(restored, '重启后 Worker 仍在');
      assert.equal(restored.model, 'strong', '重启后仍能识别原本的模型配置');

      // 重启后按持久化的别名解析：解析结果必须仍是 strong 的客户端与模型
      const resolved = second.runtime.models.resolve(restored.model ?? config.defaultModelAlias);
      assert.equal(resolved.alias, 'strong');
      assert.equal(resolved.model, 'glm-5.3-flash');
      assert.equal(resolved.client, clients.get('strong'), '重启后解析到同一个 strong 客户端');
    } finally {
      await second.runtime.stop();
      second.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：模型目录不会把凭据写进提示词或调用记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  const config = twoModels(testConfig(dir, { maxStepsPerRun: 1 }));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  const { store, runtime } = harness(dir, config, clients);
  try {
    const { owner } = runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    runtime.enqueue(owner.id);
    for (let i = 0; i < 300 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await runtime.waitForIdle(5_000);

    // 模型目录在「系统当前状态」块里（跟着历史之后的 user 消息走），不在 system；
    // 直接构造一次核对。
    const worker = store.getWorker(owner.id)!;
    const task = store.getTaskByGroup(owner.groupId)!;
    const prompt = workerStateBlock({
      task,
      worker,
      collaborators: [],
      isOwner: true,
      taskFacts: '暂无',
      artifactTable: '暂无',
      noteText: null,
      noteStaleEpoch: null,
      noteCoveredSeq: 0,
      windowSummary: '',
      modelCatalog: { models: runtime.models.list(), currentAlias: worker.model },
    });
    assert.match(prompt, /可用模型/, '提示词里应有可用模型段');
    assert.match(prompt, /strong/, '应列出可选择的别名');
    assert.ok(!prompt.includes('test-key'), '凭据不能进入提示词');
    assert.ok(!prompt.includes('apiKey'), '凭据字段名也不应出现');
  } finally {
    await runtime.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型：普通任务不会被强制增加专家环节', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-models-'));
  const seen: Seen[] = [];
  const config = twoModels(testConfig(dir, { maxStepsPerRun: 1 }));
  const clients = new Map<string, ModelClient>([
    ['default', tracking('default', seen)],
    ['strong', tracking('strong', seen)],
  ]);
  const { store, runtime } = harness(dir, config, clients);
  try {
    const { owner } = runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    runtime.enqueue(owner.id);
    for (let i = 0; i < 300 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await runtime.waitForIdle(5_000);
    // 程序不得自动创建协作者
    assert.equal(store.listGroupWorkers(owner.groupId).length, 1, '不应自动创建额外的 Worker');
    assert.ok(
      seen.every((item) => item.alias === 'default'),
      `普通任务不应自动调用其它模型（实际 ${JSON.stringify(seen.slice(0, 3))}）`,
    );
  } finally {
    await runtime.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多供应商：每个别名用自己的凭据与思考强度', () => {
  const before = { ...process.env };
  try {
    process.env['OLLAMA_BASE_URL'] = 'https://a.example/v1';
    process.env['OLLAMA_API_KEY'] = 'key-a';
    process.env['MODEL_NAME'] = 'model-a';
    process.env['PRO_API_KEY'] = 'key-b';
    process.env['MODEL_CATALOG'] = JSON.stringify([
      { alias: 'default', model: 'model-a' },
      {
        alias: 'pro',
        provider: 'other',
        baseUrl: 'https://b.example/v1',
        apiKeyEnv: 'PRO_API_KEY',
        model: 'model-b',
        reasoningEffort: 'max',
      kind: 'chat',
      },
    ]);
    const config = loadConfig();
    const pro = config.models.find((item) => item.alias === 'pro')!;
    assert.equal(pro.apiKey, 'key-b', 'pro 必须用自己的 key，不能退回全局凭据');
    assert.equal(pro.baseUrl, 'https://b.example/v1');
    assert.equal(pro.reasoningEffort, 'max');
    const fallback = config.models.find((item) => item.alias === 'default')!;
    assert.equal(fallback.apiKey, 'key-a');
    assert.equal(fallback.reasoningEffort, null, '没写就用全局强度');
  } finally {
    process.env = before;
  }
});

test('多供应商：apiKeyEnv 指向的变量缺失时明确失败，不静默退回全局凭据', () => {
  const before = { ...process.env };
  try {
    process.env['OLLAMA_BASE_URL'] = 'https://a.example/v1';
    process.env['OLLAMA_API_KEY'] = 'key-a';
    process.env['MODEL_NAME'] = 'model-a';
    delete process.env['MISSING_KEY_ENV'];
    process.env['MODEL_CATALOG'] = JSON.stringify([
      { alias: 'pro', baseUrl: 'https://b.example/v1', apiKeyEnv: 'MISSING_KEY_ENV', model: 'model-b' },
    ]);
    assert.throws(() => loadConfig(), /MISSING_KEY_ENV/, '缺凭据要在启动时失败，不能带病运行');
  } finally {
    process.env = before;
  }
});
