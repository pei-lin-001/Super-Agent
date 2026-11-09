/**
 * 调用记录的实例归属。
 *
 * 崩溃实例留下的 running 必须能收敛，存活实例与归属未知的记录一律不动。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { MockModel } from '../../src/model/mock.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { loadConfig } from '../../src/config.ts';
import { Store } from '../../src/storage/store.ts';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'sa-instance-'));
}

test('实例归属：崩溃实例的调用收敛，存活与未知记录保留', () => {
  const dir = makeDir();
  const path = join(dir, 'db.sqlite');
  try {
    // 先写入三条 running：已退出实例、存活实例、无归属的旧记录
    const writer = new Store(path, { instanceId: 'inst_dead' });
    writer.startModelCall({ id: 'mc_dead', purpose: 'worker', model: 'm' });
    writer.close();

    const alive = new Store(path, { instanceId: 'inst_alive' });
    alive.startModelCall({ id: 'mc_alive', purpose: 'watchdog', model: 'm' });

    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO model_call (id, instance_id, purpose, model, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    ).run('mc_legacy', null, 'router', 'm', '2026-01-01T00:00:00.000Z');
    db.close();

    // 存活实例：在实例文件里写自己的 pid，身份可确认
    const runtimeDir = join(dir, 'work', '.runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'watchdog.json'),
      JSON.stringify({ pid: process.pid, instanceId: 'inst_alive', stopped: false }),
      'utf8',
    );

    const reader = new Store(path, { instanceId: 'inst_new' });
    try {
      const result = reader.recoverModelCalls((instanceId) => {
        // 只有 inst_alive 有实例文件且进程存在
        return instanceId === 'inst_alive';
      });
      assert.ok(result.interrupted >= 1, '崩溃实例的记录应被收敛');
    } finally {
      reader.close();
    }
    alive.close();

    const verify = new DatabaseSync(path, { readOnly: true });
    const rows = verify.prepare('SELECT id, status FROM model_call ORDER BY id').all() as {
      id: string;
      status: string;
    }[];
    verify.close();
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    assert.equal(byId.get('mc_dead'), 'interrupted', '已退出实例的调用要收敛为 interrupted');
    assert.equal(byId.get('mc_alive'), 'running', '存活实例的调用不能被误改');
    assert.equal(byId.get('mc_legacy'), 'running', '归属未知的旧记录不猜，保持原状');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('实例归属：新调用会写入本实例标识，重启后不会互相覆盖', () => {
  const dir = makeDir();
  const path = join(dir, 'db.sqlite');
  try {
    const first = new Store(path, { instanceId: 'inst_a' });
    first.startModelCall({ id: 'mc_a', purpose: 'worker', model: 'm' });
    first.finishModelCall({ id: 'mc_a', status: 'ok', usage: null, httpAttempts: 1, error: null });
    first.close();

    const second = new Store(path, { instanceId: 'inst_b' });
    second.startModelCall({ id: 'mc_b', purpose: 'worker', model: 'm' });
    second.finishModelCall({ id: 'mc_b', status: 'failed', usage: null, httpAttempts: 2, error: 'boom' });
    second.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('SELECT id, instance_id, status FROM model_call ORDER BY id').all() as {
      id: string;
      instance_id: string | null;
      status: string;
    }[];
    db.close();
    assert.equal(rows.find((r) => r.id === 'mc_a')?.instance_id, 'inst_a');
    assert.equal(rows.find((r) => r.id === 'mc_b')?.instance_id, 'inst_b');
    assert.equal(rows.find((r) => r.id === 'mc_a')?.status, 'ok');
    assert.equal(rows.find((r) => r.id === 'mc_b')?.status, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('实例归属：主系统与 Watchdog 互不误清', () => {
  const dir = makeDir();
  const path = join(dir, 'db.sqlite');
  try {
    const mainStore = new Store(path, { instanceId: 'main_x' });
    mainStore.startModelCall({ id: 'mc_main', purpose: 'worker', model: 'm' });
    const wdStore = new Store(path, { instanceId: 'watchdog_y' });
    wdStore.startModelCall({ id: 'mc_wd', purpose: 'watchdog', model: 'm' });

    // 维护者执行恢复：只能动"确认已退出"的实例，主系统还在跑
    const result = wdStore.recoverModelCalls(() => true);
    assert.equal(result.interrupted, 0, '所有实例都存活时不应改动任何记录');
    wdStore.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('SELECT id, status FROM model_call').all() as { id: string; status: string }[];
    db.close();
    mainStore.close();
    assert.ok(rows.every((row) => row.status === 'running'), '两个实例的调用都应保持 running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('实例归属：真实进程被 SIGKILL 后，下一次启动把它的调用收敛', async () => {
  const dir = makeDir();
  const path = join(dir, 'db.sqlite');
  const workDir = join(dir, 'work');
  try {
    // 起一个真实进程：它写一条 running 调用后挂住，等着被杀
    const child = spawn(
      process.execPath,
      [
        '-e',
        `import('${process.cwd()}/src/storage/store.ts').then(({ Store }) => {
           const store = new Store(${JSON.stringify(path)}, { instanceId: 'inst_killed' });
           store.startModelCall({ id: 'mc_killed', purpose: 'worker', model: 'm' });
           console.log('ready');
           setInterval(() => {}, 1000);
         });`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程没有准备好')), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // 写实例文件，让它看起来"活着"
    mkdirSync(join(workDir, '.runtime'), { recursive: true });
    writeFileSync(
      join(workDir, '.runtime', 'instance.json'),
      JSON.stringify({ pid: child.pid, instanceId: 'inst_killed', stopped: false }),
      'utf8',
    );

    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    // 新实例启动：应该把 mc_killed 收敛
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({
      DB_PATH: path,
      WORK_DIR: workDir,
      OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
      OLLAMA_API_KEY: 'k',
      MODEL_NAME: 'm',
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const config = loadConfig();
      const store = new Store(config.dbPath, { instanceId: 'inst_next' });
      const runtime = new Runtime({
        store,
        config,
        workerModel: new MockModel(() => ({
          text: null,
          reasoning: null,
          toolCalls: [],
          finishReason: 'stop',
          model: 'm',
          usage: null,
        })),
      });
      runtime.recover();
      const db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT status FROM model_call WHERE id = 'mc_killed'").get() as { status: string };
      db.close();
      assert.equal(row.status, 'interrupted', '被杀实例的调用必须收敛为 interrupted');
      await runtime.stop();
      store.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
