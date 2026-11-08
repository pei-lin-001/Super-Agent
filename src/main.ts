import { ConfigError, loadConfig } from './config.ts';
import { OpenAICompatibleModel } from './model/openai.ts';
import { Router } from './runtime/router.ts';
import { Runtime } from './runtime/runtime.ts';
import { Store } from './storage/store.ts';
import { startRepl } from './ui/repl.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`配置缺失：${error.message}`);
      console.error('请复制 .env.example 为 .env.local 并补齐配置（.env.local 已被 git 忽略）。');
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const store = new Store(config.dbPath);
  const workerModel = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    label: `openai-compatible:${config.baseUrl}`,
  });
  const routerModel = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    label: `openai-compatible:${config.baseUrl}`,
  });

  const runtime = new Runtime({ store, config, workerModel });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  console.log(
    [
      `模型提供方：${config.provider}`,
      `端点：${config.baseUrl}`,
      `Router 模型：${config.routerModel}　Worker 模型：${config.workerModel}　思考强度：${config.reasoningEffort}`,
      `数据库：${config.dbPath}`,
      `工作目录：${config.workDir}`,
      `并发上限：${config.limits.maxConcurrentRuns}　单组 Worker 上限：${config.limits.maxWorkersPerGroup}`,
    ].join('\n'),
  );

  try {
    await startRepl({ runtime, router });
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
