import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, scripted, testConfig } from '../helpers.ts';
import { MockModel, mockReply } from '../../src/model/mock.ts';
import { Router } from '../../src/runtime/router.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';
import type { ChatRequest } from '../../src/model/types.ts';

test('重启恢复：running 转回 waiting 并继续完成，中断被明确记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-recovery-'));
  await mkdir(join(dir, 'work', 'materials'), { recursive: true });

  const config1 = testConfig(dir, { maxConcurrentRuns: 0 });
  const store1 = new Store(config1.dbPath);
  try {
    const runtime1 = new Runtime({
      store: store1,
      config: config1,
      workerModel: new MockModel(() => mockReply({ text: '不应执行' })),
    });
    const { task, owner } = runtime1.createTask({
      title: '恢复测试',
      goal: '验证重启后继续',
      ownerRole: '负责人',
      ownerBrief: '保存产物并交付',
    });
    assert.equal(store1.getWorker(owner.id)!.status, 'queued');
    // 模拟进程在 Worker 执行中崩溃
    store1.db.prepare("UPDATE worker SET status = 'running' WHERE id = ?").run(owner.id);
    store1.db
      .prepare("UPDATE worker SET step_count = 1 WHERE id = ?")
      .run(owner.id);

    const taskId = task.id;
    store1.close();

    const config2 = testConfig(dir, { maxConcurrentRuns: 1 });
    const store2 = new Store(config2.dbPath);
    const workerModel = new MockModel(({ request }: { request: ChatRequest }) => {
      const isFirst = request.messages.filter((message) => message.role === 'assistant').length === 0;
      if (isFirst) {
        return mockReply({
          toolCalls: [{ name: 'artifact_save', arguments: { name: 'resume.md', content: '# 恢复后完成\n' } }],
        });
      }
      return mockReply({
        toolCalls: [{ name: 'submit_result', arguments: { summary: '恢复后完成交付', artifacts: ['resume.md'] } }],
      });
    });
    const runtime2 = new Runtime({ store: store2, config: config2, workerModel });
    const router2 = new Router(runtime2, new MockModel(() => mockReply({ text: '已汇报' })), config2);
    runtime2.attachRouter(router2);

    const recovered = runtime2.recover();
    assert.equal(recovered.interrupted, 1);

    const interruptedNotices = store2
      .listGroupMessages(store2.getTask(taskId)!.groupId)
      .filter((message) => message.kind === 'notice' && message.body.includes('中断'));
    assert.equal(interruptedNotices.length, 1, '恢复时必须留下中断说明，不能假装没发生');

    await runtime2.waitForIdle(10_000);
    const finished = store2.getTask(taskId)!;
    assert.equal(finished.status, 'completed');
    const artifacts = store2.listArtifacts(taskId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.name, 'resume.md');

    await runtime2.stop();
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('等待超时会注入明确提示并唤醒 Worker', async () => {
  const ownerScript = (step: number, request: ChatRequest) => {
    switch (step) {
      case 0:
        return mockReply({
          toolCalls: [{ name: 'create_worker', arguments: { role: '沉默助手', brief: '不回复任何消息' } }],
        });
      case 1: {
        const helper = /已创建协作者 (w\d+_[0-9a-f]+)/.exec(request.messages.at(-1)?.content ?? '')?.[1] ?? '';
        return mockReply({
          toolCalls: [
            { name: 'message_send', arguments: { to: helper, kind: 'request', body: '请回复（预期不会回）' } },
          ],
        });
      }
      case 2:
        return mockReply({
          toolCalls: [{ name: 'wait_for', arguments: { kinds: ['reply'], timeout_seconds: 0.2 } }],
        });
      case 3: {
        const inbox = request.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content ?? '')
          .join('\n');
        assert.match(inbox, /等待已超时/, '超时后应收到明确提示');
        return mockReply({
          toolCalls: [{ name: 'artifact_save', arguments: { name: 'timeout.md', content: '超时后自行推进' } }],
        });
      }
      case 4:
        return mockReply({
          toolCalls: [{ name: 'submit_result', arguments: { summary: '超时后自行完成', artifacts: ['timeout.md'] } }],
        });
      default:
        return mockReply({ text: '结束' });
    }
  };

  const harness = await createHarness({
    worker: scripted({
      负责人: ownerScript,
      沉默助手: () => mockReply({ text: '我收到了，但不回复。' }),
    }),
    limits: { waitTimeoutMs: 150 },
  });

  try {
    const { task } = harness.runtime.createTask({
      title: '超时测试',
      goal: '验证等待超时',
      ownerRole: '负责人',
      ownerBrief: '等待并超时',
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    harness.runtime.tick();
    await harness.runtime.waitForIdle(10_000);

    const finished = harness.store.getTask(task.id)!;
    assert.equal(finished.status, 'completed');
    const notices = harness.store
      .listGroupMessages(task.groupId)
      .filter((message) => message.body.includes('等待已超时'));
    assert.equal(notices.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('重复发送同一去重键只落一条消息', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '待命' }) });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '去重测试',
      goal: '验证幂等',
      ownerRole: '负责人',
      ownerBrief: '发送消息',
    });
    const helper = harness.runtime.createCollaborator(owner, '助手', '待命');
    assert.equal(helper.ok, true);

    const first = harness.runtime.sendMessage({
      from: owner,
      to: helper.workerId!,
      kind: 'request',
      body: '请核对',
      dedupeKey: 'verify-1',
    });
    const second = harness.runtime.sendMessage({
      from: owner,
      to: helper.workerId!,
      kind: 'request',
      body: '请核对（重试）',
      dedupeKey: 'verify-1',
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.messageId, second.messageId);

    const requests = harness.store
      .listGroupMessages(task.groupId)
      .filter((message) => message.kind === 'request');
    assert.equal(requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});
