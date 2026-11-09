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
      // 严格围绕同一个 issue 推进；只有读到真实变化才关闭它。
      // 只看结构化证据行："产物：deliverable.md v1" 才是登记过，
      // 任务目标、期望描述里提到同名文件都不算。
      const seenDeliverable = /产物[：:]\s*deliverable\.md/.test(toolOutputs);
      const issuedCommand = toolOutputs.includes('已提交维护命令');
      if (!issuedCommand) {
        payload = reply(
          'maintain',
          {
            action: 'nudge_worker',
            issue_id: 'wdi_spin',
            task_id: 'task_main',
            worker_id: 'w1_main',
            text: '维护者提醒：你在重复同一个动作，请改成交付产物并提交。',
            reason: '负责人在重复同一个无效动作',
            expected: '产出 deliverable.md 并提交',
          },
          `w${wdCalls}`,
        );
      } else if (!seenDeliverable) {
        // 命令已入队但还没看到业务变化：继续观察，不关闭问题
        payload = reply('inspect_task', { task_id: 'task_main' }, `w${wdCalls}`);
      } else {
        payload = reply(
          'record',
          {
            issue_id: 'wdi_spin',
            status: 'closed',
            note: '复查到 deliverable.md 已登记且任务完成，问题解决',
          },
          `w${wdCalls}`,
        );
      }
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
         // 先记录一个具体的未解决问题：后面要检查的是这同一个问题被关闭。
         // 任务目标里提到产物名，用来验证"目标里出现文件名"不会被当成产物存在
         store.upsertWdIssue({
           id: 'wdi_spin',
           taskId: 'task_main',
           title: '负责人在重复同一个无效动作',
           note: 'spins.txt 反复被写成同一行，没有产出',
           checkAfter: null,
         });
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

  // ---- 5) 复查后关闭同一个问题（阶段四） ----
  // 判定依据是"同一个 issue 从 open 变成 closed，且关闭前读到过真实变化"，
  // 不是"模型又调用了一次"。
  let issueClosed = false;
  let issueNote = '';
  for (let i = 0; i < 900; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status, note FROM wd_issue WHERE id = 'wdi_spin'").get() as
      | { status: string; note: string | null }
      | undefined;
    db.close();
    if (row?.status === 'closed') {
      issueClosed = true;
      issueNote = row.note ?? '';
      break;
    }
    await sleep(100);
  }
  check(issueClosed, '阶段四：同一个问题被关闭');
  check(/deliverable/i.test(issueNote), `阶段四：关闭理由引用了真实业务证据（${issueNote.slice(0, 80)}）`);

  // 关联检查：issue → action → command 必须是同一条链
  const db4 = new DatabaseSync(dbPath, { readOnly: true });
  const action = db4.prepare("SELECT issue_id, command_id, action FROM wd_action WHERE action = 'nudge_worker'").get() as
    | { issue_id: string | null; command_id: string | null; action: string }
    | undefined;
  const command = action?.command_id
    ? (db4.prepare('SELECT status FROM control_command WHERE id = ?').get(action.command_id) as { status: string } | undefined)
    : undefined;
  const issue = db4.prepare("SELECT status FROM wd_issue WHERE id = 'wdi_spin'").get() as { status: string } | undefined;
  db4.close();
  check(action?.issue_id === 'wdi_spin', `维护动作关联到同一个问题（${action?.issue_id ?? '无'}）`);
  check(action?.command_id === controlId, '维护动作关联到实际执行的命令');
  check(command?.status === 'done', `命令执行回执为 done（实际 ${command?.status ?? '无'}）`);
  check(issue?.status === 'closed', '问题状态最终为 closed');
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
