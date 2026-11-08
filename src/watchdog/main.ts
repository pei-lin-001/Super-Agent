/**
 * Watchdog 独立进程入口。
 *
 * 它不构造 Runtime：不会恢复作业、不会调度业务 Worker、不会清理主系统的任何东西。
 * 它只做三件事：观察主库（只读语义）、通过控制命令实施维护、把自己的会话与动作记录在自己的表里。
 * 主系统退出后它仍在运行，并能按需拉起主系统。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { OpenAICompatibleModel } from '../model/openai.ts';
import { Store } from '../storage/store.ts';
import { instancePath, isPidAlive, looksLikeOurProcess, readInstance } from './observer.ts';
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
  const instance = readInstance(config);
  if (instance && isPidAlive(instance.pid)) {
    return { ok: false, message: `主系统仍在运行（pid=${instance.pid}），不重复启动` };
  }
  if (instance && !looksLikeOurProcess(instance.pid, 'src/main.ts') && isPidAlive(instance.pid)) {
    return { ok: false, message: `pid=${instance.pid} 已被其他进程复用，不操作它` };
  }
  const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'src/main.ts'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WATCHDOG_SUPERVISED: '1' },
  });
  child.unref();
  const dir = dirname(instancePath(config));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    instancePath(config),
    JSON.stringify({ pid: child.pid ?? 0, startedAt: new Date().toISOString(), dbPath: config.dbPath }, null, 2),
    'utf8',
  );
  return { ok: true, message: `已拉起主系统 pid=${child.pid}，稍后复查它是否真的恢复调度` };
}

const session = new WatchdogSession({
  store,
  config,
  model,
  modelName: process.env['WATCHDOG_MODEL'] ?? config.workerModel,
  restartMain,
});

mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');

const log = (message: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
};

const intervalMs = config.limits.watchdogIntervalMs;
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
if (process.env['WATCHDOG_NO_TICK'] !== '1') void tick();
setInterval(() => void tick(), intervalMs);

const shutdown = (): void => {
  log('Watchdog 退出');
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
