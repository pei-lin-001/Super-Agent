import type { Limits } from '../config.ts';
import type { Task, Worker, WorkerNote, WorkerTurn } from '../domain/types.ts';
import type { ChatMessage, ModelClient } from '../model/types.ts';
import { RecordingModel } from '../model/recorder.ts';
import type { Store } from '../storage/store.ts';
import { groupTurns, estimateTurnChars, estimateTurnsChars, type HistoryPlan } from './context.ts';

export interface NoteDecision {
  action: 'none' | 'compact';
  reason: string;
  fromSeq: number;
  toSeq: number;
  turns: WorkerTurn[];
  chars: number;
  coveredSeq: number;
  previous: WorkerNote | null;
}

const NONE = (reason: string): NoteDecision => ({
  action: 'none',
  reason,
  fromSeq: 0,
  toSeq: 0,
  turns: [],
  chars: 0,
  coveredSeq: 0,
  previous: null,
});

/**
 * 触发条件：窗口之外、尚未被成功覆盖、且达到条数与字符双阈值。
 * 历史整体还装得下窗口时一律不整理——短任务不该因为 turn 多就被总结。
 */
export function decideNote(input: {
  store: Store;
  worker: Worker;
  task: Task;
  history: HistoryPlan;
  limits: Limits;
  now?: number;
}): NoteDecision {
  const { store, worker, task, history, limits } = input;
  const now = input.now ?? Date.now();
  const previous = store.latestSuccessfulNote(worker.id);
  const coveredSeq = previous?.coveredSeq ?? 0;

  if (history.windowStartSeq === 0) return NONE('没有历史');
  if (history.totalChars <= limits.contextWindowChars) return NONE('全部历史都在窗口内');

  const uncovered = store.listWorkerTurnsRange(worker.id, coveredSeq + 1, history.windowStartSeq - 1);
  if (uncovered.length === 0) return NONE('没有已退出窗口且未覆盖的历史');

  const chars = estimateTurnsChars(uncovered);
  if (uncovered.length < limits.noteTriggerTurns) return NONE(`待整理 ${uncovered.length} 条，未达 ${limits.noteTriggerTurns} 条`);
  if (chars < limits.noteTriggerChars) return NONE(`待整理 ${chars} 字符，未达 ${limits.noteTriggerChars}`);

  const latest = store.latestNote(worker.id);
  if (latest?.failed && now - Date.parse(latest.createdAt) < limits.noteRetryMs) {
    return NONE('上次整理失败，仍在重试间隔内');
  }
  if (store.consecutiveNoteFailures(worker.id) >= limits.noteMaxFailures) {
    return NONE(`连续整理失败 ${limits.noteMaxFailures} 次，本次运行不再重试`);
  }

  // 单次输入按字符预算截取，且只切在整组边界上，避免把调用与结果拆开。
  const groups = groupTurns(uncovered);
  const picked: WorkerTurn[] = [];
  let used = 0;
  for (const group of groups) {
    const groupChars = estimateTurnsChars(group);
    if (used > 0 && used + groupChars > limits.noteInputChars) break;
    picked.push(...group);
    used += groupChars;
    if (used >= limits.noteInputChars) break;
  }
  if (picked.length === 0) return NONE('没有可整理的历史');

  return {
    action: 'compact',
    reason: '已退出窗口且未覆盖',
    fromSeq: picked[0]!.seq,
    toSeq: picked[picked.length - 1]!.seq,
    turns: picked,
    chars: used,
    coveredSeq,
    previous,
  };
}

const callNameOf = (turn: WorkerTurn): string => {
  if (!Array.isArray(turn.toolCalls)) return '';
  return turn.toolCalls.map((call) => call.name).join('、');
};

/** 渲染历史片段，保留「未执行」与「执行结果未知」的区别。 */
export function renderTurnsForNote(turns: WorkerTurn[]): string {
  const lines: string[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    if (turn.role === 'assistant' && Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      const calls = turn.toolCalls;
      const following: WorkerTurn[] = [];
      let cursor = index + 1;
      while (cursor < turns.length && turns[cursor]!.role === 'tool') {
        following.push(turns[cursor]!);
        cursor += 1;
      }
      const seen = new Set(following.map((item) => item.toolCallId));
      const head = turn.content?.trim() ? `：${turn.content.trim().slice(0, 400)}` : '';
      lines.push(`turn#${turn.seq} [助手] 调用 ${calls.map((call) => call.name).join('、')}${head}`);
      for (const item of following) {
        lines.push(`turn#${item.seq} [结果] ${(item.content ?? '').slice(0, 600)}`);
      }
      for (const call of calls) {
        if (!seen.has(call.id)) {
          lines.push(`turn#${turn.seq} [执行结果未知] ${call.name}：历史没有记录结果，不能当作已执行或未执行`);
        }
      }
      index = cursor - 1;
      continue;
    }
    if (turn.role === 'tool') {
      lines.push(`turn#${turn.seq} [结果] ${(turn.content ?? '').slice(0, 600)}`);
      continue;
    }
    const label = turn.role === 'user' ? '收到' : '说明';
    lines.push(`turn#${turn.seq} [${label}] ${(turn.content ?? '').slice(0, 800)}`);
  }
  return lines.join('\n');
}

export function buildNotePrompt(input: {
  task: Task;
  worker: Worker;
  decision: NoteDecision;
  limits: Limits;
}): ChatMessage[] {
  const { task, worker, decision, limits } = input;
  const previousText = decision.previous
    ? decision.previous.content
    : '（这是第一次整理，之前没有工作记录）';
  const system = `你是 Super-Agent 的工作记录整理器，为同一个 Worker 维护一份累计工作记录。
你的输出会成为该 Worker 后续唯一的过程记忆，必须准确、可追溯，不能编造。`;

  const user = `# 任务（程序记录，不要改写）
- 任务：${task.title}
- 共同目标：${task.goal}
- 完成条件：${task.doneCriteria || '（无明确条件）'}
- 当前要求版本：${task.reviewEpoch}
- Worker：${worker.id}（${worker.role}）

# 上一份工作记录
${previousText}

# 本次新增历史（turn#${decision.fromSeq} 至 turn#${decision.toSeq}，共 ${decision.turns.length} 条）
${renderTurnsForNote(decision.turns)}

# 输出要求
1. 输出一份累计记录：保留上一份里仍然有效的事实、决定、失败原因和来源引用，再加入本次新增内容。
2. 与当前要求冲突的旧计划，写成「已失效：<原因>」，不要继续当作当前计划。
3. 每条事实都带来源：turn#N、msg_xxx、art_xxx 或文件名。
4. 不得写「检查已通过」「可以交付」这类结论——检查状态由程序提供，你写了也不作数。
5. 工具结果缺失时写「执行结果未知（turn#N）」；程序明确标注的「未执行」保留原样。两者不能混为一谈。
6. 全文不超过 ${limits.noteMaxChars} 字符。放不下的细节只保留引用，不要堆砌原文。
7. 只输出记录正文，不要前言、不要代码块围栏。

建议小节：## 已完成 / ## 已确认事实 / ## 已作出的决定 / ## 已尝试但失败 / ## 未解决与等待中 / ## 下一步`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 整理失败只写诊断记录，不推进覆盖位置，也不覆盖上一份有效记录。 */
function recordFailure(store: Store, input: {
  worker: Worker;
  task: Task;
  decision: NoteDecision;
  reason: string;
}): void {
  store.insertWorkerNote({
    id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    workerId: input.worker.id,
    taskId: input.task.id,
    fromSeq: input.decision.fromSeq,
    toSeq: input.decision.toSeq,
    coveredSeq: input.decision.coveredSeq,
    epoch: input.decision.previous?.epoch ?? input.task.reviewEpoch,
    content: '',
    sourceTurns: input.decision.turns.length,
    sourceChars: input.decision.chars,
    failed: true,
    failReason: input.reason.slice(0, 300),
    createdAt: new Date().toISOString(),
  });
}

export async function runNote(input: {
  model: ModelClient;
  modelName: string;
  store: Store;
  worker: Worker;
  task: Task;
  decision: NoteDecision;
  limits: Limits;
}): Promise<{ ok: boolean; note?: WorkerNote; reason?: string }> {
  const { model, modelName, store, worker, task, decision, limits } = input;
  const epochAtStart = task.reviewEpoch;
  let content: string;
  try {
    // 工作记录整理同样是模型调用，必须和 Router/Worker 一样记账。
    const result = await new RecordingModel(model, store, 'note', {
      taskId: task.id,
      workerId: worker.id,
    }).chat({
      model: modelName,
      messages: buildNotePrompt({ task, worker, decision, limits }),
      tools: [],
      reasoningEffort: 'low',
    });
    content = (result.text ?? '').trim();
    if (content === '') {
      recordFailure(store, { worker, task, decision, reason: '模型返回空内容' });
      return { ok: false, reason: '模型返回空内容' };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordFailure(store, { worker, task, decision, reason });
    return { ok: false, reason };
  }

  // 整理期间要求版本变了：这份记录基于旧要求，不能直接安装成当前有效记录。
  const current = store.getTask(task.id);
  if (!current || current.reviewEpoch !== epochAtStart) {
    recordFailure(store, { worker, task, decision, reason: '整理期间要求版本变化，结果作废' });
    return { ok: false, reason: '整理期间要求版本变化，结果作废' };
  }

  const clipped =
    content.length > limits.noteMaxChars
      ? `${content.slice(0, limits.noteMaxChars)}\n…（记录已按上限截断，细节请按来源引用查回）`
      : content;

  const note: WorkerNote = {
    id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    workerId: worker.id,
    taskId: task.id,
    fromSeq: decision.fromSeq,
    toSeq: decision.toSeq,
    coveredSeq: decision.toSeq,
    epoch: epochAtStart,
    content: clipped,
    sourceTurns: decision.turns.length,
    sourceChars: decision.chars,
    failed: false,
    failReason: null,
    createdAt: new Date().toISOString(),
  };
  store.insertWorkerNote(note);
  return { ok: true, note };
}
