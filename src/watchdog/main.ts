/**
 * Watchdog 独立进程入口。
 *
 * 它不构造 Runtime：不会恢复作业、不会调度业务 Worker、不会清理主系统的任何东西。
 * 它只做三件事：观察主库（只读语义）、通过控制命令实施维护、把自己的会话与动作记录在自己的表里。
 * 主系统退出后它仍在运行，并能按需拉起主系统。
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { clockStamp } from '../domain/ids.ts';
import { PiModel } from '../model/pi.ts';
import { Store } from '../storage/store.ts';
import { mkdirSync as mkdir, writeFileSync as writeJson } from 'node:fs';
import {
  decideModelReview,
  identifyProcess,
  instancePath,
  isPidAlive,
  looksLikeOurProcess,
  readInstance,
  type ModelReviewGateState,
} from './observer.ts';
import { mainHealth, restartMainWithRollbackPoint, spawnMain } from './process.ts';
import { ProcessService } from '../runtime/process.ts';
import { latestReviewTimestamp, WatchdogSession } from './session.ts';

const config = loadConfig();
// 维护者也是独立实例：它的调用记录不能被主系统的恢复流程误收敛。
const instanceId = `watchdog_${randomBytes(8).toString('hex')}`;
const store = new Store(config.dbPath, { instanceId });

const model = new PiModel({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  retry: config.limits.modelRetry,
  reasoningEffort: config.reasoningEffort,
  maxTokens: config.maxTokens,
}, config.modelName);

const stopFile = join(config.workDir, '.runtime', 'watchdog.stop');
const pidFile = join(config.workDir, '.runtime', 'watchdog.json');

/**
 * 重启主系统。
 *
 * 两件事都做：留下回滚点、把活着的进程停掉再拉起。原来是"只拉起已退出的"，
 * 所以 Worker 改完代码没有任何办法让它生效——杀了自己就没人拉。
 */
async function restartMain(): Promise<{ ok: boolean; message: string }> {
  // 停机标记必须在动作执行前重新检查：维护者明确停机时不能被自动拉起。
  if (existsSync(stopFile)) {
    return { ok: false, message: '存在停机标记，不执行自动拉起；需要维护者显式恢复自动维护' };
  }
  const result = await restartMainWithRollbackPoint(config, { cooldownMs: 0 });
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
  writeFileSync(
    pidFile,
    JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString(), instanceId, kind: 'watchdog', stopped: false },
      null,
      2,
    ),
    'utf8',
  );
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
  console.log(`[${clockStamp()}] ${message}`);
};

/** 活跃语义巡检间隔可以在线调整：旧 watchdog.interval 覆盖项继续兼容。 */
function currentIntervalMs(): number {
  const override = store.activeOverride('watchdog.interval');
  if (override) {
    const value = Number(override.content.trim());
    if (Number.isFinite(value) && value >= 10_000 && value <= 3_600_000) return value;
  }
  return config.limits.watchdogIntervalMs;
}

let intervalMs = currentIntervalMs();
const idleIntervalMs = config.limits.watchdogIdleIntervalMs;
const healthTickMs = config.limits.watchdogHealthTickMs;
log(
  `Watchdog 启动：pid=${process.pid}｜本地健康 tick ${Math.round(healthTickMs / 1000)}s` +
    `｜活跃语义巡检 ${Math.round(intervalMs / 1000)}s｜空闲语义巡检 ${Math.round(idleIntervalMs / 1000)}s` +
    `｜数据库 ${config.dbPath}`,
);
log('主系统状态：' + (readInstance(config) ? `实例文件存在（pid=${readInstance(config)!.pid}）` : '没有实例文件'));

let running = false;
let lastModelReview = latestReviewTimestamp(config) ?? 0;
let lastGateReason = '';
let lastHealthNote: string | null = null;
let observedActiveIntervalMs = intervalMs;
const ROUTER_MESSAGE_FAILURE_BACKOFF_MS = 60_000;
const reviewGateState: ModelReviewGateState = {
  incidentSignature: null,
  incidentReviewedAt: 0,
  dueIssueAttempts: {},
  routerMessageBatch: null,
  routerMessageFailedAt: 0,
};
const wakeFile = join(config.workDir, '.runtime', 'maintainer.wake');

/**
 * 本地 gate 只读事实，不调用模型。
 *
 * 正常活跃/空闲按两个语义间隔巡视；显式 Router 消息、到期事件、维护申请和
 * 新的严重健康签名才即时触发。相同健康事实由 observer 中稳定的程序签名去重，
 * 心跳年龄本身不会制造新 incident。
 */
function dueForReview(forceReview = false): {
  run: boolean;
  reason: string;
  active: boolean;
  healthNote: string | null;
  incidentSignature: string | null;
  dueIssueKeys: string[];
} {
  const now = Date.now();
  intervalMs = currentIntervalMs();
  if (intervalMs !== observedActiveIntervalMs) {
    log(`活跃语义巡检间隔调整为 ${Math.round(intervalMs / 1000)}s（旧 watchdog.interval 覆盖项）`);
    observedActiveIntervalMs = intervalMs;
  }
  const active = store.listTasks().some((item) =>
    item.status === 'pending' || item.status === 'active' || item.status === 'waiting',
  );
  const pendingRouter = store.listPendingIntercom('watchdog', 8);
  const pendingRouterBatch = pendingRouter.map((message) => message.id).sort().join(',');
  const issues = store.listOpenIssues();
  const dueIssues = issues
    .filter((issue) => !issue.checkAfter || Date.parse(issue.checkAfter) <= now)
    .map((issue) => ({ id: issue.id, checkAfter: issue.checkAfter }));
  const health = mainHealth(config);
  const gate = decideModelReview({
    now,
    active,
    lastModelReviewAt: lastModelReview,
    baselineAt: latestReviewTimestamp(config) === null ? null : new Date(lastModelReview || 0).toISOString(),
    activeIntervalMs: intervalMs,
    idleIntervalMs,
    pendingRouterMessages: pendingRouter.length,
    pendingRouterBatch,
    routerFailureBackoffMs: ROUTER_MESSAGE_FAILURE_BACKOFF_MS,
    dueIssues,
    health,
    state: reviewGateState,
  });
  if (forceReview) {
    return {
      run: true,
      reason: '一次性强制语义巡检',
      active,
      healthNote: gate.healthNote,
      incidentSignature: gate.incidentSignature,
      dueIssueKeys: [],
    };
  }
  return {
    run: gate.run,
    reason: gate.reason,
    active,
    healthNote: gate.healthNote,
    incidentSignature: gate.incidentSignature,
    dueIssueKeys: gate.dueIssueKeys,
  };
}

/**
 * Worker 提的维护申请。
 *
 * 申请只是线索，不是结论。维护者先复用任务授权、已有有效证据和当前状态；
 * 只有缺口或范围变化可能改变决定时，才补做最小检查。进程操作仍只经
 * restart_main 的程序守卫执行。
 */
async function runMaintenanceRequests(): Promise<void> {
  const pending = store.listPendingWdRequests(3);
  if (pending.length === 0) return;
  for (const request of pending) {
    if (existsSync(stopFile)) {
      store.resolveWdRequest(request.id, 'rejected', '存在停机标记，不执行重启');
      log(`拒绝维护申请 ${request.id}：存在停机标记`);
      continue;
    }
    const question = [
      `# Worker 提了一个维护申请：${request.id}`,
      `类型：${request.kind}｜任务：${request.taskId ?? '-'}｜Worker：${request.workerId ?? '-'}`,
      `它给的理由：${request.reason}`,
      `它给的引用：${request.refs.length > 0 ? request.refs.join('、') : '（没有给）'}`,
      '',
      '这只是申请，不是结论。先复用任务 brief、已有检查结论、作业回执和正式结果；',
      '只有证据缺失、过期，或当前改动/要求/范围已变化且可能改变决定时，才补做最小检查。',
      '已知有效的同一检查不必机械重跑；申请方报告本身仍不能替代可核对证据。',
      '',
      '决定：',
      '- 值得 → maintain(action="restart_main", reason="...")。它会先打回滚点、停主系统、拉起、等心跳，然后把结果给你。',
      '- 不值得 → record 记一个事件说明理由，或直接给出简短结论，不要重启。',
      '- 重启失败（心跳没起来）→ 读取 work/.runtime/main.log 和 restart.json，再决定是否上报或提出后续动作。',
      '',
      '结束时写清：你核对了什么、看到什么、做了什么决定、为什么。',
    ].join('\n');
    try {
      const answer = await session.ask(question, { taskId: request.taskId, history: false });
      store.resolveWdRequest(request.id, 'done', answer.slice(0, 800));
      log(`维护申请 ${request.id} 已处理：${answer.split('\n')[0]?.slice(0, 140) ?? ''}`);
    } catch (error) {
      store.resolveWdRequest(request.id, 'failed', (error as Error).message.slice(0, 400));
      log(`维护申请 ${request.id} 处理失败：${(error as Error).message}`);
    }
  }
}

async function tick(forceReview = false): Promise<void> {
  if (running) return;
  running = true;
  let attemptedRouterMessages: string[] = [];
  try {
    // 提问与巡检串行：同一时刻只有一个维护会话在动。
    // 提问优先于停机标记：停机只表示"不要自动拉起主系统"，不影响回答人的问题。
    await runQuestionWorker();
    // 维护申请排在巡检之前：它有时效性（Worker 正卡在那里等），而巡检是周期性的。
    // 停机标记由 runMaintenanceRequests 内部检查，命中时把申请标成 rejected 而不是丢掉。
    await runMaintenanceRequests();
    if (existsSync(stopFile)) {
      log('发现停机标记，等待恢复维护（不会自动重启主系统）');
      return;
    }
    const gate = dueForReview(forceReview);
    if (gate.healthNote !== lastHealthNote) {
      if (gate.healthNote) log(`本地健康检查：${gate.healthNote}`);
      lastHealthNote = gate.healthNote;
    }
    if (!gate.incidentSignature) {
      reviewGateState.incidentSignature = null;
      reviewGateState.incidentReviewedAt = 0;
    }
    if (!gate.run) {
      if (gate.reason !== lastGateReason) {
        log(`跳过语义巡检：${gate.reason}`);
        lastGateReason = gate.reason;
      }
      return;
    }
    lastGateReason = '';
    attemptedRouterMessages = store.listPendingIntercom('watchdog', 8).map((message) => message.id).sort();
    if (gate.incidentSignature) {
      reviewGateState.incidentSignature = gate.incidentSignature;
      reviewGateState.incidentReviewedAt = Date.now();
    }
    for (const key of gate.dueIssueKeys) {
      reviewGateState.dueIssueAttempts[key] = Date.now();
    }
    lastModelReview = Date.now();
    const reviewIntervalMs = gate.active ? intervalMs : idleIntervalMs;
    const result = await session.runOnce(Math.max(1, Math.round(reviewIntervalMs / 60_000)));
    reviewGateState.routerMessageBatch = null;
    reviewGateState.routerMessageFailedAt = 0;
    log(
      `语义巡检完成（${gate.reason}）：本会话 ${result.steps} 个模型 step` +
        `${result.acted ? '，尝试了维护动作' : ''}｜${result.summary.split('\n')[0]?.slice(0, 160) ?? ''}`,
    );
  } catch (error) {
    const stillPending = new Set(store.listPendingIntercom('watchdog', 20).map((message) => message.id));
    const failedMessages = attemptedRouterMessages.filter((id) => stillPending.has(id));
    if (failedMessages.length > 0) {
      reviewGateState.routerMessageBatch = failedMessages.sort().join(',');
      reviewGateState.routerMessageFailedAt = Date.now();
      log(
        `语义巡检失败：${(error as Error).message}｜${failedMessages.length} 条 Router 消息保持 pending，` +
          `同批退避 ${ROUTER_MESSAGE_FAILURE_BACKOFF_MS / 1000}s`,
      );
    } else {
      log(`语义巡检失败：${(error as Error).message}（保留观察记录，等待下个语义间隔）`);
    }
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
    if (process.env['WATCHDOG_ONCE'] !== '1') checkWake();
  }
}

function checkWake(): void {
  if (running || !existsSync(wakeFile)) return;
  try {
    rmSync(wakeFile, { force: true });
    void tick();
  } catch (error) {
    log(`读取维护唤醒标记失败，将由定时巡检继续处理：${(error as Error).message}`);
  }
}

// 只验证进程独立性与状态隔离时，可以跳过首次巡检（用于进程存活测试）。
if (process.env['WATCHDOG_ONCE'] === '1') {
  // 一次性巡检：给验收脚本用，跑完就退出。
  await tick(true);
  store.close();
  process.exit(0);
}
// 唤醒标记由主进程写入；运行中保留标记，当前巡检结束后再处理。
let wakeWatcher: ReturnType<typeof watch> | null = null;
try {
  wakeWatcher = watch(dirname(wakeFile), (_event, name) => {
    if (!name || name.toString() === 'maintainer.wake') checkWake();
  });
  wakeWatcher.on('error', (error) => log(`维护唤醒监听失败，将由定时巡检继续处理：${error.message}`));
} catch (error) {
  log(`无法监听维护唤醒标记，将由定时巡检继续处理：${(error as Error).message}`);
}
if (existsSync(wakeFile)) checkWake();
else if (process.env['WATCHDOG_NO_TICK'] !== '1') void tick();
// 本地 tick 只检查队列、事件期限和进程健康；模型语义巡检由 dueForReview gate 决定。
setInterval(() => void tick(), healthTickMs);

const shutdown = (): void => {
  log('Watchdog 退出');
  wakeWatcher?.close();
  disposeJobs();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
