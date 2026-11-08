/**
 * Watchdog 独立进程入口。
 *
 * 它不构造 Runtime：不会恢复作业、不会调度业务 Worker、不会清理主系统的任何东西。
 * 它只做三件事：观察主库（只读语义）、通过控制命令实施维护、把自己的会话与动作记录在自己的表里。
 * 主系统退出后它仍在运行，并能按需拉起主系统。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { OpenAICompatibleModel } from '../model/openai.ts';
import { Store } from '../storage/store.ts';
import { mkdirSync as mkdir, writeFileSync as writeJson } from 'node:fs';
import { instancePath, isPidAlive, looksLikeOurProcess, readInstance } from './observer.ts';
import { mainHealth, spawnMain } from './process.ts';
import { WatchdogSession } from './session.ts';

const config = loadConfig();
const store = new Store(config.dbPath);

const model = new OpenAICompatibleModel({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  retry: config.limits.modelRetry,
  reasoningEffort: config.reasoningEffort,
  maxTokens: config.maxTokens,
});

const stopFile = join(config.workDir, '.runtime', 'watchdog.stop');
const pidFile = join(config.workDir, '.runtime', 'watchdog.json');

/** 拉起主系统。只在确认它确实退出、或 PID 属于无关进程时进行。 */
async function restartMain(): Promise<{ ok: boolean; message: string }> {
  // 停机标记必须在动作执行前重新检查：维护者明确停机时不能被自动拉起。
  if (existsSync(stopFile)) {
    return { ok: false, message: '存在停机标记，不执行自动拉起；需要维护者显式恢复自动维护' };
  }
  const result = spawnMain(config, { cooldownMs: 120_000 });
  return { ok: result.ok, message: result.message };
}

const session = new WatchdogSession({
  store,
  config,
  model,
  modelName: process.env['WATCHDOG_MODEL'] ?? config.workerModel,
  restartMain,
  health: () => mainHealth(config),
});

mkdirSync(dirname(pidFile), { recursive: true });

// 单实例：同一时间只允许一个有效维护者，避免重复巡检与恢复风暴。
// 原子抢占：同时启动时只有一个能拿到写句柄（O_EXCL），不依赖"先读再写"的顺序。
const lockPath = `${pidFile}.lock`;
let acquired = false;
for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    acquired = true;
  } catch {
    // 锁文件已存在：确认持有者是否真的还活着，否则视为陈旧锁清理后重试。
    let holder = 0;
    try {
      holder = Number(readFileSync(lockPath, 'utf8').trim());
    } catch {
      holder = 0;
    }
    const alive = Number.isInteger(holder) && holder >= 2 && isPidAlive(holder) && looksLikeOurProcess(holder, 'watchdog');
    if (alive) {
      console.log(`已有 Watchdog 在运行（pid=${holder}），本次不启动`);
      store.close();
      process.exit(3);
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // 清理陈旧锁失败时直接退出，避免两个实例同时写库。
      console.log('无法清理陈旧锁，本次不启动');
      store.close();
      process.exit(3);
    }
  }
}
if (!acquired) {
  console.log('未能取得单实例锁，本次不启动');
  store.close();
  process.exit(3);
}
const releaseLock = (): void => {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // 退出路径不阻塞。
  }
};
process.on('exit', releaseLock);

writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');

// 维护者提问入口：写持久问题队列，由唯一的维护者串行处理。
// 已有 Watchdog 在跑时，这里只当客户端，不会因为单实例约束被拒绝。
// 没有 Watchdog 在跑时，本次进程接管唯一的维护资格来处理问题。
const askIndex = process.argv.indexOf('--ask');
const questionId = `wdq_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

async function runQuestionWorker(): Promise<void> {
  const pending = store.nextPendingQuestion();
  if (!pending) return;
  try {
    const answer = await session.ask(pending.question);
    store.finishWdQuestion(pending.id, answer, null);
  } catch (error) {
    store.finishWdQuestion(pending.id, null, (error as Error).message);
  }
}

if (askIndex !== -1) {
  const question = process.argv[askIndex + 1] ?? '';
  if (question.trim() === '') {
    console.log('用法：pnpm watchdog --ask "为什么这个任务停住了？"');
    process.exit(1);
  }
  store.insertWdQuestion(questionId, question);
  console.log(`已提交问题 ${questionId}`);

  const existing = (() => {
    try {
      const info = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
      return info.pid;
    } catch {
      return null;
    }
  })();
  const ownerAlive =
    existing !== null && Number.isInteger(existing) && existing >= 2 && isPidAlive(existing) && looksLikeOurProcess(existing, 'watchdog');

  if (ownerAlive) {
    // 已经有维护者在跑：等它处理，不启动第二个。
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const record = store.getWdQuestion(questionId);
      if (record && record.status !== 'pending') {
        console.log('---');
        console.log(record.status === 'done' ? record.answer ?? '' : `处理失败：${record.error ?? '未知原因'}`);
        store.close();
        process.exit(record.status === 'done' ? 0 : 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    console.log('问题仍在队列中（维护者尚未处理完），可用 --answer <问题ID> 稍后查询。');
    store.close();
    process.exit(5);
  }

  // 没有维护者在跑：本次进程取得维护资格后处理问题。
  await runQuestionWorker();
  const record = store.getWdQuestion(questionId);
  if (record) {
    console.log('---');
    console.log(record.status === 'done' ? record.answer ?? '' : `处理失败：${record.error ?? '未知原因'}`);
  }
  store.close();
  process.exit(record?.status === 'done' ? 0 : 1);
}

const answerIndex = process.argv.indexOf('--answer');
if (answerIndex !== -1) {
  const id = process.argv[answerIndex + 1] ?? '';
  const record = store.getWdQuestion(id);
  if (!record) {
    console.log(`找不到问题 ${id}`);
    store.close();
    process.exit(1);
  }
  console.log(`${record.status}｜${record.question}`);
  if (record.answer) console.log(`回答：${record.answer}`);
  if (record.error) console.log(`失败：${record.error}`);
  store.close();
  process.exit(0);
}

const log = (message: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
};

/** 巡检间隔可以在线调整：watchdog.interval 覆盖项优先于配置。 */
function currentIntervalMs(): number {
  const override = store.activeOverride('watchdog.interval');
  if (override) {
    const value = Number(override.content.trim());
    if (Number.isFinite(value) && value >= 10_000 && value <= 3_600_000) return value;
  }
  return config.limits.watchdogIntervalMs;
}

let intervalMs = currentIntervalMs();
log(`Watchdog 启动：pid=${process.pid}｜间隔 ${Math.round(intervalMs / 1000)}s｜数据库 ${config.dbPath}`);
log('主系统状态：' + (readInstance(config) ? `实例文件存在（pid=${readInstance(config)!.pid}）` : '没有实例文件'));

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  if (existsSync(stopFile)) {
    log('发现停机标记，等待恢复维护（不会自动重启主系统）');
    return;
  }
  running = true;
  try {
    // 提问与巡检串行：同一时刻只有一个维护会话在动。
    await runQuestionWorker();
    const result = await session.runOnce(Math.round(intervalMs / 60_000));
    log(`巡检完成：${result.steps} 次模型调用${result.acted ? '，执行了维护动作' : ''}｜${result.summary.split('\n')[0]?.slice(0, 160) ?? ''}`);
  } catch (error) {
    log(`巡检失败：${(error as Error).message}（保留观察记录，继续按间隔重试）`);
    store.appendWdAction({
      id: `wda_${Date.now().toString(36)}`,
      issueId: null,
      action: 'inspect_failed',
      reason: '巡检异常',
      expected: '',
      result: (error as Error).message,
    });
  } finally {
    running = false;
  }
}

// 只验证进程独立性与状态隔离时，可以跳过首次巡检（用于进程存活测试）。
if (process.env['WATCHDOG_ONCE'] === '1') {
  // 一次性巡检：给验收脚本用，跑完就退出。
  await tick();
  store.close();
  process.exit(0);
}
if (process.env['WATCHDOG_NO_TICK'] !== '1') void tick();
let timer = setInterval(() => void tick(), intervalMs);
// 每轮都重新读一次间隔，在线调整不需要重启进程。
setInterval(() => {
  const next = currentIntervalMs();
  if (next !== intervalMs) {
    intervalMs = next;
    clearInterval(timer);
    timer = setInterval(() => void tick(), intervalMs);
    log(`巡检间隔调整为 ${Math.round(intervalMs / 1000)}s（在线生效）`);
  }
}, 15_000);

const shutdown = (): void => {
  log('Watchdog 退出');
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
