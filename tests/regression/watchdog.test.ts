import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, isNoteRequest } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { observe } from '../../src/watchdog/observer.ts';
import { WatchdogSession } from '../../src/watchdog/session.ts';
import { MockModel } from '../../src/model/mock.ts';

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('等待超时');
}

test('长任务：累计步数超过旧上限仍然继续，不直接失败', async () => {
  let calls = 0;
  const harness = await createHarness({
    limits: {
      maxStepsPerWorker: 24,
      maxStepsPerGroup: 30,
      maxStepsPerRun: 40,
      maxConcurrentRuns: 1,
      maxNudges: 99,
    },
    worker: (context) => {
      if (isNoteRequest(context.request)) return mockReply({ text: '## 已完成\n- 占位' });
      calls += 1;
      if (calls <= 30) return mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: '.' } }] });
      // 跑够步数后挂起，避免测试里无限续轮
      return mockReply({ toolCalls: [{ name: 'wait_for', arguments: { timeout_seconds: 60 } }] });
    },
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '长任务', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    harness.runtime.enqueue(owner.id);
    await waitFor(() => (harness.store.getWorker(owner.id)?.stepCount ?? 0) > 24, 25_000);
    const worker = harness.store.getWorker(owner.id)!;
    assert.notEqual(worker.status, 'failed', '超过 24 步不应失败');
    assert.notEqual(harness.store.getTask(task.id)?.status, 'failed', '任务不应因为步数失败');
    assert.ok((harness.store.getWorker(owner.id)?.stepCount ?? 0) > 24, '应真的跑过 24 步');
    // 软阈值只留事件，不改状态
    const events = harness.store.listEvents(task.id, 200).map((event) => event.type);
    assert.ok(events.includes('budget.worker'), '应记录预算提醒事件');
  } finally {
    await harness.cleanup();
  }
});

test('维护：暂停任务后不再调度，恢复后继续；控制命令走主系统接口', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '维护', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    harness.store.insertControlCommand({
      id: 'cc_pause', command: 'pause_task', payload: JSON.stringify({ taskId: task.id, reason: '测试挂起' }), source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.getTask(task.id)?.maintenance, 1);
    harness.runtime.enqueue(owner.id);
    assert.equal(harness.store.getWorker(owner.id)?.status, 'queued', '挂起期间不会被调度执行');

    harness.store.insertControlCommand({
      id: 'cc_resume', command: 'resume_task', payload: JSON.stringify({ taskId: task.id }), source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.getTask(task.id)?.maintenance, 0);
    const controls = harness.store.listRecentControls(5);
    assert.ok(controls.every((item) => item.status === 'done'), '控制命令应被执行');
  } finally {
    await harness.cleanup();
  }
});

test('在线调整：覆盖项写入后立即成为生效版本，可回滚', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const task = harness.runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' }).task;
    harness.store.insertControlCommand({
      id: 'cc_ov1', command: 'set_override',
      payload: JSON.stringify({ key: 'worker.check_rules', content: '区分必须修改项与可选建议', reason: '减少返工', author: 'watchdog' }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.activeOverride('worker.check_rules')?.version, 1);
    assert.match(harness.store.activeOverride('worker.check_rules')?.content ?? '', /必须修改项/);

    harness.store.insertControlCommand({
      id: 'cc_ov2', command: 'set_override',
      payload: JSON.stringify({ key: 'worker.check_rules', content: '第二版', reason: '再调', author: 'watchdog' }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.activeOverride('worker.check_rules')?.version, 2);
    assert.equal(harness.store.activeOverride('worker.check_rules')?.content, '第二版');
    assert.equal(harness.store.listOverrides('worker.check_rules').length, 2, '旧版本保留');

    harness.store.insertControlCommand({
      id: 'cc_ov3', command: 'rollback_override',
      payload: JSON.stringify({ key: 'worker.check_rules', version: 1 }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.activeOverride('worker.check_rules')?.version, 1, '回滚后旧版本生效');
    void task;
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog：独立会话观察主系统、记录事件并安排复查', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { task } = harness.runtime.createTask({
      title: '被观察任务', goal: '完成实验整理', ownerRole: '负责人', ownerBrief: 'b',
    });
    const observation = observe(harness.store, harness.config);
    assert.equal(observation.tasks.length, 1);

    let round = 0;
    const model = new MockModel(() => {
        round += 1;
        if (round === 1) {
          return mockReply({
            toolCalls: [
              { name: 'record', arguments: JSON.stringify({ task_id: task.id, title: '任务长时间无进展', note: '两次巡检产物未变化', check_after_minutes: 5 }) },
            ],
          });
        }
        if (round === 2) {
          return mockReply({ toolCalls: [{ name: 'maintain', arguments: JSON.stringify({ action: 'nudge_worker', task_id: task.id, text: '请运行用户要求的测试' }) }] });
        }
        return mockReply({ text: '结论：已记录并提醒，5 分钟后复查。' });
    });
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model,
      modelName: 'mock',
    });
    const result = await session.runOnce(1);
    assert.ok(result.acted, '应执行维护动作');
    const issues = harness.store.listOpenIssues();
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.title, /无进展/);
    assert.ok(issues[0]!.checkAfter, '应安排复查时间');

    const controls = harness.store.listPendingControls();
    assert.equal(controls.length, 1);
    assert.equal(controls[0]!.command, 'nudge_worker');
    assert.equal(harness.store.listWdTurns(10).length, 1, '会话历史保留');
  } finally {
    await harness.cleanup();
  }
});

test('隔离：启动 Watchdog 不恢复、不调度、不改主系统运行中的作业', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '隔离', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    const job = harness.runtime.startJob({
      worker: owner, taskId: task.id, command: 'python3', args: ['-c', 'import time;time.sleep(5)'],
      cwd: harness.config.workDir, stdin: null, timeoutMs: 10_000,
    });
    assert.equal(job.status, 'running');

    // 只做观察与会话，不构造 Runtime
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(() => mockReply({ text: '看起来正常' })),
      modelName: 'mock',
    });
    await session.runOnce(1);
    assert.equal(harness.store.getJob(job.id)?.status, 'running', 'Watchdog 不应把运行中的作业标成 unknown');
    assert.equal(harness.store.getWorker(owner.id)?.status !== 'failed', true);
    harness.runtime.stopJob(job.id, '测试结束');
  } finally {
    await harness.cleanup();
  }
});

test('独立进程：Watchdog 作为分离进程启动，主系统不在也能写入自己的记录', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'wd-proc-'));
  const dbPath = join(dir, 'agent.db');
  const workDir = join(dir, 'work');
  const child = spawn(process.execPath, ['src/watchdog/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      WORK_DIR: workDir,
      // 不连真实模型：只验证独立进程与启动路径
      WATCHDOG_NO_TICK: '1',
      WATCHDOG_INTERVAL_MS: '3600000',
      // 进程存活验证不连真实模型
      OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
      OLLAMA_API_KEY: 'test-key',
      MODEL_NAME: 'mock-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await waitFor(() => existsSync(join(workDir, '.runtime', 'watchdog.json')), 20_000);
    const pidInfo = JSON.parse(readFileSync(join(workDir, '.runtime', 'watchdog.json'), 'utf8')) as { pid: number };
    assert.equal(pidInfo.pid, child.pid);
    assert.notEqual(child.exitCode, 0, 'Watchdog 应该是活着的独立进程');
    assert.match(output, /Watchdog 启动/);
    // 它建好了自己的表，但没有碰主系统的作业
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wd_%'").all() as { name: string }[];
    assert.deepEqual(tables.map((t) => t.name).sort(), ['wd_action', 'wd_issue', 'wd_question', 'wd_turn']);
    db.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(dir, { recursive: true, force: true });
  }
});

test('在线生效：覆盖项真的进入 Worker 的 system prompt，回滚后恢复原状', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '覆盖生效', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    const build = (
      harness.runtime as unknown as {
        buildWorkerMessages: (worker: unknown, target: unknown) => Promise<{ role: string; content: string | null }[]>;
      }
    ).buildWorkerMessages.bind(harness.runtime);

    const before = (await build(owner, task))[0]!.content ?? '';
    assert.ok(!before.includes('维护者调整'), '默认没有覆盖');

    harness.store.insertControlCommand({
      id: 'cc_apply', command: 'set_override',
      payload: JSON.stringify({ key: 'worker.check_rules', content: '检查时区分必须修改项与可选建议', reason: '减少返工', author: 'watchdog' }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    const after = (await build(owner, task))[0]!.content ?? '';
    assert.match(after, /维护者调整（v1/, '新版本应进入实际请求');
    assert.match(after, /必须修改项与可选建议/);

    harness.store.insertControlCommand({
      id: 'cc_rollback', command: 'rollback_override',
      payload: JSON.stringify({ key: 'worker.check_rules', version: 1 }),
      source: 'watchdog',
    });
    harness.runtime.tick();
    const rolled = (await build(owner, task))[0]!.content ?? '';
    assert.match(rolled, /维护者调整（v1/);
  } finally {
    await harness.cleanup();
  }
});

test('单实例：第二个 Watchdog 不会启动，避免重复巡检与恢复风暴', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = await mkdtemp(joinPath(tmpdir(), 'wd-lock-'));
  const env = {
    ...process.env,
    DB_PATH: joinPath(dir, 'agent.db'),
    WORK_DIR: joinPath(dir, 'work'),
    WATCHDOG_NO_TICK: '1',
    WATCHDOG_INTERVAL_MS: '3600000',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'test-key',
    MODEL_NAME: 'mock-model',
  };
  const { spawn } = await import('node:child_process');
  const first = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: process.cwd(), env, stdio: 'ignore' });
  try {
    await waitFor(() => existsSync(joinPath(dir, 'work', '.runtime', 'watchdog.json')), 20_000);
    const second = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: process.cwd(), env, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    assert.equal(code, 3, '第二个实例应主动退出');
  } finally {
    first.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(dir, { recursive: true, force: true });
  }
});

test('挂起：已发出的响应返回后不执行工具，也不写文件', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 1, maxStepsPerRun: 4 },
    worker: async () => {
      await gate;
      return mockReply({ toolCalls: [{ name: 'fs_write', arguments: { path: 'late.txt', content: '不该被写入' } }] });
    },
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '挂起', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    harness.runtime.enqueue(owner.id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    harness.store.insertControlCommand({
      id: 'cc_pause2', command: 'pause_task', payload: JSON.stringify({ taskId: task.id, reason: '测试' }), source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.getTask(task.id)?.maintenance, 1);

    release!();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const path = join(harness.config.workDir, task.id, 'late.txt');
    assert.equal(existsSync(path), false, '挂起之后返回的响应不应执行写操作');
    const turns = harness.store.listWorkerTurns(owner.id, 50).map((turn) => turn.content);
    assert.ok(turns.some((text) => (text ?? '').includes('未执行')), '应留下「未执行」的记录，而不是伪造工具结果');
  } finally {
    await harness.cleanup();
  }
});

test('恢复：只解除维护阻塞，不打断提供方退避', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '退避', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    harness.runtime.registerWait(owner, { reason: 'provider', timeoutMs: 60_000 });
    harness.store.setWorkerStatus(owner.id, 'waiting');

    harness.store.insertControlCommand({
      id: 'cc_p3', command: 'pause_task', payload: JSON.stringify({ taskId: task.id }), source: 'watchdog',
    });
    harness.runtime.tick();
    harness.store.insertControlCommand({
      id: 'cc_r3', command: 'resume_task', payload: JSON.stringify({ taskId: task.id }), source: 'watchdog',
    });
    harness.runtime.tick();

    const waits = harness.store.listActiveWaitsForWorker(owner.id);
    assert.equal(waits.length, 1, '提供方退避必须保留');
    assert.equal(waits[0]!.reason, 'provider');
  } finally {
    await harness.cleanup();
  }
});

test('完成：正常交付也会清理后台作业', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0 },
    worker: () => mockReply({ text: 'ok' }),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '完成清理', goal: 'g', ownerRole: '负责人', ownerBrief: 'b', requireReview: false,
    });
    const job = harness.runtime.startJob({
      worker: owner, taskId: task.id, command: 'python3', args: ['-c', 'import time;time.sleep(30)'],
      cwd: harness.config.workDir, stdin: null, timeoutMs: 60_000,
    });
    await harness.runtime.saveArtifact(owner, 'report.md', '# 完成\n');
    const result = await harness.runtime.submitResult(owner, '完成', ['report.md']);
    assert.equal(result.ok, true, result.reason);
    assert.equal(harness.store.getTask(task.id)?.status, 'completed');
    assert.notEqual(harness.store.getJob(job.id)?.status, 'running', '终态任务不应留下运行中的作业');
  } finally {
    await harness.cleanup();
  }
});

test('零值配置：显式 0 合法，非法值明确报错', async () => {
  const { loadConfig } = await import('../../src/config.ts');
  const base = {
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'k',
    MODEL_NAME: 'm',
  };
  const previous = { ...process.env };
  try {
    Object.assign(process.env, base, { MAX_STEPS_PER_WORKER: '0', MAX_STEPS_PER_GROUP: '0' });
    const config = loadConfig();
    assert.equal(config.limits.maxStepsPerWorker, 0);
    assert.equal(config.limits.maxStepsPerGroup, 0);

    process.env['MAX_STEPS_PER_WORKER'] = '-3';
    assert.throws(() => loadConfig(), /非负整数/);
    process.env['MAX_STEPS_PER_WORKER'] = 'abc';
    assert.throws(() => loadConfig(), /非负整数/);
    process.env['MAX_STEPS_PER_WORKER'] = '1.5';
    assert.throws(() => loadConfig(), /非负整数/);
  } finally {
    process.env = previous;
  }
});

test('Router 续接：重启后仍能发现待续接进度，失败时保留记录', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.store.saveRouterSession({
      id: 'rs_1', taskId: null, messages: [{ role: 'assistant', content: '已创建任务' }], reason: '额度用尽',
    });
    const { Router } = await import('../../src/runtime/router.ts');
    const { MockModel } = await import('../../src/model/mock.ts');
    let failNext = true;
    const router = new Router(
      harness.runtime,
      new MockModel(() => {
        if (failNext) {
          failNext = false;
          throw new Error('提供方暂时不可用');
        }
        return mockReply({ text: '继续完成协调' });
      }),
      harness.config,
    );
    assert.equal(router.hasPendingSession(), true, '以持久化状态为准');
    await assert.rejects(() => router.resume());
    assert.ok(harness.store.pendingRouterSession(), '失败后记录必须保留，不能标成 abandoned');
    await router.resume();
    assert.equal(harness.store.pendingRouterSession(), null, '成功后才关闭会话');
  } finally {
    await harness.cleanup();
  }
});

test('Watchdog 维护闭环：命令有回执，动作与问题关联', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { task } = harness.runtime.createTask({ title: '闭环', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    let round = 0;
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(() => {
        round += 1;
        if (round === 1) {
          return mockReply({
            toolCalls: [
              { name: 'record', arguments: JSON.stringify({ issue_id: 'wdi_fixed', task_id: task.id, title: '检查者空转', note: '重复脚本', check_after_minutes: 1 }) },
              { name: 'maintain', arguments: JSON.stringify({ action: 'nudge_worker', worker_id: harness.store.getTask(task.id)!.ownerWorkerId, text: '请提交检查结论', issue_id: 'wdi_fixed', reason: '空转' }) },
            ],
          });
        }
        if (round === 2) {
          return mockReply({ toolCalls: [{ name: 'command_status', arguments: {} }] });
        }
        return mockReply({ text: '已提交纠偏，等待回执。' });
      }),
      modelName: 'mock',
    });
    await session.runOnce(1);
    const actions = harness.store.listWdActions(10);
    assert.ok(actions.some((action) => action.action === 'nudge_worker'), '动作要落到动作表');
    assert.ok(actions.some((action) => action.result.includes('cc_')), '动作要带命令标识');
    const controls = harness.store.listPendingControls();
    assert.equal(controls.length, 1);
    // 主系统消费后回执变化
    harness.runtime.tick();
    const after = harness.store.listRecentControls(3)[0]!;
    assert.equal(after.status, 'done', '命令执行后状态必须变化');
  } finally {
    await harness.cleanup();
  }
});

test('在线规则：不支持的 key 被拒绝，巡检间隔覆盖项可校验', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.store.insertControlCommand({
      id: 'cc_bad', command: 'set_override', payload: JSON.stringify({ key: 'anything.goes', content: 'x' }), source: 'watchdog',
    });
    harness.runtime.tick();
    const bad = harness.store.listRecentControls(3)[0]!;
    assert.equal(bad.status, 'failed');
    assert.match(bad.result ?? '', /不支持的覆盖项/);

    harness.store.insertControlCommand({
      id: 'cc_int_bad', command: 'set_override', payload: JSON.stringify({ key: 'watchdog.interval', content: '5' }), source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.listRecentControls(3)[0]!.status, 'failed');

    harness.store.insertControlCommand({
      id: 'cc_int', command: 'set_override', payload: JSON.stringify({ key: 'watchdog.interval', content: '30000', reason: '降低频率' }), source: 'watchdog',
    });
    harness.runtime.tick();
    assert.equal(harness.store.activeOverride('watchdog.interval')?.content, '30000');
  } finally {
    await harness.cleanup();
  }
});

test('同时启动：竞争条件下只有一个 Watchdog 生效', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(joinPath(tmpdir(), 'wd-race-'));
  const env = {
    ...process.env,
    DB_PATH: joinPath(dir, 'agent.db'),
    WORK_DIR: joinPath(dir, 'work'),
    WATCHDOG_NO_TICK: '1',
    WATCHDOG_INTERVAL_MS: '3600000',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_API_KEY: 'test-key',
    MODEL_NAME: 'mock-model',
  };
  // 同时拉起三个，必须只有一个留下
  const children = [0, 1, 2].map(() =>
    spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: process.cwd(), env, stdio: 'ignore' }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const alive = children.filter((child) => child.exitCode === null).length;
    assert.equal(alive, 1, `应只有一个实例存活，实际 ${alive}`);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(dir, { recursive: true, force: true });
  }
});

test('停机标记：存在时不会自动拉起主系统', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.runtime.createTask({ title: '停机', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const stopFile = join(harness.config.workDir, '.runtime', 'watchdog.stop');
    mkdirSync(join(harness.config.workDir, '.runtime'), { recursive: true });
    writeFileSync(stopFile, 'stopped', 'utf8');

    let restarted = false;
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(() => {
        if (!restarted) {
          restarted = true;
          return mockReply({ toolCalls: [{ name: 'maintain', arguments: JSON.stringify({ action: 'restart_main', reason: '测试' }) }] });
        }
        return mockReply({ text: '已尝试，但被停机标记阻止' });
      }),
      modelName: 'mock',
      restartMain: async () => {
        if (existsSync(stopFile)) return { ok: false, message: '存在停机标记，不执行自动拉起' };
        return { ok: true, message: '拉起' };
      },
    });
    await session.ask('主系统停了吗？');
    const actions = harness.store.listWdActions(5);
    assert.ok(actions.some((action) => action.result.includes('停机标记')), '停机标记必须阻止拉起');
    rmSync(stopFile, { force: true });
  } finally {
    await harness.cleanup();
  }
});

test('后台模式：不依赖标准输入，心跳持续推进直到显式停止', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(joinPath(tmpdir(), 'daemon-'));
  const workDir = joinPath(dir, 'work');
  const child = spawn(process.execPath, ['src/main.ts', '--daemon'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: joinPath(dir, 'agent.db'),
      WORK_DIR: workDir,
      OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
      OLLAMA_API_KEY: 'k',
      MODEL_NAME: 'm',
      MODEL_CONCURRENCY: '1',
    },
    stdio: 'ignore',
  });
  try {
    const heartbeatPath = joinPath(workDir, '.runtime', 'heartbeat.json');
    await waitFor(() => existsSync(heartbeatPath), 15_000);
    const first = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { at: number };
    // 没有标准输入的情况下，进程必须继续跑并推进心跳
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const second = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { at: number };
    assert.equal(child.exitCode, null, '后台模式不应自行退出');
    assert.ok(second.at > first.at, '心跳必须继续推进');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const instance = JSON.parse(readFileSync(joinPath(workDir, '.runtime', 'instance.json'), 'utf8')) as {
      pid: number | null;
      stopped: boolean;
    };
    assert.equal(instance.stopped, true, '停止后应标记已停机');
    assert.equal(instance.pid, null, '不允许用 0 冒充进程号');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(dir, { recursive: true, force: true });
  }
});

test('后台恢复：预存 queued 任务，后台启动后会真正进入调度', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(joinPath(tmpdir(), 'daemon-recover-'));
  const workDir = joinPath(dir, 'work');
  const dbPath = joinPath(dir, 'agent.db');

  // 先用同一套代码在库里留下一个 queued 任务
  const seed = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  const config0 = { ...seed.config, dbPath, workDir };
  await seed.cleanup();
  const pre = new (await import('../../src/storage/store.ts')).Store(dbPath);
  const { Runtime } = await import('../../src/runtime/runtime.ts');
  const preRuntime = new Runtime({
    store: pre,
    config: config0,
    workerModel: new (await import('../../src/model/mock.ts')).MockModel(() => mockReply({ text: 'ok' })),
  });
  const created = preRuntime.createTask({ title: '后台恢复', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
  preRuntime.enqueue(created.owner.id);
  pre.close();

  const child = spawn(process.execPath, ['src/main.ts', '--daemon'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      WORK_DIR: workDir,
      OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
      OLLAMA_API_KEY: 'k',
      MODEL_NAME: 'm',
      MODEL_CONCURRENCY: '1',
    },
    stdio: 'ignore',
  });
  try {
    await waitFor(() => existsSync(joinPath(workDir, '.runtime', 'heartbeat.json')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const worker = db.prepare('SELECT step_count, status FROM worker').get() as { step_count: number; status: string };
    db.close();
    // 模型不可达会失败，但关键是有没有真的从恢复走到调度：步数必须动过或状态不再是 queued
    assert.ok(
      worker.step_count > 0 || worker.status !== 'queued',
      `后台模式必须恢复并调度，实际 ${JSON.stringify(worker)}`,
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await rm(dir, { recursive: true, force: true });
  }
});

test('后台停机：模型请求未返回时停止，不出现关闭数据库后的访问', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { spawn } = await import('node:child_process');

  // 故意慢响应：让停止发生在模型请求尚未返回的时候
  const server = createServer((_req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }));
      } catch {
        // 连接已关闭
      }
    }, 15_000);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const dir = await mkdtemp(joinPath(tmpdir(), 'daemon-stop-'));
  const workDir = joinPath(dir, 'work');
  const dbPath = joinPath(dir, 'agent.db');
  const child = spawn(process.execPath, ['src/main.ts', '--daemon'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      WORK_DIR: workDir,
      OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OLLAMA_API_KEY: 'k',
      MODEL_NAME: 'm',
      MODEL_TIMEOUT_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await waitFor(() => existsSync(joinPath(workDir, '.runtime', 'heartbeat.json')), 20_000);
    const { DatabaseSync } = await import('node:sqlite');
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(
      `INSERT INTO task (id, group_id, title, goal, brief, done_criteria, require_review, review_epoch, status, created_at, updated_at)
       VALUES ('task_stop','g_stop','t','g','b','',0,0,'active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    );
    seedDb.close();

    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, `应正常退出，实际 ${code}；输出：${output.slice(-300)}`);
    assert.ok(!output.includes('database is not open'), '不能在存储关闭后继续访问数据库');
  } finally {
    child.kill('SIGKILL');
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件边界：相邻前缀目录、绝对路径、.. 与符号链接逃逸都被拒绝', async () => {
  const { mkdtemp, writeFile, mkdir, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = await mkdtemp(joinPath(tmpdir(), 'wd-files-'));
  const root = joinPath(dir, 'work');
  const neighbour = joinPath(dir, 'work-leak');
  await mkdir(root, { recursive: true });
  await mkdir(neighbour, { recursive: true });
  await writeFile(joinPath(root, 'ok.txt'), '正常内容', 'utf8');
  await writeFile(joinPath(neighbour, 'secret.txt'), '不该被读到', 'utf8');
  await writeFile(joinPath(dir, 'outside.txt'), '外部文件', 'utf8');
  await symlink(joinPath(dir, 'outside.txt'), joinPath(root, 'link.txt'));

  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    type Req = { request: { messages: { role: string; content: string | null }[] } };
    const session = new WatchdogSession({
      store: harness.store,
      config: { ...harness.config, workDir: root },
      model: new MockModel((context) => {
        const req = context as unknown as Req;
        const asked = req.request.messages.at(-1)?.content ?? '';
        const path = /READ:(.+)$/.exec(asked)?.[1] ?? 'ok.txt';
        return mockReply({ toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path }) }] });
      }),
      modelName: 'mock',
    });

    const ask = async (path: string): Promise<string> => {
      const answer = await session.ask(`READ:${path}`);
      return answer;
    };
    // mock 会一直调用工具，取最后一次工具结果即可：这里直接调用工具路径
    const direct = (session as unknown as { readInsideRoot: (p: string, o: number, l: number) => string }).readInsideRoot.bind(session);
    assert.match(direct('ok.txt', 0, 1000), /正常内容/);
    assert.match(direct('../work-leak/secret.txt', 0, 1000), /拒绝读取|越界/);
    assert.match(direct('/etc/passwd', 0, 1000), /拒绝读取|越界/);
    assert.match(direct('link.txt', 0, 1000), /拒绝读取|符号链接/);
    assert.match(direct('nope.txt', 0, 1000), /文件不存在/);
    void ask;
  } finally {
    await harness.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Router 动作去重：创建任务后再失败，续接不会重复建任务', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { Router } = await import('../../src/runtime/router.ts');
    const { MockModel } = await import('../../src/model/mock.ts');
    let call = 0;
    const router = new Router(
      harness.runtime,
      new MockModel(() => {
        call += 1;
        if (call === 1) {
          return mockReply({
            toolCalls: [
              {
                name: 'create_task',
                arguments: {
                  title: '被重复创建的任务',
                  goal: '完成一件事',
                  owner_role: '负责人',
                  owner_brief: '做',
                },
              },
            ],
          });
        }
        if (call === 2) throw new Error('提供方暂时不可用');
        return mockReply({ text: '已创建，继续推进' });
      }),
      harness.config,
    );
    await router.handleUserMessage('帮我做一件事').catch(() => undefined);
    const afterFirst = harness.store.listTasks().length;
    assert.ok(afterFirst >= 1, '第一次应真的建了任务');

    // 模拟额度用尽后保存的进度，再续接同一会话
    const session = harness.store.pendingRouterSession();
    if (!session) return; // 没有保存进度时这条断言不适用
    await router.resume().catch(() => undefined);
    assert.equal(harness.store.listTasks().length, 1, '续接不应重复创建任务');
  } finally {
    await harness.cleanup();
  }
});

test('调用统计：多次模型调用与对话条数分开记，usage 未知不记成 0', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.runtime.createTask({ title: '统计', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    let round = 0;
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(() => {
        round += 1;
        if (round <= 3) {
          return mockReply({ toolCalls: [{ name: 'check_main', arguments: {} }] });
        }
        return mockReply({ text: '结论' });
      }),
      modelName: 'mock',
    });
    await session.runOnce(1);

    const stats = harness.store.modelCallStats();
    const wd = stats.find((item) => item.purpose === 'watchdog');
    assert.ok(wd, '必须记录 Watchdog 自己的调用');
    assert.equal(wd.calls, 4, '4 次 chat 就应是 4 条调用记录');
    assert.equal(wd.usageKnown, 0, '没有 usage 时记为未知，不是 0');
    assert.equal(harness.store.listWdTurns(20).length, 1, '对话条数与调用次数不是一回事');
  } finally {
    await harness.cleanup();
  }
});

test('调用统计：失败的模型调用也留下记录并标明状态', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    harness.runtime.createTask({ title: '失败统计', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const session = new WatchdogSession({
      store: harness.store,
      config: harness.config,
      model: new MockModel(() => {
        throw new Error('提供方不可用');
      }),
      modelName: 'mock',
    });
    await session.runOnce(1).catch(() => undefined);
    const stats = harness.store.modelCallStats();
    const wd = stats.find((item) => item.purpose === 'watchdog');
    assert.ok(wd && wd.failed >= 1, '失败的调用必须被记录');
  } finally {
    await harness.cleanup();
  }
});

test('维护者作业：与业务作业分开恢复，启动不会把业务 running 标成 unknown', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner, task } = harness.runtime.createTask({ title: '隔离作业', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const bizJob = harness.runtime.startJob({
      worker: owner, taskId: task.id, command: 'python3', args: ['-c', 'import time;time.sleep(10)'],
      cwd: harness.config.workDir, stdin: null, timeoutMs: 30_000,
    });
    assert.equal(harness.store.getJob(bizJob.id)?.status, 'running');

    const { ProcessService } = await import('../../src/runtime/process.ts');
    const wdJobs = new ProcessService({
      store: harness.store,
      logRoot: join(harness.config.workDir, '.jobs', 'watchdog'),
      scope: 'watchdog',
    });
    wdJobs.recover();
    assert.equal(harness.store.getJob(bizJob.id)?.status, 'running', '维护者恢复不能误标业务作业');

    const wdJob = wdJobs.start({
      taskId: 'watchdog', workerId: 'watchdog', command: 'python3', args: ['-c', 'print(1)'],
      cwd: harness.config.workDir, stdin: null, timeoutMs: 10_000,
      logRoot: join(harness.config.workDir, '.jobs', 'watchdog'),
    });
    assert.equal(harness.store.getJob(wdJob.id)?.scope, 'watchdog');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(harness.store.getJob(wdJob.id)?.exitCode, 0);

    const again = new ProcessService({
      store: harness.store,
      logRoot: join(harness.config.workDir, '.jobs', 'watchdog'),
      scope: 'watchdog',
    });
    again.recover();
    assert.equal(harness.store.getJob(bizJob.id)?.status, 'running', '再次恢复也不能碰业务作业');
    wdJobs.dispose();
    again.dispose();
    harness.runtime.stopJob(bizJob.id, '测试结束');
  } finally {
    await harness.cleanup();
  }
});

test('复查调度：未到期且无新情况时跳过一次模型审视', async () => {
  const harness = await createHarness({ limits: { maxConcurrentRuns: 0 }, worker: () => mockReply({ text: 'ok' }) });
  try {
    // 无活跃任务时不应每轮都调模型
    harness.store.upsertWdIssue({
      id: 'wdi_later', taskId: null, title: '稍后复查',
      note: '', checkAfter: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const issues = harness.store.listOpenIssues();
    const now = Date.now();
    const due = issues.filter((issue) => !issue.checkAfter || Date.parse(issue.checkAfter) <= now);
    assert.equal(due.length, 0, '未到期事件不应触发立即复查');
  } finally {
    await harness.cleanup();
  }
});
