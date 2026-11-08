import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMessageTransition,
  assertTaskTransition,
  assertWorkerTransition,
  canTransitionTask,
  canTransitionWorker,
  isTerminalTask,
} from '../../src/domain/state.ts';

test('任务状态只允许合法迁移，终态不可复活', () => {
  assert.equal(canTransitionTask('pending', 'active'), true);
  assert.equal(canTransitionTask('active', 'waiting'), true);
  assert.equal(canTransitionTask('waiting', 'active'), true);
  assert.equal(canTransitionTask('active', 'completed'), true);
  assert.equal(canTransitionTask('completed', 'active'), false);
  assert.equal(canTransitionTask('cancelled', 'completed'), false);
  assert.throws(() => assertTaskTransition('completed', 'active'), /非法状态迁移/);
  assert.equal(isTerminalTask('failed'), true);
  assert.equal(isTerminalTask('waiting'), false);
});

test('Worker 状态迁移', () => {
  assert.doesNotThrow(() => assertWorkerTransition('idle', 'running'));
  assert.doesNotThrow(() => assertWorkerTransition('running', 'waiting'));
  assert.doesNotThrow(() => assertWorkerTransition('waiting', 'running'));
  assert.throws(() => assertWorkerTransition('done', 'running'), /非法状态迁移/);
  assert.throws(() => assertWorkerTransition('failed', 'waiting'), /非法状态迁移/);
});

test('消息状态迁移：送达不等于处理', () => {
  assert.doesNotThrow(() => assertMessageTransition('queued', 'delivered'));
  assert.doesNotThrow(() => assertMessageTransition('delivered', 'consumed'));
  assert.throws(() => assertMessageTransition('queued', 'consumed'), /非法状态迁移/);
  assert.throws(() => assertMessageTransition('consumed', 'failed'), /非法状态迁移/);
});
