import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';
import { beijingTime, clockStamp } from '../domain/ids.ts';
import { identifyProcess, readInstance, type ProcessIdentity } from './observer.ts';

export type MainState = 'absent' | 'exited' | 'unverified' | 'alive' | 'unresponsive';

export interface MainHealth {
  state: MainState;
  pid: number | null;
  detail: string;
  heartbeatAgeMs: number | null;
  /** 身份探测结论；null 表示还没有可探测的有效 PID。 */
  identity: ProcessIdentity | null;
  /** 仅凭新鲜且 PID 一致的心跳推断出的存活状态，不能授权停止或启动进程。 */
  degraded: boolean;
}

const MIN_VALID_PID = 2;
const HEARTBEAT_FRESH_MS = 30_000;
const HEARTBEAT_FUTURE_SKEW_MS = 5_000;

export function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid >= MIN_VALID_PID;
}

interface HeartbeatFile {
  exists: boolean;
  at: number | null;
  pid: number | null;
  parseError: boolean;
}

/** 进程探测依赖只用于测试注入；生产路径全部使用真实系统调用。 */
export interface MainProcessDeps {
  isAlive?: (pid: number) => boolean;
  identify?: (pid: number, marker: string) => ProcessIdentity;
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}

/** EPERM 表示进程存在但没有信号权限，不能当成进程已退出。 */
function isPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHeartbeat(path: string): HeartbeatFile {
  if (!existsSync(path)) return { exists: false, at: null, pid: null, parseError: false };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; pid?: unknown };
    return {
      exists: true,
      at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : null,
      pid: typeof value.pid === 'number' ? value.pid : null,
      parseError: false,
    };
  } catch {
    return { exists: true, at: null, pid: null, parseError: true };
  }
}

function makeHealth(
  state: MainState,
  pid: number | null,
  detail: string,
  heartbeatAgeMs: number | null = null,
  identity: ProcessIdentity | null = null,
  degraded = false,
): MainHealth {
  return { state, pid, detail, heartbeatAgeMs, identity, degraded };
}

/**
 * 主系统健康：mismatch 表示已确认 PID 被复用，unknown 表示探测能力不可用。
 *
 * unknown 只有在心跳新鲜且 PID 一致时降级为可观察的 alive。该降级证据
 * 不能用于停止或启动进程。
 */
export function mainHealth(config: Config, deps: Pick<MainProcessDeps, 'isAlive' | 'identify'> = {}): MainHealth {
  const isAlive = deps.isAlive ?? isPidPresent;
  const identify = deps.identify ?? identifyProcess;
  const instance = readInstance(config) as { pid?: unknown; stopped?: boolean; heartbeat?: string } | null;
  if (!instance) return makeHealth('absent', null, '没有实例文件');
  if (instance.stopped === true) return makeHealth('exited', null, '实例文件标记为已停机');
  if (!isValidPid(instance.pid)) {
    return makeHealth('unverified', null, `实例文件里的 pid 不合法：${String(instance.pid)}`);
  }
  const pid = instance.pid;
  if (!isAlive(pid)) return makeHealth('exited', pid, `进程 ${pid} 已不存在`);

  const heartbeatPath = instance.heartbeat ?? join(config.workDir, '.runtime', 'heartbeat.json');
  const heartbeat = readHeartbeat(heartbeatPath);
  const age = heartbeat.at === null ? null : Date.now() - heartbeat.at;

  let identity: ProcessIdentity;
  try {
    identity = identify(pid, 'src/main.ts');
  } catch {
    identity = 'unknown';
  }

  if (identity === 'mismatch') {
    return makeHealth('unverified', pid, `pid ${pid} 已确认不是本项目的 src/main.ts 进程，可能是 PID 复用`, age, identity);
  }
  if (identity === 'unknown') {
    const weakEvidence =
      heartbeat.pid === pid &&
      age !== null &&
      age >= -HEARTBEAT_FUTURE_SKEW_MS &&
      age <= HEARTBEAT_FRESH_MS;
    if (weakEvidence) {
      return makeHealth(
        'alive',
        pid,
        `运行中（降级判定：身份探测不可用，心跳 ${Math.round((age ?? 0) / 1000)} 秒前且 pid ${pid} 一致；只用于观察）`,
        age,
        identity,
        true,
      );
    }
    return makeHealth(
      'unverified', pid,
      `进程 ${pid} 存在，但身份探测不可用（命令行不可读或权限不足）；不能据此认定 PID 复用`,
      age,
      identity,
    );
  }

  if (!heartbeat.exists) {
    return makeHealth('alive', pid, '进程存活，但没有心跳文件，无法确认调度是否在转', null, identity);
  }
  if (heartbeat.parseError) {
    return makeHealth('alive', pid, '进程存活，但心跳文件无法解析', null, identity);
  }
  if (heartbeat.pid !== pid) {
    return makeHealth('unverified', pid, '心跳文件属于另一个进程', age, identity);
  }
  if (age !== null && age > HEARTBEAT_FRESH_MS) {
    return makeHealth('unresponsive', pid, `进程存活但心跳已 ${Math.round(age / 1000)} 秒未更新`, age, identity);
  }
  return makeHealth('alive', pid, `运行中（心跳 ${age === null ? '未知' : `${Math.round(age / 1000)} 秒前`}）`, age, identity);
}

export interface RestartRecord {
  attemptedAt: string;
  outcome: 'spawned' | 'refused';
  detail: string;
  pid: number | null;
}

/** 重启尝试记录：冷却期内不重复拉起。 */
export function readRestartLog(config: Config): RestartRecord[] {
  const path = join(config.workDir, '.runtime', 'restart.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RestartRecord[];
  } catch {
    return [];
  }
}

export function recordRestart(config: Config, record: RestartRecord): void {
  const path = join(config.workDir, '.runtime', 'restart.json');
  mkdirSync(dirname(path), { recursive: true });
  const log = readRestartLog(config);
  log.push(record);
  writeFileSync(path, JSON.stringify(log.slice(-50), null, 2), 'utf8');
}

export function lastRestartAgeMs(config: Config): number | null {
  const log = readRestartLog(config);
  const last = log.filter((item) => item.outcome === 'spawned').at(-1);
  if (!last) return null;
  return Date.now() - Date.parse(last.attemptedAt);
}

export interface SpawnResult {
  ok: boolean;
  message: string;
  pid: number | null;
}

/**
 * 受控拉起：只在前置条件都满足时启动，并保留诊断输出位置。
 *
 * `allowRunning` 仅为兼容旧调用保留，不能让仍被强证据确认存活的进程绕过守卫。
 * 计划重启必须先让 stopMain 确认原进程已退出，才能走到这里。
 */
export function spawnMain(
  config: Config,
  options: { cooldownMs: number; allowRunning?: boolean },
  deps: Pick<MainProcessDeps, 'isAlive' | 'identify'> & { spawn?: typeof spawn } = {},
): SpawnResult {
  const health = mainHealth(config, deps);
  const refuse = (message: string, pid: number | null): SpawnResult => {
    recordRestart(config, {
      attemptedAt: new Date().toISOString(),
      outcome: 'refused',
      detail: message,
      pid,
    });
    return { ok: false, message, pid };
  };
  if (health.degraded) {
    return refuse(`只有弱证据（心跳推断），不能授权启动第二个主进程：${health.detail}`, health.pid);
  }
  if (health.state === 'unverified') {
    return refuse(`无法确认进程身份，保守跳过：${health.detail}`, health.pid);
  }
  if (health.state === 'alive' || health.state === 'unresponsive') {
    return refuse(`主系统仍存在（${health.state}：${health.detail}），不重复启动`, health.pid);
  }
  const age = lastRestartAgeMs(config);
  if (age !== null && age < options.cooldownMs) {
    return refuse(
      `距上次启动尝试仅 ${Math.round(age / 1000)} 秒（冷却 ${Math.round(options.cooldownMs / 1000)} 秒），本次不重复拉起`,
      null,
    );
  }

  const logPath = join(config.workDir, '.runtime', 'main.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const launch = deps.spawn ?? spawn;
  const child = launch(process.execPath, ['--env-file-if-exists=.env.local', 'src/main.ts', '--daemon'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPER_AGENT_DAEMON: '1' },
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const runningLogTimer = setTimeout(() => {
    try {
      writeFileSync(logPath, `${clockStamp()} running pid=${child.pid}\n${output}`, 'utf8');
    } catch {
      // 忽略写日志失败。
    }
  }, 2000);
  runningLogTimer.unref?.();
  child.on('exit', (code) => {
    clearTimeout(runningLogTimer);
    // 启动失败保留诊断，不丢弃输出。
    try {
      writeFileSync(logPath, `${clockStamp()} exit=${code} pid=${child.pid}\n${output}`, 'utf8');
    } catch {
      // 忽略写日志失败。
    }
  });
  child.unref();

  recordRestart(config, {
    attemptedAt: new Date().toISOString(),
    outcome: 'spawned',
    detail: `以 --daemon 启动，日志 ${logPath}`,
    pid: child.pid ?? null,
  });
  return {
    ok: true,
    message: `已创建后台进程 pid=${child.pid ?? '-'}（日志 ${logPath}）。这表示进程已创建，不等于已恢复调度，仍需复查心跳与队列。`,
    pid: child.pid ?? null,
  };
}

export interface RestartOutcome {
  ok: boolean;
  /** 重启前的 git tag：新进程起不来时唯一的回去的路。 */
  tag: string | null;
  /** 新进程 pid；没起来为 null。 */
  pid: number | null;
  stoppedMain: boolean;
  waitedMs: number;
  message: string;
}

function stopRefusal(health: MainHealth): string | null {
  if (health.degraded) {
    return `主系统身份只有弱证据，不能授权终止进程：${health.detail}`;
  }
  if (health.identity === 'mismatch') {
    return `无法确认主系统身份：PID 已确认被其他进程复用，不发送终止信号：${health.detail}`;
  }
  if (health.identity === 'unknown') {
    return `无法确认主系统身份：身份探测不可用，不能判断是否已发生 PID 复用，不发送终止信号：${health.detail}`;
  }
  if (health.identity !== 'match' || health.state === 'unverified') {
    return `无法确认主系统身份，不发送终止信号：${health.detail}`;
  }
  if (health.pid === null || !isValidPid(health.pid)) {
    return `无法确认主系统 pid，不发送终止信号：${health.detail}`;
  }
  return null;
}

/** 等到主系统真的退出；超时就强杀，不无限等。依赖仅供可控回归测试。 */
export async function stopMain(
  config: Config,
  timeoutMs: number,
  deps: MainProcessDeps = {},
): Promise<{ stopped: boolean; message: string }> {
  const isAlive = deps.isAlive ?? isPidPresent;
  const kill = deps.kill ?? ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
    process.kill(pid, signal);
  });
  const health = mainHealth(config, deps);
  if (health.state === 'exited' || health.state === 'absent') {
    return { stopped: true, message: '主系统本就不在运行' };
  }
  const initialRefusal = stopRefusal(health);
  if (initialRefusal) return { stopped: false, message: initialRefusal };
  const pid = health.pid;
  if (pid === null) return { stopped: false, message: `无法确认主系统 pid：${health.detail}` };
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { stopped: true, message: `主系统 ${pid} 在发送 SIGTERM 前已退出` };
    }
    return { stopped: false, message: `发送 SIGTERM 失败：${(error as Error).message}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = readInstance(config) as { pid?: unknown } | null;
    if (isValidPid(observed?.pid) && observed.pid !== pid) {
      return {
        stopped: false,
        message: `等待停机时实例 PID 已从 ${pid} 变为 ${observed.pid}，为避免停止或重复拉起新实例，本次中止`,
      };
    }
    if (!isAlive(pid)) return { stopped: true, message: `主系统 ${pid} 已按 SIGTERM 退出` };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!isAlive(pid)) return { stopped: true, message: `主系统 ${pid} 已按 SIGTERM 退出` };
  const current = mainHealth(config, deps);
  if (current.pid !== pid) {
    return {
      stopped: false,
      message: `等待停机时实例 PID 已从 ${pid} 变为 ${current.pid ?? '未知'}，不发送 SIGKILL`,
    };
  }
  const currentRefusal = stopRefusal(current);
  if (currentRefusal) {
    return { stopped: false, message: `SIGTERM 超时后复查未通过，不发送 SIGKILL：${currentRefusal}` };
  }
  // 优雅停机等不到就只能强杀：SIGTERM 已经给过机会了。
  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { stopped: true, message: `主系统 ${pid} 在发送 SIGKILL 前已退出` };
    }
    return { stopped: false, message: `发送 SIGKILL 失败：${(error as Error).message}` };
  }
  const hardDeadline = Date.now() + 5_000;
  while (Date.now() < hardDeadline) {
    if (!isAlive(pid)) return { stopped: true, message: `主系统 ${pid} 在超时后被 SIGKILL 终止` };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const afterKill = mainHealth(config, deps);
  return {
    stopped: false,
    message: `主系统 ${pid} 在 SIGKILL 后仍未退出，放弃本次重启（当前 ${afterKill.state}：${afterKill.detail}）`,
  };
}

/** 等新进程写出心跳；这是「起没起来」唯一不依赖主系统自述的判据。 */
async function waitForHeartbeat(
  config: Config,
  previousStartedAt: string | null,
  expectedPid: number | null,
  spawnedAt: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const path = join(config.workDir, '.runtime', 'heartbeat.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const beat = JSON.parse(readFileSync(path, 'utf8')) as { at?: number; pid?: number };
      const instance = readInstance(config);
      const fresh = typeof beat.at === 'number' && beat.at >= spawnedAt && Date.now() - beat.at < 15_000;
      const changed = typeof instance?.startedAt === 'string' && instance.startedAt !== previousStartedAt;
      if (fresh && changed && expectedPid !== null && beat.pid === expectedPid && instance?.pid === expectedPid) {
        return { ok: true, detail: '新心跳已写入' };
      }
    } catch {
      // 文件还没写出来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const health = mainHealth(config);
  return { ok: false, detail: `等待 ${Math.round(timeoutMs / 1000)} 秒仍未看到新心跳（当前 ${health.state}：${health.detail}）` };
}

/**
 * 计划内重启：给改动一次生效的机会，并留好回去的路。
 *
 * 顺序是有讲究的：
 * 1. 先打 tag —— 必须在任何破坏性动作之前。这一步不写进模型流程，因为它只干一件事：不忘。
 * 2. 记录旧进程的 startedAt —— 否则新进程起来后，残留的旧心跳会被当成"成功了"。
 * 3. 停主系统（SIGTERM → 等 → SIGKILL）。
 * 4. 拉起，等心跳。
 * 失败时不动 git，把 tag 和诊断交回给调用方（模型）决定回滚还是上报。
 */
export async function restartMainWithRollbackPoint(
  config: Config,
  options: { stopTimeoutMs?: number; heartbeatTimeoutMs?: number; cooldownMs?: number },
): Promise<RestartOutcome> {
  const started = Date.now();
  const before = mainHealth(config);
  const previousInstance = readInstance(config) as { startedAt?: string } | null;

  // 1) 回去的路，先留好。tag 失败不阻断，但要在结果里说清楚，别让人以为有退路。
  let tag: string | null = null;
  try {
    const { execFileSync } = await import('node:child_process');
    tag = `restart-before-${beijingTime(new Date()).replace(/[: ]/g, '-')}`;
    execFileSync('git', ['tag', tag], { cwd: process.cwd(), stdio: 'ignore' });
  } catch {
    tag = null;
  }

  // 2) 停主系统
  const stopTimeout = options.stopTimeoutMs ?? 60_000;
  const stopped = await stopMain(config, stopTimeout);
  if (!stopped.stopped) {
    recordRestart(config, {
      attemptedAt: new Date().toISOString(),
      outcome: 'refused',
      detail: stopped.message,
      pid: before.pid,
    });
    return {
      ok: false,
      tag,
      pid: null,
      stoppedMain: false,
      waitedMs: Date.now() - started,
      message: `重启中止：${stopped.message}`,
    };
  }

  // 3) 拉起。allowRunning 是因为实例文件还是旧的那份，不能当"还活着"看待。
  const spawnedAt = Date.now();
  const spawned = spawnMain(config, {
    cooldownMs: options.cooldownMs ?? 0,
    allowRunning: true,
  });
  if (!spawned.ok) {
    return {
      ok: false,
      tag,
      pid: null,
      stoppedMain: true,
      waitedMs: Date.now() - started,
      message: `主系统已停止，但拉起失败：${spawned.message}${tag ? `｜回滚点 ${tag}` : '｜没有可用的回滚点'}`,
    };
  }

  // 4) 等心跳：不信主系统的话，只看文件时间。
  const beat = await waitForHeartbeat(
    config,
    previousInstance?.startedAt ?? null,
    spawned.pid,
    spawnedAt,
    options.heartbeatTimeoutMs ?? 45_000,
  );
  const tail = tag ? `｜重启前提交的标记 ${tag}（不包含未提交改动）` : '｜没有可用的提交标记';
  return {
    ok: beat.ok && spawned.ok,
    tag,
    pid: spawned.pid,
    stoppedMain: true,
    waitedMs: Date.now() - started,
    message: beat.ok
      ? `已重启 pid=${spawned.pid ?? '-'}，${beat.detail}${tail}`
      : `进程已创建 pid=${spawned.pid ?? '-'}，但${beat.detail}。先看 work/.runtime/main.log 再决定是重试还是回滚${tail}`,
  };
}
