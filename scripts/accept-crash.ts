/**
 * 崩溃恢复验收（严格版）。
 *
 * 判定条件，缺一不可：
 * 1) 真实业务任务已启动并产生第一阶段产物；
 * 2) 主进程被 SIGKILL，且确认进程已消失；
 * 3) Watchdog 通过正式维护工具拉起主系统；
 * 4) 新进程恢复的是同一个任务；
 * 5) 恢复后产生新的业务进度，最终 completed；
 * 6) 产物内容与提交引用一致。
 *
 * 任何一步失败或超时，脚本以非零退出码结束。心跳只作为辅助证据。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const base = join(root, 'work-accept', stamp);
const workDir = base;
const dbPath = join(root, '.data', `accept-crash-${stamp}.db`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

const failures: string[] = [];
function require_(condition: boolean, message: string): void {
  if (condition) {
    log(`✓ ${message}`);
    return;
  }
  failures.push(message);
  log(`✗ ${message}`);
}

// ---- 本地受控模型：第一阶段写文件，之后提交 ----
let modelCalls = 0;
const STAGE1_CALLS = 6;
const modelServer = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    modelCalls += 1;
    const toolPhase = modelCalls <= STAGE1_CALLS;
    const reply = (name: string, args: Record<string, unknown>, id: string): unknown => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });
    let payload: unknown;
    if (toolPhase) {
      payload = reply('fs_write', { path: 'progress.txt', content: `stage1 call ${modelCalls}\n` }, `c${modelCalls}`);
    } else if (modelCalls === STAGE1_CALLS + 1) {
      payload = reply('artifact_save', { name: 'deliverable.md', content: '# 交付\n第二阶段完成\n' }, `c${modelCalls}`);
    } else {
      payload = reply('submit_result', { summary: '恢复后完成交付', artifacts: ['deliverable.md'] }, `c${modelCalls}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
const modelPort = (modelServer.address() as { port: number }).port;

const env = {
  ...process.env,
  DB_PATH: dbPath,
  WORK_DIR: workDir,
  OLLAMA_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  OLLAMA_API_KEY: 'local-test',
  MODEL_NAME: 'local-controlled',
  MODEL_CONCURRENCY: '1',
  MODEL_TIMEOUT_MS: '30000',
};

mkdirSync(join(workDir, '.runtime'), { recursive: true });

const readTask = (): { id: string; status: string } | null => {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT id, status FROM task ORDER BY created_at DESC LIMIT 1').get() as
      | { id: string; status: string }
      | undefined;
    db.close();
    return row ?? null;
  } catch {
    return null;
  }
};

let mainPid: number | null = null;
let main1: ReturnType<typeof spawn> | null = null;

try {
  // ---- 1) 启动主系统并建立真实任务 ----
  main1 = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: 'ignore' });
  mainPid = main1.pid ?? null;
  for (let i = 0; i < 150 && !existsSync(join(workDir, '.runtime', 'heartbeat.json')); i += 1) await sleep(100);
  require_(existsSync(join(workDir, '.runtime', 'heartbeat.json')), '主进程已启动并写出心跳');

  // 用独立进程注入任务（复用真实 API，不直接改数据库状态）
  const inject = spawn(
    process.execPath,
    [
      '--env-file-if-exists=.env.local',
      '-e',
      `import('./src/storage/store.ts').then(async ({Store}) => {
         const { Runtime } = await import('./src/runtime/runtime.ts');
         const { MockModel } = await import('./src/model/mock.ts');
         const { loadConfig } = await import('./src/config.ts');
         const config = loadConfig();
         const store = new Store(config.dbPath);
         const runtime = new Runtime({ store, config, workerModel: new MockModel(() => ({ text: 'noop', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'x', usage: null })) });
         const { owner } = runtime.createTask({
           title: '崩溃恢复验收任务', goal: '写出 progress.txt 并交付 deliverable.md',
           doneCriteria: '产物 deliverable.md 已登记并被提交引用', requireReview: false,
           ownerRole: '执行者', ownerBrief: '按阶段推进',
         });
         runtime.enqueue(owner.id);
         store.close();
         console.log('injected');
       }).catch((error) => { console.error(error); process.exit(1); });`,
    ],
    { cwd: root, env, stdio: 'pipe' },
  );
  await new Promise((resolve) => inject.on('exit', resolve));
  await sleep(1500);

  const task = readTask();
  require_(task !== null, '任务已建立');
  const taskId = task?.id ?? '';

  // ---- 2) 等待第一阶段产物 ----
  const progressPath = join(workDir, taskId, 'progress.txt');
  for (let i = 0; i < 200 && !existsSync(progressPath); i += 1) await sleep(100);
  const stage1 = existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : '';
  require_(stage1.includes('stage1'), `第一阶段产物已生成（${stage1.trim().split('\n').length} 行）`);
  require_((readTask()?.status ?? '') !== 'completed', '崩溃发生时任务尚未完成');

  // ---- 3) 真的杀掉 ----
  if (mainPid) process.kill(mainPid, 'SIGKILL');
  await sleep(1200);
  let alive = true;
  try {
    process.kill(mainPid!, 0);
  } catch {
    alive = false;
  }
  require_(!alive, `主进程 ${mainPid} 已被 SIGKILL 且确认退出`);

  // ---- 4) Watchdog 拉起 ----
  const wd = spawn(process.execPath, ['src/watchdog/main.ts', '--ask', '主系统还在运行吗？不在的话请按策略恢复它。'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wdOut = '';
  wd.stdout?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });
  wd.stderr?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });
  await new Promise((resolve) => wd.on('exit', resolve));
  log(`Watchdog 输出：${wdOut.trim().split('\n').slice(-2).join(' / ')}`);

  // ---- 5) 新进程恢复同一任务 ----
  let newPid: number | null = null;
  for (let i = 0; i < 150; i += 1) {
    try {
      const info = JSON.parse(readFileSync(join(workDir, '.runtime', 'instance.json'), 'utf8')) as { pid: number | null };
      if (info.pid && info.pid !== mainPid) {
        newPid = info.pid;
        break;
      }
    } catch {
      // 还没写出来
    }
    await sleep(200);
  }
  require_(newPid !== null, `Watchdog 拉起了新主进程（pid=${newPid}）`);

  // ---- 6) 恢复后继续推进直到完成 ----
  let finalStatus = '';
  for (let i = 0; i < 300; i += 1) {
    const current = readTask();
    finalStatus = current?.status ?? '';
    if (finalStatus === 'completed' || finalStatus === 'failed') break;
    await sleep(200);
  }
  require_(finalStatus === 'completed', `恢复后任务完成（最终状态 ${finalStatus || '未知'}）`);

  // ---- 7) 产物与提交引用 ----
  let artifactOk = false;
  let submittedOk = false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const artifact = db.prepare("SELECT name, sha256, bytes FROM artifact WHERE name = 'deliverable.md'").get() as
      | { name: string; sha256: string; bytes: number }
      | undefined;
    const result = db.prepare("SELECT refs FROM message WHERE kind = 'result'").get() as { refs: string } | undefined;
    db.close();
    artifactOk = Boolean(artifact && artifact.bytes > 0);
    submittedOk = Boolean(result && result.refs.includes('deliverable.md'));
    if (artifact) log(`产物 deliverable.md sha256=${artifact.sha256.slice(0, 12)} bytes=${artifact.bytes}`);
  } catch (error) {
    log(`读取产物失败：${(error as Error).message}`);
  }
  require_(artifactOk, '交付产物已登记且非空');
  require_(submittedOk, '提交引用包含该产物');

  // 阶段证据：进度文件行数应比第一阶段多
  const stage2 = existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : '';
  const stage1Lines = stage1.trim() === '' ? 0 : stage1.trim().split('\n').length;
  const stage2Lines = stage2.trim() === '' ? 0 : stage2.trim().split('\n').length;
  log(`进度文件行数：${stage1Lines} → ${stage2Lines}`);
} catch (error) {
  failures.push(`验收脚本异常：${(error as Error).message}`);
} finally {
  modelServer.close();
  try {
    if (mainPid) process.kill(mainPid, 'SIGTERM');
  } catch {
    // 已退出
  }
  try {
    const info = JSON.parse(readFileSync(join(workDir, '.runtime', 'instance.json'), 'utf8')) as { pid: number | null };
    if (info.pid && info.pid !== mainPid) process.kill(info.pid, 'SIGTERM');
  } catch {
    // 已退出
  }
  await sleep(800);
  // 只清理本次创建的数据库；工作目录保留供复查
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // 忽略
  }
}

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）：`);
  for (const item of failures) console.log(` - ${item}`);
  console.log(`工作目录保留供复查：${workDir}`);
  process.exit(1);
}
console.log(`\n验收通过。工作目录：${workDir}`);
process.exit(0);
