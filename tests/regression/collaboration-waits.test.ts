import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, allText } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { observe } from '../../src/watchdog/observer.ts';

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
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
    const { owner } = h.runtime.createTask({ title: 't', goal: 'g', ownerRole: '负责人', ownerBrief: '执行' });
    const a = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'a').workerId!)!;
    const b = h.store.getWorker(h.runtime.createCollaborator(owner, '检查', 'b').workerId!)!;
    const r1 = h.runtime.sendMessage({ from: a, to: b.id, kind: 'request', body: 'a' });
    const r2 = h.runtime.sendMessage({ from: b, to: a.id, kind: 'request', body: 'b' });
    h.runtime.registerWait(a, { replyTo: r1.messageId, kinds: ['reply'], timeoutMs: 60_000 });
    h.runtime.registerWait(b, { replyTo: r2.messageId, kinds: ['reply'], timeoutMs: 60_000 });
    h.runtime.registerWait(owner, { reason: 'provider', timeoutMs: 60_000 });
    for (const member of [owner, a, b]) {
      if (h.store.getWorker(member.id)!.status === 'idle') h.store.setWorkerStatus(member.id, 'queued');
      h.store.setWorkerStatus(member.id, 'waiting');
    }
    h.runtime.recover();
    assert.equal(h.store.listActiveWaitsForWorker(owner.id).length, 1);
    assert.equal(h.store.listActiveWaitsForWorker(a.id).length + h.store.listActiveWaitsForWorker(b.id).length, 1);
    const observation = observe(h.store, h.config);
    assert.ok(observation.tasks[0]!.workers.find((item) => item.id === owner.id)!.waits.some((value) => value.includes('provider')));
  } finally { await h.cleanup(); }
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
