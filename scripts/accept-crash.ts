/**
 * 崩溃恢复验收：真实创建主进程 → 真的杀掉 → 由 Watchdog 拉起 → 确认业务继续。
 * 使用独立数据库与工作目录，不碰正在使用的实例。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const base = join(root, 'work-accept');
const dbPath = join(root, '.data', 'accept-crash.db');
const workDir = base;
// 本地受控模型：第一次要求 restart_main，之后给结论。不连外部提供方。
let modelCalls = 0;
const modelServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    modelCalls += 1;
    const wantsTool = modelCalls <= 2;
    const payload = wantsTool
      ? {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `call_${modelCalls}`,
                    type: 'function',
                    function: { name: 'maintain', arguments: JSON.stringify({ action: 'restart_main', reason: '实例已退出' }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { content: '主系统已按策略尝试恢复，需复查心跳。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        };
    void body;
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
  OLLAMA_API_KEY: 'k',
  MODEL_NAME: 'm',
  MODEL_CONCURRENCY: '1',
};

rmSync(base, { recursive: true, force: true });
rmSync(dbPath, { force: true });
mkdirSync(join(workDir, '.runtime'), { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const heartbeat = (): number | null => {
  try {
    return JSON.parse(readFileSync(join(workDir, '.runtime', 'heartbeat.json'), 'utf8')).at as number;
  } catch {
    return null;
  }
};

const steps: string[] = [];
const record = (text: string): void => {
  steps.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  console.log(steps.at(-1));
};

// 1) 真实主进程
const main1 = spawn(process.execPath, ['src/main.ts', '--daemon'], { cwd: root, env, stdio: 'ignore' });
for (let i = 0; i < 100 && heartbeat() === null; i += 1) await sleep(100);
record(`主进程启动 pid=${main1.pid}，心跳=${heartbeat()}`);

// 2) 真的杀掉（SIGKILL，模拟崩溃，不给收尾机会）
main1.kill('SIGKILL');
await sleep(1200);
let alive = true;
try {
  process.kill(main1.pid!, 0);
} catch {
  alive = false;
}
record(`SIGKILL 之后进程存活=${alive}`);

// 3) Watchdog 观察并拉起
const wd = spawn(process.execPath, ['src/watchdog/main.ts', '--ask', '主系统是否还在运行？如果不在，请按策略恢复。'], {
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
record(`Watchdog 问答完成，输出 ${wdOut.length} 字符`);

// 4) 验证是否真的恢复
const instancePath = join(workDir, '.runtime', 'instance.json');
const instance = existsSync(instancePath)
  ? (JSON.parse(readFileSync(instancePath, 'utf8')) as { pid: number | null; stopped?: boolean })
  : null;
record(`实例文件：${JSON.stringify(instance)}`);
const beatBefore = heartbeat();
await sleep(6000);
const beatAfter = heartbeat();
record(`心跳 ${beatBefore} → ${beatAfter}（${beatAfter !== null && beatBefore !== null && beatAfter > beatBefore ? '推进' : '未推进'}）`);

writeFileSync(join(base, 'accept-result.json'), JSON.stringify({ steps, instance, beatBefore, beatAfter, wdOut: wdOut.slice(-2000) }, null, 2));

// 清理自己创建的进程
for (const pid of [instance?.pid].filter((p): p is number => typeof p === 'number')) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 已退出
  }
}
modelServer.close();
record(`验收结束（模型调用 ${modelCalls} 次）`);
