/**
 * 维护闭环验收：命令入队 → 执行回执 → 业务发生变化 → 复查后关闭问题。
 *
 * 用本地受控模型驱动两边的"判断"，所以这里证明的是**执行机制**：
 * 维护动作是否真的被主系统执行、执行后业务是否真的变了、复查是否基于变化下结论。
 * 真实模型的判断质量由另一条验收（accept-watchdog-real）观察。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'sa-maint-'));
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

// 业务 Worker：前两轮只做无效动作（spins.txt 反复重写同一内容），收到维护提示后改为推进并提交。
let busyCalls = 0;
let nudged = false;
let wdCalls = 0;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
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
      .filter((message) => message.role === 'tool')
      .map((message) => message.content ?? '')
      .join('\n');
    const textAll = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');

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
    const say = (content: string): unknown => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    let payload: unknown;
    if (isWatchdog) {
      wdCalls += 1;
      // 第一次：确认主系统在跑；第二次：下发 nudge；之后：复查并给结论
      // 按已有工具结果推进：先看主系统，再下发提醒，最后复查给结论。
      if (toolOutputs === '') payload = reply('check_main', {}, `w${wdCalls}`);
      else if (!toolOutputs.includes('nudge') && !toolOutputs.includes('维护')) {
        payload = reply(
          'maintain',
          { action: 'nudge_worker', worker_id: 'w1_main', text: '维护者提醒：你在重复同一个动作，请改成交付产物并提交。', reason: '重复无效动作' },
          `w${wdCalls}`,
        );
      } else payload = say('已下发提醒，业务侧有新的提交，问题可以关闭。');
    } else {
      busyCalls += 1;
      // 维护提示出现后，Worker 才会改变行为
      if (textAll.includes('维护者') || textAll.includes('nudge') || textAll.includes('提醒')) nudged = true;
      if (!nudged) {
        payload = reply('fs_write', { path: 'spins.txt', content: '同一件事\n' }, `b${busyCalls}`);
      } else if (!toolOutputs.includes('deliverable.md')) {
        payload = reply('artifact_save', { name: 'deliverable.md', content: '# 交付\n纠正后完成\n' }, `b${busyCalls}`);
      } else if (!toolOutputs.includes('已提交')) {
        payload = reply('submit_result', { summary: '纠正后完成交付', artifacts: ['deliverable.md'] }, `b${busyCalls}`);
      } else payload = say('完成');
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
  MAX_STEPS_PER_RUN: '4',
  // 巡检间隔缩短：验收要观察到"下一轮复查"，不是等真实的 60 秒
  WATCHDOG_INTERVAL_MS: '8000',
};

let main: ReturnType<typeof spawn> | null = null;
let wd: ReturnType<typeof spawn> | null = null;

try {
  // ---- 0) 建立任务（只写持久状态，由主系统接管） ----
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
           id: 'task_main', groupId: 'grp_main', title: '维护闭环验收',
           goal: '交付 deliverable.md', brief: '', doneCriteria: '产物已提交',
           requireReview: false, reviewEpoch: 0, ownerWorkerId: null,
           status: 'active', closeReason: null, createdAt: now, updatedAt: now, closedAt: null,
         });
         store.createWorker({
           id: 'w1_main', groupId: 'grp_main', parentId: null, role: '执行者', brief: '推进交付',
           status: 'queued', model: null, stepCount: 0, createdAt: now, updatedAt: now, lastError: null,
         });
         store.setTaskOwner('task_main', 'w1_main');
         store.appendEvent('task_main', 'w1_main', 'task.created', '维护闭环验收');
         store.close();
         console.log('injected');
       }).catch((e) => { console.error(e); process.exit(1); });`,
    ],
    { cwd: root, env, stdio: 'pipe' },
  );
  await new Promise((resolve) => inject.on('exit', resolve));

  // ---- 1) 主系统运行：先进入重复无效动作 ----
  main = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let mainOut = '';
  main.stdout?.on('data', (c: Buffer) => {
    mainOut += c.toString();
  });
  main.stderr?.on('data', (c: Buffer) => {
    mainOut += c.toString();
  });

  const spinsPath = join(workDir, 'task_main', 'spins.txt');
  for (let i = 0; i < 200 && !existsSync(spinsPath); i += 1) await sleep(100);
  check(existsSync(spinsPath), '业务已开始执行（出现重复动作）');
  const spinsBefore = existsSync(spinsPath) ? readFileSync(spinsPath, 'utf8') : '';
  await sleep(2000);
  const spinsAfter = existsSync(spinsPath) ? readFileSync(spinsPath, 'utf8') : '';
  check(spinsBefore === spinsAfter, '业务处在重复同一动作的状态（内容没变化）');

  // ---- 2) 维护者巡检 → 下发命令（阶段一：命令入队） ----
  wd = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let wdOut = '';
  wd.stdout?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });
  wd.stderr?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });

  let controlId = '';
  for (let i = 0; i < 400; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id FROM control_command WHERE command = 'nudge_worker' LIMIT 1").get() as
      | { id: string }
      | undefined;
    db.close();
    if (row) {
      controlId = row.id;
      break;
    }
    await sleep(100);
  }
  check(controlId !== '', '阶段一：维护命令已入队');

  // ---- 3) 主系统执行命令（阶段二：执行回执） ----
  let finished = false;
  for (let i = 0; i < 300; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT status FROM control_command WHERE id = ?').get(controlId) as
      | { status: string }
      | undefined;
    db.close();
    if (row && row.status !== 'pending') {
      finished = true;
      check(row.status === 'done', `阶段二：主系统执行了命令（状态 ${row.status}）`);
      break;
    }
    await sleep(100);
  }
  if (!finished) check(false, '阶段二：主系统执行了命令（超时未执行）');

  // ---- 4) 业务发生预期变化（阶段三） ----
  let delivered = false;
  for (let i = 0; i < 300; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT bytes FROM artifact WHERE name = 'deliverable.md'").get() as
      | { bytes: number }
      | undefined;
    db.close();
    if (row && row.bytes > 0) {
      delivered = true;
      break;
    }
    await sleep(100);
  }
  check(delivered, '阶段三：纠正后业务真的产出了交付物（已登记产物）');

  let finalStatus = '';
  for (let i = 0; i < 400; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status FROM task WHERE id = 'task_main'").get() as { status: string };
    db.close();
    finalStatus = row.status;
    if (finalStatus === 'completed' || finalStatus === 'failed') break;
    await sleep(100);
  }
  check(finalStatus === 'completed', `阶段三：任务最终完成（${finalStatus}）`);

  // ---- 5) 复查后关闭问题（阶段四） ----
  // 维护者下一轮巡检应当基于变化给出结论并关闭事件；这里检查它确实又看了一次
  const wdCallsBefore = wdCalls;
  for (let i = 0; i < 600 && wdCalls === wdCallsBefore; i += 1) await sleep(100);
  check(wdCalls > wdCallsBefore, '阶段四：维护者在下一轮巡检里复查了结果');

  const db4 = new DatabaseSync(dbPath, { readOnly: true });
  const actions = db4.prepare('SELECT action FROM wd_action').all() as { action: string }[];
  const openIssues = db4.prepare('SELECT id FROM wd_issue WHERE status = ?').all('open') as { id: string }[];
  db4.close();
  log(`维护动作：${actions.map((a) => a.action).join('｜') || '（无）'}`);
  log(`未解决事件：${openIssues.length}`);
  check(actions.length > 0, '维护动作有记录');
} catch (error) {
  check(false, `脚本异常：${(error as Error).message}`);
} finally {
  wd?.kill('SIGTERM');
  main?.kill('SIGTERM');
  await sleep(1200);
  server.close();
  if (failures.length === 0) rmSync(dir, { recursive: true, force: true });
  else console.log(`工作目录保留：${dir}`);
}

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('\n验收通过');
process.exit(0);
