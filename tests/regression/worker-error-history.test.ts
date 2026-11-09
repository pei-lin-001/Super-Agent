/**
 * 工具失败要落库、要从库里读回来。
 *
 * 之前 worker_turn 根本没有 is_error 字段：工具失败了，历史里只留一段文本，
 * 模型下一轮回放时看到的效果和"成功但没有输出"一样，于是重复同一个失败操作。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { nowIso } from '../../src/domain/ids.ts';

test('worker_turn 记住工具失败，读回来仍是失败', async () => {
  // 本用例只验落库/读回，不驱动模型；但 createHarness 要求 worker 必填，
  // 给一个明确的桩而不是省略，避免类型不成立却靠 Node 擦除类型跑过。
  const harness = await createHarness({ worker: () => mockReply({ text: '本用例不走模型' }) });
  try {
    const { owner } = harness.runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    harness.store.appendWorkerTurn({
      id: 'turn_a', workerId: owner.id, seq: 1, role: 'assistant', content: null,
      toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"materials/无.txt"}' }],
      toolCallId: null, createdAt: nowIso(),
    });
    harness.store.appendWorkerTurn({
      id: 'turn_b', workerId: owner.id, seq: 2, role: 'tool', content: '[fs_read] 路径不存在',
      toolCalls: null, toolCallId: 'c1', isError: true, createdAt: nowIso(),
    });
    harness.store.appendWorkerTurn({
      id: 'turn_c', workerId: owner.id, seq: 3, role: 'tool', content: '[fs_read] 文件内容',
      toolCalls: null, toolCallId: 'c2', isError: false, createdAt: nowIso(),
    });

    const turns = harness.store.listWorkerTurns(owner.id, 10);
    assert.equal(turns.find((turn) => turn.seq === 2)?.isError, true, '失败要落成 1，不能丢');
    assert.equal(turns.find((turn) => turn.seq === 3)?.isError, false, '成功要落成 0');
    assert.equal(turns.find((turn) => turn.seq === 1)?.isError, null, '非工具轮不写这个字段');
  } finally {
    await harness.cleanup();
  }
});
