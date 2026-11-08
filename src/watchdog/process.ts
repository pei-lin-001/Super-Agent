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

/** 受控拉起：只在前置条件都满足时启动，并保留诊断输出位置。 */
export function spawnMain(config: Config, options: { cooldownMs: number }): SpawnResult {
  const health = mainHealth(config);
  if (health.state === 'alive' || health.state === 'unresponsive') {
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
