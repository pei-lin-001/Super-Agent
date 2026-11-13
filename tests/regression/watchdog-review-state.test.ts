import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply, MockModel } from '../../src/model/mock.ts';
import { observe } from '../../src/watchdog/observer.ts';
import { createReviewState, renderReviewContext } from '../../src/watchdog/review-state.ts';
import { WatchdogSession } from '../../src/watchdog/session.ts';

test('Watchdog 首次巡检明确为初始快照，纯步数增长不进入 delta', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({ title: '基线任务', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const first = observe(harness.store, harness.config);
    const initial = renderReviewContext(first, null, []);
    assert.match(initial, /本次是初始快照（没有可用基线）/);
    assert.match(initial, /不表示刚刚新增/);

    const state = createReviewState(first, { id: 'wdt_prev', createdAt: first.generatedAt, content: '上轮结论：等待外部作业。' });
    const changed = structuredClone(first);
    changed.generatedAt = new Date(Date.parse(first.generatedAt) + 1000).toISOString();
    changed.tasks[0]!.workers[0]!.steps += 20;
    const next = renderReviewContext(changed, state, []);
    const delta = next.split('## 当前非终态任务')[0]!;
    assert.match(delta, /未检测到 task\/worker\/wait\/job\/artifact\/review 事实状态变化/);
    assert.doesNotMatch(delta, /step 数字增长不算变化.*Worker/);
    assert.match(next, /read_inspection\(inspection_id="wdt_prev"\)/);
    assert.match(next, /上轮结论：等待外部作业/);

    harness.store.appendWdTurn({ id: 'wdt_prev', role: 'assistant', content: '上轮完整结论：作业未结束时不要重复操作。' });
    assert.match(harness.store.getWatchdogConclusion('wdt_prev')?.content ?? '', /作业未结束时不要重复操作/);
    void created;
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 当前任务始终展示作业事实，作业变化继续进入 delta', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '作业可见性',
      goal: 'g',
      ownerRole: '负责人',
      ownerBrief: 'b',
    });
    const job = harness.runtime.startJob({
      worker: owner,
      taskId: task.id,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: harness.config.workDir,
      stdin: null,
      timeoutMs: 60_000,
    });
    const before = observe(harness.store, harness.config);
    const beforeJob = before.tasks.find((item) => item.id === task.id)?.jobs.find((item) => item.id === job.id);
    assert.ok(beforeJob);
    assert.equal(beforeJob.status, 'running');
    assert.equal(beforeJob.exitCode, null);

    const state = createReviewState(before, null);
    const unchanged = structuredClone(before);
    unchanged.generatedAt = new Date(Date.parse(before.generatedAt) + 1000).toISOString();
    const unchangedText = renderReviewContext(unchanged, state, []);
    const unchangedDelta = unchangedText.split('## 当前非终态任务')[0]!;
    const currentBlock = unchangedText.split('## 当前非终态任务')[1]!.split('## 终态任务')[0]!;
    assert.match(unchangedDelta, /未检测到 task\/worker\/wait\/job\/artifact\/review 事实状态变化/);
    assert.ok(
      currentBlock.includes(`当前作业：${job.id}(${job.command}) running|exit=-`),
      '作业没有发生事实变化时，当前任务块仍应保留它的身份和状态',
    );

    const changed = structuredClone(before);
    changed.generatedAt = new Date(Date.parse(before.generatedAt) + 2000).toISOString();
    const changedJob = changed.tasks.find((item) => item.id === task.id)!.jobs.find((item) => item.id === job.id)!;
    changedJob.status = 'exited';
    changedJob.exitCode = 0;
    changedJob.endedAt = changed.generatedAt;
    const changedText = renderReviewContext(changed, state, []);
    const changedDelta = changedText.split('## 当前非终态任务')[0]!;
    assert.ok(
      changedDelta.includes(
        `作业 ${job.id}：running|exit=-|${job.command} → exited|exit=0|${job.command}`,
      ),
      '作业状态和退出码变化仍应进入事实 delta',
    );
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 依赖带作业状态和截止时间，终态任务遇未解决事件仍保留详情', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '终态引用任务', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    harness.store.createWait({
      id: 'wait_job',
      workerId: owner.id,
      groupId: task.groupId,
      reason: 'job',
      matchFrom: null,
      matchReplyTo: null,
      matchKinds: null,
      matchJob: 'job_missing',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const waiting = observe(harness.store, harness.config);
    const activeText = renderReviewContext(waiting, createReviewState(waiting, null), []);
    assert.match(activeText, /等待：job@.*\[job job_missing\(unknown, exit -\)\]/);

    harness.store.setTaskStatus(task.id, 'completed', { reason: '完成' });
    const issue = [{ id: 'wdi_open', taskId: task.id, title: '交付后仍需观察', note: null }];
    const terminal = observe(harness.store, harness.config);
    const retained = renderReviewContext(terminal, createReviewState(waiting, null), issue);
    assert.match(retained, /因未解决事件|未解决事件引用/);
    assert.match(retained, /终态引用任务/);
    const compact = renderReviewContext(terminal, createReviewState(waiting, null), []);
    assert.doesNotMatch(compact.split('## 上轮完整结论定位')[0]!, /终态引用任务/);
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog delta 保留维护/要求变化，并按 review id 区分同一产物多角度评审', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '评审区分', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', '正文').artifact;
    const before = observe(harness.store, harness.config);
    const state = createReviewState(before, null);

    harness.store.setMaintenance(task.id, true);
    harness.store.bumpReviewEpoch(task.id);
    const now = new Date().toISOString();
    for (const reviewer of ['reviewer_a', 'reviewer_b']) {
      harness.store.createReview({
        id: `review_${reviewer}`,
        taskId: task.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactSha256: artifact.sha256,
        epoch: 1,
        requestedBy: owner.id,
        reviewerId: reviewer,
        requestMessageId: `msg_${reviewer}`,
        replyMessageId: null,
        outcome: 'pending',
        createdAt: now,
      });
    }
    const after = observe(harness.store, harness.config);
    const rendered = renderReviewContext(after, state, []);
    assert.match(rendered, /维护挂起：否 → 是/);
    assert.match(rendered, /要求版本：0 → 1/);
    assert.match(rendered, /检查新增 review_reviewer_a/);
    assert.match(rendered, /检查新增 review_reviewer_b/);
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 周期巡检不重放旧长历史，完整结论可按 id 读取且人工提问保留历史', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  const oldFullConclusion =
    `完整巡检结论开头：${'历史判断与证据。'.repeat(90)}\nOLD_FULL_INSPECTION_MARKER`;
  let firstPrompt = '';
  const firstModel = new MockModel(({ request }) => {
    firstPrompt = request.messages.map((message) => message.content ?? '').join('\n');
    return mockReply({ text: oldFullConclusion });
  });
  try {
    harness.runtime.createTask({ title: '巡检持久化', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    await (new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: firstModel,
      modelName: 'mock',
    })).runOnce(1);
    const inspection = harness.store.getWatchdogConclusion();
    assert.ok(inspection);

    // 模拟旧实现会注入的完整工具流水和动作记录，以及一条仍待回答的 Router 消息。
    for (let index = 0; index < 12; index += 1) {
      harness.store.appendWdTurn({
        id: `wdt_old_tool_${index}`,
        role: 'tool',
        content: `fs_read: OLD_TOOL_LOG_MARKER_${index} ${'旧工具内容'.repeat(80)}`,
      });
    }
    for (let index = 0; index < 6; index += 1) {
      harness.store.appendWdAction({
        id: `wda_old_${index}`,
        issueId: null,
        action: 'inspect',
        reason: `OLD_ACTION_MARKER_${index}`,
        expected: '旧动作不应自动重发',
        result: '旧结果不应自动重发',
      });
    }
    harness.store.insertIntercom({
      id: 'ic_unanswered',
      fromLayer: 'router',
      kind: 'question',
      body: 'UNANSWERED_ROUTER_MARKER：请核实主系统状态',
      sessionKey: 'peer',
      conversationId: 'topic',
      routeKnown: true,
    });

    let periodicPrompt = '';
    let restoredPrompt = '';
    const periodicModel = new MockModel(({ callIndex, request }) => {
      const text = request.messages.map((message) => message.content ?? '').join('\n');
      if (callIndex === 0) {
        periodicPrompt = text;
        return mockReply({
          toolCalls: [{
            name: 'read_inspection',
            arguments: { inspection_id: inspection.id },
          }],
        });
      }
      if (callIndex === 1) {
        restoredPrompt = text;
        return mockReply({ text: '新周期巡检结论' });
      }
      assert.fail(`周期巡检只应调用两次 Mock，实际出现第 ${callIndex + 1} 次`);
    });
    await (new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: periodicModel,
      modelName: 'mock',
    })).runOnce(1);

    assert.match(firstPrompt, /本次是初始快照/);
    assert.equal(periodicModel.calls[0]!.messages.length, 2, '周期巡检只发送稳定 system 与当前快照');
    assert.match(periodicPrompt, /未检测到 task\/worker\/wait\/job\/artifact\/review 事实状态变化/);
    assert.ok(
      periodicPrompt.includes(`read_inspection(inspection_id="${inspection.id}")`),
      '周期请求应只提供按 id 读取完整结论的线索',
    );
    assert.match(periodicPrompt, /UNANSWERED_ROUTER_MARKER/, '未答 Router 消息仍应出现在本次周期请求');
    assert.doesNotMatch(periodicPrompt, /OLD_FULL_INSPECTION_MARKER/, '上轮完整结论不能自动整段重发');
    assert.doesNotMatch(periodicPrompt, /OLD_TOOL_LOG_MARKER/, '旧工具流水不能自动重发');
    assert.doesNotMatch(periodicPrompt, /OLD_ACTION_MARKER/, '旧维护动作不能自动重发');

    assert.match(restoredPrompt, /OLD_FULL_INSPECTION_MARKER/, 'read_inspection 应按 id 返回完整结论');
    assert.equal(harness.store.getWatchdogConclusion(inspection.id)?.content, oldFullConclusion);

    let manualPrompt = '';
    const manualModel = new MockModel(({ request }) => {
      manualPrompt = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '人工提问答复' });
    });
    await (new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: manualModel,
      modelName: 'mock',
    })).ask('人工追问');
    assert.match(manualPrompt, /OLD_FULL_INSPECTION_MARKER/, '人工 ask 仍应保留维护对话历史');
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 基线 JSON 损坏时降级为初始快照并继续巡检', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  let prompt = '';
  try {
    const runtimeDir = join(harness.config.workDir, '.runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'watchdog-review.json'), '{broken json', 'utf8');

    const model = new MockModel(({ request }) => {
      prompt = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '已按当前快照继续巡检' });
    });
    const result = await new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model,
      modelName: 'mock',
    }).runOnce(1);

    assert.match(prompt, /基线警告：上轮巡检基线无法解析/);
    assert.match(prompt, /本次是初始快照（没有可用基线）/);
    assert.equal(result.summary, '已按当前快照继续巡检');
  } finally {
    await harness.cleanup();
  }
});
