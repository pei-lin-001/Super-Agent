/**
 * 计划重启的前置守卫。
 *
 * 这里不真的停/启进程（那属于 accept 脚本和真机）。只锁住一条最容易出事的：
 * 主系统身份不明时不能贸然拉起第二个进程——两个 daemon 抢同一个库、抢同一个
 * bot 长轮询，Telegram 会直接返回 Conflict 并把消息投给其中一个。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { mainHealth, spawnMain } from '../../src/watchdog/process.ts';

function makeConfig(): { config: ReturnType<typeof loadConfig>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sa-restart-'));
  mkdirSync(join(dir, 'work', '.runtime'), { recursive: true });
  return { config: { ...loadConfig({ requireModel: false }), workDir: join(dir, 'work') }, dir };
}

test('身份不明时不拉起第二个进程：allowRunning 也不能绕过这条', async () => {
  const { config, dir } = makeConfig();
  try {
    // 用自己的 pid 冒充主系统：进程活着，但命令行不是 src/main.ts → unverified
    writeFileSync(
      join(config.workDir, '.runtime', 'instance.json'),
      JSON.stringify({ pid: process.pid, stopped: false, kind: 'main' }),
      'utf8',
    );
    const health = mainHealth(config);
    assert.equal(health.state, 'unverified', `应判定为身份不明（实际 ${health.state}）`);

    for (const allowRunning of [false, true]) {
      const result = spawnMain(config, { cooldownMs: 0, allowRunning });
      assert.equal(result.ok, false, `allowRunning=${allowRunning} 时仍应拒绝`);
      assert.match(result.message, /无法确认/);
      // 拒绝时 pid 是"涉及的那个旧进程"，不是新进程——这里只确认没有真的启动。
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('活着且心跳新鲜时不重复拉起', async () => {
  const { config, dir } = makeConfig();
  try {
    // 用自己的 pid，同时把命令行伪装成 src/main.ts 不现实；这里用 unverified 之外的
    // 一条：心跳文件属于另一个 pid → unverified，同样必须拒绝。
    writeFileSync(
      join(config.workDir, '.runtime', 'instance.json'),
      JSON.stringify({
        pid: process.pid,
        stopped: false,
        kind: 'main',
        heartbeat: join(config.workDir, '.runtime', 'heartbeat.json'),
      }),
      'utf8',
    );
    writeFileSync(
      join(config.workDir, '.runtime', 'heartbeat.json'),
      JSON.stringify({ at: Date.now(), pid: 999_999 }),
      'utf8',
    );
    const result = spawnMain(config, { cooldownMs: 0, allowRunning: true });
    assert.equal(result.ok, false, '心跳不属于该进程时必须拒绝');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
