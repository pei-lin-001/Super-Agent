import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { isTerminalWorker } from '../domain/state.ts';
import type { Store } from '../storage/store.ts';

export interface Observation {
  generatedAt: string;
  mainAlive: boolean;
  mainInstance: { pid: number; startedAt: string; dbPath: string } | null;
  tasks: {
    id: string;
    title: string;
    status: string;
    maintenance: number;
    reviewEpoch: number;
    requireReview: boolean;
    workers: { id: string; role: string; status: string; steps: number; lastError: string | null }[];
    artifacts: { name: string; version: number; bytes: number }[];
    pendingReviews: number;
    approvedReviews: number;
    runningJobs: number;
    recentEvents: string[];
    stuckSignals: string[];
  }[];
}

/** 主系统实例文件：用于判断它是活着、还是已经退出。 */
export function instancePath(config: Config): string {
  return join(config.workDir, '.runtime', 'instance.json');
}

export function readInstance(config: Config): { pid: number; startedAt: string; dbPath: string } | null {
  const path = instancePath(config);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; startedAt: string; dbPath: string };
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 判断进程是否确实是本项目的实例，而不是复用了同一个 PID 的无关进程。 */
export function looksLikeOurProcess(pid: number, marker: string): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes(marker);
  } catch {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      return out.includes(marker);
    } catch {
      return false;
    }
  }
}

/**
 * 增量观察：只取摘要与引用，不把全部历史塞进来。
 * 需要细节时由 Watchdog 再用工具按 id 读取。
 */
export function observe(store: Store, config: Config): Observation {
  const instance = readInstance(config);
  const mainAlive = instance !== null && isPidAlive(instance.pid);
  const tasks = store.listTasks().map((task) => {
    const workers = store.listGroupWorkers(task.groupId);
    const artifacts = store.listArtifacts(task.id);
    const reviews = store.listReviews(task.id);
    const events = store.listEvents(task.id, 8);
    const jobs = store.listJobs(task.id);
    const running = jobs.filter((job) => job.status === 'running');

    const signals: string[] = [];
    const silent = workers.filter((worker) => worker.status === 'waiting');
    if (silent.length === workers.filter((worker) => !isTerminalWorker(worker.status)).length && silent.length > 0) {
      signals.push(`${silent.length} 个 Worker 同时处于等待`);
    }
    const failed = workers.filter((worker) => worker.status === 'failed');
    if (failed.length > 0) signals.push(`${failed.length} 个 Worker 失败`);
    if (artifacts.length > 0 && reviews.every((review) => review.outcome !== 'approved')) {
      signals.push('已有产物但没有任何 approved 检查');
    }
    const same = jobs.filter((job) => job.status === 'failed').length;
    if (same >= 3) signals.push(`${same} 个作业失败`);

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      maintenance: Number(task.maintenance ?? 0),
      reviewEpoch: task.reviewEpoch,
      requireReview: task.requireReview,
      workers: workers.map((worker) => ({
        id: worker.id,
        role: worker.role,
        status: worker.status,
        steps: worker.stepCount,
        lastError: worker.lastError,
      })),
      artifacts: artifacts.map((artifact) => ({ name: artifact.name, version: artifact.version, bytes: artifact.bytes })),
      pendingReviews: reviews.filter((review) => review.outcome === 'pending').length,
      approvedReviews: reviews.filter((review) => review.outcome === 'approved').length,
      runningJobs: running.length,
      recentEvents: events.map((event) => `${event.type} ${event.detail ?? ''}`.trim()),
      stuckSignals: signals,
    };
  });
  return { generatedAt: new Date().toISOString(), mainAlive, mainInstance: instance, tasks };
}

export function renderObservation(observation: Observation): string {
  const lines: string[] = [];
  lines.push(`观察时间：${observation.generatedAt}`);
  lines.push(
    `主系统：${observation.mainAlive ? `运行中（pid=${observation.mainInstance?.pid}）` : '未运行或实例文件缺失'}`,
  );
  if (observation.tasks.length === 0) {
    lines.push('任务：暂无');
    return lines.join('\n');
  }
  for (const task of observation.tasks) {
    lines.push('');
    lines.push(`## 任务 ${task.id}｜${task.title}`);
    lines.push(
      `状态：${task.status}${task.maintenance === 1 ? '（维护挂起）' : ''}｜要求版本 ${task.reviewEpoch}｜` +
        `需要检查：${task.requireReview ? '是' : '否'}`,
    );
    lines.push(
      `Worker：` +
        task.workers
          .map((worker) => `${worker.id}(${worker.role}) ${worker.status}/${worker.steps}步${worker.lastError ? ` 错误:${worker.lastError}` : ''}`)
          .join('；'),
    );
    lines.push(
      `产物：${task.artifacts.length === 0 ? '无' : task.artifacts.map((item) => `${item.name} v${item.version}`).join('、')}｜` +
        `检查：approved ${task.approvedReviews} / pending ${task.pendingReviews}｜运行中作业 ${task.runningJobs}`,
    );
    if (task.stuckSignals.length > 0) lines.push(`可疑信号：${task.stuckSignals.join('；')}`);
    if (task.recentEvents.length > 0) lines.push(`最近事件：${task.recentEvents.join(' | ')}`);
  }
  return lines.join('\n');
}
