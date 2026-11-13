import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import { formatTaskUsage } from '../../src/ui/usage.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot', peerId: 'owner' });

test('任务用量无 LIMIT 截断，区分已知零/未知，并严格隔离话题', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({
      title: '用量统计',
      goal: 'g',
      ownerRole: '负责人',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot', peerId: 'owner', sessionKey: TG_KEY, conversationId: 'topic-a' },
    });
    const taskId = created.task.id;
    const finish = (
      id: string,
      purpose: 'worker' | 'note' | 'router' | 'router-note' | 'watchdog',
      usage: { promptTokens: number; completionTokens: number } | null,
      options: { conversationId?: string | null } = {},
    ): void => {
      harness.store.startModelCall({
        id,
        purpose,
        model: 'mock',
        taskId: purpose === 'worker' || purpose === 'note' ? taskId : null,
        workerId: purpose === 'worker' || purpose === 'note' ? created.owner.id : null,
        routerSessionKey: purpose === 'router' || purpose === 'router-note' ? TG_KEY : null,
        conversationId: options.conversationId ?? null,
      });
      harness.store.finishModelCall({ id, status: 'ok', usage });
    };

    for (let index = 0; index < 58; index += 1) {
      finish(`mc_worker_${index}`, 'worker', { promptTokens: 1, completionTokens: 2 });
    }
    finish('mc_zero', 'worker', { promptTokens: 0, completionTokens: 0 });
    finish('mc_unknown', 'worker', null);
    finish('mc_note', 'note', { promptTokens: 3, completionTokens: 4 });

    finish('mc_router_a', 'router', { promptTokens: 5, completionTokens: 6 }, { conversationId: 'topic-a' });
    finish('mc_router_note_a', 'router-note', { promptTokens: 7, completionTokens: 8 }, { conversationId: 'topic-a' });
    finish('mc_router_b', 'router', { promptTokens: 100, completionTokens: 100 }, { conversationId: 'topic-b' });
    finish('mc_router_null', 'router', { promptTokens: 200, completionTokens: 200 }, { conversationId: null });
    finish('mc_watchdog_1', 'watchdog', { promptTokens: 9, completionTokens: 10 });
    finish('mc_watchdog_unknown', 'watchdog', null);

    const usage = harness.store.taskUsage(taskId);
    assert.ok(usage);
    const worker = usage.direct.find((bucket) => bucket.purpose === 'worker');
    assert.ok(worker);
    assert.equal(worker.calls, 60, '不能沿用 listModelCalls 默认 50 条上限');
    assert.equal(worker.usageKnownCalls, 59);
    assert.equal(worker.explicitZeroCalls, 1);
    assert.equal(worker.usageUnknownCalls, 1);
    assert.equal(worker.promptTokens, 58);
    assert.equal(worker.completionTokens, 116);

    assert.deepEqual(usage.routerContext.map((bucket) => bucket.purpose), ['router', 'router-note']);
    assert.equal(usage.routerContext.find((bucket) => bucket.purpose === 'router')?.calls, 1, '其他话题和空话题不能串入');
    assert.equal(usage.watchdogContext[0]?.calls, 2);
    assert.equal(usage.watchdogContext[0]?.usageUnknownCalls, 1);

    const rendered = formatTaskUsage(usage);
    assert.match(rendered, /任务直接归属调用.*不受上述时间窗截断/s);
    assert.match(rendered, /明确为 0：1 次/);
    assert.match(rendered, /usage 未知 1 次/);
    assert.match(rendered, /同期 Router.*非 task_id 直接归属/s);
    assert.match(rendered, /同期 Watchdog（全局调用，不属于该任务）/);
    assert.match(rendered, /任务记录存续窗口，排除建任务前与交付后调用/);
  } finally {
    await harness.cleanup();
  }
});
