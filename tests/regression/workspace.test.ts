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
