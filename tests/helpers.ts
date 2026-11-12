import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Limits } from '../src/config.ts';
import type { ChatRequest, ModelClient, StepResult } from '../src/model/types.ts';
import { MockModel, mockReply, type MockHandler } from '../src/model/mock.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';

export interface Harness {
  dir: string;
  config: Config;
  store: Store;
  workerModel: MockModel;
  routerModel: MockModel;
  runtime: Runtime;
  router: Router;
  cleanup(): Promise<void>;
}

const BASE_LIMITS: Limits = {
  maxConcurrentRuns: 3,
  maxWorkersPerGroup: 6,
  maxTotalWorkers: 12,
  maxStepsPerRun: 8,
  maxStepsPerWorker: 24,
  maxStepsPerGroup: 160,
  maxRequestHops: 4,
  messageTtlMinutes: 30,
  waitTimeoutMs: 400,
  modelRetry: 0,
  maxNudges: 3,
  maxRouterRounds: 6,
  watchdogIntervalMs: 60_000,
  contextWindowChars: 16_000,
  pairingOvershootChars: 2_000,
  contextWindowTokens: 32_000,
  routerReserveTokens: 1_000,
  workerKeepRecentTokens: 40_000,
  routerKeepRecentTokens: 4_000,
  routerNoteMaxChars: 2_000,
  noteTriggerTurns: 10,
  noteTriggerChars: 3_000,
  noteMaxChars: 6_000,
  noteInputChars: 24_000,
  noteRetryMs: 120_000,
  noteMaxFailures: 3,
};

export function testConfig(dir: string, overrides: Partial<Limits> = {}): Config {
  return {
    provider: 'mock',
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'test-key',
    modelName: 'mock-model',
    routerModel: 'mock-router',
    workerModel: 'mock-worker',
    models: [
      {
        alias: 'default',
        provider: 'mock',
        baseUrl: 'http://127.0.0.1:0/v1',
        apiKey: 'test-key',
        apiKeyEnv: null,
        model: 'mock-worker',
        reasoningEffort: null,
kind: 'chat',
contextWindow: null,
note: null,
        costHint: null,
      },
    ],
    defaultModelAlias: 'default',
    channels: {
      stateDir: join(dir, 'channels'),
      pollTimeoutMs: 1000,
      maxInboundBytes: 25 * 1024 * 1024,
      telegram: { enabled: false, ownerIds: [], botToken: '', apiBase: 'http://127.0.0.1:0', cdnBase: '' },
      weixin: { enabled: false, ownerIds: [], botToken: '', apiBase: 'http://127.0.0.1:0', cdnBase: '' },
    },
    reasoningEffort: 'max',
    timeoutMs: 5000,
    maxTokens: 2048,
    dbPath: join(dir, '.data', 'agent.db'),
    workDir: join(dir, 'work'),
    materialsDir: join(dir, 'work', 'materials'),
    readRoot: dir,
    limits: { ...BASE_LIMITS, ...overrides },
  };
}

export async function createHarness(options: {
  worker: MockHandler;
  router?: MockHandler;
  limits?: Partial<Limits>;
  materials?: Record<string, string>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-test-'));
  const workDir = join(dir, 'work');
  const materialsDir = join(workDir, 'materials');
  await mkdir(materialsDir, { recursive: true });
  for (const [name, content] of Object.entries(options.materials ?? {})) {
    await writeFile(join(materialsDir, name), content, 'utf8');
  }

  const config: Config = {
    readRoot: dir,
    provider: 'mock',
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'test-key',
    modelName: 'mock-model',
    routerModel: 'mock-router',
    workerModel: 'mock-worker',
    models: [
      {
        alias: 'default',
        provider: 'mock',
        baseUrl: 'http://127.0.0.1:0/v1',
        apiKey: 'test-key',
        apiKeyEnv: null,
        model: 'mock-worker',
        reasoningEffort: null,
kind: 'chat',
contextWindow: null,
note: null,
        costHint: null,
      },
    ],
    defaultModelAlias: 'default',
    channels: {
      stateDir: join(dir, 'channels'),
      pollTimeoutMs: 1000,
      maxInboundBytes: 25 * 1024 * 1024,
      telegram: { enabled: false, ownerIds: [], botToken: '', apiBase: 'http://127.0.0.1:0', cdnBase: '' },
      weixin: { enabled: false, ownerIds: [], botToken: '', apiBase: 'http://127.0.0.1:0', cdnBase: '' },
    },
    reasoningEffort: 'max',
    timeoutMs: 5000,
    maxTokens: 2048,
    dbPath: join(dir, '.data', 'agent.db'),
    workDir,
    materialsDir,
    limits: { ...BASE_LIMITS, ...options.limits },
  };

  const store = new Store(config.dbPath);
  // 假模型必须真的让出一次事件循环：同步返回会让整条执行链在微任务里跑完，
  // 定时器永远排不上，进程看起来像卡死。
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const workerModel = new MockModel(async (context) => {
    await tick();
    return options.worker(context);
  });
  const routerModel = new MockModel(async (context) => {
    await tick();
    const handler =
      options.router ??
      (() => ({
        text: '已记录。',
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
        model: 'mock-router',
        usage: null,
      }));
    return handler(context);
  });
  const runtime = new Runtime({ store, config, workerModel });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  return {
    dir,
    config,
    store,
    workerModel,
    routerModel,
    runtime,
    router,
    async cleanup() {
      await runtime.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function systemText(request: ChatRequest): string {
  return request.messages.find((message) => message.role === 'system')?.content ?? '';
}

/**
 * 整个请求里的全部文本（system + 历史 + 本轮）。
 *
 * 任务卡、待处理消息这些"每轮都会变"的状态已经从 system 挪到最后的 user 消息里，
 * 目的是让提示缓存能命中稳定的前缀。断言"某段内容在提示里"时用这个，
 * 断言"这段内容属于规则而非状态"时才用 systemText。
 */
export function allText(request: ChatRequest): string {
  return request.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

// 身份与职责在「系统当前状态」块里（跟着最后那条 user 消息走），不在 system。
export function roleOf(request: ChatRequest): string {
  const match = allText(request).match(/- 职责：(.+)/);
  return match?.[1]?.trim() ?? '';
}

export function workerIdOf(request: ChatRequest): string {
  const match = allText(request).match(/- Worker：(\S+)/);
  return match?.[1]?.trim() ?? '';
}

/** 工作记录整理请求与普通任务请求分开应答。 */
export function isNoteRequest(request: ChatRequest): boolean {
  return systemText(request).includes('工作记录整理器');
}

/** 按职责分派剧本，每个职责独立计数。 */
export function scripted(
  handlers: Record<string, (step: number, request: ChatRequest) => StepResult | Promise<StepResult>>,
  options: { note?: (request: ChatRequest) => StepResult | Promise<StepResult> } = {},
): MockHandler {
  const counters = new Map<string, number>();
  const roles = Object.keys(handlers);
  return ({ request }) => {
    if (isNoteRequest(request)) {
      if (options.note) return options.note(request);
      return mockReply({ text: '## 已完成\n（默认工作记录）' });
    }
    const role = roleOf(request);
    const key = roles.find((candidate) => role === candidate) ?? roles.find((candidate) => role.includes(candidate));
    if (!key) {
      throw new Error(`没有为职责「${role}」准备剧本。已准备：${roles.join(', ')}`);
    }
    const step = counters.get(key) ?? 0;
    counters.set(key, step + 1);
    return handlers[key]!(step, request);
  };
}

export function lastToolContent(request: ChatRequest): string {
  return request.messages.at(-1)?.content ?? '';
}

export function toolResult(request: ChatRequest): string | null {
  // 取最近一条工具结果，而不是「最后一条消息」：pi 的 agent-loop 会把新到的
  // 协作者消息（steering）插在工具结果之后，最后一条就不一定是工具结果了。
  const tool = request.messages.filter((message) => message.role === 'tool').at(-1);
  return tool ? (tool.content ?? '') : null;
}

/**
 * 收件箱（历史里的 user 消息）。
 *
 * 要排除最后那条「稳定执行上下文」——它现在排在最末尾（为了缓存命中），
 * 但它不是收件箱内容。以前它排在历史之前，所以直接拼接不会影响顺序；
 * 挪到末尾后仍然排除掉，语义才一致。
 */
export function inboxOf(request: ChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content ?? '')
    .filter((text) => !text.includes('稳定执行上下文'))
    .join('\n');
}
