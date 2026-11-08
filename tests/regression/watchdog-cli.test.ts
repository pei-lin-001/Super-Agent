/**
 * Watchdog 命令行入口的进程级验证。
 *
 * 只调用 Session 方法证明不了命令行行为：本轮缺陷正好出在「先抢锁、后判断模式」。
 * 所以这里全部用真实子进程 + 真实单实例锁 + 真实问题队列。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

interface Env {
  dir: string;
  workDir: string;
  dbPath: string;
  port: number;
  env: NodeJS.ProcessEnv;
  close: () => Promise<void>;
}

async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-wdcli-'));
  const workDir = join(dir, 'work');
  const dbPath = join(dir, 'db.sqlite');
  mkdirSync(join(workDir, '.runtime'), { recursive: true });
  let count = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `维护结论 ${count}：数据层可读，调度层状态如上。` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_PATH: dbPath,
    WORK_DIR: workDir,
    OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OLLAMA_API_KEY: 'test',
    MODEL_NAME: 'local',
    MODEL_RETRY: '1',
    WATCHDOG_INTERVAL_MS: '4000',
  };
  return {
    dir,
    workDir,
    dbPath,
    port,
    env,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runCli(env: NodeJS.ProcessEnv, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/watchdog/main.ts', ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('已有常驻维护者时，另一个进程提交问题并被处理，随后可查询', async () => {
  const ctx = await makeEnv();
  let resident: ChildProcess | null = null;
  try {
    // 停机标记：让维护者不要顺手拉起主系统，把注意力放在问答上
    writeFileSync(join(ctx.workDir, '.runtime', 'watchdog.stop'), '', 'utf8');
    resident = spawn(process.execPath, ['src/watchdog/main.ts'], {
      cwd: root,
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let residentOut = '';
    resident.stdout?.on('data', (chunk: Buffer) => {
      residentOut += chunk.toString();
    });
    resident.stderr?.on('data', (chunk: Buffer) => {
      residentOut += chunk.toString();
    });
    const started = await waitFor(() => residentOut.includes('Watchdog 启动'), 15_000);
    assert.ok(started, `常驻维护者必须真的启动，输出：${residentOut.slice(-300)}`);

    // 客户端提交问题：不能被单实例锁挡在问答逻辑之外
    const ask = await runCli(ctx.env, ['--ask', '主系统现在是什么状态？'], 40_000);
    assert.equal(ask.code, 0, `--ask 应成功返回，实际退出码 ${ask.code}，输出：${ask.out}`);
    assert.match(ask.out, /维护结论/, '必须拿到回答');

    const id = /wdq_[a-z0-9]+/.exec(ask.out)?.[0] ?? '';
    assert.ok(id !== '', '回答里应包含问题 ID');

    // --answer 查询：不抢锁、不恢复作业、不启动模型会话
    const answer = await runCli(ctx.env, ['--answer', id], 15_000);
    assert.equal(answer.code, 0, `--answer 应成功，输出：${answer.out}`);
    assert.match(answer.out, /维护结论/, '查询应能读到之前的回答');
  } finally {
    resident?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.close();
  }
});

test('第二个维护者启动失败时，不改动现有维护者的作业', async () => {
  const ctx = await makeEnv();
  let first: ChildProcess | null = null;
  try {
    writeFileSync(join(ctx.workDir, '.runtime', 'watchdog.stop'), '', 'utf8');
    first = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let firstOut = '';
    first.stdout?.on('data', (chunk: Buffer) => {
      firstOut += chunk.toString();
    });
    assert.ok(await waitFor(() => firstOut.includes('Watchdog 启动'), 15_000), '第一个维护者应启动');

    // 在第一个维护者名下制造一个运行中的作业
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(ctx.dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO process_job (id, task_id, worker_id, command, args_json, cwd, pid, status, exit_code,
         signal, scope, stdout_path, stderr_path, timeout_ms, started_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job_wd_running', 'watchdog', 'watchdog', 'sleep', '["30"]', ctx.workDir, null, 'running', null,
      null, 'watchdog', '/dev/null', '/dev/null', 30_000, now, null, null);
    db.close();

    // 第二个维护者：必须因为已有实例而退出，且不能把上面的作业标成 unknown
    const second = await runCli(ctx.env, [], 15_000);
    assert.notEqual(second.code, 0, '第二个维护者不应成功启动');

    const check = new DatabaseSync(ctx.dbPath, { readOnly: true });
    const row = check.prepare("SELECT status FROM process_job WHERE id = 'job_wd_running'").get() as { status: string };
    check.close();
    assert.equal(row.status, 'running', '现有维护者的作业状态不能被第二个实例改动');

    // 业务作业不受影响
    const biz = new DatabaseSync(ctx.dbPath, { readOnly: true });
    const bizRow = biz.prepare("SELECT COUNT(*) AS c FROM process_job WHERE scope = 'biz'").get() as { c: number };
    biz.close();
    assert.equal(bizRow.c, 0, '维护者不应创建业务作业');
  } finally {
    first?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.close();
  }
});

test('巡检执行期间提交的问题按串行顺序处理', async () => {
  const ctx = await makeEnv();
  let resident: ChildProcess | null = null;
  try {
    writeFileSync(join(ctx.workDir, '.runtime', 'watchdog.stop'), '', 'utf8');
    resident = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    resident.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    assert.ok(await waitFor(() => out.includes('Watchdog 启动'), 15_000), '维护者应启动');

    // 连发两个问题：都应该被处理，顺序按入队
    const [a, b] = await Promise.all([
      runCli(ctx.env, ['--ask', '第一个问题：任务还在跑吗？'], 60_000),
      runCli(ctx.env, ['--ask', '第二个问题：有没有空转？'], 60_000),
    ]);
    assert.equal(a.code, 0, `第一个问题应被处理：${a.out}`);
    assert.equal(b.code, 0, `第二个问题应被处理：${b.out}`);

    const idA = /wdq_[a-z0-9]+/.exec(a.out)?.[0] ?? '';
    const idB = /wdq_[a-z0-9]+/.exec(b.out)?.[0] ?? '';
    assert.ok(idA !== '' && idB !== '', '两个问题都应有 ID');
    assert.notEqual(idA, idB, '两个问题必须是不同的记录');

    const answerA = await runCli(ctx.env, ['--answer', idA], 15_000);
    const answerB = await runCli(ctx.env, ['--answer', idB], 15_000);
    assert.match(answerA.out, /done|维护结论/, `第一个问题应有结果：${answerA.out}`);
    assert.match(answerB.out, /done|维护结论/, `第二个问题应有结果：${answerB.out}`);
  } finally {
    resident?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.close();
  }
});
