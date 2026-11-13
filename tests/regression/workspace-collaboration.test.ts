import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mockReply } from '../../src/model/mock.ts';
import { Store } from '../../src/storage/store.ts';
import { allText, createHarness } from '../helpers.ts';

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('等待测试状态超时');
}

test('复用工作空间时，第二任务成员和协作消息归属当前任务', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const first = harness.runtime.createTask({
      title: '第一项',
      goal: '旧任务',
      ownerRole: '负责人',
      ownerBrief: '完成旧任务',
    });
    const second = harness.runtime.createTask({
      title: '第二项',
      goal: '新任务',
      ownerRole: '负责人',
      ownerBrief: '完成新任务',
      workspaceId: first.task.groupId,
    });

    assert.equal(second.owner.currentTaskId, second.task.id, '新负责人必须服务第二项任务');
    const helperResult = harness.runtime.createCollaborator(second.owner, '核对者', '核对第二项任务');
    assert.equal(helperResult.ok, true, helperResult.reason);
    const helper = harness.store.getWorker(helperResult.workerId!)!;
    assert.equal(helper.currentTaskId, second.task.id, '新协作者必须继承当前任务，而不是空间里的旧任务');

    const request = harness.runtime.sendMessage({
      from: second.owner,
      to: helper.id,
      kind: 'request',
      intent: 'help',
      body: '请核对第二项任务',
    });
    assert.equal(request.ok, true, request.reason);
    assert.equal(harness.store.getMessage(request.messageId!)?.taskId, second.task.id);

    const wait = harness.runtime.registerWait(second.owner, {
      replyTo: request.messageId,
      from: helper.id,
      kinds: ['reply'],
      timeoutMs: 60_000,
    });
    harness.store.setWorkerStatus(second.owner.id, 'waiting');
    const notice = harness.runtime.sendRouterMessage({
      taskId: second.task.id,
      workerId: second.owner.id,
      kind: 'notice',
      body: '补充一条不改变要求的线索',
    });
    assert.equal(notice.ok, true, notice.reason);
    assert.equal(harness.store.listActiveWaitsForWorker(second.owner.id)[0]?.id, wait.waitId);

    const reply = harness.runtime.sendMessage({
      from: helper,
      to: second.owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      body: '核对完成',
    });
    assert.equal(reply.ok, true, reply.reason);
    assert.equal(harness.store.listActiveWaitsForWorker(second.owner.id).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('复用工作空间时，第二任务能真实写入、登记、提交并生成自己的结果消息', async () => {
  let secondSteps = 0;
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: ({ request }) => {
      const text = allText(request);
      if (!text.includes('- Task: 第二项执行')) return mockReply({ text: '不执行旧任务' });
      secondSteps += 1;
      if (secondSteps === 1) {
        return mockReply({
          toolCalls: [{
            name: 'artifact_save',
            arguments: { name: 'second.md', content: '第二项任务自己的结果' },
          }],
        });
      }
      return mockReply({
        toolCalls: [{
          name: 'submit_result',
          arguments: { summary: '第二项完成', artifacts: ['second.md'] },
        }],
      });
    },
  });
  try {
    const first = harness.runtime.createTask({
      title: '第一项',
      goal: '旧任务',
      ownerRole: '负责人',
      ownerBrief: '旧任务',
    });
    const second = harness.runtime.createTask({
      title: '第二项执行',
      goal: '新任务',
      ownerRole: '负责人',
      ownerBrief: '新任务',
      workspaceId: first.task.groupId,
    });

    const internal = harness.runtime as unknown as { queue: string[]; pump(): void };
    internal.queue.splice(0, internal.queue.length, second.owner.id);
    harness.config.limits.maxConcurrentRuns = 1;
    internal.pump();
    await until(() => harness.store.getTask(second.task.id)?.status === 'completed');
    await harness.router.notify();

    const artifacts = harness.store.listArtifacts(second.task.id);
    assert.equal(artifacts.length, 1);
    assert.equal(harness.store.listArtifacts(first.task.id).length, 0);
    assert.ok(existsSync(join(harness.config.workDir, artifacts[0]!.path)), '第二任务产物必须落在自己的任务目录');
    const results = harness.store.listTaskMessages(second.task.id).filter((message) => message.kind === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.taskId, second.task.id);
    assert.ok(secondSteps >= 2, '第二任务负责人应实际执行保存和提交两步');
  } finally {
    await harness.cleanup();
  }
});

test('复用工作空间时，旧任务审批、消息、暂停和终结都不影响第二任务', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const first = harness.runtime.createTask({
      title: '旧检查任务',
      goal: '旧目标',
      ownerRole: '负责人',
      ownerBrief: '旧任务',
      requireReview: true,
    });
    const second = harness.runtime.createTask({
      title: '新检查任务',
      goal: '新目标',
      ownerRole: '负责人',
      ownerBrief: '新任务',
      requireReview: true,
      workspaceId: first.task.groupId,
    });

    const firstHelper = harness.store.getWorker(
      harness.runtime.createCollaborator(first.owner, '旧检查者', '检查旧产物').workerId!,
    )!;
    const firstArtifact = harness.runtime.saveArtifact(first.owner, 'shared.md', '旧任务内容').artifact;
    const firstReview = harness.runtime.sendMessage({
      from: first.owner,
      to: firstHelper.id,
      kind: 'request',
      intent: 'review',
      body: '检查旧版本',
      refs: { artifacts: [{ artifactId: firstArtifact.id, name: firstArtifact.name, version: firstArtifact.version }] },
    });
    assert.equal(firstReview.ok, true, firstReview.reason);
    const approved = harness.runtime.sendMessage({
      from: firstHelper,
      to: first.owner.id,
      kind: 'reply',
      replyTo: firstReview.messageId!,
      outcome: 'approved',
      body: '旧版本通过',
    });
    assert.equal(approved.ok, true, approved.reason);

    const secondArtifact = harness.runtime.saveArtifact(second.owner, 'shared.md', '新任务内容').artifact;
    assert.equal(harness.store.listReviews(second.task.id).length, 0, '旧任务审批不能出现在第二任务');
    assert.ok(
      harness.store.listTaskMessages(second.task.id).every((message) => message.taskId === second.task.id),
      '第二任务消息视图不能混入旧任务消息',
    );
    const blocked = await harness.runtime.submitResult(second.owner, '尝试沿用旧审批', [secondArtifact.name]);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? '', /要求版本 0/);

    const secondEpoch = harness.store.getWorker(second.owner.id)!.runEpoch;
    harness.store.insertControlCommand({
      id: 'cc_pause_first',
      command: 'pause_task',
      payload: JSON.stringify({ taskId: first.task.id, reason: '测试旧任务暂停隔离' }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    assert.ok((harness.store.getWorker(first.owner.id)?.runEpoch ?? 0) > 0, '暂停必须推进旧任务成员代次');
    assert.equal(harness.store.getWorker(second.owner.id)!.runEpoch, secondEpoch, '暂停旧任务不能推进第二任务成员代次');
    assert.ok(
      harness.store.listQueuedWorkers().some((worker) => worker.id === second.owner.id),
      '第二任务的排队成员不能被旧任务维护挂起误过滤',
    );

    await harness.runtime.stopTask(first.task.id, '旧任务结束');
    assert.equal(harness.store.getTask(second.task.id)?.status, 'active');
    assert.equal(harness.store.getWorker(second.owner.id)?.currentTaskId, second.task.id);
    assert.equal(harness.store.getWorker(first.owner.id)?.currentTaskId, null);
    assert.equal(harness.store.getWorker(firstHelper.id)?.currentTaskId, null);
  } finally {
    await harness.cleanup();
  }
});

test('Router notice 不改变要求版本，并能临时唤醒三类 reply 等待', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: 'notice',
      goal: '验证不改变要求',
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const helper = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, '协作者', '提供信息').workerId!,
    )!;
    const request = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'request',
      intent: 'help',
      body: '请核对',
    });
    assert.equal(request.ok, true, request.reason);

    const internal = harness.runtime as unknown as { queue: string[] };
    const executeTool = (
      harness.router as unknown as {
        executeTool(name: string, rawArguments: string): Promise<string>;
      }
    ).executeTool.bind(harness.router);
    const epochBefore = harness.store.getTask(task.id)!.reviewEpoch;
    const briefBefore = harness.store.getTask(task.id)!.brief;

    for (const options of [
      { replyTo: request.messageId!, from: helper.id, kinds: ['reply' as const] },
      { from: helper.id, kinds: ['reply' as const] },
      {},
    ]) {
      const wait = harness.runtime.registerWait(owner, { ...options, timeoutMs: 60_000 });
      if (harness.store.getWorker(owner.id)?.status !== 'waiting') {
        harness.store.setWorkerStatus(owner.id, 'waiting');
      }
      internal.queue.length = 0;
      const delivered = await executeTool('send_to_worker', JSON.stringify({
        task_id: task.id,
        worker_id: owner.id,
        kind: 'notice',
        body: 'Router 提供的未改变要求的信息',
      }));
      assert.match(delivered, /已投递消息/);
      assert.ok(internal.queue.includes(owner.id), 'Router notice 应临时唤醒 reply 等待');
      assert.equal(harness.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
      assert.equal(harness.store.getTask(task.id)!.reviewEpoch, epochBefore);
      assert.equal(harness.store.getTask(task.id)!.brief, briefBefore);
      assert.equal(harness.store.getWorker(owner.id)?.status, 'waiting');
    }

    for (const reason of ['provider', 'job', 'user', 'maintenance'] as const) {
      const wait = harness.runtime.registerWait(owner, { reason, timeoutMs: 60_000 });
      if (harness.store.getWorker(owner.id)?.status !== 'waiting') {
        harness.store.setWorkerStatus(owner.id, 'waiting');
      }
      internal.queue.length = 0;
      const notice = harness.runtime.sendRouterMessage({
        taskId: task.id,
        workerId: owner.id,
        kind: 'notice',
        body: `${reason} 期间的事实更新`,
      });
      assert.equal(notice.ok, true, notice.reason);
      assert.ok(!internal.queue.includes(owner.id), `${reason} 等待不能被 Router notice 唤醒`);
      assert.equal(harness.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
    }

    const unknown = harness.runtime.sendRouterMessage({
      taskId: task.id,
      workerId: owner.id,
      kind: 'reply' as never,
      body: '不应落库',
    });
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason ?? '', /未知消息类型/);

    const update = await executeTool('send_to_worker', JSON.stringify({
      task_id: task.id,
      worker_id: owner.id,
      kind: 'update',
      body: '新增一项交付要求',
    }));
    assert.match(update, /已投递消息/);
    assert.equal(harness.store.getTask(task.id)!.reviewEpoch, epochBefore + 1);
    assert.match(harness.store.getTask(task.id)!.brief, /新增一项交付要求/);
  } finally {
    await harness.cleanup();
  }
});

test('Router notice 被 Worker 实际消费后仍保留原 reply 等待', async () => {
  let seenNotice = false;
  let renewedWait = false;
  let seenReply = false;
  let step = 0;
  let requestId = '';
  let helperId = '';
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: ({ request }) => {
      const text = allText(request);
      if (text.includes('原请求正式完成')) {
        seenReply = true;
        if (step++ === 0) {
          return mockReply({
            toolCalls: [{
              name: 'artifact_save',
              arguments: { name: 'reply.md', content: '正式回复已收到\n' },
            }],
          });
        }
        return mockReply({
          toolCalls: [{
            name: 'submit_result',
            arguments: { summary: 'notice 未解除原等待，正式回复后完成', artifacts: ['reply.md'] },
          }],
        });
      }
      if (text.includes('Router 维护事实：原请求仍在处理')) {
        seenNotice = true;
        renewedWait = true;
        return mockReply({
          toolCalls: [{
            name: 'wait_for',
            arguments: {
              reply_to: requestId,
              from: helperId,
              kinds: ['reply'],
              timeout_seconds: 60,
            },
          }],
        });
      }
      return mockReply({ text: '不应执行其他工作' });
    },
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: 'Router notice 实际消费',
      goal: '验证临时唤醒不解除原等待',
      ownerRole: '负责人',
      ownerBrief: '等待协作者回复',
    });
    const helper = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, '协作者', '完成原请求').workerId!,
    )!;
    helperId = helper.id;
    const request = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'request',
      intent: 'help',
      body: '请完成原请求',
    });
    assert.equal(request.ok, true, request.reason);
    requestId = request.messageId!;
    const wait = harness.runtime.registerWait(owner, {
      replyTo: requestId,
      from: helper.id,
      kinds: ['reply'],
      timeoutMs: 60_000,
    });
    harness.store.setWorkerStatus(owner.id, 'waiting');

    const executeTool = (
      harness.router as unknown as {
        executeTool(name: string, rawArguments: string): Promise<string>;
      }
    ).executeTool.bind(harness.router);
    const delivered = await executeTool('send_to_worker', JSON.stringify({
      task_id: task.id,
      worker_id: owner.id,
      kind: 'notice',
      body: 'Router 维护事实：原请求仍在处理',
    }));
    assert.match(delivered, /已投递消息/);
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);

    const internal = harness.runtime as unknown as { queue: string[]; pump(): void };
    internal.queue.splice(0, internal.queue.length, owner.id);
    harness.config.limits.maxConcurrentRuns = 1;
    internal.pump();
    await until(() =>
      seenNotice &&
      renewedWait &&
      harness.store.getWorker(owner.id)?.status === 'waiting' &&
      harness.store.listActiveWaitsForWorker(owner.id).length === 1,
    );

    const notice = harness.store.listTaskMessages(task.id).find((message) =>
      message.kind === 'notice' && message.fromKind === 'router');
    assert.equal(notice?.status, 'consumed', 'Worker 必须实际读到 Router notice');
    const renewed = harness.store.listActiveWaitsForWorker(owner.id)[0]!;
    assert.notEqual(renewed.id, wait.waitId, '模型重新登记等待时，旧等待记录可被正常替换');
    assert.equal(renewed.reason, 'reply');
    assert.equal(renewed.matchReplyTo, requestId, '重新等待仍须依赖同一条原请求');
    assert.equal(renewed.matchFrom, helper.id, '重新等待仍须只接受原协作者的回复');
    assert.deepEqual(renewed.matchKinds, ['reply'], 'notice 不能代替正式 reply');

    const reply = harness.runtime.sendMessage({
      from: helper,
      to: owner.id,
      kind: 'reply',
      replyTo: requestId,
      body: '原请求正式完成',
    });
    assert.equal(reply.ok, true, reply.reason);
    await until(() => seenReply && harness.store.getTask(task.id)?.status === 'completed');
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id).length, 0, '正式回复必须解除重新登记的等待');
    assert.equal(harness.store.listArtifacts(task.id).length, 1, '正式回复后 Worker 必须实际继续并保存产物');
    const result = harness.store.listTaskMessages(task.id).find((message) => message.kind === 'result');
    assert.match(result?.body ?? '', /正式回复后完成/);
  } finally {
    await harness.cleanup();
  }
});

test('唤醒到第二任务后，旧任务未消费 request 不进入收件箱也不触发处理', async () => {
  let seen = '';
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: ({ request }) => {
      seen = allText(request);
      return mockReply({ text: '收到当前任务' });
    },
  });
  try {
    const first = harness.runtime.createTask({
      title: '旧任务',
      goal: '旧目标',
      ownerRole: '负责人',
      ownerBrief: '旧任务',
    });
    const helper = harness.store.getWorker(
      harness.runtime.createCollaborator(first.owner, '协作者', '接收旧请求').workerId!,
    )!;
    const oldRequest = harness.runtime.sendMessage({
      from: first.owner,
      to: helper.id,
      kind: 'request',
      intent: 'help',
      body: '旧任务中尚未处理的问题',
    });
    assert.equal(oldRequest.ok, true, oldRequest.reason);
    const oldMessage = harness.store.getMessage(oldRequest.messageId!)!;

    harness.store.setWorkerStatus(helper.id, 'dormant', '旧任务结束');
    harness.store.setWorkerCurrentTask(helper.id, null);
    const second = harness.runtime.createTask({
      title: '新任务',
      goal: '新目标',
      ownerRole: '负责人',
      ownerBrief: '新任务',
      workspaceId: first.task.groupId,
    });
    const wake = harness.runtime.wakeWorker({
      workerId: helper.id,
      taskId: second.task.id,
      brief: '为新任务继续工作',
    });
    assert.equal(wake.ok, true, wake.reason);

    const inbox = harness.store.listInbox(helper.id);
    assert.ok(inbox.every((message) => message.taskId === second.task.id), '收件箱只能包含当前任务消息');
    assert.ok(!inbox.some((message) => message.id === oldMessage.id), '旧任务未消费请求不能混入新任务');

    const internal = harness.runtime as unknown as {
      queue: string[];
      pump(): void;
      onMessageDelivered(message: typeof oldMessage): void;
    };
    internal.queue.length = 0;
    internal.onMessageDelivered(oldMessage);
    assert.ok(!internal.queue.includes(helper.id), '旧消息投递事件不能唤醒新任务成员');

    internal.queue.splice(0, internal.queue.length, helper.id);
    harness.config.limits.maxConcurrentRuns = 1;
    internal.pump();
    await until(() => seen !== '');
    assert.doesNotMatch(seen, /旧任务中尚未处理的问题/);
  } finally {
    await harness.cleanup();
  }
});

test('迁移不猜测非空历史归属，保留休眠空值与显式唤醒结果', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const first = harness.runtime.createTask({
      title: '旧任务',
      goal: '旧目标',
      ownerRole: '负责人',
      ownerBrief: '旧任务',
    });
    const second = harness.runtime.createTask({
      title: '新任务',
      goal: '新目标',
      ownerRole: '负责人',
      ownerBrief: '新任务',
      workspaceId: first.task.groupId,
    });

    harness.store.setWorkerStatus(first.owner.id, 'dormant', '旧任务结束');
    harness.store.setWorkerCurrentTask(first.owner.id, null);
    const wake = harness.runtime.wakeWorker({
      workerId: first.owner.id,
      taskId: second.task.id,
      brief: '明确接手新任务',
    });
    assert.equal(wake.ok, true, wake.reason);
    const dormant = harness.store.getWorker(
      harness.runtime.createCollaborator(first.owner, '仍休眠者', '没有当前任务').workerId!,
    )!;
    harness.store.setWorkerStatus(dormant.id, 'dormant', '保持休眠');
    harness.store.setWorkerCurrentTask(dormant.id, null);

    // 模拟旧版本留下的非空错误绑定。没有额外持久证据时不能靠时间或最近任务猜测修正。
    const db = new DatabaseSync(harness.config.dbPath);
    db.prepare('UPDATE worker SET current_task_id = ? WHERE id = ?').run(first.task.id, second.owner.id);
    db.close();

    const reopened = new Store(harness.config.dbPath);
    try {
      assert.equal(reopened.getWorker(dormant.id)?.currentTaskId, null, '休眠 null 不应被迁移补回任务');
      assert.equal(
        reopened.getWorker(first.owner.id)?.currentTaskId,
        second.task.id,
        '显式唤醒到较新任务的结果必须保留',
      );
      assert.equal(
        reopened.getWorker(second.owner.id)?.currentTaskId,
        first.task.id,
        '已有的非空错误绑定必须保留原值，等待显式诊断',
      );
    } finally {
      reopened.close();
    }

    const otherWorkspace = harness.runtime.createTask({
      title: '另一个空间',
      goal: '验证跨空间拒绝',
      ownerRole: '负责人',
      ownerBrief: '独立任务',
    });
    const crossDb = new DatabaseSync(harness.config.dbPath);
    crossDb.prepare('UPDATE worker SET current_task_id = ? WHERE id = ?').run(
      otherWorkspace.task.id,
      second.owner.id,
    );
    crossDb.close();
    const rejected = harness.runtime.sendRouterMessage({
      taskId: second.task.id,
      workerId: second.owner.id,
      kind: 'notice',
      body: '不应跨工作空间投递',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason ?? '', /不是该任务的当前成员/);
  } finally {
    await harness.cleanup();
  }
});

test('任务消息只返回最新 N 条，并按时间正序展示', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '消息窗口',
      goal: '验证任务消息窗口',
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const insert = (index: number, createdAt: string): void => {
      harness.store.insertMessage({
        id: `msg_window_${index}`,
        groupId: task.groupId,
        taskId: task.id,
        fromKind: 'router',
        fromId: 'router',
        toKind: 'worker',
        toId: owner.id,
        kind: 'notice',
        body: `第 ${index} 条`,
        payload: null,
        replyTo: null,
        refs: null,
        dedupeKey: null,
        broadcastId: null,
        status: 'queued',
        createdAt,
        deliveredAt: null,
        consumedAt: null,
        error: null,
      });
    };
    insert(1, '2026-01-01T00:00:01.000Z');
    insert(2, '2026-01-01T00:00:02.000Z');
    insert(3, '2026-01-01T00:00:03.000Z');
    insert(4, '2026-01-01T00:00:04.000Z');

    assert.deepEqual(
      harness.store.listTaskMessages(task.id, 2).map((message) => message.body),
      ['第 3 条', '第 4 条'],
      '任务详情应先截取最新消息，再以正序返回',
    );
  } finally {
    await harness.cleanup();
  }
});

test('当前限制：已有 reply 等待时，无关 peer request 只留在收件箱而不并行唤醒', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '等待限制',
      goal: '记录当前语义',
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const helperA = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, 'A', '回复现有请求').workerId!,
    )!;
    const helperB = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, 'B', '发送无关请求').workerId!,
    )!;
    const requestA = harness.runtime.sendMessage({
      from: owner,
      to: helperA.id,
      kind: 'request',
      intent: 'help',
      body: '请回答当前问题',
    });
    const wait = harness.runtime.registerWait(owner, {
      replyTo: requestA.messageId!,
      from: helperA.id,
      kinds: ['reply'],
      timeoutMs: 60_000,
    });
    if (harness.store.getWorker(owner.id)?.status !== 'waiting') {
      harness.store.setWorkerStatus(owner.id, 'waiting');
    }

    const internal = harness.runtime as unknown as { queue: string[] };
    internal.queue.length = 0;
    const unrelated = harness.runtime.sendMessage({
      from: helperB,
      to: owner.id,
      kind: 'request',
      intent: 'help',
      body: '另一项无关问题',
    });
    assert.equal(unrelated.ok, true, unrelated.reason);
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
    assert.ok(!internal.queue.includes(owner.id), '普通 peer request 当前不会并行打断既有 reply 等待');
    assert.ok(
      harness.store.listTaskMessages(task.id).some((message) => message.id === unrelated.messageId),
      '未唤醒不等于丢消息，当前任务的收件箱仍保留请求',
    );
  } finally {
    await harness.cleanup();
  }
});
