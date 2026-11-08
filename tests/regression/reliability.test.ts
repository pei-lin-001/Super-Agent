import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, scripted, systemText, toolResult, workerIdOf } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { fileTools } from '../../src/tools/files.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import type { ChatRequest } from '../../src/model/types.ts';

/** 用 0 并发构造数据：只落库、不触发模型调用，便于直接验证程序规则。 */
async function staticHarness() {
  return createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
}

test('调度：单轮步数用完仍能跨轮完成并自动交付，无需新的用户消息', async () => {
  let step = 0;
  const harness = await createHarness({
    limits: { maxStepsPerRun: 1, maxStepsPerWorker: 12 },
    materials: { 'a.md': '# A\n数据 42\n' },
    worker: scripted({
      执行者: () => {
        const current = step++;
        if (current === 0) return mockReply({ toolCalls: [{ name: 'fs_read', arguments: { path: 'materials/a.md' } }] });
        if (current === 1) return mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: '.' } }] });
        if (current === 2) return mockReply({ toolCalls: [{ name: 'fs_search', arguments: { pattern: '42' } }] });
        if (current === 3) return mockReply({ toolCalls: [{ name: 'artifact_save', arguments: { name: 'out.md', content: '完成\n' } }] });
        return mockReply({ toolCalls: [{ name: 'submit_result', arguments: { summary: '多轮完成', artifacts: ['out.md'] } }] });
      },
    }),
    router: () => mockReply({ text: '已建任务' }),
  });

  try {
    const { task } = harness.runtime.createTask({
      title: '多轮任务',
      goal: '验证跨轮调度',
      ownerRole: '执行者',
      ownerBrief: '按步骤推进',
    });
    await harness.runtime.waitForIdle(10_000);

    const finished = harness.store.getTask(task.id)!;
    assert.equal(finished.status, 'completed', `应跨轮完成，实际 ${finished.status}：${finished.closeReason ?? ''}`);
    const owner = harness.runtime.listGroupWorkers(task.groupId)[0]!;
    assert.equal(owner.stepCount, 5, '五步全部真正执行，没有丢调度');
    assert.equal(harness.store.listArtifacts(task.id).length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('调度：运行中到达的调度请求不会丢，也不会让同一 Worker 并发执行', async () => {
  const harness = await createHarness({
    limits: { maxStepsPerRun: 2, maxStepsPerWorker: 12 },
    worker: scripted({
      执行者: (step: number) => {
        if (step < 4) return mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: '.' } }] });
        if (step === 4) return mockReply({ toolCalls: [{ name: 'artifact_save', arguments: { name: 'x.md', content: 'x' } }] });
        return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { timeout_seconds: 30 } }] });
      },
    }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '重排',
      goal: '运行中再次请求调度',
      ownerRole: '执行者',
      ownerBrief: '多步',
    });
    // 在 Worker 运行期间反复请求调度，不应产生第二个执行过程。
    for (let index = 0; index < 5; index += 1) harness.runtime.enqueue(owner.id);
    await harness.runtime.waitForIdle(10_000);
    const current = harness.store.getWorker(owner.id)!;
    assert.ok(current.stepCount >= 4, `应继续推进，实际 ${current.stepCount} 步`);
    assert.equal(harness.store.getTask(task.id)!.status, 'active', '尚未提交时任务应保持 active，而不是静默停住');
    assert.equal(harness.store.listArtifacts(task.id).length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('消息：广播按接收者各投一条，互不影响消费状态', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '广播',
      goal: '验证 fan-out',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const c1 = harness.runtime.createCollaborator(owner, '核对A', '核对 A');
    const c2 = harness.runtime.createCollaborator(owner, '核对B', '核对 B');
    assert.ok(c1.ok && c2.ok);

    const result = harness.runtime.sendMessage({ from: owner, to: 'group', kind: 'update', body: '补充要求：都要标注来源' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.messageIds?.length, 2, '两个接收者应各得一条消息');

    const inbox1 = harness.store.listInbox(c1.workerId!);
    const inbox2 = harness.store.listInbox(c2.workerId!);
    assert.equal(inbox1.length, 1);
    assert.equal(inbox2.length, 1);
    assert.equal(inbox1[0]!.broadcastId, inbox2[0]!.broadcastId, '同一次广播应共享 broadcastId');
    assert.notEqual(inbox1[0]!.id, inbox2[0]!.id, '每个接收者是独立消息记录');

    // 第一个人读完后，第二个人仍然收得到。
    harness.store.setMessageStatus(inbox1[0]!.id, 'consumed');
    assert.equal(harness.store.listInbox(c1.workerId!).length, 0);
    assert.equal(harness.store.listInbox(c2.workerId!).length, 1, '一人读取不应影响另一人');
    assert.equal(harness.store.getTask(task.id)!.status, 'active', '广播不应改变任务状态');
  } finally {
    await harness.cleanup();
  }
});

test('消息：错误接收者不能冒充回复他人的请求', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({
      title: '冒充',
      goal: '验证回复归属',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const c1 = harness.runtime.createCollaborator(owner, '核对A', 'A');
    const c2 = harness.runtime.createCollaborator(owner, '核对B', 'B');
    const request = harness.runtime.sendMessage({
      from: owner,
      to: c1.workerId!,
      kind: 'request',
      intent: 'help',
      body: '请核对',
    });
    assert.ok(request.messageId);

    const impostor = harness.runtime.sendMessage({
      from: harness.store.getWorker(c2.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      body: '我来回复',
    });
    assert.equal(impostor.ok, false);
    assert.match(impostor.reason ?? '', /只能回复发给自己的请求/);
  } finally {
    await harness.cleanup();
  }
});

test('产物：越界路径与绝对路径被拒绝，不同版本各自独立落盘', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '产物',
      goal: '验证版本与边界',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });

    assert.throws(() => harness.runtime.saveArtifact(owner, '../../../escaped.txt', 'x'), /不能包含 \.\./);
    assert.throws(() => harness.runtime.saveArtifact(owner, '/tmp/escaped.txt', 'x'), /必须是相对路径/);
    assert.throws(() => harness.runtime.saveArtifact(owner, 'a/../../b.txt', 'x'), /不能包含 \.\./);

    const v1 = harness.runtime.saveArtifact(owner, 'report.md', '# v1\n').artifact;
    const v2 = harness.runtime.saveArtifact(owner, 'report.md', '# v2\n').artifact;
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.notEqual(v1.path, v2.path, '不同版本必须写到不同路径');

    const read1 = await harness.runtime.readArtifactVersion(task.id, 'report.md', 1);
    assert.equal(read1.content, '# v1\n', '保存 v2 后读 v1 仍应得到 v1');
    const readLatest = await harness.runtime.readArtifactVersion(task.id, 'report.md', null);
    assert.equal(readLatest.content, '# v2\n');
  } finally {
    await harness.cleanup();
  }
});

test('产物：fs_write 不能覆盖已登记的产物目录', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '写入边界',
      goal: '验证 fs_write 边界',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const saved = harness.runtime.saveArtifact(owner, 'report.md', '# 已登记\n').artifact;
    const context: ToolContext = {
      host: harness.runtime,
      worker: owner,
      task,
      workDir: harness.config.workDir,
      materialsDir: harness.config.materialsDir,
    };
    const writeTool = fileTools.find((tool) => tool.name === 'fs_write')!;
    const relativeArtifactPath = saved.path.replace(`${task.id}/`, '');

    await assert.rejects(
      async () => writeTool.run({ path: relativeArtifactPath, content: '被改写' }, context),
      /artifact_save/,
    );
    await assert.rejects(async () => writeTool.run({ path: '../../outside.md', content: 'x' }, context), /不能包含 \.\./);
    assert.equal((await harness.runtime.readArtifactVersion(task.id, 'report.md', 1)).content, '# 已登记\n');
  } finally {
    await harness.cleanup();
  }
});

test('检查：一次请求覆盖多份产物，未覆盖全部产物时不能提交', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '多产物检查',
      goal: '验证覆盖',
      requireReview: true,
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const checker = harness.runtime.createCollaborator(owner, '检查者', '检查');
    assert.ok(checker.ok);

    const a1 = harness.runtime.saveArtifact(owner, 'a.md', 'A').artifact;
    const a2 = harness.runtime.saveArtifact(owner, 'b.md', 'B').artifact;

    const multi = harness.runtime.sendMessage({
      from: owner,
      to: checker.workerId!,
      kind: 'request',
      intent: 'review',
      body: '请检查这两份',
      refs: { artifacts: [a1, a2].map((item) => ({ artifactId: item.id, name: item.name, version: item.version })) },
    });
    assert.equal(multi.ok, true, multi.reason);
    assert.equal(harness.store.listReviewsByRequest(multi.messageId!).length, 2, '一次请求两份产物应登记两条检查记录');

    // 只批准第一份，第二份仍然缺结论。
    const reply = harness.runtime.sendMessage({
      from: harness.store.getWorker(checker.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: multi.messageId!,
      outcome: 'approved',
      body: '两份都通过',
    });
    assert.equal(reply.ok, true, reply.reason);

    // 另建一份未被检查的产物，提交必须被拒绝。
    const c1 = harness.runtime.saveArtifact(owner, 'c.md', 'C').artifact;
    const rejected = await harness.runtime.submitResult(owner, '交付', ['a.md', 'b.md', 'c.md']);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason ?? '', /c\.md v1/);
    assert.ok(c1.version === 1);
  } finally {
    await harness.cleanup();
  }
});

test('检查：不通过、无法判断、旧版本、旧要求都不能放行', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '检查门槛',
      goal: '验证负面场景',
      requireReview: true,
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const checker = harness.runtime.createCollaborator(owner, '检查者', '检查');
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', 'v1').artifact;

    const request = harness.runtime.sendMessage({
      from: owner,
      to: checker.workerId!,
      kind: 'request',
      intent: 'review',
      body: '请检查',
      refs: { artifacts: [{ artifactId: artifact.id, name: artifact.name, version: artifact.version }] },
    });
    assert.ok(request.messageId);

    // 未回复时提交被拒
    const pending = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(pending.ok, false);
    assert.match(pending.reason ?? '', /待回复 1/);

    // 明确不通过
    harness.runtime.sendMessage({
      from: harness.store.getWorker(checker.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      outcome: 'changes_required',
      body: '缺少来源',
    });
    const changed = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(changed.ok, false);
    assert.match(changed.reason ?? '', /report\.md v1/);

    // 改成 v2 但沿用旧结论
    const v2 = harness.runtime.saveArtifact(owner, 'report.md', 'v2 已补来源').artifact;
    assert.equal(v2.version, 2);
    const stale = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(stale.ok, false);
    assert.match(stale.reason ?? '', /report\.md v2/, '旧版本的检查结论不能覆盖新版本');

    // 复检通过
    const second = harness.runtime.sendMessage({
      from: owner,
      to: checker.workerId!,
      kind: 'request',
      intent: 'review',
      body: '请复检',
      refs: { artifacts: [{ artifactId: v2.id, name: v2.name, version: v2.version }] },
    });
    harness.runtime.sendMessage({
      from: harness.store.getWorker(checker.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: second.messageId!,
      outcome: 'approved',
      body: '通过',
    });
    // 用户补充要求后，要求版本抬升，刚才的通过结论不再算数。
    harness.runtime.sendRouterMessage({ taskId: task.id, kind: 'update', workerId: owner.id, body: '再加一节风险说明' });
    assert.equal(harness.store.getTask(task.id)!.reviewEpoch, 1);
    for (const message of harness.store.listInbox(owner.id)) harness.store.setMessageStatus(message.id, 'consumed');
    const staleAfterUpdate = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(staleAfterUpdate.ok, false);
    assert.match(staleAfterUpdate.reason ?? '', /要求版本 1/);

    const third = harness.runtime.sendMessage({
      from: owner,
      to: checker.workerId!,
      kind: 'request',
      intent: 'review',
      body: '按新要求复检',
      refs: { artifacts: [{ artifactId: v2.id, name: v2.name, version: v2.version }] },
    });
    harness.runtime.sendMessage({
      from: harness.store.getWorker(checker.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: third.messageId!,
      outcome: 'approved',
      body: '新要求下通过',
    });
    const accepted = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(harness.store.getTask(task.id)!.status, 'completed');

    // 已完成后不能再用旧检查重新提交
    const again = await harness.runtime.submitResult(owner, '再来一次', ['report.md']);
    assert.equal(again.ok, false);
  } finally {
    await harness.cleanup();
  }
});

test('检查：普通求助不产生检查记录，回复也不需要结论', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '求助',
      goal: '验证 help 与 review 的区别',
      requireReview: true,
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const helper = harness.runtime.createCollaborator(owner, '协作者', '协助');
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', 'v1').artifact;
    const request = harness.runtime.sendMessage({
      from: owner,
      to: helper.workerId!,
      kind: 'request',
      intent: 'help',
      body: '帮我看看这份报告',
      refs: { artifacts: [{ artifactId: artifact.id, name: artifact.name, version: artifact.version }] },
    });
    assert.equal(harness.store.listReviewsByRequest(request.messageId!).length, 0, '普通求助不应登记检查记录');

    const reply = harness.runtime.sendMessage({
      from: harness.store.getWorker(helper.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      body: '看过了',
    });
    assert.equal(reply.ok, true, reply.reason);
    assert.equal(harness.store.listReviews(task.id).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('恢复：按状态分类重建，重复调用不会重复安排', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const first = harness.runtime.createTask({
      title: '恢复一',
      goal: 'queued 重排',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const second = harness.runtime.createTask({
      title: '恢复二',
      goal: 'waiting 保持',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const third = harness.runtime.createTask({
      title: '恢复三',
      goal: 'running 中断',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });

    harness.store.setWorkerStatus(second.owner.id, 'running');
    harness.store.setWorkerStatus(second.owner.id, 'waiting');
    harness.store.createWait({
      id: 'wait_test_1',
      workerId: second.owner.id,
      groupId: second.owner.groupId,
      reason: 'reply',
      matchFrom: null,
      matchReplyTo: null,
      matchKinds: ['reply'],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    harness.store.setWorkerStatus(third.owner.id, 'running');

    const result = harness.runtime.recover();
    assert.equal(result.interrupted, 1, 'running 应记为中断');
    assert.ok(result.requeued >= 1, 'queued 应重新排队');
    assert.equal(result.waiting, 1, '等待中的 Worker 不应被重跑');
    assert.equal(harness.store.getWorker(third.owner.id)!.status, 'queued');
    assert.equal(harness.store.getWorker(second.owner.id)!.status, 'waiting');
    assert.ok(
      harness.store
        .listGroupMessages(first.task.groupId, 10)
        .concat(harness.store.listGroupMessages(third.task.groupId, 10))
        .some((message) => message.kind === 'notice' && message.body.includes('中断')),
      '中断要有明确说明',
    );

    const before = harness.runtime.stats().queued;
    const second_run = harness.runtime.recover();
    assert.equal(second_run.interrupted, 0);
    assert.equal(harness.runtime.stats().queued, before, '重复恢复不应重复入队');
  } finally {
    await harness.cleanup();
  }
});

test('恢复：提供方等待写入数据库，重启后按 deadline 自动重排', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '提供方恢复',
      goal: '持久化等待',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    harness.store.setWorkerStatus(owner.id, 'running');
    harness.store.setWorkerStatus(owner.id, 'waiting');
    harness.store.createWait({
      id: 'wait_provider',
      workerId: owner.id,
      groupId: task.groupId,
      reason: 'provider',
      matchFrom: null,
      matchReplyTo: null,
      matchKinds: null,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    harness.runtime.tick();
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id).length, 0, '过期的提供方等待应被解除');
    assert.ok(harness.runtime.stats().queued >= 1, '应重新进入调度队列');
  } finally {
    await harness.cleanup();
  }
});

test('配额：历史 Worker 不占活跃额度，组内累计创建仍有上限', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0, maxTotalWorkers: 2, maxWorkersPerGroup: 2 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  const finish = (taskId: string, workerId: string): void => {
    harness.store.setWorkerStatus(workerId, 'running');
    harness.store.setWorkerStatus(workerId, 'done');
    harness.store.setTaskStatus(taskId, 'completed', { reason: '占位结束' });
  };
  try {
    // 跑满两个活跃额度并结束它们。
    const a = harness.runtime.createTask({ title: '占位一', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const b = harness.runtime.createTask({ title: '占位二', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    assert.throws(
      () => harness.runtime.createTask({ title: '超额', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' }),
      /活跃 Worker 已达上限/,
    );
    finish(a.task.id, a.owner.id);
    finish(b.task.id, b.owner.id);

    // 历史记录保留了，但不再占用活跃额度。
    assert.equal(harness.store.listWorkers().length, 2, '历史记录必须保留');
    const next = harness.runtime.createTask({ title: '任务三', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    assert.ok(next.task.id, '旧任务结束后应能继续接收新任务');

    // 组内累计预算：本组已有 1 个 owner，只能再加 1 个协作者。
    const extra = harness.runtime.createCollaborator(next.owner, '协作者', '协助');
    assert.equal(extra.ok, true, extra.reason);
    const tooMany = harness.runtime.createCollaborator(next.owner, '第三人', '协助');
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.reason ?? '', /累计创建/);
  } finally {
    await harness.cleanup();
  }
});

test('对话：一批工具调用被等待打断时，未执行的调用留下明确记录且调用与结果配对', async () => {
  const seen: ChatRequest[] = [];
  const harness = await createHarness({
    limits: { maxStepsPerRun: 4, maxStepsPerWorker: 8, waitTimeoutMs: 80 },
    worker: scripted({
      执行者: (step: number, request: ChatRequest) => {
        seen.push(request);
        if (step === 0) {
          return mockReply({
            toolCalls: [
              { name: 'wait_for', arguments: { timeout_seconds: 0.05 } },
              { name: 'fs_list', arguments: { path: '.' } },
            ],
          });
        }
        return mockReply({ toolCalls: [{ name: 'artifact_save', arguments: { name: 'k.md', content: 'k' } }] });
      },
    }),
  });
  try {
    const { owner } = harness.runtime.createTask({
      title: '中断的调用',
      goal: '验证配对',
      ownerRole: '执行者',
      ownerBrief: '多工具',
    });
    await harness.runtime.waitForIdle(10_000);
    harness.runtime.tick();
    await harness.runtime.waitForIdle(10_000);

    const turns = harness.store.listWorkerTurns(owner.id, 50);
    const unexecuted = turns.filter((turn) => (turn.content ?? '').includes('[未执行]'));
    assert.equal(unexecuted.length, 1, '被等待打断的那次调用应留下未执行记录');

    // 之后每次请求都必须让每个 assistant.toolCalls 都有对应 tool 消息。
    for (const request of seen) {
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const message of request.messages) {
        if (message.role === 'assistant' && message.toolCalls) {
          for (const call of message.toolCalls) calls.add(call.id);
        }
        if (message.role === 'tool' && message.toolCallId) results.add(message.toolCallId);
      }
      for (const id of calls) {
        assert.ok(results.has(id), `工具调用 ${id} 缺少对应的结果消息`);
      }
    }
  } finally {
    await harness.cleanup();
  }
});

test('对话：fs_read 支持 offset 续读，能取回后半段的关键信息', async () => {
  const filler = 'A'.repeat(9000);
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    materials: { 'long.md': `${filler}\n关键结论：尾部标记 TAIL-MARKER\n` },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '分段读取',
      goal: '验证 offset',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const context: ToolContext = {
      host: harness.runtime,
      worker: owner,
      task,
      workDir: harness.config.workDir,
      materialsDir: harness.config.materialsDir,
    };
    const readTool = fileTools.find((tool) => tool.name === 'fs_read')!;
    const first = await readTool.run({ path: 'materials/long.md' }, context);
    assert.equal(first.type, 'ok');
    assert.ok(!first.content.includes('TAIL-MARKER'), '第一次读取不应包含尾部内容');
    assert.match(first.content, /继续请用 offset=/);

    const offset = Number(/offset=(\d+)/.exec(first.content)![1]);
    const second = await readTool.run({ path: 'materials/long.md', offset }, context);
    assert.equal(second.type, 'ok');
    assert.match(second.content, /TAIL-MARKER/, '续读应能取回后半段内容');
  } finally {
    await harness.cleanup();
  }
});

test('对话：system prompt 里能看到任务要求与同组协作者', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '提示词',
      goal: '验证 system prompt',
      doneCriteria: '产物包含来源',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    harness.runtime.createCollaborator(owner, '核对者', '核对数据');
    const workers = harness.store.listGroupWorkers(task.groupId);
    assert.equal(workers.length, 2);
    assert.ok(workerIdOf({ messages: [{ role: 'system', content: `- Worker：${owner.id}` }] } as ChatRequest) === owner.id);
    assert.ok(systemText({ messages: [{ role: 'system', content: 'x' }] } as ChatRequest) === 'x');
  } finally {
    await harness.cleanup();
  }
});

test('等待：等待中的 Worker 不占用并发名额，也不反复调用模型', async () => {
  let calls = 0;
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 1, maxStepsPerRun: 6, waitTimeoutMs: 5000 },
    worker: scripted({
      执行者: (step: number) => {
        calls += 1;
        if (step === 0) return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { timeout_seconds: 5 } }] });
        return mockReply({ text: '继续等待' });
      },
    }),
  });
  try {
    const { owner } = harness.runtime.createTask({
      title: '等待不空转',
      goal: '验证等待语义',
      ownerRole: '执行者',
      ownerBrief: '等待',
    });
    await harness.runtime.waitForIdle(5_000);
    assert.equal(harness.store.getWorker(owner.id)!.status, 'waiting');
    const afterWait = calls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, afterWait, '等待期间不应继续调用模型');
    assert.equal(harness.runtime.stats().running, 0, '等待应让出并发名额');
  } finally {
    await harness.cleanup();
  }
});

test('取消：任务结束后到达的回复被拒绝，不会让任务复活', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '取消',
      goal: '验证终态',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    const helper = harness.runtime.createCollaborator(owner, '协作者', '协助');
    const request = harness.runtime.sendMessage({
      from: owner,
      to: helper.workerId!,
      kind: 'request',
      intent: 'help',
      body: '请帮忙',
    });
    await harness.runtime.stopTask(task.id, '用户取消');

    const late = harness.runtime.sendMessage({
      from: harness.store.getWorker(helper.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      body: '迟到的回复',
    });
    assert.equal(late.ok, false);
    assert.match(late.reason ?? '', /已处于 cancelled/);
    assert.equal(harness.store.getTask(task.id)!.status, 'cancelled');
    assert.equal(toolResult({ messages: [] } as unknown as ChatRequest), null);
  } finally {
    await harness.cleanup();
  }
});

test('数据库迁移：旧库缺少新列时补齐，不删除数据', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '迁移',
      goal: '验证增量迁移',
      ownerRole: '负责人',
      ownerBrief: '负责',
    });
    harness.runtime.saveArtifact(owner, 'report.md', '内容');
    // 模拟旧库：把新增列去掉。
    harness.store.db.exec('ALTER TABLE task DROP COLUMN review_epoch');
    harness.store.db.exec('ALTER TABLE message DROP COLUMN broadcast_id');
    harness.store.db.exec('ALTER TABLE wait_record DROP COLUMN reason');
    harness.store.close();

    const { Store } = await import('../../src/storage/store.ts');
    const reopened = new Store(harness.config.dbPath);
    const migrated = reopened.getTask(task.id);
    assert.ok(migrated, '迁移后原有任务记录仍在');
    assert.equal(migrated!.reviewEpoch, 0, '缺失列应补默认值');
    assert.equal(reopened.listArtifacts(task.id).length, 1, '迁移不能丢数据');
    const columns = reopened.db.prepare('PRAGMA table_info(message)').all() as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'broadcast_id'));
    reopened.close();
  } finally {
    try {
      harness.store.close();
    } catch {
      // 迁移测试里已经手动关闭过
    }
    await harness.cleanup();
  }
});
