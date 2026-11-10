import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';
import { isPidAlive, looksLikeOurProcess, readInstance } from './observer.ts';

export type MainState = 'absent' | 'exited' | 'unverified' | 'alive' | 'unresponsive';

export interface MainHealth {
  state: MainState;
  pid: number | null;
  detail: string;
  heartbeatAgeMs: number | null;
}

const MIN_VALID_PID = 2;

export function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid >= MIN_VALID_PID;
}

/** 主系统健康：区分不存在、已退出、身份无法确认、活着但主循环无响应。 */
export function mainHealth(config: Config): MainHealth {
  const instance = readInstance(config) as { pid?: unknown; stopped?: boolean; heartbeat?: string } | null;
  if (!instance) return { state: 'absent', pid: null, detail: '没有实例文件', heartbeatAgeMs: null };
  if (instance.stopped === true) return { state: 'exited', pid: null, detail: '实例文件标记为已停机', heartbeatAgeMs: null };
  if (!isValidPid(instance.pid)) {
    return { state: 'unverified', pid: null, detail: `实例文件里的 pid 不合法：${String(instance.pid)}`, heartbeatAgeMs: null };
  }
  const pid = instance.pid;
  if (!isPidAlive(pid)) return { state: 'exited', pid, detail: `进程 ${pid} 已不存在`, heartbeatAgeMs: null };
  if (!looksLikeOurProcess(pid, 'src/main.ts')) {
    return { state: 'unverified', pid, detail: `pid ${pid} 的命令行不符合本项目，可能是 PID 复用`, heartbeatAgeMs: null };
  }
  const heartbeatPath = instance.heartbeat ?? join(config.workDir, '.runtime', 'heartbeat.json');
  if (!existsSync(heartbeatPath)) {
    return { state: 'alive', pid, detail: '进程存活，但没有心跳文件，无法确认调度是否在转', heartbeatAgeMs: null };
  }
  try {
    const beat = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { at?: number; pid?: number };
    const age = typeof beat.at === 'number' ? Date.now() - beat.at : null;
    if (beat.pid !== pid) {
      return { state: 'unverified', pid, detail: '心跳文件属于另一个进程', heartbeatAgeMs: age };
    }
    if (age !== null && age > 30_000) {
      return { state: 'unresponsive', pid, detail: `进程存活但心跳已 ${Math.round(age / 1000)} 秒未更新`, heartbeatAgeMs: age };
    }
    return { state: 'alive', pid, detail: `运行中（心跳 ${age === null ? '未知' : `${Math.round(age / 1000)} 秒前`}）`, heartbeatAgeMs: age };
  } catch {
    return { state: 'alive', pid, detail: '心跳文件无法解析', heartbeatAgeMs: null };
  }
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
 * `allowRunning` 只给「计划重启」用：调用方已经确认主系统退出了（或刚把它停掉），
 * 这里的 alive 检查会看到上一次的实例文件，属于正常现象。
 * 崩溃拉起（默认）仍然拒绝在活着的时候重复启动。
 */
export function spawnMain(
  config: Config,
  options: { cooldownMs: number; allowRunning?: boolean },
): SpawnResult {
  const health = mainHealth(config);
  if (!options.allowRunning && (health.state === 'alive' || health.state === 'unresponsive')) {
    return { ok: false, message: `主系统仍存在（${health.state}：${health.detail}），不重复启动`, pid: health.pid };
  }
  if (health.state === 'unverified') {
    return { ok: false, message: `无法确认进程身份，保守跳过：${health.detail}`, pid: health.pid };
  }
  const age = lastRestartAgeMs(config);
  if (age !== null && age < options.cooldownMs) {
    return {
      ok: false,
      message: `距上次启动尝试仅 ${Math.round(age / 1000)} 秒（冷却 ${Math.round(options.cooldownMs / 1000)} 秒），本次不重复拉起`,
      pid: null,
    };
  }

  const logPath = join(config.workDir, '.runtime', 'main.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'src/main.ts', '--daemon'], {
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
  child.on('exit', (code) => {
    // 启动失败保留诊断，不丢弃输出。
    try {
      writeFileSync(logPath, `${new Date().toISOString()} exit=${code}\n${output}`, 'utf8');
    } catch {
      // 忽略写日志失败。
    }
  });
  child.unref();
  setTimeout(() => {
    try {
      writeFileSync(logPath, `${new Date().toISOString()} running pid=${child.pid}\n${output}`, 'utf8');
    } catch {
      // 忽略写日志失败。
    }
  }, 2000).unref?.();

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

/** 等到主系统真的退出；超时就强杀，不无限等。 */
async function stopMain(config: Config, timeoutMs: number): Promise<{ stopped: boolean; message: string }> {
  const health = mainHealth(config);
  if (health.state === 'exited' || health.state === 'absent') {
    return { stopped: true, message: '主系统本就不在运行' };
  }
  if (health.pid === null || !isValidPid(health.pid)) {
    return { stopped: false, message: `无法确认主系统 pid（${health.detail}），不贸然杀进程` };
  }
  const pid = health.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { stopped: false, message: `发送 SIGTERM 失败：${(error as Error).message}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return { stopped: true, message: `主系统 ${pid} 已按 SIGTERM 退出` };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // 优雅停机等不到就只能强杀：SIGTERM 已经给过机会了。
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能刚好退出，忽略。
  }
  const hardDeadline = Date.now() + 5_000;
  while (Date.now() < hardDeadline) {
    if (!isPidAlive(pid)) return { stopped: true, message: `主系统 ${pid} 在超时后被 SIGKILL 终止` };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { stopped: false, message: `主系统 ${pid} 在 SIGKILL 后仍未退出，放弃本次重启` };
}

/** 等新进程写出心跳；这是「起没起来」唯一不依赖主系统自述的判据。 */
async function waitForHeartbeat(
  config: Config,
  previousStartedAt: string | null,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const path = join(config.workDir, '.runtime', 'heartbeat.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const beat = JSON.parse(readFileSync(path, 'utf8')) as { at?: number; startedAt?: string };
      const fresh = typeof beat.at === 'number' && Date.now() - beat.at < 15_000;
      const changed = !previousStartedAt || beat.startedAt !== previousStartedAt;
      if (fresh && (changed || !previousStartedAt)) return { ok: true, detail: '新心跳已写入' };
      if (fresh && previousStartedAt) {
        // 心跳新鲜但 startedAt 相同：可能是旧进程的心跳还没被覆盖，再看一眼进程。
        const health = mainHealth(config);
        if (health.state === 'alive') return { ok: true, detail: '主系统被判定为 alive' };
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
    tag = `restart-before-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    execFileSync('git', ['tag', '-f', tag], { cwd: process.cwd(), stdio: 'ignore' });
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
    options.heartbeatTimeoutMs ?? 45_000,
  );
  const tail = tag ? `｜回滚点 ${tag}（git reset --hard ${tag}）` : '｜没有可用的回滚点';
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
