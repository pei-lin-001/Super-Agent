/**
 * Worker → Watchdog 的维护申请通道。
 *
 * 三件事必须成立：
 * 1) 申请落库、能被读出来，refs 坏掉也不丢申请；
 * 2) 同一份申请只处理一次（并发/重放不会重复重启）；
 * 3) 终态任务提申请要被拒，别让"重启生效"变成"重启一个已经结束的任务"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';

test('维护申请：落库、可读、只处理一次', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = harness.runtime.createTask({
      title: 't', goal: 'g', ownerRole: '执行者', ownerBrief: 'b',
    });
    const result = harness.runtime.requestMaintenance({
      worker: owner,
      kind: 'restart',
      reason: '改了 router.ts，需要重启生效',
      refs: ['c8cdecc', 'src/runtime/router.ts'],
    });
    assert.equal(result.ok, true, '正常任务应当能提申请');

    const pending = harness.store.listPendingWdRequests(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, 'restart');
    assert.deepEqual(pending[0]!.refs, ['c8cdecc', 'src/runtime/router.ts']);
    assert.equal(pending[0]!.workerId, owner.id);

    // 只处理一次：第二次必须被挡住，否则重放会重启两遍
    assert.equal(harness.store.resolveWdRequest(result.id, 'done', '已重启'), true);
    assert.equal(harness.store.resolveWdRequest(result.id, 'done', '又重启一次'), false);
    assert.equal(harness.store.listPendingWdRequests(10).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('维护申请：终态任务提申请要被拒', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: 't', goal: 'g', ownerRole: '执行者', ownerBrief: 'b',
    });
    harness.store.setTaskStatus(task.id, 'cancelled', { reason: '测试取消' });
    const result = harness.runtime.requestMaintenance({
      worker: owner, kind: 'restart', reason: 'x', refs: ['a'],
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /终态/);
    assert.equal(harness.store.listPendingWdRequests(10).length, 0, '被拒的申请不该落库');
  } finally {
    await harness.cleanup();
  }
});

test('维护申请：refs 是坏 JSON 时仍然看得到这条申请', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.store.insertWdRequest({
      id: 'wdr_bad', kind: 'restart', taskId: 't', workerId: 'w',
      reason: 'refs 被写坏了', refs: [],
    });
    // 直接改坏，模拟历史脏数据
    (harness.store as unknown as { run: (...args: unknown[]) => void })
      .run("UPDATE wd_request SET refs = '{not json' WHERE id = 'wdr_bad'");
    const pending = harness.store.listPendingWdRequests(10);
    assert.equal(pending.length, 1, '格式坏掉不能把申请藏起来');
    assert.deepEqual(pending[0]!.refs, [], '坏掉的 refs 降级为空，正文 reason 还在');
    assert.match(pending[0]!.reason, /写坏/);
  } finally {
    await harness.cleanup();
  }
});
