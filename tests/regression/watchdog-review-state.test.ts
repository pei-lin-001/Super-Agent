import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply, MockModel } from '../../src/model/mock.ts';
import {
  decideModelReview,
  observe,
  type ModelReviewGateState,
} from '../../src/watchdog/observer.ts';
import { createReviewState, renderReviewContext } from '../../src/watchdog/review-state.ts';
import { WatchdogSession } from '../../src/watchdog/session.ts';

test('Watchdog 语义巡检 gate：本地 tick 不调模型，活跃/空闲按各自间隔触发', () => {
  const now = Date.parse('2026-11-13T08:00:00.000Z');
  const state: ModelReviewGateState = {
    incidentSignature: null,
    incidentReviewedAt: 0,
    dueIssueAttempts: {},
    routerMessageBatch: null,
    routerMessageFailedAt: 0,
  };
  const check = (input: {
    active: boolean;
    lastModelReviewAt: number;
    at?: number;
  }) => decideModelReview({
    now: input.at ?? now,
    active: input.active,
    lastModelReviewAt: input.lastModelReviewAt,
    baselineAt: '2026-11-13T08:00:00.000Z',
    activeIntervalMs: 600_000,
    idleIntervalMs: 1_800_000,
    pendingRouterMessages: 0,
    dueIssues: [],
    health: { state: 'alive', pid: 42, identity: 'match' },
    state,
  });

  for (let elapsed = 10_000; elapsed < 600_000; elapsed += 10_000) {
    assert.equal(check({ active: true, lastModelReviewAt: now, at: now + elapsed }).run, false);
  }
  const activeDue = check({ active: true, lastModelReviewAt: now, at: now + 600_000 });
  assert.equal(activeDue.run, true);
  assert.match(activeDue.reason, /活跃任务/);

  for (let elapsed = 10_000; elapsed < 1_800_000; elapsed += 10_000) {
    assert.equal(check({ active: false, lastModelReviewAt: now, at: now + elapsed }).run, false);
  }
  const idleDue = check({ active: false, lastModelReviewAt: now, at: now + 1_800_000 });
  assert.equal(idleDue.run, true);
  assert.match(idleDue.reason, /空闲/);
});

test('Watchdog 语义巡检 gate：事件和严重健康事实去重，恢复后可再次触发', () => {
  const now = Date.parse('2026-11-13T08:00:00.000Z');
  const state: ModelReviewGateState = {
    incidentSignature: null,
    incidentReviewedAt: 0,
    dueIssueAttempts: {},
    routerMessageBatch: null,
    routerMessageFailedAt: 0,
  };
  const base = {
    now,
    active: false,
    lastModelReviewAt: now - 10_000,
    baselineAt: '2026-11-13T08:00:00.000Z',
    activeIntervalMs: 600_000,
    idleIntervalMs: 1_800_000,
    dueIssues: [],
    state,
  };

  const routerMessage = decideModelReview({
    ...base,
    pendingRouterMessages: 1,
    health: { state: 'alive', pid: 42, identity: 'match' },
  });
  assert.equal(routerMessage.run, true, '显式 Router 消息应立即触发');

  const dueIssue = decideModelReview({
    ...base,
    pendingRouterMessages: 0,
    dueIssues: [{ id: 'wdi_due', checkAfter: new Date(now - 1_000).toISOString() }],
    health: { state: 'alive', pid: 42, identity: 'match' },
  });
  assert.equal(dueIssue.run, true);
  assert.deepEqual(dueIssue.dueIssueKeys, ['wdi_due@' + new Date(now - 1_000).toISOString()]);
  state.dueIssueAttempts[dueIssue.dueIssueKeys[0]!] = now;
  assert.equal(decideModelReview({
    ...base,
    now: now + 10_000,
    pendingRouterMessages: 0,
    dueIssues: [{ id: 'wdi_due', checkAfter: new Date(now - 1_000).toISOString() }],
    health: { state: 'alive', pid: 42, identity: 'match' },
  }).run, false, '同一个到期事件不能在每次健康 tick 重试');

  const incident = decideModelReview({
    ...base,
    pendingRouterMessages: 0,
    health: { state: 'unresponsive', pid: 42, identity: 'match' },
  });
  assert.equal(incident.run, true);
  assert.equal(incident.incidentSignature, 'unresponsive:42');
  state.incidentSignature = incident.incidentSignature;
  state.incidentReviewedAt = now;
  assert.equal(decideModelReview({
    ...base,
    now: now + 10_000,
    pendingRouterMessages: 0,
    health: { state: 'unresponsive', pid: 42, identity: 'match' },
  }).run, false, '相同健康事实不能每 10 秒触发');

  // 主循环在健康恢复后会清空 incident 签名；同一 PID 再次故障应重新触发。
  state.incidentSignature = null;
  state.incidentReviewedAt = 0;
  assert.equal(decideModelReview({
    ...base,
    now: now + 20_000,
    pendingRouterMessages: 0,
    health: { state: 'unresponsive', pid: 42, identity: 'match' },
  }).run, true);

  const unverified = decideModelReview({
    ...base,
    now: now + 30_000,
    pendingRouterMessages: 0,
    health: { state: 'unverified', pid: 42, identity: 'mismatch' },
  });
  assert.equal(unverified.run, false, 'PID 身份探测异常只能降级观察，不能形成模型风暴');
  assert.match(unverified.healthNote ?? '', /PID 已确认不匹配/);

  state.routerMessageBatch = 'ic_failed';
  state.routerMessageFailedAt = now + 40_000;
  const backoff = decideModelReview({
    ...base,
    now: now + 50_000,
    pendingRouterMessages: 1,
    pendingRouterBatch: 'ic_failed',
    routerFailureBackoffMs: 60_000,
    health: { state: 'alive', pid: 42, identity: 'match' },
  });
  assert.equal(backoff.run, false, '同一批 Router 消息失败后不能在每次 10 秒 tick 重试');
  assert.match(backoff.reason, /正在退避/);
  assert.equal(decideModelReview({
    ...base,
    now: now + 100_001,
    pendingRouterMessages: 1,
    pendingRouterBatch: 'ic_failed',
    routerFailureBackoffMs: 60_000,
    health: { state: 'alive', pid: 42, identity: 'match' },
  }).run, true, '退避到期后应重新处理');
  assert.equal(decideModelReview({
    ...base,
    now: now + 50_000,
    pendingRouterMessages: 1,
    pendingRouterBatch: 'ic_new',
    routerFailureBackoffMs: 60_000,
    health: { state: 'alive', pid: 42, identity: 'match' },
  }).run, true, '新批次 Router 消息应立即突破旧批次退避');
});

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
      currentBlock.includes(`作业重点：${job.id}(${job.command}) running|exit=-`),
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
    assert.match(changedDelta, new RegExp(`任务 ${task.id} 作业：变化 ${job.id}`));
    assert.doesNotMatch(changedDelta, /running\|exit=-\|.*→ exited\|exit=0\|/);
    assert.match(changedText, new RegExp(`${job.id}\\(${job.command}\\) exited\\|exit=0`));
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
    assert.match(rendered, /检查：新增 review_reviewer_a、review_reviewer_b/);
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

    let manualSummaryPrompt = '';
    let manualAnswerPrompt = '';
    const manualModel = new MockModel(({ request }) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('Maintain a traceable note of the Super-Agent maintenance session')) {
        manualSummaryPrompt = request.messages.map((message) => message.content ?? '').join('\n');
        return mockReply({ text: '累计摘要：旧巡检结论可按 id 查回，不能把压缩当作原结论不存在。' });
      }
      manualAnswerPrompt = request.messages.map((message) => message.content ?? '').join('\n');
      return mockReply({ text: '人工提问答复' });
    });
    await (new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: manualModel,
      modelName: 'mock',
    })).ask('人工追问');
    assert.match(manualSummaryPrompt, /OLD_FULL_INSPECTION_MARKER/, '被移出近期窗口的全文应进入累计摘要，而不是无痕消失');
    assert.match(manualAnswerPrompt, /累计摘要：旧巡检结论可按 id 查回/, '人工 ask 应读取更新后的累计摘要');
    assert.match(manualAnswerPrompt, /UNANSWERED_ROUTER_MARKER/, '近期问答组仍应进入人工 ask');
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

test('Watchdog delta 忽略 message/job/artifact 噪声，保留 task/worker/run 决策事件', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '事件过滤',
      goal: 'g',
      ownerRole: '负责人',
      ownerBrief: 'b',
    });
    const before = observe(harness.store, harness.config);
    const state = createReviewState(before, null);
    for (let index = 0; index < 6; index += 1) {
      harness.store.appendEvent(task.id, owner.id, 'message.updated', `NOISE_MESSAGE_${index}`);
      harness.store.appendEvent(task.id, owner.id, 'job.progress', `NOISE_JOB_${index}`);
    }
    harness.store.appendEvent(task.id, owner.id, 'task.paused', 'DECISION_TASK');
    harness.store.appendEvent(task.id, owner.id, 'worker.failed', 'DECISION_WORKER');
    harness.store.appendEvent(task.id, owner.id, 'run.failed', 'DECISION_RUN');

    const after = observe(harness.store, harness.config);
    const rendered = renderReviewContext(after, state, []);
    const delta = rendered.split('## 当前非终态任务')[0]!;
    const observedEvents = after.tasks.find((item) => item.id === task.id)!.eventDetails;
    for (const event of observedEvents) {
      if (event.type.startsWith('message.') || event.type.startsWith('job.')) {
        assert.doesNotMatch(delta, new RegExp(event.id), `${event.type} 不应进入 delta`);
      } else {
        assert.match(delta, new RegExp(event.id), `${event.type} 应作为决策事件保留`);
      }
    }
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 当前快照限制任务与运行中作业展开数，并显示准确省略数量', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0, maxTotalWorkers: 100 },
  });
  try {
    for (let index = 0; index < 25; index += 1) {
      harness.runtime.createTask({
        title: `批量任务-${index}`,
        goal: 'g',
        ownerRole: '负责人',
        ownerBrief: 'b',
      });
    }
    const observation = observe(harness.store, harness.config);
    const target = observation.tasks[0]!;
    target.runningJobs = 25;
    target.jobs = Array.from({ length: 6 }, (_, index) => ({
      id: `job_bulk_${index}`,
      command: `command-${index}`,
      status: 'running',
      exitCode: null,
      endedAt: null,
    }));
    const rendered = renderReviewContext(observation, createReviewState(observation, null), []);
    assert.equal(
      rendered.split('详情可按需：inspect_task(').length - 1,
      20,
      '当前快照只展开 20 个非终态任务',
    );
    assert.match(rendered, /另有 5 个非终态任务未展开/);
    assert.match(rendered, /另有 0 个重点作业和 19 个运行中作业未展开/);
    assert.match(rendered, /运行中总数为 25/);
    assert.doesNotMatch(rendered, /可按作业 id 用 inspect_task/);
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 任务聚焦明确标注正式结果截断和较早检查省略', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '截断提示',
      goal: 'g',
      ownerRole: '负责人',
      ownerBrief: 'b',
    });
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', '正文').artifact;
    const now = new Date().toISOString();
    for (let index = 0; index < 10; index += 1) {
      harness.store.createReview({
        id: `review_bulk_${index}`,
        taskId: task.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactSha256: artifact.sha256,
        epoch: task.reviewEpoch,
        requestedBy: owner.id,
        reviewerId: `reviewer_${index}`,
        requestMessageId: `msg_review_${index}`,
        replyMessageId: null,
        outcome: 'pending',
        createdAt: now,
      });
    }
    harness.store.insertMessage({
      id: 'msg_long_result',
      groupId: task.groupId,
      taskId: task.id,
      fromKind: 'worker',
      fromId: owner.id,
      toKind: 'router',
      toId: 'router',
      kind: 'result',
      body: `RESULT_START${'x'.repeat(3_500)}RESULT_END`,
      payload: null,
      replyTo: null,
      refs: null,
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: now,
      deliveredAt: null,
      consumedAt: null,
      error: null,
    });
    for (let index = 0; index < 3; index += 1) {
      harness.store.insertJob({
        id: `job_focus_${index}`,
        taskId: task.id,
        workerId: owner.id,
        command: `command-${index}`,
        args: [],
        cwd: harness.config.workDir,
        pid: null,
        status: 'exited',
        exitCode: 0,
        signal: null,
        stdoutPath: '',
        stderrPath: '',
        timeoutMs: 1_000,
        startedAt: now,
        endedAt: now,
        error: null,
      });
    }
    let prompt = '';
    let toolOutput = '';
    let step = 0;
    await new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(({ request }) => {
        if (step++ === 0) {
          prompt = request.messages.map((message) => message.content ?? '').join('\n');
          return mockReply({
            toolCalls: [{
              name: 'inspect_task',
              arguments: { task_id: task.id, result_id: 'msg_long_result' },
            }],
          });
        }
        toolOutput = request.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.content ?? '')
          .join('\n');
        return mockReply({ text: '已核对' });
      }),
      modelName: 'mock',
    }).ask('检查任务', { taskId: task.id, history: false });

    assert.match(prompt, /RESULT_START/);
    assert.doesNotMatch(prompt, /RESULT_END/);
    assert.match(prompt, /正式结果正文已截断/);
    assert.match(prompt, /另有 2 条较早检查未展开/);
    assert.match(prompt, /运行中作业 0 个，已全部展开；另有 2 个较早结束的非重点作业未展开/);
    assert.doesNotMatch(prompt, /可按作业 id 用 inspect_task/);
    assert.match(toolOutput, /RESULT_END/, 'inspect_task 应按 result_id 返回正式结果全文');
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 人工问答和周期巡检都明确当前实例数据库、工作目录与 cwd', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const prompts: string[] = [];
    const model = new MockModel(({ request }) => {
      prompts.push(request.messages.map((message) => message.content ?? '').join('\n'));
      return mockReply({ text: '范围已核对' });
    });
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model,
      modelName: 'mock',
    });
    await session.ask('核对维护范围', { history: false });
    await session.runOnce(10);

    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.match(prompt, /## 当前实例范围（程序事实）/);
      assert.ok(prompt.includes(`- 数据库：${harness.config.dbPath}`));
      assert.ok(prompt.includes(`- 工作目录：${harness.config.workDir}`));
      assert.ok(prompt.includes(`- 进程 cwd：${process.cwd()}`));
      assert.match(prompt, /其他路径读到的事实属于外部证据，不能拼成当前实例状态/);
    }
  } finally {
    await harness.cleanup();
  }
});
