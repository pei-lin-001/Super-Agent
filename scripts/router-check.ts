/**
 * 对一份已经结束（或进行中）的运行记录，单独让 Router 汇报一次现状。
 * 用于检查 Router 的对外表达：成果、状态、未完成项、术语解释与限制。
 * 用法：node --env-file-if-exists=.env.local scripts/router-check.ts <db> [问题]
 */
import { basename, join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { OpenAICompatibleModel } from '../src/model/openai.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { isolateRun } from './smoke-lib.ts';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法：node scripts/router-check.ts <db 路径> [问题]');
  process.exit(3);
}
const question =
  process.argv[3] ??
  '现在进展如何？请告诉我已经交付了什么、当前状态、还没完成的部分，以及有没有需要我决定的事。不要新建任务，也不要重新分派。';

const runId = basename(dbPath).replace(/\.db$/, '');
const config = isolateRun(loadConfig(), runId);
const store = new Store(dbPath);
const options = {
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  retry: config.limits.modelRetry,
  reasoningEffort: config.reasoningEffort,
  maxTokens: config.maxTokens,
};
const runtime = new Runtime({ store, config, workerModel: new OpenAICompatibleModel(options) });
const router = new Router(runtime, new OpenAICompatibleModel(options), config);
runtime.attachRouter(router);

console.log(`数据库：${dbPath}`);
console.log(`工作目录：${config.workDir}`);
console.log(`问题：${question}\n`);

await router.handleUserMessage(question);
const reply = store.listRouterTurns(4).at(-1);
console.log('==== Router 回复 ====');
console.log(reply?.content ?? '（没有产生回复）');
await runtime.stop();
store.close();
