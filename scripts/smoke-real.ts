/**
 * 真实模型冒烟：用配置里的真实模型跑一遍综合场景。
 * 运行：node --env-file-if-exists=.env.local scripts/smoke-real.ts
 */
import { randomBytes } from 'node:crypto';
import { clockStamp } from '../src/domain/ids.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PiModel } from '../src/model/pi.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { isolateRun, judgeTask, report } from './smoke-lib.ts';

const MATERIALS: Record<string, string> = {
  'sales-q3.md': `# 2026 年 Q3 销售数据

- 华北区营收：1280 万元，环比增长 12%
- 华东区营收：2160 万元，环比增长 9%
- 华南区营收：1740 万元，环比下降 3%
- 合计营收：5180 万元
- 新签客户：47 家
`,
  'ops-q3.md': `# 2026 年 Q3 运营数据

- 活跃客户数：1820 家（Q2 为 1655 家）
- 平均交付周期：18 天（Q2 为 24 天）
- 客户满意度：4.4 / 5（Q2 为 4.6 / 5）
- 工单积压：312 单，其中超期 58 单
`,
  'notes.md': `# 内部备注

- 华南区下滑主要来自两个大客户续约延后。
- 满意度下降与交付周期缩短并存，需要核对统计口径是否一致。
- 华东区 9% 的增长口径与 Q2 口径不同，统计时注意。
`,
};

function log(message: string): void {
  console.log(`[${clockStamp()}] ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const base = loadConfig();
  const runId = `real-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  const config = isolateRun(base, runId);
  log(`本次运行：${runId}｜数据库 ${config.dbPath}`);
  await mkdir(config.materialsDir, { recursive: true });
  for (const [name, content] of Object.entries(MATERIALS)) {
    const path = join(config.materialsDir, name);
    try {
      await readFile(path);
    } catch {
      await writeFile(path, content, 'utf8');
      log(`已写入材料 ${name}`);
    }
  }

  const loggingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const copy = response.clone();
    void copy.text().then((text) => {
      try {
        const json = JSON.parse(text) as {
          choices?: { finish_reason?: string; message?: { content?: string; tool_calls?: unknown[] } }[];
          usage?: unknown;
        };
        const choice = json.choices?.[0];
        log(
          `模型响应 finish=${choice?.finish_reason} content=${(choice?.message?.content ?? '').length} tools=${choice?.message?.tool_calls?.length ?? 0} usage=${JSON.stringify(json.usage)}`,
        );
      } catch {
        log(`模型响应非 JSON：${text.slice(0, 200)}`);
      }
    });
    return response;
  };

  const store = new Store(config.dbPath);
  const workerModel = new PiModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    fetchImpl: loggingFetch,
  }, config.modelName);
  const routerModel = new PiModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    fetchImpl: loggingFetch,
  }, config.modelName);
  config.limits.maxConcurrentRuns = Math.min(config.limits.maxConcurrentRuns, 1);
  const runtime = new Runtime({ store, config, workerModel });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  let createdTaskId: string | null = null;
  const unsubscribe = runtime.on((event) => {
    switch (event.type) {
      case 'router.reply':
        log(`Router：${event.text}`);
        break;
      case 'router.notice':
        log(`提示：${event.text}`);
        break;
      case 'task.created':
        createdTaskId = event.taskId;
        log(`任务建立：${event.taskId} ${event.title}`);
        break;
      case 'task.status':
        log(`任务状态：${event.taskId} → ${event.status}`);
        break;
      case 'worker.created':
        log(`Worker：${event.workerId}（${event.role}${event.parentId ? `，来源 ${event.parentId}` : ''}）`);
        break;
      case 'message.sent':
        log(`消息：${event.from} → ${event.to} (${event.kind})`);
        break;
      case 'error':
        log(`错误：${event.text}`);
        break;
      default:
        break;
    }
  });

  runtime.start();
  const recovered = runtime.recover();
  if (recovered.recovered > 0 || recovered.waiting > 0) {
    log(`恢复：中断 ${recovered.interrupted}、重排 ${recovered.requeued}、仍在等待 ${recovered.waiting}`);
  }

  const started = Date.now();
  log('发送主请求');
  await router.handleUserMessage(
    '请根据 materials 目录下的三份材料整理一份季度报告，保存为 report.md。要求：给出营收与运营的关键结论，所有数据都标注来源文件；完成后请安排一次同组检查再交付。',
  );
  const routerDone = Date.now() - started;
  log(`Router 首轮回复完成，用时 ${(routerDone / 1000).toFixed(1)}s（此时 Worker 应仍在后台工作）`);

  await sleep(2000);
  log('在后台工作期间发送第二条独立请求');
  const secondStart = Date.now();
  await router.handleUserMessage('顺便用一句话说明：这个系统里 Router 和 Worker 各负责什么？');
  log(`第二条请求已回复，等待 ${((Date.now() - secondStart) / 1000).toFixed(1)}s`);

  const waitLimitMs = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 600_000);
  log(`等待上限：${Math.round(waitLimitMs / 1000)} 秒`);
  const deadline = Date.now() + waitLimitMs;
  let timedOut = false;
  while (Date.now() < deadline) {
    const tasks = store.listTasks();
    const open = tasks.filter((task) => task.status === 'active' || task.status === 'waiting' || task.status === 'pending');
    if (tasks.length > 0 && open.length === 0 && runtime.stats().running === 0) break;
    await sleep(1000);
  }
  if (store.listTasks().some((task) => ['active', 'waiting', 'pending'].includes(task.status))) timedOut = true;
  await runtime.waitForIdle(30_000);

  log('==== 结果 ====');
  for (const task of store.listTasks()) {
    console.log(`\n任务 ${task.id}｜${task.title}｜状态 ${task.status}｜负责人 ${task.ownerWorkerId}`);
    console.log(`  目标：${task.goal}`);
    console.log(`  完成条件：${task.doneCriteria}`);
    if (task.closeReason) console.log(`  结项说明：${task.closeReason.slice(0, 300)}`);
    for (const worker of store.listGroupWorkers(task.groupId)) {
      console.log(`  - ${worker.id} ${worker.role} ${worker.status} steps=${worker.stepCount} parent=${worker.parentId ?? '-'}`);
    }
    for (const message of store.listGroupMessages(task.groupId, 100)) {
      console.log(`    [${message.kind}] ${message.fromId}→${message.toId} ${message.status} ${message.body.slice(0, 120)}`);
    }
    for (const artifact of store.listArtifacts(task.id)) {
      console.log(`    产物：${artifact.name} v${artifact.version} ${artifact.bytes} 字节 sha256=${artifact.sha256.slice(0, 12)}`);
    }
  }

  unsubscribe();
  await runtime.stop();

  if (!createdTaskId) {
    store.close();
    report({ ok: false, code: 1, lines: ['Router 没有建立任何任务'] });
  }
  const targetTaskId = createdTaskId;
  const verdict = timedOut
    ? { ok: false, code: 2, lines: [`等待超时：${Math.round(waitLimitMs / 1000)} 秒内任务没有结束`] }
    : judgeTask(store, config, targetTaskId);
  verdict.lines.push('—— 过程证据 ——');
  for (const task of store.listTasks()) {
    verdict.lines.push(`任务 ${task.id}｜${task.status}｜${task.title}`);
  }
  for (const worker of store.listWorkers()) {
    verdict.lines.push(`Worker ${worker.id}｜${worker.status}｜${worker.stepCount} 步｜${worker.lastError ?? '-'}`);
  }
  verdict.lines.push(
    `模型调用：见上表每条记录的 http_attempts（与请求体转储数不同）`,
  );
  store.close();
  report(verdict);
}

main().catch((error: unknown) => {
  console.error('冒烟异常退出：', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(3);
});
