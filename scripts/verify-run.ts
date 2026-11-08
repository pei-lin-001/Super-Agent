/**
 * 对一次已完成的运行记录重新做严格判定（不调用模型）。
 * 用法：node scripts/verify-run.ts <db 路径> [taskId]
 */
import { basename } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/storage/store.ts';
import { isolateRun, judgeTask, report } from './smoke-lib.ts';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法：node scripts/verify-run.ts <db 路径> [taskId]');
  process.exit(3);
}
const runId = basename(dbPath).replace(/\.db$/, '');
const config = isolateRun(loadConfig(), runId);
const store = new Store(dbPath);
const taskId = process.argv[3] ?? store.listTasks().at(-1)?.id;
if (!taskId) {
  console.error('数据库里没有任务');
  process.exit(3);
}
console.log(`数据库：${dbPath}`);
console.log(`工作目录：${config.workDir}`);
console.log(`任务：${taskId}`);
const verdict = judgeTask(store, config, taskId);
store.close();
report(verdict);
