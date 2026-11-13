import { beijingTime } from '../domain/ids.ts';
import { isTerminalTask } from '../domain/state.ts';
import type { TaskStatus } from '../domain/types.ts';
import type { Observation } from './observer.ts';

type ObservedTask = Observation['tasks'][number];

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
    events: Object.fromEntries(task.eventDetails.map((event) => [
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

function recordChanges(
  lines: string[],
  label: string,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  options: { reportRemovals?: boolean } = {},
): void {
  const old = before ?? {};
  const current = after ?? {};
  for (const [key, value] of Object.entries(current)) {
    if (!(key in old)) lines.push(`${label}新增 ${key}：${value}`);
    else if (old[key] !== value) lines.push(`${label} ${key}：${old[key]} → ${value}`);
  }
  if (options.reportRemovals !== false) {
    for (const key of Object.keys(old)) {
      if (!(key in current)) lines.push(`${label}移除 ${key}`);
    }
  }
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
    recordChanges(lines, `任务 ${id} Worker`, old.workers, task.workers);
    recordChanges(lines, `任务 ${id} 作业`, old.jobs, task.jobs);
    recordChanges(lines, `任务 ${id} 产物`, old.artifacts, task.artifacts);
    recordChanges(lines, `任务 ${id} 检查`, old.reviews, task.reviews);
    recordChanges(
      lines,
      `任务 ${id} 最近事件窗口新增（滚动窗口可能截断，不把淘汰当删除）`,
      old.events,
      task.events,
      { reportRemovals: false },
    );
  }
  for (const id of Object.keys(previous.tasks)) {
    if (!(id in current)) lines.push(`任务移除 ${id}`);
  }
  return lines;
}

function renderTask(task: ObservedTask, issues: ReviewIssue[]): string[] {
  const lines = [
    `- ${task.id}｜${task.title}｜${task.status}${task.maintenance === 1 ? '（维护挂起）' : ''}` +
      `｜要求版本 ${task.reviewEpoch}｜需检查 ${task.requireReview ? '是' : '否'}`,
  ];
  if (task.workers.length === 0) lines.push('  Worker：无当前成员');
  for (const worker of task.workers) {
    lines.push(
      `  Worker ${worker.id}(${worker.role}) ${worker.status}/step ${worker.steps}` +
        `${worker.lastError ? `｜错误：${worker.lastError}` : ''}` +
        `${worker.waitDetails.length ? `｜等待：${worker.waitDetails.map(waitText).join('；')}` : ''}`,
    );
  }
  const artifacts = task.artifacts.length
    ? task.artifacts.map((artifact) => `${artifact.name} v${artifact.version}`).join('、')
    : '无';
  lines.push(
    `  产物：${artifacts}｜当前检查 approved ${task.approvedReviews}/pending ${task.pendingReviews}｜运行中作业 ${task.runningJobs}`,
  );
  const jobs = task.jobs.length
    ? task.jobs.map((job) => `${job.id}(${job.command}) ${job.status}|exit=${job.exitCode ?? '-'}`).join('；')
    : '无';
  lines.push(`  当前作业：${jobs}`);
  const referenced = issues.filter((issue) => issue.taskId === task.id);
  if (referenced.length) {
    lines.push(`  未解决事件引用：${referenced.map((issue) => `${issue.id}｜${issue.title}`).join('；')}`);
  }
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
  lines.push('', '## 当前非终态任务');
  if (activeTasks.length === 0) lines.push('（无）');
  else for (const task of activeTasks) lines.push(...renderTask(task, issues));

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
