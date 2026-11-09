/**
 * 维护闭环反例：命令执行成功，但业务没有改善。
 *
 * 期望：问题保持未解决，并记录"没有改善"的复查结论。
 * 如果脚本把这种情况也判成"维护成功"，就说明判据只看了命令回执。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'sa-maint-neg-'));
const workDir = join(dir, 'work');
const dbPath = join(dir, 'db.sqlite');
mkdirSync(join(workDir, '.runtime'), { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

let busyCalls = 0;
let wdCalls = 0;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c.toString();
  });
  req.on('end', () => {
    let parsed: { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: string }[] } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
    const toolNames = (parsed.tools ?? []).map((item) => item.function?.name ?? '');
    const isWatchdog = toolNames.includes('check_main') || toolNames.includes('restart_main');
    const toolOutputs = (parsed.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => m.content ?? '')
      .join('\n');

    const reply = (name: string, args: Record<string, unknown>, id: string): unknown => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    let payload: unknown;
    if (isWatchdog) {
      wdCalls += 1;
      const issued = toolOutputs.includes('已提交维护命令');
      if (!issued) {
        payload = reply(
          'maintain',
          {
            action: 'nudge_worker',
            issue_id: 'wdi_stuck',
            task_id: 'task_stuck',
            worker_id: 'w1_stuck',
            text: '请推进交付。',
            reason: '负责人长时间没有产出',
            expected: '产出 deliverable.md',
          },
          `w${wdCalls}`,
        );
      } else {
        // 复查：业务没有任何改善，如实记录，保持问题未解决
        payload = reply(
          'record',
          {
            issue_id: 'wdi_stuck',
            status: 'open',
            title: '负责人在重复同一个无效动作',
            note: '复查：命令已执行，但 spins.txt 仍只有同一行，没有产出 deliverable.md，问题未改善',
            check_after_minutes: 5,
          },
          `w${wdCalls}`,
        );
      }
    } else {
      // 业务：无论收到什么提醒，都只重复同一个无效动作
      busyCalls += 1;
      payload = reply('fs_write', { path: 'spins.txt', content: '同一件事\n' }, `b${busyCalls}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DB_PATH: dbPath,
  WORK_DIR: workDir,
  OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
  OLLAMA_API_KEY: 'local',
  MODEL_NAME: 'local',
  MODEL_CONCURRENCY: '1',
  MODEL_RETRY: '1',
  MAX_STEPS_PER_RUN: '3',
  WATCHDOG_INTERVAL_MS: '6000',
};

let main: ReturnType<typeof spawn> | null = null;
let wd: ReturnType<typeof spawn> | null = null;

try {
  const inject = spawn(
    process.execPath,
    [
      '-e',
      `import('./src/storage/store.ts').then(async ({ Store }) => {
         const { loadConfig } = await import('./src/config.ts');
         const config = loadConfig();
         const store = new Store(config.dbPath);
         const now = new Date().toISOString();
         store.createTask({
           id: 'task_stuck', groupId: 'grp_stuck', title: '不会改善的任务',
           goal: '交付 deliverable.md', brief: '', doneCriteria: '产物已提交',
           requireReview: false, reviewEpoch: 0, ownerWorkerId: null,
           status: 'active', closeReason: null, createdAt: now, updatedAt: now, closedAt: null,
         });
         store.createWorker({
           id: 'w1_stuck', groupId: 'grp_stuck', parentId: null, role: '执行者', brief: '只会重复',
           status: 'queued', model: null, stepCount: 0, createdAt: now, updatedAt: now, lastError: null,
         });
         store.setTaskOwner('task_stuck', 'w1_stuck');
         store.upsertWdIssue({
           id: 'wdi_stuck', taskId: 'task_stuck',
           title: '负责人在重复同一个无效动作',
           note: 'spins.txt 反复被写成同一行', checkAfter: null,
         });
         store.close();
         console.log('injected');
       }).catch((e) => { console.error(e); process.exit(1); });`,
    ],
    { cwd: root, env, stdio: 'pipe' },
  );
  await new Promise((resolve) => inject.on('exit', resolve));

  main = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const spins = join(workDir, 'task_stuck', 'spins.txt');
  for (let i = 0; i < 200 && !existsSync(spins); i += 1) await sleep(100);
  check(existsSync(spins), '业务已开始重复无效动作');

  wd = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });

  // 等命令执行完
  let commandDone = false;
  for (let i = 0; i < 400; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status FROM control_command WHERE command = 'nudge_worker' LIMIT 1").get() as
      | { status: string }
      | undefined;
    db.close();
    if (row?.status === 'done') {
      commandDone = true;
      break;
    }
    await sleep(100);
  }
  check(commandDone, '维护命令已被主系统执行（回执 done）');

  // 等复查结论写回
  let note = '';
  let status = 'open';
  for (let i = 0; i < 600; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status, note FROM wd_issue WHERE id = 'wdi_stuck'").get() as
      | { status: string; note: string | null }
      | undefined;
    db.close();
    if (row) {
      status = row.status;
      note = row.note ?? '';
      if (note.includes('未改善')) break;
    }
    await sleep(100);
  }

  const content = existsSync(spins) ? readFileSync(spins, 'utf8') : '';
  log(`spins.txt：${JSON.stringify(content)}`);
  log(`问题状态：${status}｜结论：${note.slice(0, 120)}`);

  check(!existsSync(join(workDir, 'task_stuck', 'artifacts', 'v1', 'deliverable.md')), '业务确实没有改善（没有交付物）');
  check(status === 'open', `问题必须保持未解决（实际 ${status}）`);
  check(/未改善|没有产出|没有.*deliverable/.test(note), `复查结论要写明没有改善（实际：${note.slice(0, 80)}）`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const closedActions = db.prepare("SELECT COUNT(*) AS c FROM wd_action WHERE action = 'record'").get() as { c: number };
  db.close();
  log(`record 动作次数：${closedActions.c}`);
} catch (error) {
  check(false, `脚本异常：${(error as Error).message}`);
} finally {
  wd?.kill('SIGTERM');
  main?.kill('SIGTERM');
  await sleep(1000);
  server.close();
  if (failures.length === 0) rmSync(dir, { recursive: true, force: true });
  else console.log(`工作目录保留：${dir}`);
}

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('\n验收通过（反例：未改善时问题保持未解决）');
process.exit(0);
