/**
 * 文件：入站落盘并成为任务材料、出站只发已登记产物、拒绝越界与超限。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from '../helpers.ts';
import { FakeAdapter, eventOf, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf, type OutboundSegment } from '../../src/channels/types.ts';
import { safeFileName, sha256Of, writeInboundAttachment, resolveArtifactPath } from '../../src/channels/storage.ts';
import { composeInboundText } from '../../src/channels/service.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });

test('文件名：路径穿越、控制字符与超长名都被清洗成单段安全名', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('..'), 'file.bin');
  assert.equal(safeFileName('.'), 'file.bin');
  assert.equal(safeFileName('a\u0000b.txt'), 'a_b.txt');
  assert.equal(safeFileName('C:\\Windows\\evil.exe'), 'evil.exe');
  const long = safeFileName(`${'x'.repeat(200)}.pdf`);
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('.pdf'), '长名应保留扩展名');
});

test('入站文件：落盘、复制成任务材料，指纹一致且可被 Worker 读到', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const payload = Buffer.from('# 用户给的材料\n数字 42\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:7',
      name: '../../材料.md',
      kind: 'file',
      mime: 'text/markdown',
      bytes: payload,
    });
    assert.equal(stored.name, '材料.md', '穿越的文件名应被清洗');
    const abs = join(harness.config.workDir, stored.path);
    assert.ok(existsSync(abs), '入站文件应落在受控目录');
    assert.equal(readFileSync(abs).toString('utf8'), payload.toString('utf8'));

    adapter.batches.push({
      events: [
        eventOf({
          channel: 'telegram',
          accountId: 'bot_1',
          peerId: 'owner-1',
          eventId: 'update:7',
          text: '看下这个文件',
          attachments: [stored],
        }),
      ],
      cursor: '8',
    });
    await service.tick();
    await service.waitForIdle(6_000);

    const turns = harness.store.listRouterTurns(20, TG_KEY);
    const userTurn = turns.find((turn) => turn.role === 'user');
    assert.ok(userTurn, '应有一条用户输入');
    assert.match(userTurn!.content ?? '', /看下这个文件/);
    assert.match(userTurn!.content ?? '', /材料\.md/, '要告诉 Router 收到的是什么文件');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站文件：同名材料不覆盖，第二个加序号', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  try {
    const dir = join(harness.config.workDir, 'task_x');
    mkdirSync(dir, { recursive: true });
    const { stageMaterials } = await import('../../src/channels/storage.ts');
    const first = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:1',
      name: 'a.txt',
      kind: 'file',
      mime: null,
      bytes: Buffer.from('第一份'),
    });
    const second = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:2',
      name: 'a.txt',
      kind: 'file',
      mime: null,
      bytes: Buffer.from('第二份'),
    });
    const staged = stageMaterials({
      workDir: harness.config.workDir,
      taskId: 'task_x',
      attachments: [first, second],
    });
    assert.equal(staged.length, 2, '两份材料都要落进任务目录');
    assert.notEqual(staged[0]?.name, staged[1]?.name, '重名不能互相覆盖');
    const contents = staged.map((item) =>
      readFileSync(join(harness.config.workDir, item.path), 'utf8'),
    );
    assert.deepEqual(contents.sort(), ['第一份', '第二份']);
  } finally {
    await harness.cleanup();
  }
});

test('出站文件：只发已登记且指纹一致的产物', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () =>
      mockReply({
        toolCalls: [
          { name: 'artifact_save', arguments: { name: 'report.md', content: '# 报告\n' } },
          { name: 'send_file', arguments: { task_id: 'PLACEHOLDER', name: 'report.md', note: '给你报告' } },
        ],
      }),
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const created = harness.runtime.createTask({
      title: 't',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 手工登记一个产物版本
    mkdirSync(join(harness.config.workDir, created.task.id), { recursive: true });
    const rel = `${created.task.id}/report.md`;
    writeFileSync(join(harness.config.workDir, rel), '# 报告\n', 'utf8');
    const bytes = readFileSync(join(harness.config.workDir, rel));
    harness.store.insertArtifact({
      id: 'art_1',
      taskId: created.task.id,
      workerId: created.owner.id,
      name: 'report.md',
      path: rel,
      version: 1,
      bytes: bytes.byteLength,
      sha256: sha256Of(bytes),
      createdAt: new Date().toISOString(),
    });

    service.enqueueOutbound(TG_KEY, '文件给你', created.task.id, 'report.md');
    await service.drainOutbound();

    const fileSends = adapter.sent.filter((item) => item.segment.kind === 'file');
    assert.equal(fileSends.length, 1, '应发送一次文件');
    assert.equal(fileSends[0]!.segment.path, join(harness.config.workDir, rel));
    assert.equal(fileSends[0]!.target.peerId, 'owner-1');

    // 产物被改坏后不能再发
    writeFileSync(join(harness.config.workDir, rel), '# 被改过\n', 'utf8');
    service.enqueueOutbound(TG_KEY, '再发一次', created.task.id, 'report.md');
    await service.drainOutbound();
    const rows = harness.store.listOutboundBySession(TG_KEY);
    const last = rows.at(-1)!;
    const segments = (Array.isArray(last.segments) ? last.segments : []) as OutboundSegment[];
    const fileSegment = segments.find((segment) => segment.kind === 'file')!;
    assert.equal(fileSegment.status, 'failed', '指纹不符必须拒绝发送');
    assert.match(fileSegment.error ?? '', /指纹不符/);
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站文件：没有登记过的名字与越界路径都不发', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const created = harness.runtime.createTask({
      title: 't',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    service.enqueueOutbound(TG_KEY, '发个不存在的', created.task.id, '../secrets.txt');
    await service.drainOutbound();
    const row = harness.store.listOutboundBySession(TG_KEY).at(-1)!;
    const segments = (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
    const fileSegment = segments.find((segment) => segment.kind === 'file')!;
    assert.equal(fileSegment.status, 'failed');
    assert.match(fileSegment.error ?? '', /没有名为/);
    assert.equal(adapter.sent.filter((item) => item.segment.kind === 'file').length, 0);
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('产物路径：越出工作目录一律拒绝', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: '收到' }) });
  try {
    writeFileSync(join(harness.dir, 'outside.txt'), 'x', 'utf8');
    assert.equal(resolveArtifactPath(harness.config.workDir, '../outside.txt'), null);
    assert.equal(resolveArtifactPath(harness.config.workDir, '/etc/hosts'), null);
    assert.equal(resolveArtifactPath(harness.config.workDir, 'not-there.txt'), null);
  } finally {
    await harness.cleanup();
  }
});

test('入站文件 → 建任务：材料真的落进任务目录，且写进任务说明', async () => {
  let created = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => {
      if (created > 0) return mockReply({ text: '已经建过了' });
      created += 1;
      return mockReply({
        toolCalls: [
          { name: 'create_task', arguments: { title: '看材料', goal: '读一下', owner_role: '执行者', owner_brief: '读' } },
        ],
      });
    },
  });
  const service = serviceOf({ runtime: harness.runtime, store: harness.store, config: harness.config });
  const adapter = new FakeAdapter('telegram', 'bot_1', ['owner-1']);
  service.register(adapter);
  service.start();
  try {
    const payload = Buffer.from('销量,利润\n10,3\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:21',
      name: '数据.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: payload,
    });
    adapter.batches.push({
      events: [
        eventOf({
          channel: 'telegram',
          accountId: 'bot_1',
          peerId: 'owner-1',
          eventId: 'update:21',
          text: '看下这个表',
          attachments: [stored],
        }),
      ],
      cursor: '22',
    });
    await service.tick();
    await service.waitForIdle(8_000);

    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1, '应建一个任务');
    const taskId = tasks[0]!.id;
    const materialPath = join(harness.config.workDir, taskId, 'materials', '数据.csv');
    assert.ok(existsSync(materialPath), `材料应复制进任务目录（找的是 ${materialPath}）`);
    assert.equal(readFileSync(materialPath, 'utf8'), payload.toString('utf8'), '材料内容必须一致');
    assert.match(tasks[0]!.brief, /materials\/数据\.csv/, '任务说明要写明材料位置');
    assert.match(tasks[0]!.brief, /sha256/, '任务说明要带指纹，便于核对版本');

    // 同一份材料不会被第二个任务重复认领
    const unclaimed = harness.store.listUnclaimedSessionAttachments(TG_KEY);
    assert.equal(unclaimed.length, 0, '材料已被认领，不能重复附着到别的任务');
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('入站描述：附件只说明存在与大小，不编造内容', () => {
  const text = composeInboundText('这是什么', [
    { kind: 'image', name: 'shot.png', mime: 'image/png', bytes: 2048, path: '.inbox/x', sha256: 'a' },
    { kind: 'file', name: 'data.csv', mime: 'text/csv', bytes: 4096, path: '.inbox/y', sha256: 'b' },
  ]);
  assert.match(text, /这是什么/);
  assert.match(text, /shot\.png/);
  assert.match(text, /没有视觉输入/, '必须如实说明模型读不了图');
  assert.match(text, /data\.csv/);
  assert.doesNotMatch(text, /内容是/, '不能编造文件内容');
});
