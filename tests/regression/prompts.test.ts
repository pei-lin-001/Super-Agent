/**
 * 提示词关注角色边界与工具名正确性，不逐字锁死文案。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { workerSystemPrompt } from '../../src/runtime/prompts.ts';

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

test('检查提示词：不规定核对次数，不训斥', () => {
  const text = prompt();
  assert.doesNotMatch(text, /核对一次即可/, '不规定固定核对次数');
  assert.doesNotMatch(text, /这本身是失职|失职/, '不使用训斥式表达');
  assert.doesNotMatch(text, /只能核对|最多核对|必须恰好/, '不写死核对次数');
});

test('检查提示词：保留正式结论的必备要素', () => {
  const text = prompt();
  assert.match(text, /outcome/, '必须保留 outcome');
  assert.match(text, /approved/, '必须保留 approved');
  assert.match(text, /changes_required/, '必须保留 changes_required');
  assert.match(text, /inconclusive/, '必须保留 inconclusive');
  assert.match(text, /reply_to/, '必须保留 reply_to');
  assert.match(text, /版本/, '必须保留版本要求');
});

test('检查提示词：目标与证据导向，允许继续验证', () => {
  const text = prompt();
  assert.match(text, /证据/, '要围绕证据');
  assert.match(text, /可以继续验证|继续验证/, '允许在需要时继续验证');
});

test('角色边界：通用提示词不写具体用户画像', () => {
  const text = prompt();
  // 允许出现「不预设用户身份」这类否定式说明，不允许出现对用户的具体刻画。
  assert.doesNotMatch(text, /用户是[^，。；\n]{2,}/, '不描述用户是谁');
  assert.doesNotMatch(text, /用户(?:的)?(?:服务器|电脑|机器)是/, '不描述用户的运行环境');
  assert.doesNotMatch(text, /你服务的用户(?!在当前)/, '不预设服务对象的身份');
  assert.match(text, /不预设用户身份/, '应当明确说明不预设身份');
});
