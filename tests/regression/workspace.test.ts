/**
 * 工作空间：任务的长期容器。
 *
 * 要证明三件事：
 * 1) 建任务时空间被创建，归属固化在创建时的话题上；
 * 2) 空间列表按会话隔离，CLI 与聊天、聊天与聊天互不串；
 * 3) 一个空间可以接第二个任务（复用成员而不是重建）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });
const WX_KEY = sessionKeyOf({ channel: 'weixin', accountId: 'wx_1', peerId: 'owner-2' });
const brief = { ownerRole: '执行者', ownerBrief: '把活干完' };

test('工作空间：建任务时自动建，归属固化在创建时的话题', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task } = harness.runtime.createTask({
      ...brief,
      title: '工作空间 A',
      goal: 'g',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY, conversationId: 'cv_1' },
    });
    const space = harness.store.getWorkspace(task.groupId);
    assert.ok(space, '建任务必须同时建出空间');
    assert.equal(space!.id, task.workspaceId);
    assert.equal(space!.sessionKey, TG_KEY);
    assert.equal(space!.conversationId, 'cv_1', '归属在创建时固化，之后不随轮次变');

    // 另一个话题引用过的空间不会被算进它的可见范围
    const other = harness.store.listWorkspacesForConversation(TG_KEY, 'cv_other');
    assert.ok(!other.some((item) => item.id === space!.id), '别的话题不该看到这个空间');

    const same = harness.store.listWorkspacesForConversation(TG_KEY, 'cv_1');
    assert.ok(same.some((item) => item.id === space!.id));
  } finally {
    await harness.cleanup();
  }
});

test('工作空间：CLI 与聊天、聊天与聊天互不串', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const tg = harness.runtime.createTask({
      ...brief, title: '聊天任务', goal: 'g',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    const wx = harness.runtime.createTask({
      ...brief, title: '另一个聊天', goal: 'g',
      source: { channel: 'weixin', accountId: 'wx_1', peerId: 'owner-2', sessionKey: WX_KEY },
    });
    const cli = harness.runtime.createTask({ ...brief, title: 'CLI 任务', goal: 'g' });

    const tgSpaces = harness.store.listWorkspacesForConversation(TG_KEY, null).map((item) => item.id);
    assert.ok(tgSpaces.includes(tg.task.groupId));
    assert.ok(!tgSpaces.includes(wx.task.groupId), '别的聊天不能串进来');
    assert.ok(!tgSpaces.includes(cli.task.groupId), 'CLI 不能串进来');

    const cliSpaces = harness.store.listWorkspacesForConversation(null, null).map((item) => item.id);
    assert.ok(cliSpaces.includes(cli.task.groupId));
    assert.ok(!cliSpaces.includes(tg.task.groupId));
  } finally {
    await harness.cleanup();
  }
});

test('工作空间：下一个任务可以复用成员，不必重建', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const first = harness.runtime.createTask({ ...brief, title: '第一个任务', goal: 'g' });
    const spaceId = first.task.groupId;
    const second = harness.runtime.createTask({
      ...brief, title: '第二个任务', goal: 'g', workspaceId: spaceId,
    });
    assert.equal(second.task.workspaceId, spaceId, '新任务要落进指定空间');
    assert.notEqual(second.task.groupId, first.task.groupId, '每个任务仍有自己的 group');

    const members = harness.store.listGroupWorkers(spaceId);
    assert.ok(members.length >= 2, '空间里应该有两个任务的成员');
    assert.ok(members.every((member) => member.workspaceId === spaceId), '成员都挂在空间上');
  } finally {
    await harness.cleanup();
  }
});

test('成员限制：任务完成后成员休眠，同职责不能重复创建', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task, owner } = harness.runtime.createTask({ ...brief, title: 't', goal: 'g' });
    // 模拟任务完成后的收敛：成员进入休眠，空间还在
    harness.store.setWorkerStatus(owner.id, 'dormant', '任务已完成');
    harness.store.setWorkerCurrentTask(owner.id, null);

    const dormant = harness.store.listDormantWorkers(task.groupId);
    assert.equal(dormant.length, 1, '任务结束后成员应当休眠而不是消失');
    assert.equal(dormant[0]!.currentTaskId, null, '休眠时不该还挂着任务');

    // 同职责再建一个：应当被拒
    const dup = harness.runtime.createCollaborator(owner, brief.ownerRole, '再做一遍');
    assert.equal(dup.ok, false, '同职责不能重复创建');
    assert.match(dup.reason ?? '', /职责相同/);

    // 不同职责可以
    const other = harness.runtime.createCollaborator(owner, '独立检查', '核对产物');
    assert.equal(other.ok, true, `不同职责应当放行（${other.reason ?? ''}）`);
  } finally {
    await harness.cleanup();
  }
});

test('成员限制：达到空间上限后拒绝创建，提示用现有成员', async () => {
  const harness = await createHarness({ limits: { maxWorkersPerGroup: 2 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = harness.runtime.createTask({ ...brief, title: 't', goal: 'g' });
    // 负责人已经占一个名额，再加一个就到上限
    const first = harness.runtime.createCollaborator(owner, '第一个', 'b');
    assert.equal(first.ok, true, `负责人 + 1 应该还能进（${first.reason ?? ''}）`);
    const second = harness.runtime.createCollaborator(owner, '第二个', 'b');
    assert.equal(second.ok, false, '上限 2 时，再拉一个人就该被拦');
    assert.match(second.reason ?? '', /达到上限/);
    assert.match(second.reason ?? '', /归档|派给已有/, '要给出可执行的下一步');
  } finally {
    await harness.cleanup();
  }
});

test('分类：空间少时不调决策模型，多时才用，且低置信度退回新建', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    // 少于 4 个空间：不该调分类器
    let calls = 0;
    const fake = {
      client: {
        choose: async () => {
          calls += 1;
          return { choice: 'x', confidence: 0.99, probabilities: {}, usage: null };
        },
      } as never,
      model: 'clef',
    };
    const { Router } = await import('../../src/runtime/router.ts');
    const router = new Router(harness.runtime, harness.routerModel, harness.config, { classifier: fake });
    harness.runtime.createTask({ ...brief, title: 't', goal: 'g' });
    const picked = await router.pickWorkspace({ title: 'x', goal: 'y', sessionKey: null, conversationId: null });
    assert.equal(picked, null, '空间太少时不该调分类器');
    assert.equal(calls, 0, '一次调用都不该发');

    // 造够 4 个空间后再试：低置信度应当退回 null（新建）
    for (let index = 0; index < 4; index += 1) {
      harness.runtime.createTask({ ...brief, title: `空间 ${index}`, goal: 'g' });
    }
    const low = {
      client: { choose: async () => ({ choice: 'whatever', confidence: 0.2, probabilities: {}, usage: null }) } as never,
      model: 'clef',
    };
    const router2 = new Router(harness.runtime, harness.routerModel, harness.config, { classifier: low });
    const unsure = await router2.pickWorkspace({ title: 'x', goal: 'y', sessionKey: null, conversationId: null });
    assert.equal(unsure, null, '置信度不足时不要硬选一个空间');
  } finally {
    await harness.cleanup();
  }
});

test('唤醒：休眠成员接到新任务，旧结论作废但环境知识保留', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const first = harness.runtime.createTask({ ...brief, title: '第一个任务', goal: 'g1' });
    const spaceId = first.task.groupId;
    // 第一个任务结束后成员休眠
    harness.store.setWorkerStatus(first.owner.id, 'dormant', '任务已完成');
    harness.store.setWorkerCurrentTask(first.owner.id, null);

    const second = harness.runtime.createTask({
      ...brief, title: '第二个任务', goal: 'g2', workspaceId: spaceId,
    });
    const wake = harness.runtime.wakeWorker({
      workerId: first.owner.id,
      taskId: second.task.id,
      brief: '接手第二个任务',
    });
    assert.equal(wake.ok, true, wake.reason);

    const after = harness.store.getWorker(first.owner.id)!;
    assert.equal(after.status, 'queued', '唤醒后要重新排进调度');
    assert.equal(after.currentTaskId, second.task.id, '要指向新任务');
    assert.match(after.brief, /接手第二个任务/, '职责说明要换成新的');

    // 旧结论作废这条必须写进它能看到的地方
    const inbox = harness.store.listInbox(first.owner.id);
    const notice = inbox.find((message) => message.body.includes('一律作废'));
    assert.ok(notice, '唤醒通知必须写明旧任务结论不作废');
    assert.match(notice!.body, /环境知识/, '同时要说清什么可以复用');
  } finally {
    await harness.cleanup();
  }
});

test('唤醒：同空间限制——不同空间的成员不能接这个任务', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const a = harness.runtime.createTask({ ...brief, title: 'A', goal: 'g' });
    const b = harness.runtime.createTask({ ...brief, title: 'B', goal: 'g' });
    harness.store.setWorkerStatus(a.owner.id, 'dormant', '完成');
    const wake = harness.runtime.wakeWorker({
      workerId: a.owner.id, taskId: b.task.id, brief: 'x',
    });
    assert.equal(wake.ok, false);
    assert.match(wake.reason ?? '', /不在同一个工作空间/);
  } finally {
    await harness.cleanup();
  }
});

test('唤醒工具：worker 能叫醒同空间的休眠成员，跨空间被拒', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const first = harness.runtime.createTask({ ...brief, title: '第一个', goal: 'g' });
    const spaceId = first.task.groupId;
    const sleeper = first.owner;
    harness.store.setWorkerStatus(sleeper.id, 'dormant', '任务完成');
    harness.store.setWorkerCurrentTask(sleeper.id, null);

    const second = harness.runtime.createTask({ ...brief, title: '第二个', goal: 'g', workspaceId: spaceId });
    // 用第二个任务的负责人作为调用者
    const caller = harness.store.getWorker(second.owner.id)!;
    const ok = harness.runtime.wakeWorkerFor({
      worker: caller, workerId: sleeper.id, taskId: second.task.id, brief: '接着做同类工作',
    });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(harness.store.getWorker(sleeper.id)?.status, 'queued');
    assert.equal(harness.store.getWorker(sleeper.id)?.currentTaskId, second.task.id);

    // 跨空间：另一个工作空间的成员不能被叫
    const other = harness.runtime.createTask({ ...brief, title: '别的空间', goal: 'g' });
    const cross = harness.runtime.wakeWorkerFor({
      worker: harness.store.getWorker(other.owner.id)!, workerId: sleeper.id, taskId: other.task.id, brief: 'x',
    });
    assert.equal(cross.ok, false);
    assert.match(cross.reason ?? '', /本工作空间/);
  } finally {
    await harness.cleanup();
  }
});

test('工作空间表单：休眠成员带 id，Router 才知道叫醒谁', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = harness.runtime.createTask({ ...brief, title: 't', goal: 'g' });
    harness.store.setWorkerStatus(owner.id, 'dormant', '完成');
    harness.store.setWorkerCurrentTask(owner.id, null);

    const form = (harness.router as unknown as { renderWorkspaces: (s: string | null, c: string | null) => string })
      .renderWorkspaces(null, null);
    assert.match(form, /可唤醒/, '休眠成员要能被看见');
    assert.match(form, new RegExp(owner.id), '要给出成员 id，否则没法唤醒');
  } finally {
    await harness.cleanup();
  }
});

test('图片：当轮进 Router 上下文，下一轮不重发 base64', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const png = { mimeType: 'image/png', data: 'QUJD' };
    await harness.router.handleUserMessage('这张图是什么', { images: [png] });

    const first = harness.routerModel.calls.at(-1)!;
    const userTurn = first.messages.filter((m) => m.role === 'user').at(-1)!;
    assert.deepEqual(userTurn.images, [png], '当轮要带上图');

    // 再问一句（不带图）：历史里的那条不能再拖着 base64。
    await harness.router.handleUserMessage('继续');
    const second = harness.routerModel.calls.at(-1)!;
    const leaked = second.messages.filter((m) => m.role === 'user' && m.images && m.images.length > 0);
    assert.equal(leaked.length, 0, '图片不能留在历史里每轮重发');
  } finally {
    await harness.cleanup();
  }
});

test('取消任务不销毁同空间里休眠的成员', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const first = harness.runtime.createTask({ ...brief, title: '第一个', goal: 'g' });
    const spaceId = first.task.groupId;
    // 第一个任务做完，成员休眠
    harness.store.setWorkerStatus(first.owner.id, 'dormant', '任务完成');
    harness.store.setWorkerCurrentTask(first.owner.id, null);

    // 第二个任务被取消
    const second = harness.runtime.createTask({ ...brief, title: '第二个', goal: 'g', workspaceId: spaceId });
    harness.runtime.stopTask(second.task.id, "测试取消");

    assert.equal(
      harness.store.getWorker(first.owner.id)?.status,
      'dormant',
      '取消一个任务不该把上一个任务留下的待命成员一起销毁',
    );
    // 正在跑的成员由它自己在下一个检查点退出，这里只验证休眠的没被殃及。
    assert.equal(harness.store.getTask(second.task.id)?.status, 'cancelled');
  } finally {
    await harness.cleanup();
  }
});

test('休眠成员不参与调度，也不会被「任务已结束」收掉', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const first = harness.runtime.createTask({ ...brief, title: '第一个', goal: 'g' });
    harness.store.setWorkerStatus(first.owner.id, 'dormant', '任务完成');
    harness.store.setWorkerCurrentTask(first.owner.id, null);

    // 调度入口不该把它捞起来（醒来时会先转 queued）
    harness.runtime.enqueue(first.owner.id);
    assert.equal(
      harness.store.getWorker(first.owner.id)?.status,
      'dormant',
      '休眠成员不能被直接排进调度，否则 dormant→running 是非法迁移',
    );

    // 恢复流程遇到任务已结束的休眠成员应当跳过，而不是转 cancelled
    harness.runtime.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      harness.store.getWorker(first.owner.id)?.status,
      'dormant',
      '恢复不该把休眠成员当成「任务已结束」收掉',
    );
  } finally {
    await harness.cleanup();
  }
});

test('「先落草稿」的提醒跨轮只发一次', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task, owner } = harness.runtime.createTask({ ...brief, title: '长任务', goal: 'g' });
    const first = harness.runtime.nudgeMissingArtifact(owner.id, task.id);
    const second = harness.runtime.nudgeMissingArtifact(owner.id, task.id);
    assert.equal(first, true, '第一次该提醒');
    assert.equal(second, false, '换一轮不该再提醒');

    const nudges = harness.store
      .listEvents(task.id, 2000)
      .filter((event) => event.type === 'worker.no_artifact');
    assert.equal(nudges.length, 1, '同一成员只该被提醒一次，换轮不能重复');
  } finally {
    await harness.cleanup();
  }
});
