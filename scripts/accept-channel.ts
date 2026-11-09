/**
 * 渠道接入进程级验收。
 *
 * 用一个本地假平台（Telegram HTTP 形状）+ 本地假模型，真实启动 `src/main.ts --daemon`，
 * 验证整条链路：平台消息 → 落库 → 会话交接 → 建任务 → Worker 交付 → 回信到来源聊天 → 发文件，
 * 并验证进程重启后不重复派工、仍能继续收消息。
 *
 * 这不是真实平台联调：真实 Telegram/微信需要你提供机器人令牌与扫码，脚本不会假装通过。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const base = join(root, 'work-accept', `channel-${stamp}`);
const workDir = base;
const dbPath = join(root, '.data', `accept-channel-${stamp}.db`);
const stateDir = join(base, 'channels');
const token = '424242:ACCEPTANCE_TOKEN';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------- 假平台：Telegram HTTP 形状 ----------
const queue: unknown[] = [];
const sentMessages: { chatId: string; text: string }[] = [];
const sentDocuments: { chatId: string; name: string; bytes: number }[] = [];
let nextMessageId = 1000;

const platform = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path.endsWith('/getUpdates')) {
    const batch = queue.splice(0, queue.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: batch }));
    return;
  }
  if (path.endsWith('/sendMessage')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}') as { chat_id?: string; text?: string };
      nextMessageId += 1;
      sentMessages.push({ chatId: String(payload.chat_id ?? ''), text: String(payload.text ?? '') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }));
    });
    return;
  }
  if (path.endsWith('/sendDocument')) {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // multipart 里取 chat_id 和 filename，够判定"发了什么"
      const text = body.toString('latin1');
      const chatMatch = text.match(/name="chat_id"\r?\n\r?\n([^\r\n]+)/);
      const fileMatch = text.match(/filename="([^"]+)"/);
      nextMessageId += 1;
      sentDocuments.push({
        chatId: chatMatch?.[1] ?? '',
        name: fileMatch?.[1] ?? '',
        bytes: body.byteLength,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }));
    });
    return;
  }
  if (path.includes('/file/bot')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('fake-file'));
    return;
  }
  if (path.endsWith('/getFile')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { file_path: 'documents/x.txt' } }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, description: 'not found' }));
});

// ---------- 假模型：按工具集区分 Router / Worker ----------
let routerCalls = 0;
let workerWrites = 0;
/** 记住第一次看到的任务号：汇报那一轮的上下文里不一定带 id。 */
let knownTaskId = '';
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    const parsed = JSON.parse(raw || '{}') as {
      tools?: { function?: { name?: string } }[];
      messages?: { role?: string; content?: string }[];
    };
    const toolNames = (parsed.tools ?? []).map((item) => item.function?.name ?? '');
    const isRouter = toolNames.includes('create_task') || toolNames.includes('send_file');
    const toolOutputs = (parsed.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => message.content ?? '')
      .join('\n');
    const taskId = raw.match(/task_[a-z0-9]{6,}/)?.[0] ?? '';
    if (taskId !== '') knownTaskId = taskId;

    const reply = (name: string, args: Record<string, unknown>): unknown => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: `c${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const text = (content: string): unknown => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    let payload: unknown;
    if (isRouter) {
      routerCalls += 1;
      if (routerCalls === 1) {
        payload = reply('create_task', {
          title: '渠道验收任务',
          goal: '生成交付文件并回传',
          owner_role: '执行者',
          owner_brief: '生成 deliverable.md 并提交',
        });
      } else if (routerCalls === 2) {
        payload = text('收到，已经安排执行，完成后我把文件发你。');
      } else if (routerCalls === 3 && knownTaskId !== '') {
        payload = reply('send_file', { task_id: knownTaskId, name: 'deliverable.md', note: '交付文件' });
      } else if (routerCalls === 4) {
        payload = text('文件已经发出，请查收。');
      } else {
        payload = text('收到，继续。');
      }
    } else if (!toolOutputs.includes('deliverable.md')) {
      workerWrites += 1;
      payload = reply('artifact_save', { name: 'deliverable.md', content: `# 交付\n第 ${workerWrites} 次写\n` });
    } else {
      payload = reply('submit_result', { summary: '已生成交付文件', artifacts: ['deliverable.md'] });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const platformPort = (platform.address() as { port: number }).port;
const modelPort = (model.address() as { port: number }).port;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DB_PATH: dbPath,
  WORK_DIR: workDir,
  OLLAMA_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  OLLAMA_API_KEY: 'local-test',
  MODEL_NAME: 'local-controlled',
  MODEL_CONCURRENCY: '1',
  MODEL_TIMEOUT_MS: '30000',
  MODEL_REASONING_EFFORT: 'low',
  CHANNEL_STATE_DIR: stateDir,
  CHANNEL_POLL_TIMEOUT_MS: '800',
  TELEGRAM_ENABLED: '1',
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_OWNER_IDS: '777001',
  TELEGRAM_API_BASE: `http://127.0.0.1:${platformPort}`,
  WEIXIN_ENABLED: '0',
};
delete env['MODEL_CATALOG'];

mkdirSync(join(workDir, '.runtime'), { recursive: true });

const readDb = <T>(fn: (db: DatabaseSync) => T): T | null => {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};

function pushUpdate(updateId: number, text: string): void {
  queue.push({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 777001, type: 'private' },
      from: { id: 777001 },
      text,
    },
  });
}

let daemon: ChildProcess | null = null;
async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, ['src/main.ts', '--daemon'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  // 重启时心跳文件已经存在，不能只看文件：等进程真的活着并稳定一小会儿。
  await sleep(1500);
  for (let i = 0; i < 200; i += 1) {
    if (daemon.exitCode !== null) return;
    if (existsSync(join(workDir, '.runtime', 'heartbeat.json'))) return;
    await sleep(100);
  }
}

async function stopDaemon(): Promise<void> {
  if (!daemon) return;
  const child = daemon;
  daemon = null;
  child.kill('SIGTERM');
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) return;
    await sleep(50);
  }
  child.kill('SIGKILL');
  await sleep(200);
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  log(`超时等待：${label}`);
  return false;
}

try {
  // ---- 第一段：真消息 → 真任务 → 真回信 ----
  pushUpdate(5_000_001, '帮我做个交付文件');
  await startDaemon();
  require_(existsSync(join(workDir, '.runtime', 'heartbeat.json')), '主进程已启动（--daemon）');

  const gotReply = await waitFor(() => sentMessages.length > 0, 90_000, '第一条回信');
  require_(gotReply, `回信已发到来源聊天（收到 ${sentMessages.length} 条）`);
  require_(
    sentMessages.every((item) => item.chatId === '777001'),
    `回信只发给发起人（实际 ${JSON.stringify(sentMessages.map((item) => item.chatId))}）`,
  );

  const gotFile = await waitFor(() => sentDocuments.length > 0, 120_000, '交付文件');
  require_(gotFile, `交付文件已发送（收到 ${sentDocuments.length} 个）`);
  if (gotFile) {
    require_(sentDocuments[0]!.name === 'deliverable.md', `文件名正确（${sentDocuments[0]!.name}）`);
    require_(sentDocuments[0]!.chatId === '777001', '文件也发给发起人，不是别人');
  }

  const inbound = readDb((db) =>
    db.prepare('SELECT event_id, status FROM channel_inbound ORDER BY rowid').all() as {
      event_id: string;
      status: string;
    }[],
  );
  require_((inbound?.length ?? 0) === 1, `入站记录一条（实际 ${inbound?.length ?? 0}）`);
  require_(inbound?.[0]?.event_id === 'update:5000001', '入站事件身份用平台 update_id');
  require_(inbound?.[0]?.status === 'handed', `入站已交接（实际 ${inbound?.[0]?.status}）`);

  const cursor = readDb((db) => {
    const row = db.prepare('SELECT cursor FROM channel_cursor').get() as { cursor?: string } | undefined;
    return row?.cursor ?? null;
  });
  require_(cursor === '5000002', `游标已前移到下一条（实际 ${cursor}）`);

  // 汇报与收尾是并行的：等任务真正落定再判定。
  await waitFor(
    () =>
      readDb((db) => {
        const row = db.prepare('SELECT status FROM task ORDER BY created_at DESC LIMIT 1').get() as
          | { status: string }
          | undefined;
        return row?.status === 'completed';
      }) === true,
    30_000,
    '任务完成',
  );

  const task = readDb((db) => {
    const row = db
      .prepare('SELECT id, status, source_channel, source_peer_id, source_session_key FROM task ORDER BY created_at DESC LIMIT 1')
      .get() as
      | { id: string; status: string; source_channel: string; source_peer_id: string; source_session_key: string }
      | undefined;
    return row ?? null;
  });
  require_(task?.status === 'completed', `任务完成（实际 ${task?.status}）`);
  require_(task?.source_channel === 'telegram', '任务记住了来源渠道');
  require_(task?.source_peer_id === '777001', '任务记住了来源会话');
  require_(task?.source_session_key === 'telegram|bot_424242|777001', `会话键正确（${task?.source_session_key}）`);

  const outbound = readDb((db) =>
    db.prepare('SELECT status, segments FROM channel_outbound ORDER BY rowid').all() as {
      status: string;
      segments: string;
    }[],
  );
  require_((outbound?.length ?? 0) >= 2, `多条发件记录（实际 ${outbound?.length ?? 0}）`);
  require_(
    (outbound ?? []).every((row) => row.status === 'sent'),
    `全部发件状态为 sent（实际 ${JSON.stringify((outbound ?? []).map((row) => row.status))}）`,
  );

  // ---- 第二段：重启后继续，且不重复派工 ----
  await stopDaemon();
  log('主进程已停止，准备重启');
  const tasksBefore = readDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n);
  const messagesBefore = sentMessages.length;
  pushUpdate(5_000_002, '再回我一句就行');
  await startDaemon();

  const gotSecond = await waitFor(() => sentMessages.length > messagesBefore, 90_000, '重启后的回信');
  require_(gotSecond, `重启后仍能收消息并回信（新增 ${sentMessages.length - messagesBefore} 条）`);

  const inboundAfter = readDb((db) =>
    db.prepare('SELECT event_id FROM channel_inbound ORDER BY rowid').all() as { event_id: string }[],
  );
  const firstCount = (inboundAfter ?? []).filter((row) => row.event_id === 'update:5000001').length;
  require_(firstCount === 1, `重启后第一条没有被重复处理（出现 ${firstCount} 次）`);
  require_(
    (inboundAfter?.length ?? 0) === 2,
    `共有两条入站记录（实际 ${inboundAfter?.length ?? 0}）`,
  );
  const tasksAfter = readDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n);
  require_(
    (tasksAfter ?? 0) >= (tasksBefore ?? 0),
    `重启没有丢掉任务（重启前 ${tasksBefore}，重启后 ${tasksAfter}）`,
  );

  // ---- 第三段：话题命令走代码，话题切换后历史/归属跟着走 ----
  const repliesBeforeTopic = sentMessages.length;
  const routerCallsBeforeTopic = routerCalls;
  pushUpdate(5_000_003, '/new 第二个话题');
  const gotTopic = await waitFor(
    () =>
      sentMessages
        .slice(repliesBeforeTopic)
        .some((item) => item.text.includes('已新建并切换到话题「第二个话题」')),
    60_000,
    '话题新建回信',
  );
  require_(gotTopic, '话题命令有确定性回信（不经过模型）');
  // 不能用"调用次数没涨"来判定：后台自动汇报/续接随时可能插进来，那是正常的。
  // 真正的不变量是命令文本根本没进 Router 历史。
  const commandInHistory = readDb((db) =>
    db.prepare("SELECT COUNT(*) AS n FROM router_turn WHERE content LIKE '/new%'").get() as { n: number },
  );
  require_(
    (commandInHistory?.n ?? -1) === 0,
    `话题命令没有进入 Router 历史（实际命中 ${commandInHistory?.n ?? '未知'} 条）`,
  );
  log(`话题命令期间 Router 另有 ${routerCalls - routerCallsBeforeTopic} 次后台调用（自动汇报/续接，允许）`);

  const conversations = readDb((db) =>
    db.prepare('SELECT title FROM conversation ORDER BY created_at').all() as { title: string }[],
  );
  require_((conversations?.length ?? 0) === 2, `库里有两条话题（实际 ${conversations?.length ?? 0}）`);
  require_(
    (conversations ?? []).some((row) => row.title === '第二个话题'),
    `话题名已落库（实际 ${JSON.stringify(conversations?.map((row) => row.title))}）`,
  );

  const artifact = readDb((db) => {
    const row = db.prepare('SELECT name, path, sha256, bytes FROM artifact ORDER BY rowid DESC LIMIT 1').get() as
      | { name: string; path: string; sha256: string; bytes: number }
      | undefined;
    return row ?? null;
  });
  require_(artifact?.name === 'deliverable.md', `产物已登记（${artifact?.name}）`);
  if (artifact) {
    const path = join(workDir, artifact.path);
    const actual = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    require_(actual.byteLength === artifact.bytes, `产物大小与登记一致（${actual.byteLength} vs ${artifact.bytes}）`);
  }
} catch (error) {
  failures.push(`验收过程出错：${(error as Error).message}`);
  log(`✗ 验收过程出错：${(error as Error).message}`);
} finally {
  await stopDaemon();
  platform.close();
  model.close();
  if (failures.length === 0) {
    log('渠道接入进程级验收：全部通过');
    if (!process.env['KEEP_ACCEPT']) rmSync(base, { recursive: true, force: true });
    process.exitCode = 0;
  } else {
    log(`渠道接入进程级验收：${failures.length} 项未通过`);
    for (const item of failures) log(`  - ${item}`);
    log(`现场保留：${base}`);
    process.exitCode = 1;
  }
}
