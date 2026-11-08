import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, scripted } from '../helpers.ts';
import { mockError, mockReply, type MockHandler } from '../../src/model/mock.ts';
import type { ChatRequest } from '../../src/model/types.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('并行任务互不串组，Router 在后台工作期间仍可响应新消息', async () => {
  const router: MockHandler = ({ callIndex }) => {
    if (callIndex === 0) {
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '任务甲',
              goal: '处理甲',
              owner_role: '负责人甲',
              owner_brief: '完成甲',
            },
          },
        ],
      });
    }
    if (callIndex === 1) {
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '任务乙',
              goal: '处理乙',
              owner_role: '负责人乙',
              owner_brief: '完成乙',
            },
          },
        ],
      });
    }
    return mockReply({ text: `收到第 ${callIndex} 条输入，后台任务继续运行。` });
  };

  const makeOwner = (name: string) => (_step: number, _request: ChatRequest) => {
    // 故意放慢，制造后台运行窗口
    return delay(60).then(() =>
      mockReply({
        toolCalls: [
          {
            name: 'artifact_save',
            arguments: { name: `${name}.md`, content: `# ${name}\n内容` },
          },
        ],
      }),
    );
  };

  let stepA = 0;
  let stepB = 0;
  const harness = await createHarness({
    router,
    worker: scripted({
      负责人甲: (step, request) => {
        if (step === 0) return makeOwner('甲')(step, request);
        if (step === 1) {
          return mockReply({
            toolCalls: [
              {
                name: 'submit_result',
                arguments: { summary: '甲完成', artifacts: ['甲.md'] },
              },
            ],
          });
        }
        return mockReply({ text: '甲结束' });
      },
      负责人乙: (step, request) => {
        if (step === 0) return makeOwner('乙')(step, request);
        if (step === 1) {
          return mockReply({
            toolCalls: [
              {
                name: 'submit_result',
                arguments: { summary: '乙完成', artifacts: ['乙.md'] },
              },
            ],
          });
        }
        return mockReply({ text: '乙结束' });
      },
    }),
    limits: { maxConcurrentRuns: 2 },
  });

  try {
    await harness.router.handleUserMessage('做甲');
    // 后台仍在跑时，用户又发来一条消息
    await harness.router.handleUserMessage('做乙');
    await harness.router.handleUserMessage('现在进度如何？');
    await harness.runtime.waitForIdle(15_000);

    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.status === 'completed'));

    const [first, second] = tasks;
    assert.notEqual(first!.groupId, second!.groupId);

    const groupOne = harness.store.listGroupMessages(first!.groupId);
    const groupTwo = harness.store.listGroupMessages(second!.groupId);
    assert.ok(groupOne.every((message) => message.groupId === first!.groupId));
    assert.ok(groupTwo.every((message) => message.groupId === second!.groupId));
    assert.ok(!groupOne.some((message) => message.body.includes('乙')));
    assert.ok(!groupTwo.some((message) => message.body.includes('甲')));

    const artifactsOne = harness.store.listArtifacts(first!.id);
    const artifactsTwo = harness.store.listArtifacts(second!.id);
    assert.equal(artifactsOne[0]!.name, '甲.md');
    assert.equal(artifactsTwo[0]!.name, '乙.md');

    // 用户的三条输入都得到了 Router 回复
    const routerTurns = harness.store.listRouterTurns(50).filter((turn) => turn.role === 'assistant');
    assert.ok(routerTurns.length >= 3);
    void stepA;
    void stepB;
  } finally {
    await harness.cleanup();
  }
});

test('等待让出执行名额：并发为 1 时协作者仍能运行并唤醒负责人', async () => {
  let collaborator = '';
  const ownerScript = (step: number, request: ChatRequest) => {
    switch (step) {
      case 0:
        return mockReply({
          toolCalls: [{ name: 'create_worker', arguments: { role: '助手', brief: '回复负责人' } }],
        });
      case 1: {
        const match = /已创建协作者 (w\d+_[0-9a-f]+)/.exec(
          request.messages.at(-1)?.content ?? '',
        );
        collaborator = match?.[1] ?? '';
        return mockReply({
          toolCalls: [
            {
              name: 'message_send',
              arguments: { to: collaborator, kind: 'request', body: '请确认收到' },
            },
          ],
        });
      }
      case 2:
        return mockReply({
          toolCalls: [{ name: 'wait_for', arguments: { from: collaborator, kinds: ['reply'], timeout_seconds: 5 } }],
        });
      case 3: {
        const inbox = request.messages.filter((message) => message.role === 'user').map((message) => message.content ?? '').join('\n');
        assert.match(inbox, /已确认/, '负责人应拿到协作者的回复');
        return mockReply({
          toolCalls: [{ name: 'artifact_save', arguments: { name: 'out.md', content: '完成' } }],
        });
      }
      case 4:
        return mockReply({
          toolCalls: [{ name: 'submit_result', arguments: { summary: '完成', artifacts: ['out.md'] } }],
        });
      default:
        return mockReply({ text: '结束' });
    }
  };

  const helperScript = (_step: number, request: ChatRequest) => {
    const inbox = request.messages.filter((message) => message.role === 'user').map((message) => message.content ?? '').join('\n');
    const messageId = /\[(msg_[0-9a-f]+)\]/.exec(inbox)?.[1] ?? '';
    const ownerId = /来自 (w\d+_[0-9a-f]+)/.exec(inbox)?.[1] ?? '';
    return mockReply({
      toolCalls: [
        {
          name: 'message_send',
          arguments: { to: ownerId, kind: 'reply', reply_to: messageId, body: '已确认，数据无误。' },
        },
      ],
    });
  };

  let routerStep = 0;
  const harness = await createHarness({
    router: () => {
      if (routerStep++ === 0) {
        return mockReply({
          toolCalls: [
            {
              name: 'create_task',
              arguments: {
                title: '等待测试',
                goal: '验证等待不占名额',
                owner_role: '负责人',
                owner_brief: '组织并交付',
              },
            },
          ],
        });
      }
      return mockReply({ text: '已安排。' });
    },
    worker: scripted({ 负责人: ownerScript, 助手: helperScript }),
    limits: { maxConcurrentRuns: 1, waitTimeoutMs: 5000 },
  });

  try {
    await harness.router.handleUserMessage('跑一下等待场景');
    await harness.runtime.waitForIdle(15_000);

    const task = harness.store.listTasks()[0]!;
    if (task.status !== 'completed') {
      for (const w of harness.runtime.listGroupWorkers(task.groupId)) {
        console.log('worker', w.id, w.role, w.status, w.stepCount, w.lastError);
        for (const t of harness.store.listWorkerTurns(w.id, 30)) {
          console.log('  turn', t.seq, t.role, (t.content ?? '').slice(0, 120));
        }
      }
      for (const m of harness.store.listGroupMessages(task.groupId)) {
        console.log('msg', m.kind, m.fromId, '->', m.toId, m.status, 'replyTo', m.replyTo);
      }
    }
    assert.equal(task.status, 'completed');

    const workers = harness.runtime.listGroupWorkers(task.groupId);
    const owner = workers.find((worker) => worker.id === task.ownerWorkerId)!;
    const helper = workers.find((worker) => worker.id !== task.ownerWorkerId)!;
    assert.ok(helper.stepCount > 0, '并发为 1 时协作者仍应获得执行机会');
    assert.equal(owner.status, 'done');
  } finally {
    await harness.cleanup();
  }
});

test('配额：群组 Worker 数量与请求跳数有上限', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '待命' }),
    limits: { maxWorkersPerGroup: 2, maxRequestHops: 2 },
  });

  try {
    const { task, owner } = harness.runtime.createTask({
      title: '配额测试',
      goal: '验证上限',
      ownerRole: '负责人',
      ownerBrief: '测试',
    });

    const first = harness.runtime.createCollaborator(owner, '助手一', '测试');
    const second = harness.runtime.createCollaborator(owner, '助手二', '测试');
    assert.equal(first.ok, true);
    assert.equal(second.ok, false, '第三人应被组内上限拒绝');
    assert.match(second.reason ?? '', /上限/);

    const helper = harness.store.getWorker(first.workerId!)!;
    const request = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'request',
      body: '第一跳',
    });
    assert.equal(request.ok, true);

    const reply = harness.runtime.sendMessage({
      from: helper,
      to: owner.id,
      kind: 'reply',
      body: '回复',
      replyTo: request.messageId!,
    });
    assert.equal(reply.ok, true);

    const secondRequest = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'request',
      body: '第二跳',
    });
    assert.equal(secondRequest.ok, true);

    const secondReply = harness.runtime.sendMessage({
      from: helper,
      to: owner.id,
      kind: 'reply',
      body: '回复二（挂到第二跳请求）',
      replyTo: secondRequest.messageId!,
    });
    assert.equal(secondReply.ok, true);

    const thirdRequest = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'request',
      body: '第三跳',
      replyTo: secondReply.messageId!,
    });
    assert.equal(thirdRequest.ok, true);

    const thirdReply = harness.runtime.sendMessage({
      from: helper,
      to: owner.id,
      kind: 'reply',
      body: '回复三',
      replyTo: thirdRequest.messageId!,
    });
    assert.equal(thirdReply.ok, true);

    const followUp = harness.runtime.sendMessage({
      from: helper,
      to: owner.id,
      kind: 'request',
      body: '第四跳追问',
      replyTo: thirdReply.messageId!,
    });
    assert.equal(followUp.ok, false, '超过跳数上限应被拒绝');
    assert.match(followUp.reason ?? '', /上限/);

    const selfMessage = harness.runtime.sendMessage({
      from: owner,
      to: owner.id,
      kind: 'request',
      body: '给自己',
    });
    assert.equal(selfMessage.ok, false);

    void task;
  } finally {
    await harness.cleanup();
  }
});

test('失败路径：模型报错导致 Worker 与任务明确失败，并向 Router 汇报', async () => {
  const harness = await createHarness({
    worker: () => mockError('模拟模型 500'),
    limits: { modelRetry: 0 },
  });

  try {
    const { task } = harness.runtime.createTask({
      title: '必失败任务',
      goal: '验证失败可见',
      ownerRole: '负责人',
      ownerBrief: '会失败',
    });
    await harness.runtime.waitForIdle(10_000);

    const updated = harness.store.getTask(task.id)!;
    assert.equal(updated.status, 'failed');
    assert.match(updated.closeReason ?? '', /模拟模型 500/);

    const reports = harness.store
      .listGroupMessages(task.groupId, 100)
      .filter((message) => message.kind === 'fail' && message.toKind === 'router');
    assert.ok(reports.length >= 1, '失败必须上报 Router，不能静默消失');

    const worker = harness.store.getWorker(task.ownerWorkerId!)!;
    assert.equal(worker.status, 'failed');
    assert.match(worker.lastError ?? '', /模拟模型 500/);
  } finally {
    await harness.cleanup();
  }
});

test('停止任务：取消后不再产生新的工具动作，迟到回复不能复活任务', async () => {
  let calls = 0;
  const harness = await createHarness({
    worker: () => {
      calls += 1;
      return delay(40).then(() =>
        mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: '.' } }] }),
      );
    },
    limits: { maxStepsPerRun: 50, maxStepsPerWorker: 200 },
  });

  try {
    const { task } = harness.runtime.createTask({
      title: '可取消任务',
      goal: '验证取消',
      ownerRole: '负责人',
      ownerBrief: '持续干活',
    });
    await delay(80);
    assert.ok(calls > 0);

    const stopped = await harness.runtime.stopTask(task.id, '用户要求停止');
    assert.equal(stopped, true);
    const callsAtStop = calls;
    await delay(120);
    assert.ok(calls <= callsAtStop + 1, `取消后不应继续调用模型，实际 ${calls} vs ${callsAtStop}`);
    await harness.runtime.waitForIdle(5000);

    const finished = harness.store.getTask(task.id)!;
    assert.equal(finished.status, 'cancelled');

    const late = harness.runtime.sendRouterMessage({
      taskId: task.id,
      workerId: finished.ownerWorkerId!,
      kind: 'update',
      body: '迟到的补充要求',
    });
    assert.equal(late.ok, false);
    assert.equal(harness.store.getTask(task.id)!.status, 'cancelled');
  } finally {
    await harness.cleanup();
  }
});
