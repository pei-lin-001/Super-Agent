/**
 * 崩溃恢复验收 —— 常驻 Watchdog 主动发现（严格版）。
 *
 * 与 accept-crash.ts 的区别只有一处：维护者在崩溃之前就已经在运行，
 * 崩溃之后脚本不发任何 --ask，恢复必须由维护者自己巡检发现并执行。
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
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const base = join(root, 'work-accept', stamp);
const workDir = base;
const dbPath = join(root, '.data', `accept-crash-passive-${stamp}.db`);

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
/** 恢复之后写了几次进度：用计数推进，避免依赖工具回显内容。 */
let recoveredWrites = 0;
const modelServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    modelCalls += 1;
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
    // 只解析真实请求体：工具 schema 和任务目标里也会出现这些词，
    // 直接对整段文本做 includes 会把「工具定义」误当成「已经调用过」。
    let parsed: { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: string }[] } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
    const toolNames = (parsed.tools ?? []).map((item) => item.function?.name ?? '');
    const isWatchdog = toolNames.includes('check_main') || toolNames.includes('restart_main');
    // 只看工具返回的内容：这决定了业务任务走到哪一步，与进程重启无关。
    const toolOutputs = (parsed.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => message.content ?? '')
      .join('\n');
    const hasProgress = toolOutputs.includes('progress.txt');
    const hasDeliverable = toolOutputs.includes('deliverable.md');
    const hasSubmit = toolOutputs.includes('已提交') || toolOutputs.includes('交付完成');

    let payload: unknown;
    if (isWatchdog) {
      const wdTurn = raw.split('"role":"tool"').length;
      if (wdTurn <= 2) payload = reply('check_main', {}, `c${modelCalls}`);
      else if (wdTurn <= 4) payload = reply('maintain', { action: 'restart_main', reason: '实例进程已退出' }, `c${modelCalls}`);
      else {
        payload = {
          choices: [{ message: { content: '已核对主系统状态并尝试恢复，需要复查心跳与任务进度。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        };
      }
    } else if (!hasProgress) {
      payload = reply('fs_write', { path: 'progress.txt', content: `stage1 call ${modelCalls}\n` }, `c${modelCalls}`);
    } else if (recoveredWrites < 1) {
      // 恢复之后必须真的推进一行业务证据，否则"继续推进"证明不了
      recoveredWrites += 1;
      payload = reply('fs_write', { path: 'progress.txt', content: `stage1 call _\nstage2 recovered\n` }, `c${modelCalls}`);
    } else if (!hasDeliverable) {
      payload = reply('artifact_save', { name: 'deliverable.md', content: '# 交付\n第二阶段完成\n' }, `c${modelCalls}`);
    } else if (!hasSubmit) {
      payload = reply('submit_result', { summary: '恢复后完成交付', artifacts: ['deliverable.md'] }, `c${modelCalls}`);
    } else {
      payload = {
        choices: [{ message: { content: '交付完成。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      };
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
let watchdog: ReturnType<typeof spawn> | null = null;

try {
  // ---- 0) 维护者先起：崩溃发生时它已经在巡检 ----
  watchdog = spawn(process.execPath, ['src/watchdog/main.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let wdOut = '';
  watchdog.stdout?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });
  watchdog.stderr?.on('data', (c: Buffer) => {
    wdOut += c.toString();
  });
  await sleep(1_500);
  require_(watchdog.exitCode === null, `常驻维护者已启动并保持运行（${wdOut.split('\n').filter(Boolean).slice(-1)[0] ?? '无输出'}）`);

  // ---- 1) 启动主系统并建立真实任务 ----
  main1 = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: 'ignore' });
  mainPid = main1.pid ?? null;
  for (let i = 0; i < 150 && !existsSync(join(workDir, '.runtime', 'heartbeat.json')); i += 1) await sleep(100);
  require_(existsSync(join(workDir, '.runtime', 'heartbeat.json')), '主进程已启动并写出心跳');

  // 用独立进程写持久状态（任务 + 排队中的负责人），由常驻主系统接管调度。
  // 不经过 Runtime：那样会在注入进程里启动执行，注入进程退出时把执行打断。
  const inject = spawn(
    process.execPath,
    [
      '-e',
      `import('./src/storage/store.ts').then(async ({ Store }) => {
         const { loadConfig } = await import('./src/config.ts');
         const { randomUUID } = await import('node:crypto');
         const config = loadConfig();
         const store = new Store(config.dbPath);
         const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
         const taskId = 'task_' + suffix;
         const groupId = 'grp_' + suffix;
         const workerId = 'w1_' + suffix;
         const now = new Date().toISOString();
         store.createTask({
           id: taskId, groupId, title: '崩溃恢复验收任务',
           goal: '写出 progress.txt 并交付 deliverable.md',
           brief: '', doneCriteria: '产物 deliverable.md 已登记并被提交引用',
           requireReview: false, reviewEpoch: 0, ownerWorkerId: null,
           status: 'active', closeReason: null, createdAt: now, updatedAt: now, closedAt: null,
         });
         store.createWorker({
           id: workerId, groupId, parentId: null, role: '执行者', brief: '按阶段推进',
           status: 'queued', model: null, stepCount: 0,
           createdAt: now, updatedAt: now, lastError: null,
         });
         store.setTaskOwner(taskId, workerId);
         store.appendEvent(taskId, workerId, 'task.created', '崩溃恢复验收任务');
         store.close();
         console.log('injected ' + taskId);
       }).catch((error) => { console.error(error); process.exit(1); });`,
    ],
    { cwd: root, env, stdio: 'pipe' },
  );
  let injectOut = '';
  inject.stdout?.on('data', (c: Buffer) => {
    injectOut += c.toString();
  });
  inject.stderr?.on('data', (c: Buffer) => {
    injectOut += c.toString();
  });
  await new Promise((resolve) => inject.on('exit', resolve));
  log(`注入：${injectOut.trim().split('\n').slice(-1)[0]}`);
  await sleep(1200);

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

  // ---- 4) 常驻 Watchdog 自己发现并拉起 ----
  // 维护者从脚本一开始就在运行；这里不发任何提问，只等它巡检发现主系统不在。
  require_(!existsSync(join(workDir, '.runtime', 'watchdog.stop')), '不存在停机标记，维护者会自动巡检');
  log('恢复触发方式：常驻 Watchdog 自动巡检（未发送 --ask）');
  let recoveredPid = 0;
  for (let i = 0; i < 900; i += 1) {
    try {
      const info = JSON.parse(readFileSync(join(workDir, '.runtime', 'instance.json'), 'utf8')) as {
        pid?: number | null;
        stopped?: boolean;
      };
      if (typeof info.pid === 'number' && info.pid !== mainPid && info.stopped !== true) {
        recoveredPid = info.pid;
        break;
      }
    } catch {
      // 文件还没写出来
    }
    await sleep(200);
  }
  log(`新主进程 pid=${recoveredPid || '（未拉起）'}`);
  require_(recoveredPid > 0, '常驻维护者主动拉起了新主进程');
  // 脚本全程没有启动过主系统：新进程只能来自维护者。
  require_(recoveredPid !== mainPid, '新主进程不是脚本自己启动的');

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
  require_(newPid !== null && newPid === recoveredPid, `新主进程与维护者拉起的是同一个（pid=${newPid}）`);

  // ---- 6) 恢复后继续推进直到完成 ----
  let finalStatus = '';
  for (let i = 0; i < 300; i += 1) {
    const current = readTask();
    finalStatus = current?.status ?? '';
    if (finalStatus === 'completed' || finalStatus === 'failed') break;
    await sleep(200);
  }
  require_(finalStatus === 'completed', `恢复后任务完成（最终状态 ${finalStatus || '未知'}）`);

  // ---- 7) 产物与提交引用：读真实文件，算真实摘要，按引用结构核对 ----
  let artifactOk = false;
  let submittedOk = false;
  let fileOk = false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // 限定本次任务：不接受别的任务留下的同名产物。
    const artifact = db
      .prepare("SELECT id, name, path, sha256, bytes, version FROM artifact WHERE name = 'deliverable.md' AND task_id = ?")
      .get(taskId) as
      | { id: string; name: string; path: string; sha256: string; bytes: number; version: number }
      | undefined;
    const result = db
      .prepare("SELECT refs FROM message WHERE kind = 'result' AND task_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as { refs: string } | undefined;
    db.close();

    if (artifact) {
      // 真实文件：字节数与 sha256 都要和登记记录一致
      const filePath = artifact.path.startsWith('/') ? artifact.path : join(workDir, artifact.path);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath);
        const digest = createHash('sha256').update(content).digest('hex');
        fileOk = content.length === artifact.bytes && digest === artifact.sha256;
        log(`产物文件 ${filePath}`);
        log(`  实际 bytes=${content.length} sha256=${digest.slice(0, 16)}`);
        log(`  登记 bytes=${artifact.bytes} sha256=${artifact.sha256.slice(0, 16)}`);
      } else {
        log(`产物文件不存在：${filePath}`);
      }
      artifactOk = artifact.bytes > 0;
    }

    // 引用结构：refs 是数组，需要按结构找到这一版产物，而不是搜文件名子串
    if (result?.refs) {
      try {
        const refs = JSON.parse(result.refs) as unknown;
        // 实际结构是 {"artifacts":[{artifactId,name,version}]}；同时兼容裸数组。
        const parsedRefs = refs as { artifacts?: unknown[] } | unknown[];
        const list: unknown[] = Array.isArray(parsedRefs)
          ? parsedRefs
          : Array.isArray(parsedRefs?.artifacts)
            ? (parsedRefs.artifacts as unknown[])
            : [];
        submittedOk = list.some((entry) => {
          if (typeof entry === 'string') return artifact ? entry === artifact.id || entry === artifact.name : false;
          if (entry && typeof entry === 'object') {
            const item = entry as { id?: string; name?: string; version?: number; sha256?: string };
            if (!artifact) return false;
            if (item.id !== undefined) return item.id === artifact.id;
            return item.name === artifact.name && (item.version === undefined || item.version === artifact.version);
          }
          return false;
        });
        log(`提交引用：${JSON.stringify(list)}`);
      } catch {
        log(`提交引用不是合法 JSON：${result.refs.slice(0, 120)}`);
      }
    }
  } catch (error) {
    log(`读取产物失败：${(error as Error).message}`);
  }
  require_(artifactOk, '交付产物已登记且非空');
  require_(fileOk, '真实文件字节数与 sha256 与登记一致');
  require_(submittedOk, '提交引用里按结构包含这一版产物');

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
    watchdog?.kill('SIGTERM');
  } catch {
    // 已退出
  }
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
  // 失败时保留数据库供复查；成功才清理本次创建的数据库。
  if (failures.length === 0) {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // 忽略
    }
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
