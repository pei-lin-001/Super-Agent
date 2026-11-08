/**
 * 真实模型最小链路冒烟：一个任务、一个 Worker、一次工具调用、一份产物。
 * 运行：node --env-file-if-exists=.env.local scripts/smoke-mini.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { OpenAICompatibleModel } from '../src/model/openai.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';

const log = (message: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.materialsDir, { recursive: true });
  await writeFile(
    join(config.materialsDir, 'sales-q3.md'),
    '# 2026 年 Q3 销售数据\n\n- 华北区营收：1280 万元，环比增长 12%\n- 华东区营收：2160 万元，环比增长 9%\n- 华南区营收：1740 万元，环比下降 3%\n- 合计营收：5180 万元\n',
    'utf8',
  );

  const store = new Store(config.dbPath);
  const workerModel = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  });
  const routerModel = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  });
  config.limits.maxConcurrentRuns = 1;
  const runtime = new Runtime({ store, config, workerModel });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  runtime.on((event) => {
    if (event.type === 'router.reply') log(`Router：${event.text.slice(0, 300)}`);
    if (event.type === 'task.status') log(`任务：${event.taskId} → ${event.status}`);
    if (event.type === 'worker.created') log(`Worker：${event.workerId}（${event.role}）`);
    if (event.type === 'message.sent') log(`消息：${event.from} → ${event.to} (${event.kind})`);
    if (event.type === 'error') log(`提示：${event.text}`);
  });

  runtime.start();
  await router.handleUserMessage(
    '请读取 materials/sales-q3.md，写一份 150 字以内的摘要保存为 summary.md，完成后直接交付。',
  );

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const tasks = store.listTasks();
    const open = tasks.filter((task) => ['pending', 'active', 'waiting'].includes(task.status));
    if (tasks.length > 0 && open.length === 0) break;
    await sleep(2000);
  }

  for (const task of store.listTasks()) {
    console.log(`\n任务 ${task.id}｜状态 ${task.status}｜负责人 ${task.ownerWorkerId}`);
    if (task.closeReason) console.log(`  结项：${task.closeReason.slice(0, 200)}`);
    for (const worker of store.listGroupWorkers(task.groupId)) {
      console.log(`  - ${worker.id} ${worker.status} steps=${worker.stepCount} ${worker.lastError ?? ''}`);
    }
    for (const artifact of store.listArtifacts(task.id)) {
      console.log(`  产物：${artifact.name} v${artifact.version} ${artifact.bytes} 字节`);
      const content = await readFile(join(config.workDir, artifact.path), 'utf8');
      console.log(content.slice(0, 600));
    }
  }

  await runtime.stop();
  store.close();
}

main().catch((error: unknown) => {
  console.error('冒烟失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
