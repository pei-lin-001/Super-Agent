import { execFileSync } from 'node:child_process';
import { beijingTime } from '../domain/ids.ts';
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
    updatedAt: string;
    closedAt: string | null;
    maintenance: number;
    reviewEpoch: number;
    requireReview: boolean;
    ownerWorkerId: string | null;
    workers: {
      id: string;
      role: string;
      status: string;
      steps: number;
      lastError: string | null;
      waits: string[];
      waitDetails: {
        id: string;
        reason: string;
        replyTo: string | null;
        from: string | null;
        jobId: string | null;
        jobStatus: string | null;
        jobExitCode: number | null;
        deadlineAt: string;
      }[];
    }[];
    artifacts: { id: string; name: string; version: number; bytes: number; sha256: string }[];
    reviews: {
      id: string;
      name: string | null;
      version: number;
      sha256: string;
      epoch: number;
      outcome: string;
      current: boolean;
    }[];
    jobs: { id: string; command: string; status: string; exitCode: number | null; endedAt: string | null }[];
    pendingReviews: number;
    approvedReviews: number;
    runningJobs: number;
    recentEvents: string[];
    eventDetails: { id: string; type: string; detail: string | null; createdAt: string }[];
    stuckSignals: string[];
  }[];
}

export interface ModelReviewGateState {
  /** 最近一次已安排语义巡检的严重健康事件签名。 */
  incidentSignature: string | null;
  incidentReviewedAt: number;
  /** 同一个到期事件只在首次到期或等待一个语义巡检周期后再次触发。 */
  dueIssueAttempts: Record<string, number>;
  /** 最近一次模型处理失败的 Router 消息批次；相同批次失败后短暂退避。 */
  routerMessageBatch: string | null;
  routerMessageFailedAt: number;
}

export interface ModelReviewGateResult {
  run: boolean;
  reason: string;
  incidentSignature: string | null;
  dueIssueKeys: string[];
  healthNote: string | null;
}

/**
 * 严重健康事件用稳定程序事实做签名，心跳年龄不进入签名。
 *
 * unverified 可能只是没有权限读取进程身份，因此只作为观察降级，不触发
 * 高频模型巡检。absent、exited、unresponsive 才可能立即要求语义判断。
 */
export function mainIncidentSignature(health: {
  state: string;
  pid: number | null;
}): string | null {
  if (!['absent', 'exited', 'unresponsive'].includes(health.state)) return null;
  return `${health.state}:${health.pid ?? '-'}`;
}

/**
 * 纯函数版本地 review gate。
 *
 * 每几秒调用它只做数据库查询后的比较；只有显式消息、事件到期、新的严重
 * 健康签名，或活跃/空闲语义间隔到期时才返回 run=true。相同健康事实只触发
 * 一次，随后等待一个活跃语义周期再复查，避免探测异常造成模型风暴。
 */
export function decideModelReview(input: {
  now: number;
  active: boolean;
  lastModelReviewAt: number;
  baselineAt: string | null;
  activeIntervalMs: number;
  idleIntervalMs: number;
  pendingRouterMessages: number;
  /** 当前 pending Router 消息 id 的稳定签名；空串表示没有消息。 */
  pendingRouterBatch?: string;
  /** 同一批 Router 消息在模型失败后的退避时间。 */
  routerFailureBackoffMs?: number;
  dueIssues: { id: string; checkAfter: string | null }[];
  health: {
    state: string;
    pid: number | null;
    detail?: string;
    identity?: string | null;
    degraded?: boolean;
  };
  state: ModelReviewGateState;
}): ModelReviewGateResult {
  const activeInterval = Math.max(1, input.activeIntervalMs);
  const idleInterval = Math.max(1, input.idleIntervalMs);
  const dueIssueKeys = input.dueIssues.map((issue) => `${issue.id}@${issue.checkAfter ?? 'always'}`);
  const incidentSignature = mainIncidentSignature(input.health);
  const healthNote =
    input.health.identity === 'mismatch'
      ? '主系统实例 PID 已确认不匹配本项目进程，存在 PID 复用风险'
      : input.health.identity === 'unknown' || input.health.degraded || input.health.state === 'unverified'
        ? '主系统身份探测不可用；只能观察已有心跳，不能据此授权停止或拉起'
        : null;

  const pendingRouterBatch = input.pendingRouterBatch ?? '';
  const routerFailureBackoff =
    input.pendingRouterMessages > 0 &&
    pendingRouterBatch !== '' &&
    input.state.routerMessageBatch === pendingRouterBatch &&
    input.now - input.state.routerMessageFailedAt <
      Math.max(1, input.routerFailureBackoffMs ?? 60_000);

  if (input.pendingRouterMessages > 0 && !routerFailureBackoff) {
    return {
      run: true,
      reason: `${input.pendingRouterMessages} 条来自 Router 的未投递消息`,
      incidentSignature,
      dueIssueKeys,
      healthNote,
    };
  }

  const issueNeedsReview = dueIssueKeys.some((key) => {
    const previous = input.state.dueIssueAttempts[key];
    return previous === undefined || input.now - previous >= activeInterval;
  });
  if (issueNeedsReview) {
    return {
      run: true,
      reason: `${dueIssueKeys.length} 个事件到期或需要再次复查`,
      incidentSignature,
      dueIssueKeys,
      healthNote,
    };
  }

  if (
    incidentSignature !== null &&
    (incidentSignature !== input.state.incidentSignature ||
      input.now - input.state.incidentReviewedAt >= activeInterval)
  ) {
    return {
      run: true,
      reason: `主系统严重健康事实：${input.health.state}`,
      incidentSignature,
      dueIssueKeys,
      healthNote,
    };
  }

  if (
    input.baselineAt === null &&
    (input.lastModelReviewAt === 0 || input.now - input.lastModelReviewAt >= activeInterval)
  ) {
    return {
      run: true,
      reason: '没有可用的巡检基线，建立初始快照',
      incidentSignature,
      dueIssueKeys,
      healthNote,
    };
  }

  const interval = input.active ? activeInterval : idleInterval;
  if (input.now - input.lastModelReviewAt >= interval) {
    return {
      run: true,
      reason: input.active ? '存在活跃任务，到语义巡检间隔' : '系统空闲，到低频巡检间隔',
      incidentSignature,
      dueIssueKeys,
      healthNote,
    };
  }

  return {
    run: false,
    reason: routerFailureBackoff
      ? '同一批 Router 消息上次模型处理失败，正在退避'
      : input.active
      ? '没有显式触发，活跃任务的语义巡检尚未到期'
      : '没有显式触发，空闲语义巡检尚未到期',
    incidentSignature,
    dueIssueKeys: [],
    healthNote,
  };
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
/** 进程身份：match（确认是我们）/ mismatch（确认不是）/ unknown（探测失败，不能下结论）。 */
export type ProcessIdentity = 'match' | 'mismatch' | 'unknown';

export function identifyProcess(pid: number, marker: string): ProcessIdentity {
  // 先确认进程是否存在：不存在就直接是 mismatch，不能因为读不到命令行就当成 unknown。
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // EPERM 说明进程在，只是没权限发信号；ESRCH 才是真的没了。
    return code === 'EPERM' ? 'unknown' : 'mismatch';
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes(marker) ? 'match' : 'mismatch';
  } catch {
    // 没有 /proc：用 ps 再看一眼
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (out.trim() === '') return 'mismatch';
    return out.includes(marker) ? 'match' : 'mismatch';
  } catch (error) {
    // 命令本身不可用（无 ps、无权限）时不能断言对方已退出
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return 'unknown';
    return 'unknown';
  }
}

export function looksLikeOurProcess(pid: number, marker: string): boolean {
  return identifyProcess(pid, marker) === 'match';
}

export function looksLikeOurProcessLegacy(pid: number, marker: string): boolean {
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
    const workers = store.listTaskWorkers(task.id);
    const artifacts = store.listArtifacts(task.id);
    const reviews = store.listReviews(task.id);
    const events = store.listRecentEvents(task.id, 12);
    const jobs = store.listJobs(task.id);
    const running = jobs.filter((job) => job.status === 'running');

    const signals: string[] = [];
    const silent = workers.filter((worker) => worker.status === 'waiting');
    if (silent.length === workers.filter((worker) => !isTerminalWorker(worker.status)).length && silent.length > 0) {
      signals.push(`${silent.length} 个 Worker 同时处于等待`);
    }
    const failed = workers.filter((worker) => worker.status === 'failed');
    if (failed.length > 0) signals.push(`${failed.length} 个 Worker 失败`);
    const latest = [...artifacts.reduce((map, artifact) => {
      const current = map.get(artifact.name);
      if (!current || artifact.version > current.version) map.set(artifact.name, artifact);
      return map;
    }, new Map<string, typeof artifacts[number]>()).values()];
    const currentReviews = reviews.filter((review) => latest.some((artifact) => artifact.id === review.artifactId && artifact.sha256 === review.artifactSha256) && review.epoch === task.reviewEpoch);
    const recentEndedJobs = jobs.filter((job) => job.status !== 'running').slice(-8);
    const abnormalEndedJobs = recentEndedJobs
      .filter((job) => ['failed', 'timeout', 'killed', 'unknown'].includes(job.status) || (job.exitCode ?? 0) !== 0)
      .slice(-2);
    const latestEndedJob = recentEndedJobs.at(-1);
    // 运行中作业最多保留 6 个身份；总数由 runningJobs 字段准确给出。
    // 已结束作业只保留最近异常和最后完成的一项，避免批量作业把 delta 撑大。
    const trackedIds = new Set([
      ...running.slice(0, 6).map((job) => job.id),
      ...abnormalEndedJobs.map((job) => job.id),
      ...(latestEndedJob ? [latestEndedJob.id] : []),
    ]);
    const trackedJobs = jobs.filter((job) => trackedIds.has(job.id));
    if (task.requireReview && latest.some((artifact) => !currentReviews.some((review) => review.artifactId === artifact.id && review.outcome === 'approved'))) {
      signals.push('当前产物存在未获当前要求版本 approved 的版本（是否必须交付由负责人决定）');
    }
    const same = jobs.filter((job) => job.status === 'failed').length;
    if (same >= 3) signals.push(`${same} 个作业失败`);

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      closedAt: task.closedAt,
      maintenance: Number(task.maintenance ?? 0),
      reviewEpoch: task.reviewEpoch,
      requireReview: task.requireReview,
      ownerWorkerId: task.ownerWorkerId,
      workers: workers.map((worker) => ({
        id: worker.id,
        role: worker.role,
        status: worker.status,
        steps: worker.stepCount,
        lastError: worker.lastError,
        waits: store.listActiveWaitsForWorker(worker.id).map((wait) => `${wait.reason}${wait.matchReplyTo ? ` 请求:${wait.matchReplyTo}` : ''}${wait.matchFrom ? ` 来源:${wait.matchFrom}` : ''}${wait.matchJob ? ` 作业:${wait.matchJob}` : ''}`),
        waitDetails: store.listActiveWaitsForWorker(worker.id).map((wait) => {
          const job = wait.matchJob ? jobs.find((item) => item.id === wait.matchJob) ?? null : null;
          return {
            id: wait.id,
            reason: wait.reason,
            replyTo: wait.matchReplyTo,
            from: wait.matchFrom,
            jobId: wait.matchJob ?? null,
            jobStatus: job?.status ?? null,
            jobExitCode: job?.exitCode ?? null,
            deadlineAt: wait.deadlineAt,
          };
        }),
      })),
      artifacts: latest.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        version: artifact.version,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })),
      reviews: currentReviews.map((review) => {
        const artifact = artifacts.find((item) => item.id === review.artifactId) ?? null;
        return {
          id: review.id,
          name: artifact?.name ?? null,
          version: review.artifactVersion,
          sha256: review.artifactSha256,
          epoch: review.epoch,
          outcome: review.outcome,
          current:
            artifact !== null &&
            latest.some((item) => item.id === artifact.id) &&
            review.artifactSha256 === artifact.sha256 &&
            review.epoch === task.reviewEpoch,
        };
      }),
      jobs: trackedJobs.map((job) => ({
        id: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
        endedAt: job.endedAt,
      })),
      pendingReviews: currentReviews.filter((review) => review.outcome === 'pending').length,
      approvedReviews: currentReviews.filter((review) => review.outcome === 'approved').length,
      runningJobs: running.length,
      recentEvents: events.map((event) => `${event.type} ${event.detail ?? ''}`.trim()),
      eventDetails: events.map((event) => ({
        id: event.id,
        type: event.type,
        detail: event.detail,
        createdAt: event.createdAt,
      })),
      stuckSignals: signals,
    };
  });
  return { generatedAt: new Date().toISOString(), mainAlive, mainInstance: instance, tasks };
}

export function renderObservation(observation: Observation): string {
  const lines: string[] = [];
  lines.push(`观察时间：${beijingTime(observation.generatedAt)}（北京时间）`);
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
          .map((worker) => `${worker.id}(${worker.role}) ${worker.status}/${worker.steps}步${worker.waits.length ? ` 等待:${worker.waits.join(',')}` : ''}${worker.lastError ? ` 错误:${worker.lastError}` : ''}`)
          .join('；') + (task.workers.length === 0 ? '（无当前成员）' : '') +
        (task.ownerWorkerId && !task.workers.some((worker) => worker.id === task.ownerWorkerId)
          ? `｜历史负责人 ${task.ownerWorkerId}`
          : ''),
    );
    lines.push(
      `产物：${task.artifacts.length === 0 ? '无' : task.artifacts.map((item) => `${item.name} v${item.version}`).join('、')}｜` +
        `当前产物/要求版本检查：approved ${task.approvedReviews} / pending ${task.pendingReviews}｜运行中作业 ${task.runningJobs}`,
    );
    if (task.stuckSignals.length > 0) lines.push(`可疑信号：${task.stuckSignals.join('；')}`);
    if (task.recentEvents.length > 0) lines.push(`最近事件：${task.recentEvents.join(' | ')}`);
  }
  return lines.join('\n');
}
