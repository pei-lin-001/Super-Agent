import assert from 'node:assert/strict';
import type { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import type { ProcessIdentity } from '../../src/watchdog/observer.ts';
import { mainHealth, stopMain, spawnMain } from '../../src/watchdog/process.ts';

interface Fixture {
  config: ReturnType<typeof loadConfig>;
  dir: string;
  runtimeDir: string;
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sa-process-health-'));
  const workDir = join(dir, 'work');
  const runtimeDir = join(workDir, '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  return {
    config: { ...loadConfig({ requireModel: false }), workDir },
    dir,
    runtimeDir,
  };
}

function writeInstance(fixture: Fixture, pid: number): void {
  writeFileSync(
    join(fixture.runtimeDir, 'instance.json'),
    JSON.stringify({
      pid,
      startedAt: '2026-11-13T00:00:00.000Z',
      stopped: false,
      heartbeat: join(fixture.runtimeDir, 'heartbeat.json'),
      kind: 'main',
    }),
    'utf8',
  );
}

function writeHeartbeat(fixture: Fixture, pid: number, at = Date.now()): void {
  writeFileSync(join(fixture.runtimeDir, 'heartbeat.json'), JSON.stringify({ pid, at }), 'utf8');
}

function identities(...values: ProcessIdentity[]): () => ProcessIdentity {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

test('身份探测区分 mismatch、unknown 与心跳弱证据', () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_001);

    const unknown = mainHealth(fixture.config, {
      isAlive: () => true,
      identify: () => 'unknown',
    });
    assert.equal(unknown.state, 'unverified');
    assert.equal(unknown.identity, 'unknown');
    assert.equal(unknown.degraded, false);
    assert.match(unknown.detail, /身份探测不可用/);
    assert.doesNotMatch(unknown.detail, /可能是 PID 复用|已确认.*PID 复用/);

    const mismatch = mainHealth(fixture.config, {
      isAlive: () => true,
      identify: () => 'mismatch',
    });
    assert.equal(mismatch.state, 'unverified');
    assert.equal(mismatch.identity, 'mismatch');
    assert.match(mismatch.detail, /确认不是.*PID 复用/);

    writeFileSync(
      join(fixture.runtimeDir, 'heartbeat.json'),
      JSON.stringify({ pid: 41_001 }),
      'utf8',
    );
    const noTimestamp = mainHealth(fixture.config, {
      isAlive: () => true,
      identify: () => 'match',
    });
    assert.equal(noTimestamp.state, 'alive');
    assert.match(noTimestamp.detail, /心跳.*未知/);

    writeHeartbeat(fixture, 41_001);
    const degraded = mainHealth(fixture.config, {
      isAlive: () => true,
      identify: () => 'unknown',
    });
    assert.equal(degraded.state, 'alive');
    assert.equal(degraded.identity, 'unknown');
    assert.equal(degraded.degraded, true);
    assert.match(degraded.detail, /降级判定.*只用于观察/);

    writeHeartbeat(fixture, 41_001, Date.now() - 120_000);
    assert.equal(
      mainHealth(fixture.config, { isAlive: () => true, identify: () => 'unknown' }).state,
      'unverified',
    );
    writeHeartbeat(fixture, 41_001, Date.now() + 60_000);
    assert.equal(
      mainHealth(fixture.config, { isAlive: () => true, identify: () => 'unknown' }).state,
      'unverified',
      '过远的未来心跳不能作为新鲜弱证据',
    );
    writeFileSync(
      join(fixture.runtimeDir, 'heartbeat.json'),
      '{"pid":41001,"at":1e309}',
      'utf8',
    );
    assert.equal(
      mainHealth(fixture.config, { isAlive: () => true, identify: () => 'unknown' }).state,
      'unverified',
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('弱证据只允许观察：拒绝停止、拒绝拉起并记录拒绝原因', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_002);
    writeHeartbeat(fixture, 41_002);
    const signals: string[] = [];
    let launchCount = 0;
    const launchStub = (() => {
      launchCount += 1;
      return {
        pid: 99_002,
        stdout: null,
        stderr: null,
        on: () => undefined,
        unref: () => undefined,
      } as unknown as ChildProcess;
    });

    const stopped = await stopMain(fixture.config, 0, {
      isAlive: () => true,
      identify: () => 'unknown',
      kill: (_pid, signal) => signals.push(signal),
    });
    assert.equal(stopped.stopped, false);
    assert.match(stopped.message, /弱证据.*不能授权终止进程/);
    assert.deepEqual(signals, [], '弱证据不能发送任何终止信号');

    const spawned = spawnMain(
      fixture.config,
      { cooldownMs: 0, allowRunning: true },
      {
        isAlive: () => true,
        identify: () => 'unknown',
        spawn: launchStub as typeof spawn,
      },
    );
    assert.equal(spawned.ok, false);
    assert.match(spawned.message, /弱证据.*不能授权启动/);
    assert.equal(launchCount, 0, '弱证据不能创建第二个主进程');

    const log = JSON.parse(readFileSync(join(fixture.runtimeDir, 'restart.json'), 'utf8')) as {
      outcome: string;
      detail: string;
    }[];
    assert.equal(log.at(-1)?.outcome, 'refused');
    assert.match(log.at(-1)?.detail ?? '', /弱证据/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('即使 allowRunning，强证据确认主进程存活时也不能重复拉起', () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_009);
    writeHeartbeat(fixture, 41_009);
    let launchCount = 0;
    const launchStub = (() => {
      launchCount += 1;
      return {
        pid: 99_009,
        stdout: null,
        stderr: null,
        on: () => undefined,
        unref: () => undefined,
      } as unknown as ChildProcess;
    });

    const result = spawnMain(
      fixture.config,
      { cooldownMs: 0, allowRunning: true },
      {
        isAlive: () => true,
        identify: () => 'match',
        spawn: launchStub as typeof spawn,
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /主系统仍存在/);
    assert.equal(launchCount, 0, 'allowRunning 不能绕过强证据存活检查');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('SIGTERM 超时后身份退化为 unknown，不继续发送 SIGKILL', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_003);
    writeHeartbeat(fixture, 41_003);
    const signals: string[] = [];
    const result = await stopMain(fixture.config, 0, {
      isAlive: () => true,
      identify: identities('match', 'unknown'),
      kill: (_pid, signal) => signals.push(signal),
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.match(result.message, /SIGTERM 超时后复查未通过.*弱证据/);
    assert.doesNotMatch(result.message, /SIGKILL 后/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('SIGTERM 遇到 ESRCH 时按进程已退出处理', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_010);
    const result = await stopMain(fixture.config, 0, {
      isAlive: () => true,
      identify: () => 'match',
      kill: () => {
        throw Object.assign(new Error('进程不存在'), { code: 'ESRCH' });
      },
    });

    assert.equal(result.stopped, true);
    assert.match(result.message, /发送 SIGTERM 前已退出/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('SIGTERM 超时后确认 PID 被复用，不以新身份的存活冒充原进程', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_004);
    const signals: string[] = [];
    const result = await stopMain(fixture.config, 0, {
      isAlive: () => true,
      identify: identities('match', 'mismatch'),
      kill: (_pid, signal) => signals.push(signal),
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.match(result.message, /PID 已确认被其他进程复用/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('SIGTERM 超时后探测失败给出独立诊断，不误报 PID 复用', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_005);
    const signals: string[] = [];
    const result = await stopMain(fixture.config, 0, {
      isAlive: () => true,
      identify: identities('match', 'unknown'),
      kill: (_pid, signal) => signals.push(signal),
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.match(result.message, /身份探测不可用/);
    assert.doesNotMatch(result.message, /PID 已确认被其他进程复用/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('等待 SIGTERM 时实例 PID 变化，立即中止且不发送 SIGKILL', async () => {
  const fixture = createFixture();
  try {
    const originalPid = 41_006;
    const replacementPid = 41_007;
    writeInstance(fixture, originalPid);
    const signals: string[] = [];
    const result = await stopMain(fixture.config, 10, {
      isAlive: (pid) => pid === originalPid || pid === replacementPid,
      identify: () => 'match',
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') writeInstance(fixture, replacementPid);
      },
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.match(result.message, /实例 PID 已从 41006 变为 41007/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('SIGTERM 超时后仍有强身份证据，才允许发送 SIGKILL', async () => {
  const fixture = createFixture();
  try {
    writeInstance(fixture, 41_008);
    writeHeartbeat(fixture, 41_008);
    let alive = true;
    const signals: string[] = [];
    const result = await stopMain(fixture.config, 0, {
      isAlive: () => alive,
      identify: () => 'match',
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') alive = false;
      },
    });

    assert.equal(result.stopped, true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.match(result.message, /SIGKILL 终止/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
