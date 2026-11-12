import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../../src/storage/store.ts';

function withStore(body: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sa-intercom-'));
  const store = new Store(join(dir, 'agent.db'));
  try {
    body(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('通道：发给某一层的消息只出现在那一层的待办里', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_a', fromLayer: 'router', kind: 'notice', body: '用户说系统卡了' });
    store.insertIntercom({ id: 'ic_b', fromLayer: 'watchdog', kind: 'notice', body: '我重启过主系统' });

    assert.deepEqual(store.listPendingIntercom('watchdog').map((m) => m.id), ['ic_a']);
    assert.deepEqual(store.listPendingIntercom('router').map((m) => m.id), ['ic_b']);
  });
});

test('通道：投递过一次就不再出现在待办里，避免重复注入撑爆上下文', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_a', fromLayer: 'router', kind: 'notice', body: '一条通报' });
    assert.equal(store.listPendingIntercom('watchdog').length, 1);

    store.markIntercomDelivered('ic_a');
    assert.equal(store.listPendingIntercom('watchdog').length, 0, '已投递的不再重复给');
    // notice 投递即终结：没人会回复它，留在 delivered 只会被反复注入。
    assert.equal(store.getIntercom('ic_a')?.status, 'consumed');
  });
});

test('通道：回复把原消息标记为已答复，且 reply 带上跳数与话题', () => {
  withStore((store) => {
    store.insertIntercom({ id: 'ic_q', fromLayer: 'router', kind: 'question', body: '重启过吗', topicId: 'ic_q' });
    const original = store.getIntercom('ic_q')!;

    store.insertIntercom({
      id: 'ic_r',
      fromLayer: 'watchdog',
      kind: 'reply',
      body: '重启过，两次',
      topicId: original.topicId ?? original.id,
      replyTo: original.id,
      hops: original.hops + 1,
    });
    store.consumeIntercom(original.id);

    const reply = store.getIntercom('ic_r')!;
    assert.equal(reply.replyTo, 'ic_q');
    assert.equal(reply.topicId, 'ic_q', '同一话题串成一条链');
    assert.equal(reply.hops, 1);
    assert.equal(store.getIntercom('ic_q')?.status, 'answered');
  });
});

test('通道：过期的消息不再投递', () => {
  withStore((store) => {
    // 负数 TTL 让它当场过期。
    store.insertIntercom({ id: 'ic_old', fromLayer: 'router', kind: 'notice', body: '旧消息', ttlMs: -1000 });
    assert.equal(store.listPendingIntercom('watchdog').length, 0, '过期的不该被取出来');
    store.expireIntercom();
    assert.equal(store.getIntercom('ic_old')?.status, 'expired');
  });
});

test('维护者状态：只给可核对的事实，不给推测', () => {
  withStore((store) => {
    store.appendWdAction({
      id: 'wda_1',
      issueId: 'wdi_1',
      commandId: null,
      action: 'restart_main',
      reason: '代码需要生效',
      expected: '主系统重启',
      result: '成功',
    } as never);
    const status = store.maintainerStatus();
    assert.ok(status.lastRestartAt !== null, '重启记录要能读到');
    assert.deepEqual(status.openIssues, [], '没有未解决事件时是空数组，不是 null');
    assert.ok(Array.isArray(status.recentCommands));
  });
});
