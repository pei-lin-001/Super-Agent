/**
 * 真实模型验收 3：常驻 Watchdog 运行时，另一个进程提交自然语言问题并拿到回答。
 *
 * 判定条件：
 * - 常驻维护者真的启动（有自己的 pid 与单实例锁）；
 * - 客户端进程提交问题时没有被"已有实例"挡掉；
 * - 回答来自模型，不是程序拼的固定话术；
 * - 记账里有 watchdog 用途的调用记录。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'sa-wd-real-'));
const workDir = join(dir, 'work');
const dbPath = join(dir, 'db.sqlite');
mkdirSync(join(workDir, '.runtime'), { recursive: true });
// 不让维护者顺手拉起主系统：本次只验证问答链路。
writeFileSync(join(workDir, '.runtime', 'watchdog.stop'), '', 'utf8');

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DB_PATH: dbPath,
  WORK_DIR: workDir,
  WATCHDOG_INTERVAL_MS: '120000',
  // 真实模型调查一个问题可能要十分钟以上；客户端只是"先返回 ID"，不该被当成失败。
  WATCHDOG_ASK_WAIT_MS: '900000',
};

const failures: string[] = [];
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const runCli = (args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'src/watchdog/main.ts', ...args], {
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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

let resident: ChildProcess | null = null;
try {
  resident = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'src/watchdog/main.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  resident.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  resident.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const started = Date.now();
  while (Date.now() - started < 30_000 && !out.includes('Watchdog 启动')) await sleep(300);
  check(out.includes('Watchdog 启动'), '常驻维护者已启动');
  check(readFileSync(join(workDir, '.runtime', 'watchdog.json'), 'utf8').includes('pid'), '写出了自己的实例文件');

  const ask = await runCli(['--ask', '现在主系统是什么状态？数据层能不能读到东西？说清楚哪些是确认的、哪些还不能确认。'], 600_000);
  console.log(`\n--- 提问输出 ---\n${ask.out.slice(-2500)}\n`);
  check(ask.code === 0, `客户端提交并拿到回答（退出码 ${ask.code}）`);
  const answer = ask.out.split('---').slice(1).join('---').trim();
  // 连续第二轮：会带上第一轮的对话历史，检验"历史结构合法、且能延续推理"。
  const ask2 = await runCli(['--ask', '上一轮你说过哪些还不能确认的部分？只依据已有记录回答。'], 600_000);
  check(ask2.code === 0, `第二轮客户端拿到回答（退出码 ${ask2.code}）`);
  const answer2 = ask2.out.split('---').slice(1).join('---').trim();
  check(answer2.length > 40, `第二轮回答有实质内容（${answer2.length} 字）`);
  console.log(`\n--- 第二轮输出 ---\n${ask2.out.slice(-1500)}\n`);
  check(answer.length > 20, `回答有实质内容（${answer.length} 字）`);

  const id = /wdq_[a-z0-9]+/.exec(ask.out)?.[0] ?? '';
  check(id !== '', '问题有持久 ID');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const calls = db.prepare("SELECT COUNT(*) AS c FROM model_call WHERE purpose = 'watchdog'").get() as { c: number };
  const turns = db.prepare('SELECT COUNT(*) AS c FROM wd_turn').get() as { c: number };
  db.close();
  console.log(`维护者模型调用：${calls.c} 次｜对话记录：${turns.c} 条`);
  check(calls.c >= 1, '维护问答的模型调用被记账');
} finally {
  resident?.kill('SIGTERM');
  await sleep(1000);
  if (failures.length === 0) rmSync(dir, { recursive: true, force: true });
  else console.log(`工作目录保留：${dir}`);
}

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('\n验收通过');
process.exit(0);
