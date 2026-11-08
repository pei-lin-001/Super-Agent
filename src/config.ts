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
  maxStepsPerWorker: number;
  maxStepsPerGroup: number;
  maxRequestHops: number;
  messageTtlMinutes: number;
  waitTimeoutMs: number;
  modelRetry: number;
  maxNudges: number;
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
      maxStepsPerWorker: intEnv('MAX_STEPS_PER_WORKER', 24),
      maxStepsPerGroup: intEnv('MAX_STEPS_PER_GROUP', 160),
      maxRequestHops: intEnv('MAX_REQUEST_HOPS', 4),
      messageTtlMinutes: intEnv('MESSAGE_TTL_MINUTES', 30),
      waitTimeoutMs: intEnv('WAIT_TIMEOUT_SECONDS', 300) * 1000,
      modelRetry: intEnv('MODEL_RETRY', 2),
      maxNudges: 3,
    },
  };
}
