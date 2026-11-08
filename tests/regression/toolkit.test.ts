import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { editTools } from '../../src/tools/edit.ts';
import { execTools } from '../../src/tools/exec.ts';
import { netTools } from '../../src/tools/net.ts';
import { artifactTools } from '../../src/tools/artifacts.ts';
import { capabilityTools } from '../../src/tools/capabilities.ts';
import type { ToolContext, ToolDefinition, ToolOutcome } from '../../src/tools/types.ts';
import type { Task, Worker } from '../../src/domain/types.ts';
import { createHarness, type Harness } from '../helpers.ts';

function tool(list: ToolDefinition[], name: string): ToolDefinition {
  const found = list.find((item) => item.name === name);
  assert.ok(found, `工具不存在：${name}`);
  return found;
}

interface Fixture {
  harness: Harness;
  context: ToolContext;
  taskId: string;
  worker: Worker;
  task: Task;
  dir: string;
}

async function setup(): Promise<Fixture> {
  const harness = await createHarness({
    worker: () => ({ text: 'ok', toolCalls: [], finishReason: 'stop' }) as never,
    // 本文件直接调用工具层，不需要调度器真的跑 Worker。
    limits: { maxConcurrentRuns: 0 },
  });
  const created = harness.runtime.createTask({
    title: '工具底座验证',
    goal: '验证文件、命令、作业与联网工具',
    ownerRole: '执行者',
    ownerBrief: '读文件、改文件、跑命令',
  });
  const dir = join(harness.config.workDir, created.task.id);
  await mkdir(join(dir, 'src'), { recursive: true });
  const context: ToolContext = {
    host: harness.runtime,
    worker: created.owner,
    task: created.task,
    workDir: harness.config.workDir,
    materialsDir: harness.config.materialsDir,
    signal: null,
  };
  return { harness, context, taskId: created.task.id, worker: created.owner, task: created.task, dir };
}

function text(outcome: ToolOutcome): string {
  return outcome.type === 'failed' ? `FAILED: ${outcome.content}` : outcome.content;
}

async function expectFail(promise: Promise<ToolOutcome> | ToolOutcome, pattern: RegExp): Promise<void> {
  try {
    const outcome = await promise;
    assert.equal(outcome.type, 'failed', `应当失败，实际：${text(outcome)}`);
    assert.match(outcome.content, pattern);
  } catch (error) {
    assert.match((error as Error).message, pattern);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
}

// ---------------- 文件 ----------------

test('文件：glob 查找、读取与精确编辑的三种结果', async () => {
  const fixture = await setup();
  try {
    await writeFile(join(fixture.dir, 'src', 'a.py'), 'print("a")\n', 'utf8');
    await writeFile(join(fixture.dir, 'src', 'b.py'), 'print("b")\n', 'utf8');
    await writeFile(join(fixture.dir, 'src', 'c.txt'), 'plain\n', 'utf8');

    const glob = await tool(editTools, 'fs_glob').run({ pattern: '**/*.py' }, fixture.context);
    assert.match(text(glob), /src\/a\.py/);
    assert.match(text(glob), /src\/b\.py/);
    assert.ok(!text(glob).includes('c.txt'), '不应匹配非目标类型');

    const stat = await tool(editTools, 'fs_stat').run({ path: 'src/a.py' }, fixture.context);
    assert.match(text(stat), /sha256/);
    const digest = /sha256：([0-9a-f]{12})/.exec(text(stat))?.[1];
    assert.ok(digest, '应给出指纹前缀');

    // 单处修改
    const edited = await tool(editTools, 'fs_edit').run(
      { path: 'src/a.py', old_string: 'print("a")', new_string: 'print("A")' },
      fixture.context,
    );
    assert.match(text(edited), /1 处规则/);
    assert.match(text(edited), /新的 sha256/);

    // 无匹配 → 失败且不改文件
    await expectFail(
      tool(editTools, 'fs_edit').run({ path: 'src/a.py', old_string: '不存在的内容', new_string: 'x' }, fixture.context),
      /没有找到原文/,
    );

    // 歧义 → 失败
    await writeFile(join(fixture.dir, 'src', 'd.txt'), 'dup\ndup\n', 'utf8');
    await expectFail(
      tool(editTools, 'fs_edit').run({ path: 'src/d.txt', old_string: 'dup', new_string: 'x' }, fixture.context),
      /存在歧义/,
    );

    // 指纹冲突 → 失败
    await expectFail(
      tool(editTools, 'fs_edit').run(
        { path: 'src/a.py', old_string: 'print("A")', new_string: 'print("B")', expected_sha256: 'deadbeefdead' },
        fixture.context,
      ),
      /文件已被改动/,
    );
  } finally {
    await fixture.harness.cleanup();
  }
});

test('文件：多处修改先整体校验，不会只改成功一半', async () => {
  const fixture = await setup();
  try {
    await writeFile(join(fixture.dir, 'src', 'multi.py'), 'alpha\nbeta\ngamma\n', 'utf8');
    // 第二处故意不匹配：整体应当失败，第一处也不能生效
    await expectFail(
      tool(editTools, 'fs_edit').run(
        {
          path: 'src/multi.py',
          edits: [
            { old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'not-there', new_string: 'X' },
          ],
        },
        fixture.context,
      ),
      /第 2 处修改没有找到原文/,
    );
    const after = await tool(editTools, 'fs_glob').run({ pattern: 'src/multi.py' }, fixture.context);
    assert.match(text(after), /multi\.py/);
    const read = await (await import('node:fs/promises')).readFile(join(fixture.dir, 'src', 'multi.py'), 'utf8');
    assert.equal(read, 'alpha\nbeta\ngamma\n', '失败的批量修改不能留下半成品');

    const ok = await tool(editTools, 'fs_edit').run(
      {
        path: 'src/multi.py',
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'gamma', new_string: 'GAMMA' },
        ],
      },
      fixture.context,
    );
    assert.match(text(ok), /共替换 2 个匹配/);
  } finally {
    await fixture.harness.cleanup();
  }
});

// ---------------- 命令与作业 ----------------

test('命令：真实进程的 stdout、stderr、退出码与标准输入', async () => {
  const fixture = await setup();
  try {
    const outcome = await tool(execTools, 'proc_run').run(
      {
        command: 'python3',
        args: ['-c', 'import sys; data=sys.stdin.read(); print("OUT:"+data.strip()); print("ERR", file=sys.stderr); sys.exit(3)'],
        stdin: 'hello',
        wait: true,
        wait_seconds: 15,
      },
      fixture.context,
    );
    const body = text(outcome);
    assert.match(body, /OUT:hello/);
    assert.match(body, /ERR/);
    assert.match(body, /退出码 3/);

    // 启动失败要能识别
    const failed = await tool(execTools, 'proc_run').run(
      { command: 'definitely-not-a-real-binary-xyz', args: [], wait: true, wait_seconds: 5 },
      fixture.context,
    );
    assert.match(text(failed), /未能启动|failed|进程错误/);
  } finally {
    await fixture.harness.cleanup();
  }
});

test('作业：后台运行、分页读取、等待唤醒与停止', async () => {
  const fixture = await setup();
  try {
    const started = await tool(execTools, 'proc_run').run(
      { command: 'python3', args: ['-c', 'import time\nfor i in range(30):\n    print("line", i, flush=True)\n    time.sleep(0.05)'] },
      fixture.context,
    );
    const jobId = /(job_[0-9a-f]+)/.exec(text(started))?.[1];
    assert.ok(jobId, `未返回作业 ID：${text(started)}`);

    const job = fixture.harness.runtime.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'running');

    await waitFor(() => (fixture.harness.runtime.getJob(jobId)?.status ?? 'running') !== 'running', 15_000);
    const finished = fixture.harness.runtime.getJob(jobId);
    assert.equal(finished?.status, 'exited');
    assert.equal(finished?.exitCode, 0);

    // 分页读取
    const part = await tool(execTools, 'proc_read').run({ job_id: jobId, limit: 30 }, fixture.context);
    assert.match(text(part), /line 0/);
    const offset = /继续请用 offset=(\d+)/.exec(text(part))?.[1];
    assert.ok(offset, '应提示后续偏移');
    const rest = await tool(execTools, 'proc_read').run({ job_id: jobId, offset: Number(offset) }, fixture.context);
    assert.match(text(rest), /line 2\d/);

    // 停止：连同子进程一起结束
    const longRunning = await tool(execTools, 'proc_run').run(
      { command: 'python3', args: ['-c', 'import time; time.sleep(60)'] },
      fixture.context,
    );
    const longId = /(job_[0-9a-f]+)/.exec(text(longRunning))?.[1]!;
    const stop = await tool(execTools, 'proc_stop').run({ job_id: longId, reason: '测试停止' }, fixture.context);
    assert.match(text(stop), /killed/);
    const stopped = fixture.harness.runtime.getJob(longId);
    assert.equal(stopped?.status, 'killed');
  } finally {
    await fixture.harness.cleanup();
  }
});

test('作业：执行超时会终止进程并记录原因', async () => {
  const fixture = await setup();
  try {
    const started = await tool(execTools, 'proc_run').run(
      { command: 'python3', args: ['-c', 'import time; time.sleep(60)'], timeout_seconds: 1 },
      fixture.context,
    );
    const jobId = /(job_[0-9a-f]+)/.exec(text(started))?.[1]!;
    await waitFor(() => (fixture.harness.runtime.getJob(jobId)?.status ?? 'running') !== 'running', 15_000);
    const job = fixture.harness.runtime.getJob(jobId);
    assert.equal(job?.status, 'timeout');
    assert.match(job?.error ?? '', /超过执行时限/);
  } finally {
    await fixture.harness.cleanup();
  }
});

// ---------------- 网络 ----------------

test('网络：真实 HTTP 服务的正文、重定向、404 与大小限制', async () => {
  const fixture = await setup();
  const big = 'x'.repeat(5000);
  const server: Server = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body><h1>标题</h1><script>bad()</script><p>正文段落</p></body></html>');
      return;
    }
    if (request.url === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/json' });
      response.end();
      return;
    }
    if (request.url === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(big);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const page = await tool(netTools, 'net_fetch').run({ url: `http://127.0.0.1:${port}/page` }, fixture.context);
    const body = text(page);
    assert.match(body, /状态码：200/);
    assert.match(body, /标题/);
    assert.match(body, /正文段落/);
    assert.ok(!body.includes('bad()'), '脚本内容应被剥离');

    const redirect = await tool(netTools, 'net_fetch').run({ url: `http://127.0.0.1:${port}/redirect` }, fixture.context);
    assert.match(text(redirect), /\/json/);
    assert.match(text(redirect), /"ok":true/);

    const missing = await tool(netTools, 'net_fetch').run({ url: `http://127.0.0.1:${port}/nope` }, fixture.context);
    assert.match(text(missing), /状态码：404/);

    const limited = await tool(netTools, 'net_fetch').run(
      { url: `http://127.0.0.1:${port}/big`, max_bytes: 1024, save_to: 'downloads/big.txt' },
      fixture.context,
    );
    assert.match(text(limited), /已截断|已保存/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.harness.cleanup();
  }
});

test('网络：没有搜索凭据时明确报错，不返回伪造结果', async () => {
  const fixture = await setup();
  const saved = { key: process.env['SEARCH_API_KEY'], tavily: process.env['TAVILY_API_KEY'] };
  delete process.env['SEARCH_API_KEY'];
  delete process.env['TAVILY_API_KEY'];
  try {
    await expectFail(
      tool(netTools, 'net_search').run({ query: '测试' }, fixture.context),
      /尚未配置搜索服务凭据/,
    );
  } finally {
    if (saved.key !== undefined) process.env['SEARCH_API_KEY'] = saved.key;
    if (saved.tavily !== undefined) process.env['TAVILY_API_KEY'] = saved.tavily;
    await fixture.harness.cleanup();
  }
});

// ---------------- 产物与能力 ----------------

test('产物：导入真实二进制文件，指纹一致且源文件改动不影响已登记版本', async () => {
  const fixture = await setup();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await writeFile(join(fixture.dir, 'chart.png'), png);
    const imported = await tool(artifactTools, 'artifact_import').run({ source: 'chart.png' }, fixture.context);
    const body = text(imported);
    assert.match(body, /已登记产物 chart\.png v1/);
    assert.match(body, /12 字节/);

    // 源文件改动不影响已登记快照
    await writeFile(join(fixture.dir, 'chart.png'), Buffer.from([9, 9, 9]));
    const listed = await tool(artifactTools, 'artifact_list').run({}, fixture.context);
    assert.match(text(listed), /chart\.png v1/);
    const artifacts = fixture.harness.store.listArtifacts(fixture.taskId);
    const saved = artifacts.find((item) => item.name === 'chart.png');
    assert.equal(saved?.bytes, 12);
    assert.equal(saved?.sha256, (await import('node:crypto')).createHash('sha256').update(png).digest('hex'));

    // 相同内容再次导入 → 复用，不新增版本
    await writeFile(join(fixture.dir, 'same.txt'), 'same', 'utf8');
    await tool(artifactTools, 'artifact_import').run({ source: 'same.txt' }, fixture.context);
    const again = await tool(artifactTools, 'artifact_import').run({ source: 'same.txt' }, fixture.context);
    assert.match(text(again), /已复用/);
  } finally {
    await fixture.harness.cleanup();
  }
});

test('能力：报告环境状态但不泄露密钥', async () => {
  const fixture = await setup();
  try {
    const outcome = await tool(capabilityTools, 'env_capabilities').run({}, fixture.context);
    const body = text(outcome);
    assert.match(body, /任务目录/);
    assert.match(body, /python3：可用/);
    assert.match(body, /net_fetch/);
    assert.match(body, /图片视觉输入/);
    assert.ok(!body.includes(fixture.harness.config.apiKey), '不能输出模型密钥');
  } finally {
    await fixture.harness.cleanup();
  }
});

test('取消：任务取消会终止在途进程，而不是只改状态', async () => {
  const fixture = await setup();
  try {
    const started = await tool(execTools, 'proc_run').run(
      { command: 'python3', args: ['-c', 'import time; time.sleep(120)'] },
      fixture.context,
    );
    const jobId = /(job_[0-9a-f]+)/.exec(text(started))?.[1]!;
    assert.equal(fixture.harness.runtime.getJob(jobId)?.status, 'running');

    await fixture.harness.runtime.stopTask(fixture.taskId, '用户取消');
    const job = fixture.harness.runtime.getJob(jobId);
    assert.equal(job?.status, 'killed');
    // 进程确实不在了：再等一会儿状态不会再变化
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fixture.harness.runtime.getJob(jobId)?.status, 'killed');
  } finally {
    await fixture.harness.cleanup();
  }
});

test('重启恢复：遗留的 running 作业标记为结果未知，不重放也不误杀', async () => {
  const fixture = await setup();
  try {
    const started = await tool(execTools, 'proc_run').run(
      { command: 'python3', args: ['-c', 'import time; time.sleep(0.3)'] },
      fixture.context,
    );
    const jobId = /(job_[0-9a-f]+)/.exec(text(started))?.[1]!;

    // 模拟「程序在上次运行时没有记录到结束」：把状态改回 running
    const job = fixture.harness.store.getJob(jobId)!;
    job.status = 'running';
    job.endedAt = null;
    job.exitCode = null;
    fixture.harness.store.updateJob(job);

    const { ProcessService } = await import('../../src/runtime/process.ts');
    const recovered = new ProcessService({
      store: fixture.harness.store,
      logRoot: join(fixture.harness.config.workDir, '.jobs'),
    });
    assert.equal(recovered.recover(), 1);
    const after = fixture.harness.store.getJob(jobId)!;
    assert.equal(after.status, 'unknown');
    assert.match(after.error ?? '', /执行结果未知/);
  } finally {
    await fixture.harness.cleanup();
  }
});

test('大输出：完整日志可从作业里按 offset 读回，错误码不会被裁剪掉', async () => {
  const fixture = await setup();
  try {
    const started = await tool(execTools, 'proc_run').run(
      {
        command: 'python3',
        args: ['-c', 'print("A"*3000); print("B"*3000); import sys; sys.exit(7)'],
        wait: true,
        wait_seconds: 20,
      },
      fixture.context,
    );
    const body = text(started);
    assert.match(body, /退出码 7/, '退出码必须出现在结果里');
    const jobId = (await tool(execTools, 'proc_list').run({}, fixture.context)).content
      .split('\n')[0]!
      .split('｜')[0]!;
    const all = fixture.harness.runtime.readJob(jobId, 'stdout', 0, 100_000);
    assert.ok((all?.total ?? 0) >= 6001, '完整输出仍在作业日志里');
  } finally {
    await fixture.harness.cleanup();
  }
});

test('唤醒：等待中的 Worker 收到系统通知后会被唤醒，不会一直挂着', async () => {
  const harness = await createHarness({ worker: () => ({ text: 'ok', toolCalls: [], finishReason: 'stop' }) as never });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '唤醒', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    const helper = harness.runtime.createCollaborator(owner, '协作者', '干活');
    // owner 进入等待，等 helper 的回复
    harness.runtime.registerWait(owner, { from: helper.workerId!, timeoutMs: 60_000 });
    harness.store.setWorkerStatus(owner.id, 'waiting');
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id).length, 1);

    // 协作者失败：系统通知必须叫醒等待者，而不是让它一直等一个不会再回话的人
    harness.runtime.notifySystem(owner.id, `协作者 ${helper.workerId} 失败：步数达到上限 24`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.store.listActiveWaitsForWorker(owner.id).length, 0, '等待应被解除');
    // 被唤醒后不再停留在 waiting，而是重新进入调度
    assert.notEqual(harness.store.getWorker(owner.id)?.status, 'waiting');
    void task;
  } finally {
    await harness.cleanup();
  }
});
