import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { execTools } from '../../src/tools/exec.ts';
import { ProcessService } from '../../src/runtime/process.ts';
import { restartMainWithRollbackPoint } from '../../src/watchdog/process.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { createHarness } from '../helpers.ts';

async function setup() {
  const harness = await createHarness({ worker: () => ({ text: 'ok', toolCalls: [], finishReason: 'stop' }) as never, limits: { maxConcurrentRuns: 0 } });
  const { task, owner } = harness.runtime.createTask({ title: '作业测试', goal: '验证进程', ownerRole: '负责人', ownerBrief: '运行命令' });
  const dir = join(harness.config.workDir, task.id);
  await mkdir(dir, { recursive: true });
  const context: ToolContext = { host: harness.runtime, worker: owner, task, workDir: harness.config.workDir, materialsDir: harness.config.materialsDir, readRoot: harness.config.readRoot };
  return { harness, task, dir, context };
}
function tool(name: string) {
  const value = execTools.find((item) => item.name === name);
  assert.ok(value);
  return value;
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待作业超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('同步等待读取真实尾部并将非零退出标记为失败', async () => {
  const f = await setup();
  try {
    const result = await tool('proc_run').run({ command: process.execPath, args: ['-e', "process.stdout.write('A'.repeat(80000)+'END'); process.stderr.write('ERR'); process.exitCode=7"], wait: true }, f.context);
    assert.equal(result.type, 'failed');
    assert.match(result.content, /退出码 7/);
    assert.match(result.content, /END/);
    assert.match(result.content, /ERR/);
    assert.match(result.content, /只给末尾/);
  } finally { await f.harness.cleanup(); }
});

test('超过 20MB 的中文日志保持字符偏移与分页，emoji 不被拆开', async () => {
  const f = await setup();
  try {
    const outcome = await tool('proc_run').run({ command: process.execPath, args: ['-e', "process.stdout.write('中'.repeat(7000000)+'😀尾')"] }, f.context);
    const id = /job_[0-9a-f]+/.exec(outcome.content)?.[0];
    assert.ok(id);
    await waitFor(() => f.harness.runtime.getJob(id)?.status !== 'running');
    const part = f.harness.runtime.readJob(id, 'stdout', 6999999, 2);
    assert.ok(part);
    assert.equal(part.total, 7000003);
    assert.equal(part.text, '中😀');
    assert.equal(part.nextOffset, 7000002);
    const rest = f.harness.runtime.readJob(id, 'stdout', part.nextOffset, 5);
    assert.equal(rest?.text, '尾');
    assert.equal(rest?.hasMore, false);
    const middle = f.harness.runtime.readJob(id, 'stdout', 7000001, 1);
    assert.equal(middle?.text, '尾');
    assert.equal(middle?.nextOffset, 7000003);
  } finally { await f.harness.cleanup(); }
});

test('尾部起点落在 emoji 中间时不返回孤立代理字符', async () => {
  const f = await setup();
  try {
    const script = "process.stdout.write('😀'+'A'.repeat(51200-1))";
    const result = await tool('proc_run').run({ command: process.execPath, args: ['-e', script], wait: true }, f.context);
    assert.equal(result.type, 'ok');
    assert.doesNotMatch(result.content, /[\uD800-\uDFFF]/u);
    assert.match(result.content, /只给末尾/);
  } finally { await f.harness.cleanup(); }
});

test('作业完成和主动停止后解绑取消监听；新服务不能按旧 PID 停止作业', async () => {
  const f = await setup();
  const controller = new AbortController();
  try {
    const result = await tool('proc_run').run({ command: process.execPath, args: ['-e', "process.stdout.write('done')"], wait: true }, { ...f.context, signal: controller.signal });
    assert.equal(result.type, 'ok');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const started = await tool('proc_run').run({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'] }, { ...f.context, signal: controller.signal });
    const id = /job_[0-9a-f]+/.exec(started.content)?.[0];
    assert.ok(id);
    const other = new ProcessService({ store: f.harness.store, logRoot: join(f.dir, 'other') });
    assert.equal(other.stop(id, '外部服务不能停止')?.status, 'running');
    const foreignHost = { ...f.context.host, getJob: () => f.harness.runtime.getJob(id), stopJob: (jobId: string, reason: string) => other.stop(jobId, reason) };
    const refused = await tool('proc_stop').run({ job_id: id }, { ...f.context, host: foreignHost });
    assert.equal(refused.type, 'failed');
    assert.match(refused.content, /无法确认或停止/);
    other.dispose();
    assert.equal((await tool('proc_stop').run({ job_id: id, reason: '测试' }, f.context)).type, 'ok');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    assert.equal(f.harness.runtime.getJob(id)?.status, 'killed');
  } finally { await f.harness.cleanup(); }
});

test('后台作业登记等待、完成后唤醒，取消与超时保留各自原因', async () => {
  const f = await setup();
  try {
    const started = await tool('proc_run').run({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 250)'] }, f.context);
    const id = /job_[0-9a-f]+/.exec(started.content)?.[0];
    assert.ok(id);
    const waiting = await tool('proc_wait').run({ job_id: id, timeout_seconds: 4 }, f.context);
    assert.equal(waiting.type, 'wait');
    assert.equal(f.harness.store.listActiveWaitsForWorker(f.context.worker.id).length, 1);
    await waitFor(() => f.harness.runtime.getJob(id)?.status === 'exited');
    assert.equal(f.harness.store.listActiveWaitsForWorker(f.context.worker.id).length, 0);
    assert.match((await tool('proc_wait').run({ job_id: id }, f.context)).content, /exited/);
    assert.match((await tool('proc_list').run({}, f.context)).content, /exited/);

    const controller = new AbortController();
    const cancelled = await tool('proc_run').run({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'] }, { ...f.context, signal: controller.signal });
    const cancelledId = /job_[0-9a-f]+/.exec(cancelled.content)?.[0];
    assert.ok(cancelledId);
    controller.abort();
    assert.equal(f.harness.runtime.getJob(cancelledId)?.status, 'killed');
    assert.match(f.harness.runtime.getJob(cancelledId)?.error ?? '', /取消/);
  } finally { await f.harness.cleanup(); }
});

test('启动错误、已退出 stdin 和拆分写入的 UTF-8 都不会让宿主崩溃', async () => {
  const f = await setup();
  try {
    const missing = await tool('proc_run').run({ command: 'nonexistent-process-test-xyz', wait: true }, f.context);
    assert.equal(missing.type, 'failed');
    assert.match(missing.content, /failed|进程错误/);
    const run = await tool('proc_run').run({ command: process.execPath, args: ['-e', "process.stdin.destroy(); process.stdout.write(Buffer.from([0xe4])); setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),100)"], stdin: 'x'.repeat(2_000_000) }, f.context);
    const id = /job_[0-9a-f]+/.exec(run.content)?.[0];
    assert.ok(id);
    await waitFor(() => f.harness.runtime.getJob(id)?.status !== 'running');
    assert.equal(f.harness.runtime.readJob(id, 'stdout', 0, 10)?.text, '中');
    assert.throws(() => tool('proc_read').run({ job_id: id, offset: 0.5 }, f.context), /必须是整数/);
  } finally { await f.harness.cleanup(); }
});

test('无法确认主进程身份时拒绝重启且不向该 PID 发终止信号', async () => {
  const f = await setup();
  try {
    const runtimeDir = join(f.harness.config.workDir, '.runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, 'instance.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // tag 在临时空目录创建失败，不触碰项目仓库或任何 daemon。
    const oldCwd = process.cwd();
    process.chdir(f.dir);
    try {
      const result = await restartMainWithRollbackPoint(f.harness.config, { stopTimeoutMs: 1, heartbeatTimeoutMs: 1 });
      assert.equal(result.ok, false);
      assert.equal(result.stoppedMain, false);
      assert.match(result.message, /无法确认主系统身份/);
    } finally { process.chdir(oldCwd); }
  } finally { await f.harness.cleanup(); }
});

test('重启只接受本次新实例的新心跳，旧心跳不算成功', async () => {
  const f = await setup();
  const oldCwd = process.cwd();
  const pids: number[] = [];
  const logPath = join(f.harness.config.workDir, '.runtime', 'main.log');
  async function stopOwned(pid: number) {
    await writeFile(logPath, 'awaiting exit');
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 8000;
    while (!(await readFile(logPath, 'utf8')).includes('exit=')) {
      if (Date.now() > deadline) throw new Error(`子进程 ${pid} 的退出回调未完成`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const runtimeDir = join(f.harness.config.workDir, '.runtime');
    const instancePath = join(runtimeDir, 'instance.json');
    const heartbeatPath = join(runtimeDir, 'heartbeat.json');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(f.dir, 'src'), { recursive: true });
    await writeFile(instancePath, JSON.stringify({ stopped: true, pid: null, startedAt: 'old-instance' }));
    await writeFile(heartbeatPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    await writeFile(join(f.dir, 'src', 'main.ts'), 'setInterval(() => {}, 1000);');
    process.chdir(f.dir);
    const stale = await restartMainWithRollbackPoint(f.harness.config, { heartbeatTimeoutMs: 100, cooldownMs: 0 });
    if (stale.pid) pids.push(stale.pid);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /未看到新心跳/);
    assert.doesNotMatch(stale.message, /reset --hard/);
    if (stale.pid) { await stopOwned(stale.pid); pids.pop(); }

    const script = `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(instancePath)}, JSON.stringify({ pid: process.pid, startedAt: 'new-instance' }));\n` +
      `writeFileSync(${JSON.stringify(heartbeatPath)}, JSON.stringify({ pid: process.pid, at: Date.now() }));\n` +
      'setInterval(() => {}, 1000);';
    await writeFile(join(f.dir, 'src', 'main.ts'), script);
    const fresh = await restartMainWithRollbackPoint(f.harness.config, { heartbeatTimeoutMs: 2000, cooldownMs: 0 });
    if (fresh.pid) pids.push(fresh.pid);
    assert.equal(fresh.ok, true, fresh.message);
    assert.match(fresh.message, /新心跳已写入/);
  } finally {
    for (const pid of pids) await stopOwned(pid);
    process.chdir(oldCwd);
    await f.harness.cleanup();
  }
});
