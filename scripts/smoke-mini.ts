/**
 * 真实模型最小链路冒烟：一个任务、一个 Worker、一份产物，严格判定。
 * 运行：pnpm smoke:mini
 * 退出码：0 通过；1 未通过；2 超时；3 环境问题。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PiModel } from '../src/model/pi.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { isolateRun, judgeTask, report } from './smoke-lib.ts';

const log = (message: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const base = loadConfig();
  const runId = `mini-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  const config = isolateRun(base, runId);
  log(`本次运行：${runId}`);
  log(`数据库：${config.dbPath}`);
  log(`工作目录：${config.workDir}`);

  await mkdir(config.materialsDir, { recursive: true });
  await writeFile(
    join(config.materialsDir, 'sales-q3.md'),
    '# 2026 年 Q3 销售数据\n\n- 华北区营收：1280 万元，环比增长 12%\n- 华东区营收：2160 万元，环比增长 9%\n- 华南区营收：1740 万元，环比下降 3%\n- 合计营收：5180 万元\n',
    'utf8',
  );

  const store = new Store(config.dbPath);
  const modelOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  };
  const workerModel = new PiModel(modelOptions, config.modelName);
  const routerModel = new PiModel(modelOptions, config.modelName);
  config.limits.maxConcurrentRuns = 1;
  const runtime = new Runtime({ store, config, workerModel });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  let createdTaskId: string | null = null;
  runtime.on((event) => {
    if (event.type === 'task.created') createdTaskId = event.taskId;
    if (event.type === 'task.status') log(`任务：${event.taskId} → ${event.status}`);
    if (event.type === 'worker.created') log(`Worker：${event.workerId}（${event.role}）`);
    if (event.type === 'message.sent') log(`消息：${event.from} → ${event.to} (${event.kind})`);
    if (event.type === 'router.reply') log(`Router：${event.text.slice(0, 240)}`);
    if (event.type === 'error') log(`提示：${event.text}`);
  });

  runtime.start();
  try {
    await router.handleUserMessage(
      '请读取 materials/sales-q3.md，写一份 150 字以内的摘要保存为 summary.md，完成后直接交付。',
    );
  } catch (error) {
    console.error('Router 调用失败：', error instanceof Error ? error.message : error);
    report({ ok: false, code: 3, lines: ['环境或配置问题：Router 无法完成请求，请看上面的错误信息'] });
  }

  const deadline = Date.now() + 300_000;
  let timedOut = false;
  while (Date.now() < deadline) {
    if (!createdTaskId) {
      await sleep(1000);
      continue;
    }
    const task = store.getTask(createdTaskId);
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) break;
    await sleep(2000);
  }
  if (!createdTaskId) {
    report({ ok: false, code: 1, lines: ['Router 没有建立任何任务，无法验证执行链路'] });
  }
  const task = store.getTask(createdTaskId);
  if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) timedOut = true;

  const verdict = timedOut
    ? { ok: false, code: 2, lines: ['等待超时：任务在 300 秒内没有进入终态'] }
    : judgeTask(store, config, createdTaskId);

  if (!timedOut) {
    for (const worker of store.listGroupWorkers(task!.groupId)) {
      verdict.lines.push(`Worker ${worker.id}：${worker.status}，${worker.stepCount} 步${worker.lastError ? `，错误：${worker.lastError}` : ''}`);
    }
  } else {
    for (const worker of store.listGroupWorkers(task!.groupId)) {
      console.log(`Worker ${worker.id}：${worker.status}，${worker.stepCount} 步${worker.lastError ? `，错误：${worker.lastError}` : ''}`);
    }
  }

  await runtime.stop();
  store.close();
  report(verdict);
}

main().catch((error: unknown) => {
  console.error('冒烟异常退出：', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(3);
});
