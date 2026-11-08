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
    assert.deepEqual(tables.map((t) => t.name).sort(), ['wd_action', 'wd_issue', 'wd_turn']);
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
