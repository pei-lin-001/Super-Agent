/**
 * 维护闭环的两个误判反例：
 *
 * 1. 任务目标和期望里都提到 deliverable.md，但产物从未登记 → 不能关闭问题。
 * 2. 产物已登记，但任务还没完成 → 不能关闭问题。
 *
 * 这两个场景验证的是"关闭依据必须是真实状态"，而不是文本里出现过某个名字。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'sa-misjudge-'));
const workDir = join(dir, 'work');
const dbPath = join(dir, 'db.sqlite');
mkdirSync(join(workDir, '.runtime'), { recursive: true });

const failures: string[] = [];
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let wdCalls = 0;
// 单场景运行：A = 目标里提到产物名但未登记；B = 产物已登记但任务未完成。
const scenario = (process.argv[2] ?? 'A').toUpperCase() === 'B' ? 'B' : 'A';

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
    const say = (text: string): unknown => ({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    let payload: unknown;
    if (isWatchdog) {
      if (process.env['MISJUDGE_DEBUG'] && toolOutputs !== '') {
        appendFileSync('/tmp/misjudge-tool.txt', `=== scenario=${scenario}\n${toolOutputs.slice(0, 600)}\n`);
      }
      wdCalls += 1;
      // 只看结构化的产物行和任务状态，不看任务目标里的文件名字符串
      // 登记过的产物一定带版本号；任务目标里的文件名不会带 v1。
      // 只看结构化证据行；任务目标里出现文件名不算产物。
      const hasArtifact = /产物[：:]\s*.*deliverable\.md v\d/.test(toolOutputs);
      const activeTask = /状态 active/.test(toolOutputs);
      const target = /task_b/.test(toolOutputs) ? 'task_b' : 'task_a';
      const issueId = target === 'task_b' ? 'wdi_b' : 'wdi_a';
      if (toolOutputs === '') {
        payload = reply('inspect_task', { task_id: scenario === 'A' ? 'task_a' : 'task_b' }, `w${wdCalls}`);
      } else if (hasArtifact && activeTask) {
        // 场景 B：产物在但任务没完成 → 不能关闭
        payload = reply(
          'record',
          {
            issue_id: issueId,
            status: 'open',
            title: '任务未完成',
            note: '复查：产物已登记，但任务仍是 active，不能判定为已恢复',
            check_after_minutes: 0,
          },
          `w${wdCalls}`,
        );
      } else if (hasArtifact) {
        payload = reply(
          'record',
          { issue_id: issueId, status: 'closed', note: '产物已登记且任务完成' },
          `w${wdCalls}`,
        );
      } else {
        // 场景 A：只有名字出现在目标里，产物没登记 → 保持 open
        payload = reply(
          'record',
          {
            issue_id: issueId,
            status: 'open',
            title: '没有产物',
            note: '复查：任务目标提到 deliverable.md，但产物未登记，问题未改善',
            check_after_minutes: 0,
          },
          `w${wdCalls}`,
        );
      }
    } else {
      payload = say('业务保持原样');
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
  MAX_STEPS_PER_RUN: '1',
  WATCHDOG_INTERVAL_MS: '4000',
};

let main: ReturnType<typeof spawn> | null = null;
let wd: ReturnType<typeof spawn> | null = null;

try {
  // 场景 A：目标里写 deliverable.md，但没有任何产物登记
  if (scenario === 'A') {
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
           id: 'task_a', groupId: 'grp_a', title: '目标里提到产物名',
           goal: '交付 deliverable.md', brief: '', doneCriteria: 'deliverable.md 已提交',
           requireReview: false, reviewEpoch: 0, ownerWorkerId: null,
           status: 'active', closeReason: null, createdAt: now, updatedAt: now, closedAt: null,
         });
         store.createWorker({
           id: 'w1_a', groupId: 'grp_a', parentId: null, role: '执行者', brief: '只说不做',
           status: 'queued', model: null, stepCount: 0, createdAt: now, updatedAt: now, lastError: null,
         });
         store.setTaskOwner('task_a', 'w1_a');
         store.upsertWdIssue({
           id: 'wdi_a', taskId: 'task_a', title: '任务没有产出',
           note: '目标要求交付 deliverable.md，但一直没有产物', checkAfter: null,
         });
         store.close();
       }).catch((e) => { console.error(e); process.exit(1); });`,
    ],
    { cwd: root, env, stdio: 'pipe' },
  );
  await new Promise((resolve) => inject.on('exit', resolve));
  }

  // 两个场景的数据都准备好之后再启动进程，避免巡检看到半成品状态。
  main = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
  wd = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });

  if (scenario === 'A') {
  let noteA = '';
  let statusA = 'open';
  for (let i = 0; i < 400; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status, note FROM wd_issue WHERE id = 'wdi_a'").get() as
      | { status: string; note: string | null }
      | undefined;
    db.close();
    if (row) {
      statusA = row.status;
      noteA = row.note ?? '';
      if (noteA.includes('未改善') || noteA.includes('未登记')) break;
    }
    await sleep(100);
  }
  check(statusA === 'open', `场景A：目标里出现产物名但未登记，问题必须保持 open（实际 ${statusA}）`);
  check(/未登记|未改善/.test(noteA), `场景A：结论要说明产物未登记（实际：${noteA.slice(0, 80)}）`);

  }

  if (scenario === 'B') {
  // 场景 B：产物已登记，但任务仍是 active
  // 先让 Store 建表，再手工写入状态。
  {
    // 用当前进程环境里的配置建表（env 已经在上面装配好）
    const saved: Record<string, string | undefined> = {};
    for (const key of ['DB_PATH', 'WORK_DIR', 'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'MODEL_NAME']) {
      saved[key] = process.env[key];
      process.env[key] = env[key];
    }
    const { Store } = await import('../src/storage/store.ts');
    const { loadConfig } = await import('../src/config.ts');
    const boot = new Store(loadConfig().dbPath);
    boot.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const dbB = new DatabaseSync(dbPath);
  const nowB = new Date().toISOString();
  dbB
    .prepare(
      `INSERT INTO task (id, group_id, title, goal, brief, done_criteria, require_review, review_epoch,
                         owner_worker_id, status, close_reason, created_at, updated_at, closed_at)
       VALUES ('task_b','grp_b','有产物但没完成','g','','',0,0,'w1_b','active',NULL,?,?,NULL)`,
    )
    .run(nowB, nowB);
  dbB
    .prepare(
      `INSERT INTO worker (id, group_id, parent_id, role, brief, status, model, step_count, created_at, updated_at, last_error, run_epoch)
       VALUES ('w1_b','grp_b',NULL,'执行者','b','waiting',NULL,3,?,?,NULL,1)`,
    )
    .run(nowB, nowB);
  dbB
    .prepare(
      `INSERT INTO artifact (id, task_id, worker_id, name, path, version, sha256, bytes, created_at)
       VALUES ('art_b','task_b','w1_b','deliverable.md','task_b/artifacts/v1/deliverable.md',1,'deadbeef',12,?)`,
    )
    .run(nowB);
  dbB
    .prepare("INSERT INTO wd_issue (id, task_id, title, status, attempts, note, check_after, first_seen, last_seen) VALUES ('wdi_b','task_b','任务没完成','open',0,'',NULL,?,?)")
    .run(nowB, nowB);
  dbB.close();

  let noteB = '';
  let statusB = 'open';
  let sawB = false;
  for (let i = 0; i < 900; i += 1) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status, note FROM wd_issue WHERE id = 'wdi_b'").get() as
      | { status: string; note: string | null }
      | undefined;
    db.close();
    if (row) {
      statusB = row.status;
      const candidate = row.note ?? '';
      if (candidate.includes('未完成')) {
        noteB = candidate;
        sawB = true;
        break;
      }
      // 记录最后一次看到的 B 相关结论，便于诊断
      if (candidate.includes('active')) noteB = candidate;
    }
    await sleep(100);
  }
  check(statusB === 'open', `场景B：产物已登记但任务未完成，问题必须保持 open（实际 ${statusB}）`);
  check(/active|未完成/.test(noteB), `场景B：结论要说明任务未完成（实际：${noteB.slice(0, 80)}）`);
  }

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
console.log('\n验收通过（本场景：误判条件未满足时，问题保持未解决）');
process.exit(0);
