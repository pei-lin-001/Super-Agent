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

/** 只展示可追溯的位置参数，避免把文件内容或消息正文复制进摘要输入。 */
function callLocator(name: string, raw: string): string {
  const fields: Record<string, string[]> = {
    fs_read: ['path', 'offset', 'limit'],
    artifact_read: ['name', 'version', 'offset', 'limit'],
    history_read: ['from_seq', 'to_seq', 'offset', 'limit'],
    message_read: ['message_id', 'offset', 'limit'],
  };
  const keys = fields[name];
  if (!keys) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const values = parsed as Record<string, unknown>;
    return keys.flatMap((key) => {
      const value = values[key];
      if (typeof value === 'number' && Number.isFinite(value)) return [`${key}=${value}`];
      if (typeof value === 'string') return [`${key}=${JSON.stringify(value)}`];
      return [];
    }).join(' ');
  } catch {
    return '';
  }
}

/** 渲染历史片段，显式标注整理输入的截断，不改变原始历史。 */
function noteExcerpt(content: string | null, limit: number): string {
  const text = content ?? '';
  return text.length > limit ? `${text.slice(0, limit)}…（本次整理输入截断；按 turn 编号查回原文）` : text;
}

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
      const head = turn.content?.trim() ? `：${noteExcerpt(turn.content.trim(), 400)}` : '';
      lines.push(`turn#${turn.seq} [助手]${head}`);
      for (const call of calls) {
        const locator = callLocator(call.name, call.arguments);
        lines.push(`turn#${turn.seq} [调用 ${call.id}] ${call.name}${locator ? ` ${locator}` : ''}`);
      }
      for (const item of following) {
        lines.push(`turn#${item.seq} [结果 ${item.toolCallId ?? '未知调用'}] ${noteExcerpt(item.content, 600)}`);
      }
      for (const call of calls) {
        if (!seen.has(call.id)) {
          lines.push(`turn#${turn.seq} [执行结果未知 ${call.id}] ${call.name}：历史没有记录结果，不能当作已执行或未执行`);
        }
      }
      index = cursor - 1;
      continue;
    }
    if (turn.role === 'tool') {
      lines.push(`turn#${turn.seq} [结果 ${turn.toolCallId ?? '未知调用'}] ${noteExcerpt(turn.content, 600)}`);
      continue;
    }
    const label = turn.role === 'user' ? '收到' : '说明';
    lines.push(`turn#${turn.seq} [${label}] ${noteExcerpt(turn.content, 800)}`);
  }
  return lines.join('\n');
}

/**
 * 从历史里收集文件操作清单。
 *
 * 移植 pi compaction 的 readFiles/modifiedFiles 思路：摘要最容易丢的是
 * 「我到底读过/改过哪些文件」，而这条线索决定下一轮要不要重读。
 */
export function collectFileOps(turns: WorkerTurn[]): { read: string[]; written: string[] } {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const turn of turns) {
    if (!Array.isArray(turn.toolCalls)) continue;
    for (const call of turn.toolCalls) {
      const path = typeof call.arguments === 'string' ? extractPath(call.arguments) : null;
      if (!path) continue;
      if (call.name === 'fs_read' || call.name === 'fs_stat' || call.name === 'fs_glob' || call.name === 'fs_search') read.add(path);
      if (call.name === 'fs_write' || call.name === 'fs_edit' || call.name === 'artifact_save') written.add(path);
    }
  }
  return { read: [...read], written: [...written] };
}

function extractPath(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const value = record['path'] ?? record['name'];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  } catch {
    return null;
  }
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
  const system = `Maintain a revisable working record for the same Super-Agent Worker. Preserve traceable evidence and uncertainty so work can continue; original history, messages and artifacts remain retrievable.`;

  const ops = collectFileOps(decision.turns);
  const opsBlock = [
    ops.read.length > 0 ? `- 读取类操作涉及：${ops.read.slice(0, 40).join('、')}` : '',
    ops.written.length > 0 ? `- 写入类操作涉及：${ops.written.slice(0, 40).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = `# Task (program record)
- Title: ${task.title}
- Goal: ${task.goal}
- Background, constraints and authorization: ${task.brief || '(none specified)'}
- Completion criteria: ${task.doneCriteria || '(none specified)'}
- Requirements version: ${task.reviewEpoch}
- Worker: ${worker.id} (${worker.role})

# Previous record
${previousText}

# New history (turn#${decision.fromSeq}–${decision.toSeq}; ${decision.turns.length} entries)
${renderTurnsForNote(decision.turns)}

# Paths extracted from calls (not evidence of success)
${opsBlock || '(none)'}

# Output
Maintain the current decision state: the user's goal, explicit requirements, still-valid authorization and remaining work, conclusions and their conditions, key evidence with references and actual coverage, resolved and consequential remaining unknowns, dependencies, execution status and failures. Preserve who needs a finding or correction and what action remains with them. Update or retire superseded judgments and stale tasks; distinguish optional exploration and proposed thresholds from user requirements. Preserve the force and scope of claims when compressing. Distinguish observed facts, inference and uncertainty; do not invent reasoning or upgrade a limited search into proof of absence.
A call without a result has unknown execution status (cite turn#N); preserve an explicit "未执行" as not executed. Reviews and submissions are determined by program records. Truncated input does not prove the original lacked information or was unread; retain turn#N, msg IDs, artifact IDs or filenames for retrieval. Output only the record, at most ${limits.noteMaxChars} characters, in the language useful to the Worker.`;

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
  signal?: AbortSignal | null;
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
      signal: input.signal ?? null,
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
