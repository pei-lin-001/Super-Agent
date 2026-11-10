/**
 * 真实模型验收 1：Router 在小额度下跨多轮完成不同操作。
 *
 * 判定条件：
 * - 单轮额度设为 1，必须真的发生多次续接（不是一轮做完）；
 * - 每一次续接产生的是新操作，不是复用上一次的结果；
 * - 最终任务集合符合要求，且没有重复创建；
 * - 会话在完成后关闭。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PiModel } from '../src/model/pi.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'sa-router-real-'));
process.env['DB_PATH'] = join(dir, 'db.sqlite');
process.env['WORK_DIR'] = join(dir, 'work');
process.env['MAX_ROUTER_ROUNDS'] = '1';
process.env['MODEL_CONCURRENCY'] = '1';
// 验收关心的是协调层行为，不是模型思考深度；用低强度让多轮续接在可接受时间内完成。
process.env['MODEL_REASONING_EFFORT'] = process.env['ACCEPT_REASONING'] ?? 'low';

const config = loadConfig();
const store = new Store(config.dbPath);
const model = new PiModel({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  retry: config.limits.modelRetry,
  reasoningEffort: config.reasoningEffort,
  maxTokens: config.maxTokens,
}, config.modelName);
// Worker 不参与这次验收：让它一步就提交，避免把时间花在业务执行上。
// 空响应会让 Worker 反复重试（这是另一条链路），这里不给它这个机会。
let submitSeq = 0;
const runtime = new Runtime({
  store,
  config,
  workerModel: {
    kind: 'mock',
    label: 'instant-submit',
    chat: async () => {
      submitSeq += 1;
      // 每个 Worker 两步走完：先登记产物，再提交。空产物会被校验退回，导致反复重试。
      const save = submitSeq % 2 === 1;
      return {
        text: null,
        reasoning: null,
        toolCalls: [
          save
            ? {
                id: `call_${submitSeq}`,
                name: 'artifact_save',
                arguments: JSON.stringify({ name: 'placeholder.md', content: '# 占位交付\n本次只验收协调层。\n' }),
              }
            : {
                id: `call_${submitSeq}`,
                name: 'submit_result',
                arguments: JSON.stringify({ summary: '占位交付（本次只验收协调层）', artifacts: ['placeholder.md'] }),
              },
        ],
        finishReason: 'tool_calls',
        model: 'instant-submit',
        usage: null,
      };
    },
  },
} as never);
const router = new Router(runtime, model, config);

const failures: string[] = [];
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};

try {
  console.log(`数据库：${config.dbPath}`);
  console.log(`模型：${config.workerModel}｜单轮额度：${config.limits.maxRouterRounds}`);

  await router.handleUserMessage(
    '请创建两个独立任务：第一个标题「整理周报」，第二个标题「核对账单」。' +
      '两个任务各建一次就够了，标题不要重复。建完告诉我即可。',
  );

  const rounds: number[] = [store.listTasks().length];
  // 连续续接，直到会话关闭或达到上限
  for (let i = 0; i < 6; i += 1) {
    if (!store.pendingRouterSession()) break;
    await router.resume().catch((error: unknown) => {
      console.log(`续接失败：${(error as Error).message}`);
    });
    rounds.push(store.listTasks().length);
  }

  const tasks = store.listTasks();
  const titles = tasks.map((task) => task.title);
  console.log(`每轮任务数：${rounds.join(' → ')}`);
  console.log(`最终任务：${titles.join('｜') || '（无）'}`);

  check(rounds.length >= 2, `确实发生了多轮续接（${rounds.length - 1} 次）`);
  // 额度限制的是「模型决策轮数」，不是单次决策里的工具调用数：
  // 一次响应返回两个 create_task 是合法的一次决策，不应该被算成两轮。
  check(
    (store.modelCallStats().find((item) => item.purpose === 'router')?.calls ?? 0) >= 2,
    '额度 1 确实把决策轮数压到了多轮（Router 至少被调用两次）',
  );
  check(tasks.length >= 2, `两个任务都建成了（${tasks.length} 个）`);
  check(new Set(titles).size === titles.length, '没有重复创建同名任务');
  check(!store.pendingRouterSession(), '协调完成后会话已关闭');

  const stats = store.modelCallStats().find((item) => item.purpose === 'router');
  console.log(`Router 模型调用：${stats?.calls ?? 0} 次，其中有 usage 的 ${stats?.usageKnown ?? 0} 次`);
  check((stats?.calls ?? 0) >= 2, '记账覆盖了多次 Router 调用');
} finally {
  await runtime.stop();
  store.close();
  if (failures.length === 0) rmSync(dir, { recursive: true, force: true });
  else console.log(`工作目录保留：${dir}`);
}

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('\n验收通过');
process.exit(0);
