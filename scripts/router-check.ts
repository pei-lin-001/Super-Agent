/**
 * 汇报能力检查：对一份运行记录的「隔离快照」让 Router 汇报一次现状。
 * - 先复制数据库到临时目录，原库只读打开，不会被写入或消费消息；
 * - Router 以只读模式运行，不提供 create_task / send_to_worker；
 * - 必须真的拿到一条回复，否则返回非零退出码。
 * 用法：node --env-file-if-exists=.env.local scripts/router-check.ts <db> [问题]
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { OpenAICompatibleModel } from '../src/model/openai.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { isolateRun } from './smoke-lib.ts';

const dbPath = process.argv[2];
if (!dbPath || !existsSync(dbPath)) {
  console.error('用法：node scripts/router-check.ts <db 路径> [问题]');
  process.exit(3);
}
const question =
  process.argv[3] ??
  '现在进展如何？请告诉我已经交付了什么、当前状态、还没完成的部分，以及有没有需要我决定的事。不要新建任务，也不要重新分派。';

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = { hash: digest(dbPath), mtime: statSync(dbPath).mtimeMs };

// 隔离快照：所有写入都落在副本上。
const snapshotDir = mkdtempSync(join(tmpdir(), 'router-check-'));
const snapshotPath = join(snapshotDir, `${basename(dbPath, '.db')}.snapshot.db`);
copyFileSync(dbPath, snapshotPath);

const config = isolateRun(loadConfig(), basename(dbPath, '.db'));
const store = new Store(snapshotPath);
const options = {
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  retry: config.limits.modelRetry,
  reasoningEffort: config.reasoningEffort,
  maxTokens: config.maxTokens,
};
const runtime = new Runtime({ store, config, workerModel: new OpenAICompatibleModel(options) });
const router = new Router(runtime, new OpenAICompatibleModel(options), config, { readOnly: true });

const beforeTurns = store.listRouterTurns(1000).length;
console.log(`原库：${dbPath}`);
console.log(`快照：${snapshotPath}`);
console.log(`问题：${question}\n`);

let exitCode = 0;
try {
  await router.handleUserMessage(question);
  const turns = store.listRouterTurns(1000);
  const reply = turns.length > beforeTurns ? turns.at(-1)?.content?.trim() ?? '' : '';
  if (reply === '') {
    console.error('没有取得本轮 Router 回复（router_turn 没有新增记录）。');
    exitCode = 1;
  } else {
    console.log('==== Router 回复 ====');
    console.log(reply);
  }
} catch (error) {
  console.error('Router 汇报失败：', error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await runtime.stop();
  store.close();
  const after = { hash: digest(dbPath), mtime: statSync(dbPath).mtimeMs };
  const untouched = after.hash === before.hash && after.mtime === before.mtime;
  console.log(`\n原库未被修改：${untouched ? '是' : '否'}`);
  if (!untouched) exitCode = 1;
  rmSync(snapshotDir, { recursive: true, force: true });
}
process.exit(exitCode);
