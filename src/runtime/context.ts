import type { Artifact, Review, Task, Worker, WorkerTurn } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';

/** 按字符数估算长度：这是字符数，不是 token，也不是费用。 */
export function estimateTurnChars(turn: WorkerTurn): number {
  const content = turn.content?.length ?? 0;
  const calls = turn.toolCalls ? JSON.stringify(turn.toolCalls).length : 0;
  return content + calls;
}

export function estimateTurnsChars(turns: WorkerTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTurnChars(turn), 0);
}

export interface HistoryPlan {
  /** 实际进入模型输入的 turn，已保证「工具调用」与「结果」成组。 */
  turns: WorkerTurn[];
  windowStartSeq: number;
  windowChars: number;
  /** 全部历史的规模，用于说明窗口占比与是否还值得整理。 */
  totalTurns: number;
  totalChars: number;
  /** 因保持工具配对而超出预算的字符数。 */
  overshoot: number;
  /** 因超出预算被挤出的 turn 数。 */
  droppedTurns: number;
}

/**
 * 把 turn 按「一次模型调用及其全部工具结果」切组。
 * assistant 带 toolCalls 的 turn 与紧随其后的 tool turn 属于同一组，不能拆开。
 */
export function groupTurns(turns: WorkerTurn[]): WorkerTurn[][] {
  const groups: WorkerTurn[][] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index]!;
    if (turn.role === 'assistant' && Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      const group = [turn];
      let cursor = index + 1;
      while (cursor < turns.length && turns[cursor]!.role === 'tool') {
        group.push(turns[cursor]!);
        cursor += 1;
      }
      groups.push(group);
      index = cursor;
      continue;
    }
    groups.push([turn]);
    index += 1;
  }
  return groups;
}

/**
 * 按字符预算从最新往前取历史，保持工具配对完整。
 * 超出预算时优先丢弃最老的整组，而不是把某一组拆开。
 */
export function planHistory(input: {
  store: Store;
  workerId: string;
  windowChars: number;
  overshootChars: number;
  fetchLimit?: number;
}): HistoryPlan {
  const { store, workerId, windowChars, overshootChars } = input;
  const stats = store.workerTurnStats(workerId);
  if (stats.turns === 0) {
    return {
      turns: [],
      windowStartSeq: 0,
      windowChars: 0,
      totalTurns: 0,
      totalChars: 0,
      overshoot: 0,
      droppedTurns: 0,
    };
  }

  const recent = store.listWorkerTurns(workerId, input.fetchLimit ?? 400);
  const groups = groupTurns(recent);

  let chars = 0;
  let keepFrom = groups.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const groupChars = estimateTurnsChars(groups[index]!);
    if (chars + groupChars > windowChars && keepFrom < groups.length) break;
    chars += groupChars;
    keepFrom = index;
  }

  // 仍超预算时，从最老的整组开始丢弃，直到不超过预算加允许的扩展量。
  while (keepFrom < groups.length - 1 && chars > windowChars + overshootChars) {
    chars -= estimateTurnsChars(groups[keepFrom]!);
    keepFrom += 1;
  }

  const kept = groups.slice(keepFrom).flat();
  return {
    turns: kept,
    windowStartSeq: kept[0]?.seq ?? 0,
    windowChars: chars,
    totalTurns: stats.turns,
    totalChars: stats.chars,
    overshoot: Math.max(0, chars - windowChars),
    droppedTurns: stats.turns - kept.length,
  };
}

/**
 * 每次模型调用都附带的稳定执行请求。
 * 历史窗口可能把 user 轮次挤出预算，这里保证请求里始终有一条明确的 user 消息。
 */
export function renderExecutionDirective(input: {
  task: Task;
  worker: Worker;
  isOwner: boolean;
  /** 已执行的步数；不传则不展示。 */
  stepCount?: number;
}): string {
  const { worker, isOwner } = input;
  // 这里只放「一个成员从生到死都不变」的内容，它排在对话历史之前，
  // 属于提示缓存的前缀。任务标题、要求版本、步数每轮都变，挪去 workerStateBlock。
  const lines = [
    '（稳定执行上下文，每次调用都会重复提供，不是新消息，不需要回应它）',
    `- 你的职责：${worker.role}`,
    `- 具体工作：${worker.brief}`,
    `- 角色：${isOwner ? '负责人' : '协作者'}`,
  ];
  lines.push('请结合下面的历史继续推进当前工作。');
  return lines.join('\n');
}

/** 程序事实：任务状态、要求版本、提交门槛。模型不能改写这些内容。 */
export function renderTaskFacts(input: {
  task: Task;
  isOwner: boolean;
  latestUpdate: string | null;
}): string {
  const { task, isOwner, latestUpdate } = input;
  const lines = [
    `- 任务：${task.title}`,
    `- 共同目标：${task.goal}`,
    `- 完成条件：${task.doneCriteria || '（由负责人根据目标判断；提交时须引用已保存的产物）'}`,
    `- 当前要求版本：${task.reviewEpoch}`,
    `- 提交门槛：${task.requireReview ? '每个最终提交产物须取得当前要求和版本下的同组检查通过' : '不强制检查'}`,
  ];
  if (latestUpdate) {
    lines.push(`- 最新补充要求（覆盖此前计划）：${latestUpdate.slice(0, 600)}`);
  }
  if (isOwner) {
    lines.push('- 你的角色：负责人。满足完成条件后必须调用 submit_result 交付。');
  }
  return lines.join('\n');
}

export interface ArtifactLine {
  artifact: Artifact;
  review: Review | null;
  /** 该版本在当前要求版本下是否已有 approved。 */
  approved: boolean;
}

/**
 * 每个产物名只展示最新版本；历史版本按需查。
 * 「必须交付」只取决于 submit_result 实际引用了哪些产物，这里给出的是每份产物的检查状态。
 */
export function collectArtifactLines(task: Task, artifacts: Artifact[], reviews: Review[]): ArtifactLine[] {
  const latest = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const current = latest.get(artifact.name);
    if (!current || artifact.version > current.version) latest.set(artifact.name, artifact);
  }
  return [...latest.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((artifact) => {
      const review =
        reviews
          .filter((item) => item.artifactId === artifact.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const approved = reviews.some(
        (item) =>
          item.artifactId === artifact.id &&
          item.artifactSha256 === artifact.sha256 &&
          item.epoch === task.reviewEpoch &&
          item.outcome === 'approved',
      );
      return { artifact, review, approved };
    });
}

export function renderArtifactTable(input: {
  task: Task;
  lines: ArtifactLine[];
  maxItems?: number;
}): string {
  const { task, lines } = input;
  const maxItems = input.maxItems ?? 12;
  if (lines.length === 0) return '- （还没有保存任何产物）';
  const shown = lines.slice(0, maxItems);
  const header = `检查门槛：${task.requireReview ? '必需；最终提交的每份产物须有当前要求版本下的 approved' : '可选；未通过或待回复的自愿检查不阻止提交'}`;
  const body = shown.map((line) => {
    const { artifact, review, approved } = line;
    let state: string;
    if (approved) state = `approved（要求版本 ${task.reviewEpoch}）`;
    else if (!review) state = '未请求检查';
    else if (review.epoch !== task.reviewEpoch) state = `${review.outcome}（旧要求版本 ${review.epoch}，已失效）`;
    else state = review.outcome;
    return `- ${artifact.name} v${artifact.version}｜${artifact.bytes} 字节｜sha ${artifact.sha256.slice(0, 8)}｜检查：${state}`;
  });
  const rest = lines.length - shown.length;
  const footer =
    rest > 0
      ? `另有 ${rest} 份产物未显示，用 artifact_list 查看；历史版本用 artifact_read 指定 version 读取。`
      : '历史版本用 artifact_read 指定 version 读取。';
  return [header, ...body, footer].join('\n');
}
