import { beijingTime } from '../domain/ids.ts';
import { isTerminalTask } from '../domain/state.ts';
import type { TaskStatus } from '../domain/types.ts';
import type { Observation } from './observer.ts';

type ObservedTask = Observation['tasks'][number];

/** 当前快照最多展开 20 个非终态任务；总数和省略数量始终明确展示。 */
const MAX_RENDERED_ACTIVE_TASKS = 20;

/**
 * 只有结构状态无法直接表达、且可能改变维护决策的事件才进入长期 delta。
 * message/job/artifact 等已由对应结构字段和 id 表示，重复进入事件只会扩大
 * 上下文并制造“有变化”的噪声；全文仍可从任务历史按 id 查回。
 */
const DECISION_EVENTS = new Set([
  'behavior.override',
  'budget.group',
  'budget.worker',
  'control.applied',
  'deadlock.detected',
  'note.failed',
  'report.fail',
  'router.notice',
  'router.resume_failed',
  'router.suspended',
]);

function isDecisionEvent(type: string): boolean {
  return (
    type.startsWith('task.') ||
    type.startsWith('worker.') ||
    type.startsWith('run.') ||
    DECISION_EVENTS.has(type)
  );
}

interface ProjectedTask {
  title: string;
  status: string;
  maintenance?: number;
  reviewEpoch?: number;
  requireReview?: boolean;
  /** 终态任务只保留状态，避免旧历史进入每轮基线和 delta。 */
  workers?: Record<string, string>;
  jobs?: Record<string, string>;
  artifacts?: Record<string, string>;
  reviews?: Record<string, string>;
  events?: Record<string, string>;
}

export interface ReviewState {
  version: 1;
  baseline: {
    generatedAt: string;
    mainAlive: boolean;
    tasks: Record<string, ProjectedTask>;
  };
  conclusion: { id: string; createdAt: string; excerpt: string } | null;
}

export interface ReviewIssue {
  id: string;
  taskId: string | null;
  title: string;
  note: string | null;
}

function waitText(wait: ObservedTask['workers'][number]['waitDetails'][number]): string {
  const links = [
    wait.replyTo ? `request ${wait.replyTo}` : '',
    wait.from ? `from ${wait.from}` : '',
    wait.jobId ? `job ${wait.jobId}(${wait.jobStatus ?? 'unknown'}, exit ${wait.jobExitCode ?? '-'})` : '',
  ].filter(Boolean);
  return `${wait.reason}@${beijingTime(wait.deadlineAt)}${links.length ? `[${links.join('; ')}]` : ''}`;
}

function projectTask(task: ObservedTask): ProjectedTask {
  if (isTerminalTask(task.status as TaskStatus)) return { title: task.title, status: task.status };
  const latestArtifacts = task.artifacts.reduce((map, artifact) => {
    const current = map.get(artifact.name);
    if (!current || artifact.version > current.version) map.set(artifact.name, artifact);
    return map;
  }, new Map<string, ObservedTask['artifacts'][number]>());
  return {
    title: task.title,
    status: task.status,
    maintenance: task.maintenance,
    reviewEpoch: task.reviewEpoch,
    requireReview: task.requireReview,
    workers: Object.fromEntries(task.workers.map((worker) => [
      worker.id,
      `${worker.status}|${worker.lastError ?? ''}|${worker.waitDetails.map(waitText).join(';')}`,
    ])),
    jobs: Object.fromEntries(task.jobs.map((job) => [
      job.id,
      `${job.status}|exit=${job.exitCode ?? '-'}|${job.command}`,
    ])),
    artifacts: Object.fromEntries([...latestArtifacts.values()].map((artifact) => [
      artifact.name,
      `v${artifact.version}|${artifact.bytes}B|${artifact.sha256.slice(0, 12)}`,
    ])),
    reviews: Object.fromEntries(task.reviews.map((review) => [
      review.id,
      `${review.outcome}|${review.current ? 'current' : 'stale'}|epoch=${review.epoch}`,
    ])),
    events: Object.fromEntries(task.eventDetails.filter((event) => isDecisionEvent(event.type)).map((event) => [
      event.id,
      `${event.type}${event.detail ? `(${event.detail})` : ''}`,
    ])),
  };
}

export function createReviewState(
  observation: Observation,
  conclusion: { id: string; createdAt: string; content: string } | null,
): ReviewState {
  return {
    version: 1,
    baseline: {
      generatedAt: observation.generatedAt,
      mainAlive: observation.mainAlive,
      tasks: Object.fromEntries(observation.tasks.map((task) => [task.id, projectTask(task)])),
    },
    conclusion: conclusion
      ? {
          id: conclusion.id,
          createdAt: conclusion.createdAt,
          excerpt: conclusion.content.replace(/\s+/g, ' ').trim().slice(0, 320),
        }
      : null,
  };
}

/**
 * delta 只列变化的身份；当前值统一在下面唯一的任务快照中展示。
 * 这样同一条 worker/wait/job/artifact 事实不会先后用长文本重复两次。
 */
function recordChangeKeys(
  lines: string[],
  label: string,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): void {
  const old = before ?? {};
  const current = after ?? {};
  const added = Object.keys(current).filter((key) => !(key in old));
  const changed = Object.keys(current).filter((key) => key in old && old[key] !== current[key]);
  const removed = Object.keys(old).filter((key) => !(key in current));
  const parts = [
    added.length ? `新增 ${added.join('、')}` : '',
    changed.length ? `变化 ${changed.join('、')}` : '',
    removed.length ? `窗口内不再展示 ${removed.join('、')}` : '',
  ].filter(Boolean);
  if (parts.length > 0) lines.push(`${label}：${parts.join('｜')}`);
}

function delta(previous: ReviewState['baseline'], observation: Observation): string[] {
  const lines: string[] = [];
  if (previous.mainAlive !== observation.mainAlive) {
    lines.push(`主系统：${previous.mainAlive ? '运行中' : '未运行'} → ${observation.mainAlive ? '运行中' : '未运行'}`);
  }
  const current = Object.fromEntries(observation.tasks.map((task) => [task.id, projectTask(task)]));
  for (const [id, task] of Object.entries(current)) {
    const old = previous.tasks[id];
    if (!old) {
      lines.push(`任务新增 ${id}：${task.title}｜${task.status}`);
      continue;
    }
    if (old.title !== task.title) lines.push(`任务 ${id} 标题：${old.title} → ${task.title}`);
    if (old.status !== task.status) lines.push(`任务 ${id} 状态：${old.status} → ${task.status}`);
    if (isTerminalTask(task.status as TaskStatus)) continue;
    if (old.maintenance !== task.maintenance) {
      lines.push(`任务 ${id} 维护挂起：${old.maintenance === 1 ? '是' : '否'} → ${task.maintenance === 1 ? '是' : '否'}`);
    }
    if (old.reviewEpoch !== task.reviewEpoch) {
      lines.push(`任务 ${id} 要求版本：${old.reviewEpoch} → ${task.reviewEpoch}`);
    }
    if (old.requireReview !== task.requireReview) {
      lines.push(`任务 ${id} 检查门槛：${old.requireReview ? '需要' : '不需要'} → ${task.requireReview ? '需要' : '不需要'}`);
    }
    recordChangeKeys(lines, `任务 ${id} Worker`, old.workers, task.workers);
    recordChangeKeys(lines, `任务 ${id} 作业`, old.jobs, task.jobs);
    recordChangeKeys(lines, `任务 ${id} 产物`, old.artifacts, task.artifacts);
    recordChangeKeys(lines, `任务 ${id} 检查`, old.reviews, task.reviews);
    recordChangeKeys(lines, `任务 ${id} 决策事件的当前证据`, old.events, task.events);
  }
  for (const id of Object.keys(previous.tasks)) {
    if (!(id in current)) lines.push(`任务移除 ${id}`);
  }
  return lines;
}

function renderTask(task: ObservedTask, issues: ReviewIssue[]): string[] {
  const lines = [
    `- ${task.id}｜${task.title}｜${task.status}${task.maintenance === 1 ? '（维护挂起）' : ''}` +
      `｜要求版本 ${task.reviewEpoch}｜需检查 ${task.requireReview ? '是' : '否'}｜负责人 ${task.ownerWorkerId ?? '-'}`,
  ];
  if (task.workers.length === 0) lines.push('  Worker：无当前成员');
  else {
    const counts = task.workers.reduce(
      (map, worker) => map.set(worker.status, (map.get(worker.status) ?? 0) + 1),
      new Map<string, number>(),
    );
    lines.push(
      `  Worker状态：${[...counts.entries()].map(([status, count]) => `${status} ${count}`).join('｜')}` +
        `｜总 step ${task.workers.reduce((sum, worker) => sum + worker.steps, 0)}`,
    );
    const focusedWorkers = task.workers.filter(
      (worker) => worker.lastError || worker.waitDetails.length > 0 ||
        ['failed', 'running', 'queued', 'waiting'].includes(worker.status),
    ).slice(0, 8);
    for (const worker of focusedWorkers) {
      lines.push(
        `  Worker ${worker.id}(${worker.role}) ${worker.status}` +
          `${worker.lastError ? `｜错误：${worker.lastError}` : ''}` +
          `${worker.waitDetails.length ? `｜等待：${worker.waitDetails.map(waitText).join('；')}` : ''}`,
      );
    }
    const hiddenWorkers = task.workers.length - focusedWorkers.length;
    if (hiddenWorkers > 0) {
      lines.push(`  另有 ${hiddenWorkers} 名成员未展开；可按 id 用 inspect_task 查回。`);
    }
  }
  const artifacts = task.artifacts.length
    ? task.artifacts.map((artifact) => `${artifact.name} v${artifact.version}`).join('、')
    : '无';
  lines.push(
    `  产物：${artifacts}｜当前检查 approved ${task.approvedReviews}/pending ${task.pendingReviews}｜运行中作业 ${task.runningJobs}`,
  );
  const attentionReviews = task.reviews
    .filter((review) => review.outcome !== 'approved')
    .slice(0, 4);
  if (attentionReviews.length > 0) {
    lines.push(
      `  需关注检查：${attentionReviews
        .map((review) => `${review.id}(${review.name ?? '-'} v${review.version}) ${review.outcome}@epoch${review.epoch}`)
        .join('；')}`,
    );
  }
  const runningJobs = task.jobs.filter((job) => job.status === 'running');
  const abnormalJobs = task.jobs.filter(
    (job) => job.status !== 'running' &&
      (['failed', 'timeout', 'killed', 'unknown'].includes(job.status) || (job.exitCode ?? 0) !== 0),
  ).slice(-2);
  const latestEnded = task.jobs.filter((job) => job.status !== 'running').at(-1);
  const allFocusedJobs = [...runningJobs, ...abnormalJobs, ...(latestEnded ? [latestEnded] : [])]
    .filter((job, index, values) => values.findIndex((item) => item.id === job.id) === index);
  const focusedJobs = allFocusedJobs.slice(0, 6);
  lines.push(
    `  作业重点：${focusedJobs.length
      ? focusedJobs.map((job) => `${job.id}(${job.command}) ${job.status}|exit=${job.exitCode ?? '-'}`).join('；')
      : '无运行中或需关注作业'}`,
  );
  const hiddenFocusedJobs = allFocusedJobs.length - focusedJobs.length;
  const shownRunningJobs = focusedJobs.filter((job) => job.status === 'running').length;
  const hiddenRunningJobs = Math.max(0, task.runningJobs - shownRunningJobs);
  if (hiddenFocusedJobs > 0 || hiddenRunningJobs > 0) {
    lines.push(
      `  另有 ${hiddenFocusedJobs} 个重点作业和 ${hiddenRunningJobs} 个运行中作业未展开；` +
        `运行中总数为 ${task.runningJobs}。`,
    );
  }
  const referenced = issues.filter((issue) => issue.taskId === task.id);
  if (referenced.length) {
    lines.push(`  未解决事件引用：${referenced.map((issue) => `${issue.id}｜${issue.title}`).join('；')}`);
  }
  lines.push(`  详情可按需：inspect_task(task_id="${task.id}")`);
  return lines;
}

export function renderReviewContext(
  observation: Observation,
  previous: ReviewState | null,
  issues: ReviewIssue[],
  baselineWarning?: string | null,
): string {
  const lines = [
    `观察时间：${beijingTime(observation.generatedAt)}`,
    observation.mainAlive
      ? `主系统：运行中（pid=${observation.mainInstance?.pid ?? '-'}）`
      : '主系统：未运行或实例文件缺失',
  ];
  if (baselineWarning) lines.push(`基线警告：${baselineWarning}`);
  lines.push('', '## 自上轮巡检以来的事实变化');
  if (!previous) {
    const active = observation.tasks.filter((task) => !isTerminalTask(task.status as TaskStatus)).length;
    lines.push(
      `本次是初始快照（没有可用基线）：非终态任务 ${active} 个、终态任务 ${observation.tasks.length - active} 个。` +
        '这些是当前事实，不表示刚刚新增。',
    );
  } else {
    const changes = delta(previous.baseline, observation);
    lines.push(
      ...(changes.length
        ? [`基线时间：${beijingTime(previous.baseline.generatedAt)}`, ...changes.map((change) => `- ${change}`)]
        : ['未检测到 task/worker/wait/job/artifact/review 事实状态变化；step 数字增长不算变化。']),
    );
  }

  const activeTasks = observation.tasks.filter((task) => !isTerminalTask(task.status as TaskStatus));
  const taskPriority = (task: ObservedTask): number => {
    let score = 0;
    if (issues.some((issue) => issue.taskId === task.id)) score += 100;
    if (task.runningJobs > 0) score += 20;
    if (task.pendingReviews > 0) score += 10;
    if (task.workers.some((worker) =>
      worker.lastError !== null ||
      ['failed', 'waiting', 'running'].includes(worker.status)
    )) score += 5;
    if (task.maintenance === 1) score += 1;
    return score;
  };
  const visibleActiveTasks = [...activeTasks]
    .sort((left, right) => taskPriority(right) - taskPriority(left))
    .slice(0, MAX_RENDERED_ACTIVE_TASKS);
  lines.push('', '## 当前非终态任务');
  if (activeTasks.length === 0) lines.push('（无）');
  else {
    for (const task of visibleActiveTasks) lines.push(...renderTask(task, issues));
    if (activeTasks.length > visibleActiveTasks.length) {
      lines.push(
        `另有 ${activeTasks.length - visibleActiveTasks.length} 个非终态任务未展开；` +
          '其 id、状态和事实变化仍在上方 delta 中，可按 id 用 inspect_task 查回。',
      );
    }
  }

  const terminalTasks = observation.tasks.filter((task) => isTerminalTask(task.status as TaskStatus));
  lines.push('', '## 终态任务');
  if (terminalTasks.length === 0) {
    lines.push('（无）');
  } else {
    const counts = terminalTasks.reduce(
      (map, task) => map.set(task.status, (map.get(task.status) ?? 0) + 1),
      new Map<string, number>(),
    );
    lines.push(`共 ${terminalTasks.length} 个：${[...counts.entries()].map(([status, count]) => `${status} ${count}`).join('｜')}`);
    for (const task of terminalTasks.filter((item) => issues.some((issue) => issue.taskId === item.id))) {
      lines.push(...renderTask(task, issues));
    }
  }

  lines.push('', '## 上轮完整结论定位');
  if (previous?.conclusion) {
    lines.push(`- ${previous.conclusion.id}｜${beijingTime(previous.conclusion.createdAt)}`);
    lines.push(`- 用 read_inspection(inspection_id="${previous.conclusion.id}") 读取全文`);
    lines.push(`- 摘录：${previous.conclusion.excerpt}`);
  } else {
    lines.push('（没有可定位的上轮巡检结论）');
  }
  return lines.join('\n');
}
