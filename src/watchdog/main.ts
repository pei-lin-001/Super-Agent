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
import { identifyProcess, instancePath, isPidAlive, looksLikeOurProcess, readInstance } from './observer.ts';
import { mainHealth, spawnMain } from './process.ts';
import { ProcessService } from '../runtime/process.ts';
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

// 维护者自己的作业服务：scope=watchdog，日志在 `.jobs/watchdog/`，
// 与业务作业完全分开恢复，不会把主系统 running 作业标成 unknown。
// 只有在真正取得维护执行资格之后才创建并恢复——查询类命令不应该碰它。
let wdJobs: ProcessService | null = null;

function ensureJobs(): ProcessService {
  if (wdJobs) return wdJobs;
  wdJobs = new ProcessService({ store, logRoot: join(config.workDir, '.jobs', 'watchdog'), scope: 'watchdog' });
  wdJobs.recover();
  return wdJobs;
}

function disposeJobs(): void {
  wdJobs?.dispose();
  wdJobs = null;
}

const session = new WatchdogSession({
  store,
  config,
  model,
  modelName: process.env['WATCHDOG_MODEL'] ?? config.workerModel,
  restartMain,
  health: () => mainHealth(config),
  processes: {
    start: (input) =>
      ensureJobs().start({
        taskId: 'watchdog',
        workerId: 'watchdog',
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        stdin: null,
        timeoutMs: input.timeoutMs,
        logRoot: join(config.workDir, '.jobs', 'watchdog'),
      }),
    read: (id) => ensureJobs().read(id, 'stdout', 0, 20_000),
    get: (id) => store.getJob(id),
    stop: (id) => ensureJobs().stop(id, '维护者停止'),
  },
});

mkdirSync(dirname(pidFile), { recursive: true });

// 单实例：同一时间只允许一个有效维护者，避免重复巡检与恢复风暴。
const LOCK_PATH = `${pidFile}.lock`;

/**
 * 取得唯一维护执行资格。
 * 返回 'acquired'（本次持有）/ 'busy'（已有有效维护者）/ 'unknown'（探测失败，保守退出）。
 */
async function acquireLock(): Promise<'acquired' | 'busy' | 'unknown' | 'failed'> {
  // 原子抢占：同时启动时只有一个能拿到写句柄（O_EXCL），不依赖"先读再写"的顺序。
  let acquired = false;
  for (let attempt = 0; attempt < 8 && !acquired; attempt += 1) {
    try {
      writeFileSync(LOCK_PATH, `${process.pid}\n`, { flag: 'wx' });
      acquired = true;
      break;
    } catch {
      // 锁已存在：判断持有者状态
    }
    let holder = 0;
    try {
      holder = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    } catch {
      holder = 0;
    }
    if (!Number.isInteger(holder) || holder < 2) {
      // 刚创建、内容还没写完：不能当成陈旧锁，稍等再看。
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const alive = isPidAlive(holder);
    const identity = alive ? identifyProcess(holder, 'watchdog') : 'mismatch';
    if (identity === 'match') return 'busy';
    if (identity === 'unknown') {
      // 探测失败不等于对方已经退出：保守处理，不删锁、也不启动第二个。
      return 'unknown';
    }
    try {
      rmSync(LOCK_PATH, { force: true });
    } catch {
      return 'failed';
    }
  }
  return acquired ? 'acquired' : 'failed';
}

// 释放锁时核对所有者：只删自己写的那个，避免旧进程清掉新进程的锁。
let holdingLock = false;
const releaseLock = (): void => {
  if (!holdingLock) return;
  try {
    const holder = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    if (holder === process.pid) rmSync(LOCK_PATH, { force: true });
  } catch {
    // 锁已不存在或读不到：不强行删除。
  }
};
process.on('exit', releaseLock);

function holdLock(): void {
  holdingLock = true;
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// 维护者提问入口：写持久问题队列，由唯一的维护者串行处理。
// 已有 Watchdog 在跑时，这里只当客户端，不会因为单实例约束被拒绝。
// 没有 Watchdog 在跑时，本次进程接管唯一的维护资格来处理问题。
// --answer：纯查询。不抢锁、不恢复作业、不启动模型会话，也不因为已有维护者而退出。
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

// --answer：纯查询。不抢锁、不恢复作业、不启动模型会话。
if (askIndex !== -1) {
  const question = process.argv[askIndex + 1] ?? '';
  if (question.trim() === '') {
    console.log('用法：pnpm watchdog --ask "为什么这个任务停住了？"');
    store.close();
    process.exit(1);
  }
  // 先入队：问题不会因为维护者忙碌或身份探测失败而丢失。
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
  // 本进程还没写过 pid 文件，不会把自己当成"另一个维护者"。
  const ownerAlive =
    existing !== null &&
    existing !== process.pid &&
    Number.isInteger(existing) &&
    existing >= 2 &&
    isPidAlive(existing) &&
    looksLikeOurProcess(existing, 'watchdog');

  if (ownerAlive) {
    // 已经有维护者在跑：当客户端轮询，不抢执行资格。
    // 等待时长可配：真实模型调查一个问题可能要很久，超时只是"先返回 ID"，不是失败。
    const waitMs = Number(process.env['WATCHDOG_ASK_WAIT_MS'] ?? 180_000);
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 180_000);
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
    console.log(`问题仍在队列中，可用 pnpm watchdog --answer ${questionId} 稍后查询。`);
    store.close();
    process.exit(5);
  }

  // 没有维护者：先争取执行资格，拿到之后才初始化作业服务并处理问题。
  const lock = await acquireLock();
  if (lock !== 'acquired') {
    console.log(
      lock === 'unknown'
        ? `无法确认现有维护者状态，问题 ${questionId} 已入队，请稍后用 --answer 查询`
        : `维护执行资格被占用，问题 ${questionId} 已入队，请稍后用 --answer 查询`,
    );
    store.close();
    process.exit(lock === 'unknown' ? 6 : 5);
  }
  holdLock();
  ensureJobs();
  await runQuestionWorker();
  const record = store.getWdQuestion(questionId);
  if (record) {
    console.log('---');
    console.log(record.status === 'done' ? record.answer ?? '' : `处理失败：${record.error ?? '未知原因'}`);
  }
  disposeJobs();
  store.close();
  process.exit(record?.status === 'done' ? 0 : 1);
}

// 常驻模式：先取得唯一维护执行资格，再初始化自己的作业服务并恢复。
const residentLock = await acquireLock();
if (residentLock !== 'acquired') {
  console.log(
    residentLock === 'unknown'
      ? '无法确认现有维护者状态，本次不启动（保守处理，不删锁）'
      : '已有维护者在运行，本次不启动',
  );
  store.close();
  process.exit(3);
}
holdLock();
ensureJobs();

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
let lastModelReview = 0;

/**
 * 是否现在需要模型审视：
 * - 有到期的未解决事件 → 必须看；
 * - 有活跃任务 → 按间隔周期性看（不能只靠规则命中）；
 * - 否则跳过，避免空转。
 */
function dueForReview(): { run: boolean; reason: string } {
  const now = Date.now();
  const issues = store.listOpenIssues();
  const due = issues.filter((issue) => !issue.checkAfter || Date.parse(issue.checkAfter) <= now);
  if (due.length > 0) return { run: true, reason: `${due.length} 个事件到期待复查` };
  const active = store.listTasks().some((item) => item.status === 'active' || item.status === 'waiting');
  if (active && now - lastModelReview >= intervalMs) return { run: true, reason: '存在活跃任务，周期性审视' };
  if (!active && now - lastModelReview >= intervalMs * 5) return { run: true, reason: '长时间未审视，做一次巡检' };
  return { run: false, reason: '没有到期事件，也没有新的活跃任务' };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // 提问与巡检串行：同一时刻只有一个维护会话在动。
    // 提问优先于停机标记：停机只表示"不要自动拉起主系统"，不影响回答人的问题。
    await runQuestionWorker();
    if (existsSync(stopFile)) {
      log('发现停机标记，等待恢复维护（不会自动重启主系统）');
      return;
    }
    const gate = dueForReview();
    if (!gate.run) {
      log(`跳过本轮巡检：${gate.reason}`);
      return;
    }
    lastModelReview = Date.now();
    const result = await session.runOnce(Math.round(intervalMs / 60_000));
    log(`巡检完成（${gate.reason}）：${result.steps} 次模型调用${result.acted ? '，执行了维护动作' : ''}｜${result.summary.split('\n')[0]?.slice(0, 160) ?? ''}`);
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
  disposeJobs();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
