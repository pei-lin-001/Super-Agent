import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig } from './config.ts';
import { ModelRegistry } from './model/registry.ts';
import { OpenAICompatibleModel } from './model/openai.ts';
import type { ModelClient } from './model/types.ts';
import { Router } from './runtime/router.ts';
import { Runtime } from './runtime/runtime.ts';
import { createChannelService } from './channels/bootstrap.ts';
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

  // 实例标识：进程重启后与上一次完全不同，用来判断"这条调用记录属于谁"。
  const instanceId = `main_${randomBytes(8).toString('hex')}`;
  const store = new Store(config.dbPath, { instanceId });
  // 实例文件：Watchdog 靠它判断主系统是活着、已退出，还是身份无法确认。
  const instancePath = join(config.workDir, '.runtime', 'instance.json');
  mkdirSync(dirname(instancePath), { recursive: true });
  const heartbeatPath = join(config.workDir, '.runtime', 'heartbeat.json');
  const startedAt = new Date().toISOString();
  const writeInstance = (stopped: boolean): void => {
    try {
      writeFileSync(
        instancePath,
        JSON.stringify(
          {
            pid: stopped ? null : process.pid,
            startedAt,
            dbPath: config.dbPath,
            stopped,
            heartbeat: heartbeatPath,
            instanceId,
            kind: 'main',
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
  // 目录里每个别名一个客户端；同一个别名复用同一个实例，避免重复建连接。
  const modelClients = new Map<string, ModelClient>();
  for (const profile of config.models) {
    if (modelClients.has(profile.alias)) continue;
    modelClients.set(
      profile.alias,
      new OpenAICompatibleModel({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        timeoutMs: config.timeoutMs,
        retry: config.limits.modelRetry,
        reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens,
        label: `openai-compatible:${profile.alias}@${profile.baseUrl}`,
      }),
    );
  }
  const workerModel = modelClients.get(config.defaultModelAlias)!;
  const models = new ModelRegistry(config.models, modelClients);
  const routerModel = new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    label: `openai-compatible:${config.baseUrl}`,
  });

  const runtime = new Runtime({ store, config, workerModel, models });
  const router = new Router(runtime, routerModel, config);
  runtime.attachRouter(router);

  // 渠道层纳入同一个 daemon 生命周期，复用同一 Runtime 与 SQLite。
  const channels = createChannelService({
    runtime,
    store,
    config,
    log: (message) => console.log(`[渠道] ${message}`),
  });

  console.log(
    [
      `模型提供方：${config.provider}`,
      `端点：${config.baseUrl}`,
      `Router 模型：${config.routerModel}　Worker 模型：${config.workerModel}　思考强度：${config.reasoningEffort}`,
      `可用模型：${config.models.map((item) => `${item.alias}=${item.model}`).join('　')}`,
      `数据库：${config.dbPath}`,
      `工作目录：${config.workDir}`,
      `并发上限：${config.limits.maxConcurrentRuns}　单组 Worker 上限：${config.limits.maxWorkersPerGroup}`,
      channels && channels.summary.length > 0
        ? `渠道：${channels.summary.join('；')}`
        : '渠道：未启用（CLI 照常可用）',
      ...(channels?.problems ?? []).map((item) => `渠道提示：${item}`),
    ].join('\n'),
  );

  // 生命周期由主入口统一管理：恢复 → 启动调度 → 进入交互或后台等待 → 统一收尾。
  // 交互入口不再单独承担恢复与停止，避免两套逻辑分叉。
  const recovered = runtime.recover();
  if (recovered.recovered > 0 || recovered.waiting > 0) {
    console.log(
      `[恢复] 执行中断 ${recovered.interrupted} 个、重新排队 ${recovered.requeued} 个、仍在等待 ${recovered.waiting} 个。`,
    );
  }
  runtime.start();
  channels?.service.start();

  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      console.log(`正在收尾（${reason}）。`);
      try {
        // 先停渠道：让长轮询退出，别再往正在收尾的 Runtime 里送新消息。
        await channels?.service.stop();
      } catch (error) {
        console.error('渠道收尾出错：', (error as Error).message);
      }
      try {
        // 先停止接受新执行并等运行中的工作结束，再把存储关掉；
        // 任何迟到回调都会看到 stopped 标记，不会访问已经关闭的数据库。
        await runtime.stop();
      } catch (error) {
        console.error('收尾阶段出错：', (error as Error).message);
      }
      clearInterval(heartbeatTimer);
      try {
        store.close();
      } catch {
        // 关闭失败不阻塞退出。
      }
    })();
    return shuttingDown;
  };

  const waitForSignal = (): Promise<void> =>
    new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });

  process.on('unhandledRejection', (reason) => {
    console.error('未处理的 Promise 拒绝：', reason instanceof Error ? reason.message : reason);
  });

  const daemon = process.argv.includes('--daemon') || process.env['SUPER_AGENT_DAEMON'] === '1';
  if (daemon) {
    // 后台模式必须自己撑住事件循环：否则没有任何活跃句柄时进程会直接退出。
    heartbeatTimer.ref?.();
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
    await waitForSignal();
    await shutdown('收到停止信号');
    return;
  }
  const replDone = startRepl({ runtime, router }).catch((error: unknown) => {
    console.error('交互入口出错：', (error as Error).message);
  });
  await Promise.race([replDone, waitForSignal()]);
  await shutdown('退出');
  await replDone;
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
