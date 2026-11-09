/**
 * 增量迁移必须能升级真实的旧库，而不是只在新建库上看起来正常。
 *
 * 这里的旧库结构是手工按照升级前的样子建的：wd_action 没有 command_id，
 * 并且里面已经有维护动作记录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../../src/storage/store.ts';

/** 升级前的 wd_action：没有 command_id。 */
function buildLegacyDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE wd_action (
      id         TEXT PRIMARY KEY,
      issue_id   TEXT,
      action     TEXT NOT NULL,
      reason     TEXT,
      expected   TEXT,
      result     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE wd_issue (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', attempts INTEGER NOT NULL DEFAULT 0,
      note TEXT, check_after TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
    );
    CREATE TABLE wd_turn (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO wd_action (id, issue_id, action, reason, expected, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('wda_legacy', 'wdi_old', 'nudge_worker', '旧记录', '旧期望', '旧结果', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO wd_issue (id, task_id, title, status, attempts, note, check_after, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('wdi_old', null, '旧问题', 'closed', 2, '已解决', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(`INSERT INTO wd_turn (id, role, content, created_at) VALUES (?, ?, ?, ?)`).run(
    'wdt_old',
    'user',
    '旧提问',
    '2026-01-01T00:00:00.000Z',
  );
  db.close();
}

test('旧库升级：缺列的表能迁移，旧记录保留，新字段可读写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-migrate-'));
  const path = join(dir, 'legacy.sqlite');
  try {
    buildLegacyDb(path);

    // 用当前 Store 打开：这里会执行增量迁移
    const store = new Store(path);
    try {
      const actions = store.listWdActions(10);
      const legacy = actions.find((action) => action.id === 'wda_legacy');
      assert.ok(legacy, '旧维护动作必须保留下来');
      assert.equal(legacy?.action, 'nudge_worker');
      assert.equal(legacy?.reason, '旧记录');

      // 新字段存在，并且能写入关联
      store.appendWdAction({
        id: 'wda_new',
        issueId: 'wdi_old',
        commandId: 'cc_new',
        action: 'nudge_worker',
        reason: '新记录',
        expected: '新期望',
        result: '新结果',
      });
      const after = store.listWdActions(10);
      const created = after.find((action) => action.id === 'wda_new');
      assert.ok(created, '新记录要能写进去');
      assert.equal(created?.commandId, 'cc_new', '新字段要能读回来');

      const issues = store.listOpenIssues();
      assert.equal(issues.length, 0, '旧问题状态保持不变（closed）');
    } finally {
      store.close();
    }

    // 幂等：再次打开不应该报错，也不应该丢数据
    const again = new Store(path);
    try {
      const actions = again.listWdActions(10);
      assert.equal(actions.length, 2, '重复打开后记录数不变');
      assert.equal(actions.find((a) => a.id === 'wda_new')?.commandId, 'cc_new');
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧库升级后：主系统与维护入口都能正常初始化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-migrate-init-'));
  const path = join(dir, 'legacy.sqlite');
  const saved: Record<string, string | undefined> = {};
  try {
    buildLegacyDb(path);
    for (const [key, value] of Object.entries({
      DB_PATH: path,
      WORK_DIR: join(dir, 'work'),
      OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
      OLLAMA_API_KEY: 'k',
      MODEL_NAME: 'm',
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    const { loadConfig } = await import('../../src/config.ts');
    const { MockModel } = await import('../../src/model/mock.ts');
    const { Runtime } = await import('../../src/runtime/runtime.ts');
    const { WatchdogSession } = await import('../../src/watchdog/session.ts');

    const config = loadConfig();
    const store = new Store(config.dbPath);
    try {
      const runtime = new Runtime({
        store,
        config,
        workerModel: new MockModel(() => ({
          text: 'ok',
          reasoning: null,
          toolCalls: [],
          finishReason: 'stop',
          model: 'm',
          usage: null,
        })),
      });
      runtime.start();
      runtime.tick();
      assert.equal(runtime.stats().running, 0, '升级后的库能正常参与调度');

      const session = new WatchdogSession({
        store,
        config,
        model: new MockModel(() => ({
          text: '结论',
          reasoning: null,
          toolCalls: [],
          finishReason: 'stop',
          model: 'm',
          usage: null,
        })),
        modelName: 'm',
        restartMain: async () => ({ ok: true, message: 'ok' }),
        health: () => ({ state: 'alive' as const, pid: 1, detail: 'test', heartbeatAgeMs: 10 }),
      });
      const answer = await session.ask('升级后还能问答吗？');
      assert.match(answer, /结论/, '维护入口在升级后的库上能工作');

      await runtime.stop();
    } finally {
      if (!store.isClosed) store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('迁移：老历史没有话题归属时，收进该会话最早的话题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-agent-mig-'));
  const path = join(dir, 'agent.db');
  try {
    // 先用当前结构建库，再手工造出"话题前"的历史
    const store = new Store(path);
    store.createConversation({
      id: 'cv_first',
      sessionKey: 'telegram|bot_1|owner-1',
      title: '默认话题',
      now: '2026-01-01T00:00:00.000Z',
    });
    store.appendRouterTurn({
      id: 'rt_old',
      role: 'user',
      content: '升级前说过的话',
      sessionKey: 'telegram|bot_1|owner-1',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    store.appendRouterTurn({
      id: 'rt_new',
      role: 'user',
      content: '已经有话题的话',
      sessionKey: 'telegram|bot_1|owner-1',
      conversationId: 'cv_first',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    store.close();

    // 重新打开 = 走一次迁移
    const reopened = new Store(path);
    const turns = reopened.listRouterTurns(20, 'telegram|bot_1|owner-1', 'cv_first');
    assert.deepEqual(
      turns.map((turn) => turn.content),
      ['升级前说过的话', '已经有话题的话'],
      '老历史应被收进第一个话题，且顺序不乱',
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
