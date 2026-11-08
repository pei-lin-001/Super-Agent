import { ConfigError, loadConfig } from './config.ts';
import { OpenAICompatibleModel } from './model/openai.ts';
import { Router } from './runtime/router.ts';
import { Runtime } from './runtime/runtime.ts';
import { Store } from './storage/store.ts';
import { startRepl } from './ui/repl.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  // 实例文件：Watchdog 靠它判断主系统是活着、已退出，还是身份无法确认。
  const instancePath = join(config.workDir, '.runtime', 'instance.json');
  mkdirSync(dirname(instancePath), { recursive: true });
  const heartbeatPath = join(config.workDir, '.runtime', 'heartbeat.json');
  const writeInstance = (stopped: boolean): void => {
    try {
      writeFileSync(
        instancePath,
        JSON.stringify(
          {
            pid: stopped ? null : process.pid,
            startedAt: new Date().toISOString(),
            dbPath: config.dbPath,
            stopped,
            heartbeat: heartbeatPath,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      // 退出路径不因为写文件失败而阻塞。
    }
  };
  writeInstance(false);
  // 心跳：证明事件循环和调度还在转，而不只是进程还在。
  const heartbeat = (): void => {
    try {
      writeFileSync(
        heartbeatPath,
        JSON.stringify({ pid: process.pid, at: Date.now(), queue: 0 }, null, 2),
        'utf8',
      );
    } catch {
      // 心跳失败不阻塞业务。
    }
  };
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 5000);
  heartbeatTimer.unref?.();
  process.on('exit', () => writeInstance(true));
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

  const daemon = process.argv.includes('--daemon') || process.env['SUPER_AGENT_DAEMON'] === '1';
  runtime.start();
  if (daemon) {
    console.log('后台常驻模式：不依赖标准输入，调度持续运行。停止请用 SIGTERM 或写停机标记。');
    const stopFile = join(config.workDir, '.runtime', 'watchdog.stop');
    const stopWatcher = setInterval(() => {
      try {
        if (existsSync(stopFile)) {
          console.log('检测到停机标记，退出后台模式。');
          process.kill(process.pid, 'SIGTERM');
        }
      } catch {
        // 忽略标记读取失败。
      }
    }, 3000);
    stopWatcher.unref?.();
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        console.log('收到停止信号，正在收尾。');
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    runtime.stop();
    clearInterval(heartbeatTimer);
    store.close();
    return;
  }
  try {
    await startRepl({ runtime, router });
  } finally {
    runtime.stop();
    clearInterval(heartbeatTimer);
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
