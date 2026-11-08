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
  /** 近期历史窗口的字符预算（字符数，不是 token）。 */
  contextWindowChars: number;
  /** 组装后允许的额外配对扩展量。 */
  pairingOvershootChars: number;
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

export interface Config {
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  routerModel: string;
  workerModel: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxTokens: number;
  dbPath: string;
  workDir: string;
  materialsDir: string;
  limits: Limits;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`环境变量 ${name} 必须是正数，当前为 "${raw}"`);
  }
  return Math.trunc(value);
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
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

  return {
    provider,
    baseUrl,
    apiKey,
    modelName,
    routerModel: strEnv('ROUTER_MODEL', modelName),
    workerModel: strEnv('WORKER_MODEL', modelName),
    reasoningEffort: strEnv('MODEL_REASONING_EFFORT', 'max'),
    timeoutMs: intEnv('MODEL_TIMEOUT_MS', 180_000),
    maxTokens: intEnv('MODEL_MAX_TOKENS', 16384),
    dbPath: resolve(root, strEnv('DB_PATH', '.data/agent.db')),
    workDir,
    materialsDir,
    limits: {
      maxConcurrentRuns: intEnv('MAX_CONCURRENT_RUNS', 3),
      maxWorkersPerGroup: intEnv('MAX_WORKERS_PER_GROUP', 6),
      maxTotalWorkers: intEnv('MAX_TOTAL_WORKERS', 12),
      maxStepsPerRun: intEnv('MAX_STEPS_PER_RUN', 8),
      // 旧环境变量仍被读取，但语义已改为软阈值：达到只记录预算事件，不再让 Worker 失败。
      maxStepsPerWorker: intEnv('MAX_STEPS_PER_WORKER', 0),
      maxStepsPerGroup: intEnv('MAX_STEPS_PER_GROUP', 0),
      maxRequestHops: intEnv('MAX_REQUEST_HOPS', 4),
      messageTtlMinutes: intEnv('MESSAGE_TTL_MINUTES', 30),
      waitTimeoutMs: intEnv('WAIT_TIMEOUT_SECONDS', 300) * 1000,
      modelRetry: intEnv('MODEL_RETRY', 2),
      maxNudges: 3,
      maxRouterRounds: intEnv('MAX_ROUTER_ROUNDS', 6),
      watchdogIntervalMs: intEnv('WATCHDOG_INTERVAL_MS', 60_000),
      contextWindowChars: intEnv('CONTEXT_WINDOW_CHARS', 16_000),
      pairingOvershootChars: intEnv('CONTEXT_PAIRING_OVERSHOOT_CHARS', 2_000),
      noteTriggerTurns: intEnv('NOTE_TRIGGER_TURNS', 10),
      noteTriggerChars: intEnv('NOTE_TRIGGER_CHARS', 3_000),
      noteMaxChars: intEnv('NOTE_MAX_CHARS', 6_000),
      noteInputChars: intEnv('NOTE_INPUT_CHARS', 24_000),
      noteRetryMs: intEnv('NOTE_RETRY_MS', 120_000),
      noteMaxFailures: intEnv('NOTE_MAX_FAILURES', 3),
    },
  };
}
