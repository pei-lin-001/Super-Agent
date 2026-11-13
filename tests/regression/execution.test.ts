/**
 * 执行对象本身：撤销之后，迟到的结果既不能回到业务，也不能变成未处理异常。
 *
 * 这里直接测边界对象，不经过 Runtime——否则"停机标志"之类的更粗保护会掩盖问题。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Execution, ExecutionRevoked, isRevoked, outsideRevocation } from '../../src/runtime/execution.ts';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';

test('撤销后等结果：立即以 ExecutionRevoked 结束，不等底层', async () => {
  const execution = new Execution('unit');
  let resolveWork: (value: string) => void = () => undefined;
  const work = new Promise<string>((resolve) => {
    resolveWork = resolve;
  });
  const started = Date.now();
  const pending = execution.run(() => execution.attach(work));
  setTimeout(() => execution.revoke('测试撤销'), 10);

  await assert.rejects(pending, (error: unknown) => error instanceof ExecutionRevoked);
  assert.ok(Date.now() - started < 2_000, '撤销不应等底层完成');

  // 迟到结果仍然会被观察到，不产生未处理异常
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  resolveWork('迟到结果');
  await new Promise((r) => setTimeout(r, 100));
  process.off('unhandledRejection', onRejection);
  assert.deepEqual(rejections, [], '迟到结果不能变成未处理异常');
});

test('撤销后失败：同样归为 ExecutionRevoked，而不是把底层错误抛给业务', async () => {
  const execution = new Execution('unit');
  let rejectWork: (error: Error) => void = () => undefined;
  const work = new Promise<string>((_resolve, reject) => {
    rejectWork = reject;
  });
  const pending = execution.run(() => execution.attach(work));
  setTimeout(() => execution.revoke('测试撤销'), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof ExecutionRevoked);
  rejectWork(new Error('底层迟到错误'));
  await new Promise((r) => setTimeout(r, 50));
});

test('上下文内撤销可见，撤销范围外的记账写入不受影响', async () => {
  const execution = new Execution('unit');
  await execution.run(async () => {
    assert.equal(isRevoked(), false, '未撤销时应为 false');
    execution.revoke('测试撤销');
    assert.equal(isRevoked(), true, '撤销后上下文内必须可见');
    // 记账必须能在撤销后落盘，否则取消就记不成 cancelled
    assert.equal(outsideRevocation(() => isRevoked()), false, '撤销范围外应为 false');
  });
});

test('已经撤销的执行：再次 run 仍然保持撤销状态', async () => {
  const execution = new Execution('unit');
  execution.revoke('先撤销');
  await assert.rejects(
    () => execution.run(async () => {
      if (isRevoked()) throw new ExecutionRevoked();
      return 'ok';
    }),
    (error: unknown) => error instanceof ExecutionRevoked,
  );
});

test('任务缺失时由外层统一收敛，失败状态不会被执行撤销拦住', async () => {
  let modelCalled = false;
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => {
      modelCalled = true;
      return mockReply({ text: '不应调用模型' });
    },
  });
  try {
    const now = new Date().toISOString();
    const workerId = 'w_missing_task';
    const missingTaskId = 'task_missing_context';
    harness.store.createWorker({
      id: workerId,
      groupId: 'grp_missing_context',
      workspaceId: 'grp_missing_context',
      currentTaskId: missingTaskId,
      parentId: null,
      role: '负责人',
      brief: '验证缺失任务错误路径',
      status: 'queued',
      model: 'default',
      stepCount: 0,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });

    const statusEvents: string[] = [];
    const errorEvents: string[] = [];
    const off = harness.runtime.on((event) => {
      if (event.type === 'worker.status' && event.workerId === workerId) statusEvents.push(event.status);
      if (event.type === 'error') errorEvents.push(event.text);
    });

    harness.config.limits.maxConcurrentRuns = 1;
    harness.runtime.enqueue(workerId);
    for (let attempt = 0; attempt < 200 && harness.store.getWorker(workerId)?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const failed = harness.store.getWorker(workerId)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.lastError ?? '', new RegExp(`Worker ${workerId} 的当前任务不存在`));
    assert.match(failed.lastError ?? '', new RegExp(`currentTaskId=${missingTaskId}`));
    assert.doesNotMatch(failed.lastError ?? '', /执行已结束|ExecutionRevoked/);
    assert.deepEqual(statusEvents, ['failed']);
    assert.ok(errorEvents.some((text) => text.includes(missingTaskId)), '失败事件必须带任务上下文');
    assert.equal(harness.runtime.stats().running, 0);
    assert.equal(harness.runtime.stats().queued, 0);
    assert.equal(modelCalled, false, '任务不存在时不应调用模型');
    off();
  } finally {
    await harness.cleanup();
  }
});
