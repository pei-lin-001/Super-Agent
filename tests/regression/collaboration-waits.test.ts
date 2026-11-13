import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, allText, workerIdOf } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { observe } from '../../src/watchdog/observer.ts';

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 600; n += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('等待测试状态超时');
}

test('关联 notice 能被模型看到但不解除回复等待，正式回复后继续', async () => {
  let seenNotice = 0;
  let seenReply = 0;
  let requestId = '';
  let helperId = '';
  const h = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: ({ request }) => {
    const text = allText(request);
    if (text.includes('增量证据')) seenNotice += 1;
    if (text.includes('最终结论')) seenReply += 1;
    return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { reply_to: requestId, from: helperId, kinds: ['reply'], timeout_seconds: 60 } }] });
  } });
  try {
    const { task, owner } = h.runtime.createTask({ title: 't', goal: 'g', ownerRole: '负责人', ownerBrief: '执行' });
    helperId = h.runtime.createCollaborator(owner, '核对', '核对证据').workerId!;
    const helper = h.store.getWorker(helperId)!;
    const req = h.runtime.sendMessage({ from: owner, to: helperId, kind: 'request', body: '核对' });
    assert.ok(req.ok);
    requestId = req.messageId!;
    const wait = h.runtime.registerWait(owner, { replyTo: req.messageId, from: helperId, kinds: ['reply'], timeoutMs: 60_000 });
    h.store.setWorkerStatus(owner.id, 'waiting');
    const notice = h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'notice', replyTo: req.messageId, body: '增量证据' });
    assert.ok(notice.ok, notice.reason);
    assert.equal(h.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
    const internal = h.runtime as unknown as { queue: string[]; pump(): void };
    internal.queue.splice(0, internal.queue.length, owner.id);
    h.config.limits.maxConcurrentRuns = 1;
    internal.pump();
    await until(() => seenNotice > 0 && h.store.getWorker(owner.id)?.status === 'waiting');
    assert.equal(h.store.listActiveWaitsForWorker(owner.id).length, 1);
    assert.equal(h.store.getMessage(notice.messageId!)?.status, 'consumed');
    assert.equal(h.store.getTask(task.id)?.status, 'active');
    const reply = h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'reply', replyTo: req.messageId, body: '最终结论' });
    assert.ok(reply.ok, reply.reason);
    await until(() => seenReply > 0);
    assert.ok(h.store.listActiveWaitsForWorker(owner.id).every((item) => item.id !== wait.waitId));
  } finally { await h.cleanup(); }
});

test('notice 权限、等待种类和恢复边界', async () => {
  const h = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = h.runtime.createTask({ title: 't', goal: 'g', ownerRole: '负责人', ownerBrief: '执行' });
    const a = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'a').workerId!)!;
    const b = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'b').workerId!)!;
    const request = h.runtime.sendMessage({ from: owner, to: a.id, kind: 'request', body: '请检查' });
    assert.ok(request.ok);
    assert.equal(h.runtime.sendMessage({ from: b, to: owner.id, kind: 'notice', body: '线索', replyTo: request.messageId }).ok, false);
    assert.equal(h.runtime.sendMessage({ from: b, to: owner.id, kind: 'notice', body: '线索' }).ok, true);
    assert.equal(h.runtime.sendMessage({ from: a, to: 'group', kind: 'notice', body: '线索' }).ok, false);
    assert.equal(h.runtime.sendMessage({ from: a, to: owner.id, kind: 'notice', body: '线索', outcome: 'approved' }).ok, false);
    const wait = h.runtime.registerWait(owner, { reason: 'provider', timeoutMs: 60_000 });
    h.store.setWorkerStatus(owner.id, 'waiting');
    assert.equal(h.runtime.sendMessage({ from: a, to: owner.id, kind: 'notice', body: '线索', replyTo: request.messageId }).ok, true);
    assert.equal(h.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
    h.runtime.recover();
    assert.equal(h.store.listActiveWaitsForWorker(owner.id)[0]?.id, wait.waitId);
  } finally { await h.cleanup(); }
});

test('仅明确的回复依赖闭环被解除，外部等待和未形成环的成员保留', async () => {
  const h = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task, owner } = h.runtime.createTask({
      title: '回复依赖环',
      goal: '保留原始用户目标',
      brief: `用户授权与边界：${'完整授权内容'.repeat(300)}`,
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const a = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'a').workerId!)!;
    const b = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'b').workerId!)!;
    h.runtime.registerWait(owner, { reason: 'provider', timeoutMs: 60_000 });
    for (const member of [owner, a, b]) {
      if (h.store.getWorker(member.id)!.status === 'idle') h.store.setWorkerStatus(member.id, 'queued');
      h.store.setWorkerStatus(member.id, 'waiting');
    }

    const buildCycle = (label: string): void => {
      const r1 = h.runtime.sendMessage({ from: a, to: b.id, kind: 'request', body: `a-${label}` });
      const r2 = h.runtime.sendMessage({ from: b, to: a.id, kind: 'request', body: `b-${label}` });
      assert.equal(r1.ok, true, r1.reason);
      assert.equal(r2.ok, true, r2.reason);
      h.runtime.registerWait(a, { replyTo: r1.messageId, kinds: ['reply'], timeoutMs: 60_000 });
      h.runtime.registerWait(b, { replyTo: r2.messageId, kinds: ['reply'], timeoutMs: 60_000 });
      h.runtime.recover();
    };

    buildCycle('1');
    assert.equal(h.store.listActiveWaitsForWorker(owner.id).length, 1);
    assert.equal(h.store.listActiveWaitsForWorker(a.id).length, 0, '环上每条 reply 等待都应解除');
    assert.equal(h.store.listActiveWaitsForWorker(b.id).length, 0, '不能只解最早一条后让环立即重建');
    const notices = h.store.listInbox(owner.id).filter((message) => message.body.includes('回复依赖形成闭环'));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.body, /保留原始用户目标/);
    assert.match(notices[0]!.body, new RegExp(`负责人：${owner.id}`));
    assert.match(notices[0]!.body, new RegExp(`${a.id}.*等待请求`));
    assert.match(notices[0]!.body, new RegExp(`${b.id}.*等待请求`));
    assert.match(notices[0]!.body, /任务授权\/背景/);
    assert.match(notices[0]!.body, /已截断.*inspect_task/);
    assert.match(notices[0]!.body, /任务状态未改变|任务已完成/);
    assert.doesNotMatch(notices[0]!.body, /第 1 次|上限|判为 failed/);

    buildCycle('2');
    assert.equal(h.store.listActiveWaitsForWorker(a.id).length, 0);
    assert.equal(h.store.listActiveWaitsForWorker(b.id).length, 0);
    assert.equal(h.store.getTask(task.id)?.status, 'active', '闭环不自动判失败或终结任务');
    assert.notEqual(h.store.getWorker(a.id)?.status, 'failed');
    assert.notEqual(h.store.getWorker(b.id)?.status, 'failed');
    assert.equal(
      h.store.listRecentEvents(task.id, 20).filter((event) => event.type === 'deadlock.detected').length,
      2,
    );
    assert.equal(
      h.store.listRecentEvents(task.id, 20).filter((event) => event.type === 'worker.failed').length,
      0,
      '程序只提供闭环事实，不按固定次数替模型裁决失败',
    );
    const observation = observe(h.store, h.config);
    assert.ok(observation.tasks[0]!.workers.find((item) => item.id === owner.id)!.waits.some((value) => value.includes('provider')));
  } finally { await h.cleanup(); }
});

test('真实运行中的闭环只解除等待，不 revoke 当前执行，也不虚报失败', async () => {
  let ownerId = '';
  let aId = '';
  let bId = '';
  const callsByWorker = new Map<string, number>();
  const h = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: ({ request }) => {
      const text = allText(request);
      const workerId = workerIdOf(request);
      if (workerId === '') return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { timeout_seconds: 60 } }] });
      if (workerId === ownerId) {
        return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { timeout_seconds: 60 } }] });
      }
      const count = (callsByWorker.get(workerId) ?? 0) + 1;
      callsByWorker.set(workerId, count);
      if (count === 1) {
        const peerId = workerId === aId ? bId : aId;
        return mockReply({
          toolCalls: [{
            name: 'message_send',
            arguments: { to: peerId, kind: 'request', body: `形成闭环 ${workerId}` },
          }],
        });
      }
      if (count === 2) {
        const receipt = text.match(
          new RegExp(`已投递消息 (msg_[a-f0-9]{8})（${workerId} →`),
        );
        const requestId = receipt?.[1];
        assert.ok(requestId, '应从该 Worker 自己的 message_send 回执取得请求 id');
        return mockReply({
          toolCalls: [{
            name: 'wait_for',
            arguments: { reply_to: requestId, kinds: ['reply'], timeout_seconds: 60 },
          }],
        });
      }
      return mockReply({
        toolCalls: [
          {
            name: 'report_to_router',
            arguments: {
              kind: 'progress',
              body: `${workerId} 已读到闭环通知；${text.includes('检测到回复依赖形成闭环') ? '状态可见' : '状态缺失'}`,
            },
          },
          { name: 'wait_for', arguments: { timeout_seconds: 60 } },
        ],
      });
    },
  });
  try {
    const { task, owner } = h.runtime.createTask({
      title: '真实闭环',
      goal: '保留原目标并让模型决定',
      brief: '用户只授权调查，不授权自动判失败',
      ownerRole: '负责人',
      ownerBrief: '协调',
    });
    ownerId = owner.id;
    aId = h.runtime.createCollaborator(owner, '成员 A', '核对 A').workerId!;
    bId = h.runtime.createCollaborator(owner, '成员 B', '核对 B').workerId!;
    h.config.limits.maxConcurrentRuns = 1;
    h.runtime.enqueue(aId);
    for (let attempt = 0; attempt < 600 && h.store.getWorker(ownerId)?.status !== 'waiting'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(h.store.getWorker(ownerId)?.status, 'waiting');
    h.runtime.registerWait(owner, { reason: 'provider', timeoutMs: 60_000 });

    h.config.limits.maxConcurrentRuns = 2;
    h.runtime.enqueue(bId);
    const cycleReports = (): number =>
      h.store.listRecentEvents(task.id, 30).filter((event) =>
        event.type === 'report.progress' &&
        (event.workerId === aId || event.workerId === bId) &&
        (event.detail ?? '').includes('状态可见'),
      ).length;
    for (let attempt = 0; attempt < 600 && cycleReports() < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      cycleReports(),
      2,
      JSON.stringify({
        workers: [h.store.getWorker(aId), h.store.getWorker(bId)],
        events: h.store.listRecentEvents(task.id, 30),
        waits: [
          h.store.listActiveWaitsForWorker(aId),
          h.store.listActiveWaitsForWorker(bId),
        ],
        turns: [
          h.store.listWorkerTurns(aId, 20),
          h.store.listWorkerTurns(bId, 20),
        ],
      }),
    );

    assert.equal(h.store.getTask(task.id)?.status, 'active');
    assert.equal(h.store.getWorker(aId)?.status, 'waiting');
    assert.equal(h.store.getWorker(bId)?.status, 'waiting');
    assert.equal(h.store.getWorker(aId)?.lastError, null);
    assert.equal(h.store.getWorker(bId)?.lastError, null);
    const ownerWaits = h.store.listActiveWaitsForWorker(owner.id);
    assert.equal(
      ownerWaits.some((wait) => wait.reason === 'provider'),
      true,
      JSON.stringify({ owner: h.store.getWorker(owner.id), ownerWaits }),
    );
    assert.equal(
      h.store.listRecentEvents(task.id, 30).filter((event) => ['worker.failed', 'run.cancelled', 'run.stale'].includes(event.type)).length,
      0,
    );
    const reports = h.store.listRecentEvents(task.id, 30).filter((event) =>
      event.type === 'report.progress' &&
      (event.workerId === aId || event.workerId === bId),
    );
    assert.equal(reports.length, 2);
    assert.ok(reports.every((event) => (event.detail ?? '').includes('状态可见')));
  } finally {
    await h.cleanup();
  }
});

test('显式等待 notice 事件可完成等待，默认与回复等待不会被 notice 满足', async () => {
  const h = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = h.runtime.createTask({ title: 't', goal: 'g', ownerRole: '负责人', ownerBrief: '执行' });
    const a = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'a').workerId!)!;
    const wait = h.runtime.registerWait(owner, { kinds: ['notice'], from: a.id, timeoutMs: 60_000 });
    h.store.setWorkerStatus(owner.id, 'waiting');
    assert.equal(h.runtime.sendMessage({ from: a, to: owner.id, kind: 'notice', body: '事件' }).ok, true);
    assert.ok(h.store.listActiveWaitsForWorker(owner.id).every((item) => item.id !== wait.waitId));
  } finally { await h.cleanup(); }
});

test('检查回复与结论原子提交，notice 不改变检查状态', async () => {
  const h = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task, owner } = h.runtime.createTask({ title: 't', goal: 'g', ownerRole: '负责人', ownerBrief: '执行', requireReview: true });
    const helper = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'a').workerId!)!;
    const artifact = h.runtime.saveArtifact(owner, 'report.md', '初稿').artifact;
    const request = h.runtime.sendMessage({ from: owner, to: helper.id, kind: 'request', body: '检查', intent: 'review', refs: { artifacts: [{ artifactId: artifact.id, name: artifact.name, version: artifact.version }] } });
    assert.ok(request.ok, request.reason);
    assert.equal(h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'notice', replyTo: request.messageId, body: '初步发现' }).ok, true);
    assert.equal(h.store.listReviews(task.id)[0]!.outcome, 'pending');
    const original = h.store.answerReview.bind(h.store);
    h.store.answerReview = () => { throw new Error('模拟数据库错误'); };
    assert.throws(() => h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'reply', replyTo: request.messageId, body: '通过', outcome: 'approved' }), /模拟数据库错误/);
    assert.equal(h.store.hasReply(request.messageId!), false);
    assert.equal(h.store.listReviews(task.id)[0]!.outcome, 'pending');
    h.store.answerReview = original;
    assert.equal(h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'reply', replyTo: request.messageId, body: '通过', outcome: 'approved' }).ok, true);
    assert.equal(h.store.listReviews(task.id)[0]!.outcome, 'approved');
    assert.equal(h.runtime.sendMessage({ from: helper, to: owner.id, kind: 'reply', replyTo: request.messageId, body: '重复', outcome: 'approved' }).ok, false);
    h.runtime.saveArtifact(owner, 'report.md', '新版本');
    const observed = observe(h.store, h.config).tasks[0]!;
    assert.equal(observed.approvedReviews, 0);
    assert.ok(observed.stuckSignals.some((item) => item.includes('未获当前要求版本')));
  } finally { await h.cleanup(); }
});
