import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Limits {
  maxConcurrentRuns: number;
  maxWorkersPerGroup: number;
  maxTotalWorkers: number;
  maxStepsPerRun: number;
  /** 累计调用软阈值：>0 时只记录预算事件并继续，不再直接失败（0=不提醒）。 */
  maxStepsPerWorker: number;
  maxStepsPerGroup: number;
  maxRequestHops: number;
  messageTtlMinutes: number;
  waitTimeoutMs: number;
  modelRetry: number;
  /** 连续只输出文本、不调用工具的容忍次数；超过后交给 Watchdog 诊断，不再直接失败。 */
  maxNudges: number;
  /** Router 单次运行的调度轮数上限，超出后保存进度并在下次 tick 继续。 */
  maxRouterRounds: number;
  /** Watchdog 巡检间隔（毫秒）。 */
  watchdogIntervalMs: number;
  /**
   * 近期历史窗口的字符预算（字符数，不是 token）。
   *
   * 按 pi 的经验换算约 4 字符 = 1 token：默认 200k 字符 ≈ 50k token，
   * 足够装下一整篇文章加当前工作历史。窗口给小了会迫使模型反复重读同一份材料
   * ——那看起来像"跑不完"，实际是工作记忆装不下工作集。
   */
  contextWindowChars: number;
  /** 组装后允许的额外配对扩展量。 */
  pairingOvershootChars: number;
  /** 模型上下文窗口（token）。按它算 Router 的压缩阈值。 */
  contextWindowTokens: number;
  /** Router 触发压缩前预留的 token。 */
  routerReserveTokens: number;
  /** Router 压缩后保留的近期对话 token（越大约不常压缩、越贵）。 */
  routerKeepRecentTokens: number;
  /** Worker 超出窗口后保留的近期历史 token。 */
  workerKeepRecentTokens: number;
  /** Router 摘要长度上限（字符）。 */
  routerNoteMaxChars: number;
  /** 触发一次整理所需的新增历史条数与字符数，两者同时满足。 */
  noteTriggerTurns: number;
  noteTriggerChars: number;
  /** 单份工作记录的长度上限。 */
  noteMaxChars: number;
  /** 单次整理读入的历史字符上限。 */
  noteInputChars: number;
  /** 整理失败后的最小重试间隔与连续失败上限。 */
  noteRetryMs: number;
  noteMaxFailures: number;
}

/**
 * 一个"模型配置项"：别名 + 连接方式 + 模型名。
 *
 * 别名只是名字，不与「规划者 / 执行者 / 检查者」这类职责绑定：
 * 同一个别名可以执行，也可以检查；同一职责也可以由不同别名承担。
 */
export interface ModelProfile {
  alias: string;
  /** 提供方协议；本轮只实现 OpenAI-compatible。 */
  provider: string;
  baseUrl: string;
  apiKey: string;
  /**
   * 凭据来自哪个环境变量。
   *
   * 目录里只写变量名、不写明文：跨供应商时每个别名要用不同的 key，
   * 但明文仍然只能出现在 .env.local 里。
   */
  apiKeyEnv: string | null;
  /** 真正发给提供方的模型名。 */
  model: string;
  /** 该别名的思考强度；为空则用全局 MODEL_REASONING_EFFORT。 */
  reasoningEffort: string | null;
  /**
   * 这个别名是决策模型（只做分类），不是 chat 模型。
   *
   * clef:27b 这类模型走 /v1/systemone，用 chat 接口会直接报错，
   * 所以选路线时不能只看模型名，要看这个标记。
   */
  kind: 'chat' | 'decision';
  /**
   * 这个模型真实的上下文窗口（token）；为空则用全局 contextWindowTokens。
   *
   * 必须填真实值：填大了提供方直接 400，填小了压缩过早、白花钱。
   */
  contextWindow: number | null;
  /** 来自配置的用途说明，不是实测能力。 */
  note: string | null;
  /** 来自配置的相对成本说明，不是实时价格。 */
  costHint: string | null;
}

/** 一个 IM 渠道的运行配置。凭据只从环境读取，不写进任何业务表或日志。 */
export interface ChannelAccountConfig {
  enabled: boolean;
  /** 授权的稳定用户 ID；空数组表示尚未绑定主人，此时不接收任何执行请求。 */
  ownerIds: string[];
  /** Telegram Bot token / 微信登录状态文件路径由适配器自行解析。 */
  botToken: string;
  /** 平台 API 基地址，便于自建网关或本地联调。 */
  apiBase: string;
  /** 微信媒体 CDN 基地址。 */
  cdnBase: string;
}

export interface ChannelsConfig {
  telegram: ChannelAccountConfig;
  weixin: ChannelAccountConfig;
  /** 渠道状态与凭据目录（文件权限 0600）。 */
  stateDir: string;
  /** 单次长轮询的等待上限。 */
  pollTimeoutMs: number;
  /** 允许接收的单个文件上限（字节）。 */
  maxInboundBytes: number;
}

export interface Config {
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  routerModel: string;
  workerModel: string;
  /** 可调用模型目录；至少包含 default。 */
  models: ModelProfile[];
  /** Worker 未指定模型时使用的别名。 */
  defaultModelAlias: string;
  channels: ChannelsConfig;
  reasoningEffort: string;
  timeoutMs: number;
  maxTokens: number;
  dbPath: string;
  workDir: string;
  materialsDir: string;
  /** 只读根：Worker 读文件的上限范围（仓库根）。写操作仍限制在任务目录。 */
  readRoot: string;
  limits: Limits;
}

function intEnv(name: string, fallback: number, options: { allowZero?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isFinite(value) || value < minimum || !Number.isInteger(value)) {
    const expectation = options.allowZero ? '非负整数' : '正整数';
    throw new ConfigError(`环境变量 ${name} 必须是${expectation}，当前为 "${raw}"`);
  }
  return value;
}

/** 逗号分隔的 ID 列表；允许空格，忽略空项。 */
function listEnv(name: string): string[] {
  return strEnv(name, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = strEnv(name, '').toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/**
 * 读取模型目录。
 *
 * 优先用 `MODEL_CATALOG`（JSON 数组）；没有就用 `MODEL_NAME` 造一个 `default`，
 * 保证旧配置照常启动。凭据只从环境读取，不进入任何会被写进库或日志的结构。
 */
function loadModelProfiles(fallback: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}): ModelProfile[] {
  const raw = strEnv('MODEL_CATALOG', '').trim();
  if (raw === '') {
    return [
      {
        alias: 'default',
        provider: fallback.provider,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        apiKeyEnv: null,
        model: fallback.modelName,
        reasoningEffort: null,
        kind: 'chat',
        contextWindow: null,
        note: null,
        costHint: null,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'MODEL_CATALOG 不是合法 JSON，请写成 [{"alias":"...","model":"..."}]；' +
        '注意用它时请通过 node --env-file-if-exists=.env.local 加载，shell 的 source 会吃掉 JSON 里的引号',
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError('MODEL_CATALOG 必须是非空数组');
  }
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null) throw new ConfigError(`MODEL_CATALOG[${index}] 必须是对象`);
    const record = item as Record<string, unknown>;
    const alias = typeof record['alias'] === 'string' ? record['alias'].trim() : '';
    const model = typeof record['model'] === 'string' ? record['model'].trim() : '';
    if (alias === '') throw new ConfigError(`MODEL_CATALOG[${index}] 缺少 alias`);
    if (model === '') throw new ConfigError(`MODEL_CATALOG[${index}] 缺少 model`);
    if (seen.has(alias)) throw new ConfigError(`模型别名重复：${alias}`);
    seen.add(alias);
    // 凭据只能来自环境：目录里写 apiKey 明文一律忽略，只认 apiKeyEnv 指向的变量名。
    const apiKeyEnv = typeof record['apiKeyEnv'] === 'string' ? record['apiKeyEnv'].trim() : '';
    const scopedKey = apiKeyEnv === '' ? '' : strEnv(apiKeyEnv, '');
    if (apiKeyEnv !== '' && scopedKey === '') {
      throw new ConfigError(`模型别名 ${alias} 的 apiKeyEnv=${apiKeyEnv} 没有对应环境变量`);
    }
    profiles.push({
      alias,
      provider: typeof record['provider'] === 'string' ? record['provider'] : fallback.provider,
      baseUrl: typeof record['baseUrl'] === 'string' ? record['baseUrl'] : fallback.baseUrl,
      apiKey: scopedKey === '' ? fallback.apiKey : scopedKey,
      apiKeyEnv: apiKeyEnv === '' ? null : apiKeyEnv,
      model,
      reasoningEffort: typeof record['reasoningEffort'] === 'string' ? record['reasoningEffort'] : null,
      kind: record['kind'] === 'decision' ? 'decision' : 'chat',
      contextWindow:
        typeof record['contextWindow'] === 'number' && Number.isFinite(record['contextWindow']) && record['contextWindow'] > 0
          ? Math.floor(record['contextWindow'])
          : null,
      note: typeof record['note'] === 'string' ? record['note'] : null,
      costHint: typeof record['costHint'] === 'string' ? record['costHint'] : null,
    });
  }
  return profiles;
}

export function loadConfig(options: { requireModel?: boolean } = {}): Config {
  const requireModel = options.requireModel ?? true;
  const provider = strEnv('MODEL_PROVIDER', 'ollama-cloud');
  const baseUrl = strEnv('OLLAMA_BASE_URL', strEnv('MODEL_BASE_URL', ''));
  const apiKey = strEnv('OLLAMA_API_KEY', strEnv('MODEL_API_KEY', ''));
  const modelName = strEnv('MODEL_NAME', '');

  if (requireModel) {
    if (!baseUrl) throw new ConfigError('缺少 OLLAMA_BASE_URL（或 MODEL_BASE_URL），请写入 .env.local');
    if (!apiKey) throw new ConfigError('缺少 OLLAMA_API_KEY，请写入 .env.local（不要提交到仓库）');
    if (!modelName) throw new ConfigError('缺少 MODEL_NAME，请写入 .env.local');
  }

  const root = process.cwd();
  const workDir = resolve(root, strEnv('WORK_DIR', 'work'));
  const materialsDir = resolve(workDir, 'materials');
  // 默认是整个工程根：worker 要像 pi 一样能读仓库，而不是只看得见自己的任务目录。
  const readRoot = resolve(root, strEnv('READ_ROOT', '.')).replace(/[\\/]+$/, '');

  const models = loadModelProfiles({ provider, baseUrl, apiKey, modelName });
  const channels: ChannelsConfig = {
    stateDir: resolve(root, strEnv('CHANNEL_STATE_DIR', '.data/channels')),
    pollTimeoutMs: intEnv('CHANNEL_POLL_TIMEOUT_MS', 25_000),
    maxInboundBytes: intEnv('CHANNEL_MAX_INBOUND_BYTES', 25 * 1024 * 1024),
    telegram: {
      enabled: boolEnv('TELEGRAM_ENABLED', strEnv('TELEGRAM_BOT_TOKEN', '') !== ''),
      ownerIds: listEnv('TELEGRAM_OWNER_IDS'),
      botToken: strEnv('TELEGRAM_BOT_TOKEN', ''),
      apiBase: strEnv('TELEGRAM_API_BASE', 'https://api.telegram.org'),
      cdnBase: '',
    },
    weixin: {
      enabled: boolEnv('WEIXIN_ENABLED', false),
      ownerIds: listEnv('WEIXIN_OWNER_IDS'),
      botToken: '',
      apiBase: strEnv('WEIXIN_API_BASE', 'https://ilinkai.weixin.qq.com'),
      cdnBase: strEnv('WEIXIN_CDN_BASE', 'https://novac2c.cdn.weixin.qq.com/c2c'),
    },
  };
  const defaultModelAlias = strEnv('DEFAULT_MODEL_ALIAS', models[0]?.alias ?? 'default');
  if (requireModel && !models.some((item) => item.alias === defaultModelAlias)) {
    throw new ConfigError(
      `默认模型别名 ${defaultModelAlias} 不在模型目录里；可用别名：${models.map((item) => item.alias).join(', ')}`,
    );
  }

  return {
    provider,
    baseUrl,
    apiKey,
    modelName,
    routerModel: strEnv('ROUTER_MODEL', modelName),
    workerModel: strEnv('WORKER_MODEL', modelName),
    models,
    defaultModelAlias,
    channels,
    reasoningEffort: strEnv('MODEL_REASONING_EFFORT', 'max'),
    timeoutMs: intEnv('MODEL_TIMEOUT_MS', 180_000),
    maxTokens: intEnv('MODEL_MAX_TOKENS', 16384),
    dbPath: resolve(root, strEnv('DB_PATH', '.data/agent.db')),
    workDir,
    materialsDir,
    readRoot,
    limits: {
      maxConcurrentRuns: intEnv('MAX_CONCURRENT_RUNS', 3),
      maxWorkersPerGroup: intEnv('MAX_WORKERS_PER_GROUP', 6),
      maxTotalWorkers: intEnv('MAX_TOTAL_WORKERS', 12),
      maxStepsPerRun: intEnv('MAX_STEPS_PER_RUN', 8),
      // 旧环境变量仍被读取，但语义已改为软阈值：达到只记录预算事件，不再让 Worker 失败。
      maxStepsPerWorker: intEnv('MAX_STEPS_PER_WORKER', 0, { allowZero: true }),
      maxStepsPerGroup: intEnv('MAX_STEPS_PER_GROUP', 0, { allowZero: true }),
      maxRequestHops: intEnv('MAX_REQUEST_HOPS', 4),
      messageTtlMinutes: intEnv('MESSAGE_TTL_MINUTES', 30),
      waitTimeoutMs: intEnv('WAIT_TIMEOUT_SECONDS', 300) * 1000,
      modelRetry: intEnv('MODEL_RETRY', 2),
      maxNudges: 3,
      maxRouterRounds: intEnv('MAX_ROUTER_ROUNDS', 6),
      watchdogIntervalMs: intEnv('WATCHDOG_INTERVAL_MS', 60_000),
      contextWindowChars: intEnv('CONTEXT_WINDOW_CHARS', 200_000),
      pairingOvershootChars: intEnv('CONTEXT_PAIRING_OVERSHOOT_CHARS', 8_000),
      // Router 的压缩阈值取 min(窗口-reserve, 窗口*0.75)：窗口越大，前者越接近窗口本身，
      // 于是永不触发。200k 窗口下阈值 150k，留 50k 给任务卡、待处理消息和输出。
      // 必须是模型**真实**窗口，不是名义值：配大了会直接被提供方 400。
      // deepseek-v4.1-flash 实测 226k token 的请求能过，取 256k。
      contextWindowTokens: intEnv('CONTEXT_WINDOW_TOKENS', 256_000),
      routerReserveTokens: intEnv('ROUTER_RESERVE_TOKENS', 16_384),
      routerKeepRecentTokens: intEnv('ROUTER_KEEP_RECENT_TOKENS', 40_000),
      workerKeepRecentTokens: intEnv('WORKER_KEEP_RECENT_TOKENS', 40_000),
      routerNoteMaxChars: intEnv('ROUTER_NOTE_MAX_CHARS', 6_000),
      noteTriggerTurns: intEnv('NOTE_TRIGGER_TURNS', 10),
      noteTriggerChars: intEnv('NOTE_TRIGGER_CHARS', 3_000),
      noteMaxChars: intEnv('NOTE_MAX_CHARS', 10_000),
      noteInputChars: intEnv('NOTE_INPUT_CHARS', 80_000),
      noteRetryMs: intEnv('NOTE_RETRY_MS', 120_000),
      noteMaxFailures: intEnv('NOTE_MAX_FAILURES', 3),
    },
  };
}
