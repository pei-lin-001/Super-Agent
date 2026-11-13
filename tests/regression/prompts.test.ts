/**
 * 提示词关注角色边界与工具名正确性，不逐字锁死文案。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderModelCatalog, routerStateBlock, routerSystemPrompt, workerStateBlock, workerSystemPrompt } from '../../src/runtime/prompts.ts';
import { buildNotePrompt } from '../../src/runtime/note.ts';
import { WATCHDOG_SYSTEM } from '../../src/watchdog/prompts.ts';

function prompt(overrides: Partial<Parameters<typeof workerSystemPrompt>[0]> = {}): string {
  return workerSystemPrompt({
    task: {
      id: 'task_1',
      groupId: 'grp_1',
      title: '标题',
      goal: '目标',
      brief: '背景',
      doneCriteria: '完成条件',
      requireReview: true,
      reviewEpoch: 0,
      ownerWorkerId: 'w1',
      status: 'active',
      closeReason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
    },
    worker: {
      id: 'w1',
      groupId: 'grp_1',
      parentId: null,
      role: '执行者',
      brief: '负责执行',
      status: 'running',
      model: null,
      stepCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
    },
    isOwner: true,
    collaborators: [],
    taskFacts: '暂无',
    artifactTable: '暂无',
    noteText: null,
    noteStaleEpoch: null,
    noteCoveredSeq: 0,
    windowSummary: '',
    ...overrides,
  } as Parameters<typeof workerSystemPrompt>[0]);
}

test('检查提示词：用真实工具名，不出现缩写 send', () => {
  const text = prompt();
  assert.match(text, /message_send/, '必须使用实际工具名 message_send');
  assert.doesNotMatch(text, /(?<![a-z_])send\(/, '不应用缩写 send 指代工具');
});

test('角色提示保留检查、交付与维护契约', () => {
  const owner = prompt();
  for (const token of ['message_send', 'reply_to', 'approved', 'changes_required', 'inconclusive', 'submit_result', 'request_maintenance', 'artifact_save']) assert.ok(owner.includes(token), token);
  assert.match(prompt({ isOwner: false }), /owner alone calls submit_result/i);
  assert.match(routerSystemPrompt(), /create_task[\s\S]*require_review/);
});

test('成员视图展示协作决策所需事实，运行中仍显示有效等待', () => {
  const input = {
    task: { groupId: 'g', title: '任务', reviewEpoch: 0, brief: '' },
    worker: { id: 'self', role: '负责人', brief: '整体交付', stepCount: 1 },
    collaborators: [
      { id: 'self', role: '负责人', status: 'running', parentId: null },
      { id: 'peer', role: '调查', status: 'running', parentId: 'self', brief: '核验证据', model: 'pro',
        wait: { reason: 'reply', replyTo: 'msg_1', from: 'self', jobId: null }, recent: ['msg_2 发现冲突'] },
    ],
    isOwner: true, taskFacts: '', artifactTable: '', noteText: null, noteStaleEpoch: null,
    noteCoveredSeq: 0, windowSummary: '',
  } as Parameters<typeof workerStateBlock>[0];
  const state = workerStateBlock(input);
  const peers = state.split('## Collaborators')[1]!;
  assert.match(peers, /peer.*调查.*running.*pro/);
  assert.match(peers, /核验证据/);
  assert.match(peers, /Active wait.*reply.*msg_1/);
  assert.match(peers, /msg_2/);
  assert.doesNotMatch(peers, /- self｜/);
});

test('工作记录带入要求和历史边界', () => {
  const input = {
    task: { title: '任务', goal: '目标', doneCriteria: '逐项核验', reviewEpoch: 2 },
    worker: { id: 'w', role: '执行者' },
    decision: { previous: { content: '旧记录' }, turns: [], fromSeq: 3, toSeq: 4 },
    limits: { noteMaxChars: 6000 },
  } as unknown as Parameters<typeof buildNotePrompt>[0];
  const messages = buildNotePrompt(input);
  assert.equal(messages.length, 2);
  assert.match(messages[1]!.content as string, /逐项核验/);
  assert.match(messages[1]!.content as string, /旧记录/);
  assert.match(messages[1]!.content as string, /turn#3–4/);
});

test('系统提示不随动态状态变化，负责人身份例外', () => {
  const changed = prompt({
    task: { id: 'different', title: '另一任务', reviewEpoch: 7 } as Parameters<typeof workerSystemPrompt>[0]['task'],
    worker: { id: 'other', stepCount: 99 } as Parameters<typeof workerSystemPrompt>[0]['worker'],
    collaborators: [{ id: 'peer', role: '执行', status: 'running', parentId: null }],
    taskFacts: 'new facts', artifactTable: 'new artifact', noteText: 'new note', windowSummary: 'new history',
  });
  assert.equal(changed, prompt());
  assert.notEqual(prompt({ isOwner: false }), prompt());
});

test('动态状态携带当前信息并隔离过期工作记录', () => {
  const state = workerStateBlock({
    task: { groupId: 'g', title: 'current-task', reviewEpoch: 7, brief: 'context' },
    worker: { id: 'w', role: 'owner', brief: 'assignment', stepCount: 42 },
    collaborators: [], isOwner: true, taskFacts: 'state-fact', artifactTable: 'artifact-version',
    noteText: null, noteStaleEpoch: 3, noteCoveredSeq: 9, windowSummary: 'recent-history',
    modelCatalog: { currentAlias: 'default', models: [
      { alias: 'default', model: 'model-a', note: null, costHint: null },
      { alias: 'pro', model: 'model-b', note: null, costHint: null },
    ] },
  } as unknown as Parameters<typeof workerStateBlock>[0]);
  for (const value of ['current-task', '42', 'state-fact', 'artifact-version', 'recent-history', 'default', 'pro', 'model-a', 'model-b', '3', '7']) assert.ok(state.includes(value), value);
  assert.match(state, /stale/i);
  assert.doesNotMatch(state, /turn#1–9/);
});
