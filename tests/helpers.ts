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
  contextWindowChars: 16_000,
  pairingOvershootChars: 2_000,
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
    reasoningEffort: 'max',
    timeoutMs: 5000,
    maxTokens: 2048,
    dbPath: join(dir, '.data', 'agent.db'),
    workDir: join(dir, 'work'),
    materialsDir: join(dir, 'work', 'materials'),
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
    provider: 'mock',
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'test-key',
    modelName: 'mock-model',
    routerModel: 'mock-router',
    workerModel: 'mock-worker',
    reasoningEffort: 'max',
    timeoutMs: 5000,
    maxTokens: 2048,
    dbPath: join(dir, '.data', 'agent.db'),
    workDir,
    materialsDir,
    limits: { ...BASE_LIMITS, ...options.limits },
  };

  const store = new Store(config.dbPath);
  const workerModel = new MockModel(options.worker);
  const routerModel = new MockModel(
    options.router ??
      (() => ({
        text: '已记录。',
        reasoning: null,
        toolCalls: [],
        finishReason: 'stop',
        model: 'mock-router',
        usage: null,
      })),
  );
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

export function roleOf(request: ChatRequest): string {
  const match = systemText(request).match(/- 职责：(.+)/);
  return match?.[1]?.trim() ?? '';
}

export function workerIdOf(request: ChatRequest): string {
  const match = systemText(request).match(/- Worker：(\S+)/);
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
  const last = request.messages.at(-1);
  return last?.role === 'tool' ? (last.content ?? '') : null;
}

export function inboxOf(request: ChatRequest): string {
  return request.messages.filter((message) => message.role === 'user').map((message) => message.content ?? '').join('\n');
}
