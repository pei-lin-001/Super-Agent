/**
 * 文件：入站落盘并成为任务材料、出站只发已登记产物、拒绝越界与超限。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from '../helpers.ts';
import { FakeAdapter, eventOf, serviceOf } from '../channel-helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf, type OutboundSegment } from '../../src/channels/types.ts';
import { fileTools } from '../../src/tools/files.ts';
import { safeFileName, sha256Of, writeInboundAttachment, resolveArtifactPath } from '../../src/channels/storage.ts';
import { composeInboundText } from '../../src/channels/service.ts';
import { ConversationService } from '../../src/channels/conversations.ts';

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

    const pinned = { artifactId: 'art_1', name: 'report.md', version: 1, sha256: sha256Of(bytes), bytes: bytes.byteLength };
    service.enqueueOutbound(TG_KEY, '文件给你', created.task.id, pinned);
    await service.drainOutbound();

    const fileSends = adapter.sent.filter((item) => item.segment.kind === 'file');
    assert.equal(fileSends.length, 1, '应发送一次文件');
    assert.equal(fileSends[0]!.segment.path, join(harness.config.workDir, rel));
    assert.equal(fileSends[0]!.target.peerId, 'owner-1');

    // 产物被改坏后不能再发
    writeFileSync(join(harness.config.workDir, rel), '# 被改过\n', 'utf8');
    service.enqueueOutbound(TG_KEY, '再发一次', created.task.id, pinned);
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
    service.enqueueOutbound(TG_KEY, '发个不存在的', created.task.id, {
      artifactId: 'art_missing',
      name: '../secrets.txt',
      version: 1,
      sha256: 'deadbeef',
      bytes: 1,
    });
    await service.drainOutbound();
    const row = harness.store.listOutboundBySession(TG_KEY).at(-1)!;
    const segments = (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
    const fileSegment = segments.find((segment) => segment.kind === 'file')!;
    assert.equal(fileSegment.status, 'failed');
    assert.match(fileSegment.error ?? '', /产物记录不存在/);
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
  // 图片本身随请求走多模态，这里只留一句可回溯的事实。
  const text = composeInboundText('这是什么', [
    { kind: 'image', name: 'shot.png', mime: 'image/png', bytes: 2048, path: '.inbox/x', sha256: 'a' },
    { kind: 'file', name: 'data.csv', mime: 'text/csv', bytes: 4096, path: '.inbox/y', sha256: 'b' },
  ]);
  assert.match(text, /这是什么/);
  assert.match(text, /shot\.png/);
  assert.match(text, /画面内容见随附图片/, '图跟着当轮请求一起发，说明要指向它');
  assert.match(text, /data\.csv/);
  assert.doesNotMatch(text, /内容是/, '不能编造文件内容');
});

test('出站文件：排队后登记了新版本，也只发排队时固定的那一份', async () => {
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
    const write = (rel: string, body: string): { bytes: Buffer; sha: string } => {
      writeFileSync(join(harness.config.workDir, rel), body, 'utf8');
      const bytes = readFileSync(join(harness.config.workDir, rel));
      return { bytes, sha: sha256Of(bytes) };
    };

    const v1Rel = `${created.task.id}/artifacts/v1/report.md`;
    mkdirSync(join(harness.config.workDir, created.task.id, 'artifacts', 'v1'), { recursive: true });
    const v1 = write(v1Rel, '# 第一版\n');
    harness.store.insertArtifact({
      id: 'art_v1',
      taskId: created.task.id,
      workerId: created.owner.id,
      name: 'report.md',
      path: v1Rel,
      version: 1,
      bytes: v1.bytes.byteLength,
      sha256: v1.sha,
      createdAt: new Date().toISOString(),
    });

    // 用户此刻说"发我这份"：排队时就固定 v1。
    service.enqueueOutbound(TG_KEY, '发你 v1', created.task.id, {
      artifactId: 'art_v1',
      name: 'report.md',
      version: 1,
      sha256: v1.sha,
      bytes: v1.bytes.byteLength,
    });

    const v2Rel = `${created.task.id}/artifacts/v2/report.md`;
    mkdirSync(join(harness.config.workDir, created.task.id, 'artifacts', 'v2'), { recursive: true });
    const v2 = write(v2Rel, '# 第二版，还没人看\n');
    harness.store.insertArtifact({
      id: 'art_v2',
      taskId: created.task.id,
      workerId: created.owner.id,
      name: 'report.md',
      path: v2Rel,
      version: 2,
      bytes: v2.bytes.byteLength,
      sha256: v2.sha,
      createdAt: new Date().toISOString(),
    });

    await service.drainOutbound();

    const fileSend = adapter.sent.find((item) => item.segment.kind === 'file')!;
    assert.ok(fileSend, '文件段应该发出去');
    assert.equal(fileSend.segment.version, 1, '发出去的必须是排队时的 v1');
    assert.equal(
      readFileSync(fileSend.segment.path!, 'utf8'),
      '# 第一版\n',
      '发出去的内容必须是 v1，不能被后来的 v2 顶替',
    );
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('出站文件：工作目录里指向外部的符号链接不能骗过路径检查', async () => {
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
    // 目录外的真实文件 + 任务目录内指向它的软链
    const outside = join(harness.dir, 'outside-secret.txt');
    writeFileSync(outside, '不该发出去的内容\n', 'utf8');
    const outsideBytes = readFileSync(outside);
    const linkRel = `${created.task.id}/link.md`;
    mkdirSync(join(harness.config.workDir, created.task.id), { recursive: true });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(harness.config.workDir, linkRel));

    harness.store.insertArtifact({
      id: 'art_link',
      taskId: created.task.id,
      workerId: created.owner.id,
      name: 'link.md',
      path: linkRel,
      version: 1,
      bytes: outsideBytes.byteLength,
      sha256: sha256Of(outsideBytes),
      createdAt: new Date().toISOString(),
    });

    service.enqueueOutbound(TG_KEY, '发一下', created.task.id, {
      artifactId: 'art_link',
      name: 'link.md',
      version: 1,
      sha256: sha256Of(outsideBytes),
      bytes: outsideBytes.byteLength,
    });
    await service.drainOutbound();

    const row = harness.store.listOutboundBySession(TG_KEY).at(-1)!;
    const segments = (Array.isArray(row.segments) ? row.segments : []) as OutboundSegment[];
    const fileSegment = segments.find((segment) => segment.kind === 'file')!;
    assert.equal(fileSegment.status, 'failed', '软链指向工作目录之外必须拒绝');
    assert.match(fileSegment.error ?? '', /不在工作目录内/);
    assert.equal(adapter.sent.filter((item) => item.segment.kind === 'file').length, 0);
  } finally {
    await service.stop();
    await harness.cleanup();
  }
});

test('材料认领：建任务事务失败时，附件不能被不存在的任务占用', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    // 建任务时创建负责人会撞上 Worker 上限，事务整体回滚。
    limits: { maxWorkersPerGroup: 0 },
  });
  try {
    const payload = Buffer.from('这份材料必须还能重试\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:31',
      name: '重试.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: payload,
    });
    harness.store.recordInboundBatch({
      channel: 'telegram',
      accountId: 'bot_1',
      ownerIds: ['owner-1'],
      events: [
        {
          id: 'in_31',
          eventId: 'update:31',
          peerId: 'owner-1',
          senderId: 'owner-1',
          platformMessageId: '31',
          sessionKey: TG_KEY,
          threadId: null,
          body: '材料给你',
          attachments: [stored],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '32',
    });
    harness.store.markInbound('in_31', 'handed');

    assert.throws(() =>
      harness.runtime.createTask({
        title: 't',
        goal: 'g',
        ownerRole: 'r',
        ownerBrief: 'b',
        source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
      }),
    );

    assert.equal(harness.store.listTasks().length, 0, '事务回滚后不能留下任务');
    assert.equal(
      harness.store.listUnclaimedSessionAttachments(TG_KEY).length,
      1,
      '材料必须仍然可用，用户重试建任务时还能带上',
    );
  } finally {
    await harness.cleanup();
  }
});

test('材料补充：任务建好后用户再发文件，能补进已有任务且只能补一次', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  try {
    const { task } = harness.runtime.createTask({
      title: '已有任务',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    const payload = Buffer.from('后来补的材料\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:41',
      name: '补充.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: payload,
    });
    harness.store.recordInboundBatch({
      channel: 'telegram',
      accountId: 'bot_1',
      ownerIds: ['owner-1'],
      events: [
        {
          id: 'in_41',
          eventId: 'update:41',
          peerId: 'owner-1',
          senderId: 'owner-1',
          platformMessageId: '41',
          sessionKey: TG_KEY,
          threadId: null,
          body: '再补一份',
          attachments: [stored],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '42',
    });
    // 消息已被 Router 交接之后，材料才处于"可补充"状态
    harness.store.markInbound('in_41', 'handed');

    const attached = harness.runtime.attachSessionMaterials(task.id, TG_KEY);
    assert.equal(attached.ok, true);
    const files = attached.ok ? attached.files : [];
    assert.equal(files.length, 1, '应有一份材料被补进去');
    const target = join(harness.config.workDir, files[0]!.path);
    assert.ok(existsSync(target), `材料应落在任务目录里（${target}）`);
    assert.equal(readFileSync(target, 'utf8'), payload.toString('utf8'), '内容必须一致');
    assert.match(harness.store.getTask(task.id)!.brief, /补充\.csv/, '任务说明里要记下这份材料');

    // 再补一次：没有新材料了，必须明确说没有，而不是假装成功
    const again = harness.runtime.attachSessionMaterials(task.id, TG_KEY);
    assert.equal(again.ok, false);
    assert.match(again.ok ? '' : again.message, /没有待补充的材料/);
  } finally {
    await harness.cleanup();
  }
});

test('附件按话题认领：甲话题的文件不会被乙话题新建的任务拿走', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  const conversations = new ConversationService(harness.store);
  try {
    const alpha = conversations.create(TG_KEY, '甲');
    const payload = Buffer.from('A-file\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:61',
      name: 'A-file.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: payload,
    });
    harness.store.recordInboundBatch({
      channel: 'telegram',
      accountId: 'bot_1',
      ownerIds: ['owner-1'],
      events: [
        {
          id: 'in_61',
          eventId: 'update:61',
          peerId: 'owner-1',
          senderId: 'owner-1',
          platformMessageId: '61',
          sessionKey: TG_KEY,
          threadId: null,
          body: '甲的材料',
          attachments: [stored],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '62',
    });
    // 交接时固定话题归属（真实链路由渠道层写入）
    harness.store.setInboundConversation('in_61', alpha.id);
    harness.store.markInbound('in_61', 'handed');

    const beta = conversations.create(TG_KEY, '乙');
    const { task } = harness.runtime.createTask({
      title: '乙任务',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: {
        channel: 'telegram',
        accountId: 'bot_1',
        peerId: 'owner-1',
        sessionKey: TG_KEY,
        conversationId: beta.id,
      },
    });

    assert.ok(!task.brief.includes('A-file.csv'), `乙任务不该拿到甲的材料（实际：${task.brief}）`);
    assert.equal(
      harness.store.listUnclaimedSessionAttachments(TG_KEY, alpha.id).length,
      1,
      '甲的材料仍留给自己话题使用',
    );
  } finally {
    await harness.cleanup();
  }
});

test('补材料失败：只删本次复制的新文件，原有产物与任务目录必须还在', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  try {
    const { task } = harness.runtime.createTask({
      title: '已有任务',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    const existing = join(harness.config.workDir, task.id, 'existing-deliverable.md');
    mkdirSync(join(harness.config.workDir, task.id), { recursive: true });
    writeFileSync(existing, '原有成果\n', 'utf8');

    // 附件记录在，但缓存文件已经没了
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:71',
      name: 'gone.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: Buffer.from('x\n', 'utf8'),
    });
    rmSync(join(harness.config.workDir, stored.path), { force: true });
    harness.store.recordInboundBatch({
      channel: 'telegram',
      accountId: 'bot_1',
      ownerIds: ['owner-1'],
      events: [
        {
          id: 'in_71',
          eventId: 'update:71',
          peerId: 'owner-1',
          senderId: 'owner-1',
          platformMessageId: '71',
          sessionKey: TG_KEY,
          threadId: null,
          body: '补个材料',
          attachments: [stored],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '72',
    });
    harness.store.markInbound('in_71', 'handed');

    const attached = harness.runtime.attachSessionMaterials(task.id, TG_KEY);
    assert.equal(attached.ok, false, '源文件没了必须如实失败');
    assert.equal(existsSync(existing), true, '原有产物不能被删');
    assert.equal(existsSync(join(harness.config.workDir, task.id)), true, '任务目录不能被删');
    assert.ok(harness.store.getTask(task.id), '任务记录当然还在');
  } finally {
    await harness.cleanup();
  }
});

test('补材料：负责人被通知、要求版本推进；终态任务拒绝补材料', async () => {
  const harness = await createHarness({
    worker: () => mockReply({ text: '收到' }),
    router: () => mockReply({ text: '好的' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '要补材料的任务',
      goal: 'g',
      ownerRole: 'r',
      ownerBrief: 'b',
      source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
    });
    const payload = Buffer.from('新材料\n', 'utf8');
    const stored = writeInboundAttachment({
      workDir: harness.config.workDir,
      channel: 'telegram',
      accountId: 'bot_1',
      eventId: 'update:81',
      name: 'new.csv',
      kind: 'file',
      mime: 'text/csv',
      bytes: payload,
    });
    harness.store.recordInboundBatch({
      channel: 'telegram',
      accountId: 'bot_1',
      ownerIds: ['owner-1'],
      events: [
        {
          id: 'in_81',
          eventId: 'update:81',
          peerId: 'owner-1',
          senderId: 'owner-1',
          platformMessageId: '81',
          sessionKey: TG_KEY,
          threadId: null,
          body: '再补一份',
          attachments: [stored],
          unsupported: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: '82',
    });
    harness.store.markInbound('in_81', 'handed');

    const epochBefore = harness.store.getTask(task.id)!.reviewEpoch;
    // 不带任何 note：通知与要求版本推进都不该省
    const attached = harness.runtime.attachSessionMaterials(task.id, TG_KEY);
    assert.equal(attached.ok, true);

    const after = harness.store.getTask(task.id)!;
    assert.ok(after.reviewEpoch > epochBefore, `要求版本必须推进（${epochBefore} → ${after.reviewEpoch}）`);
    const updates = harness.store
      .listGroupMessages(task.groupId, 200)
      .filter((message) => message.kind === 'update' && message.toId === owner.id);
    assert.equal(updates.length, 1, `负责人必须收到一条补充要求（实际 ${updates.length}）`);
    assert.match(updates[0]!.body, /补充了新材料/);

    // 终态任务：明确拒绝，不静默改已交付的东西
    harness.store.setTaskStatus(task.id, 'completed', { reason: '完成' });
    const rejected = harness.runtime.attachSessionMaterials(task.id, TG_KEY);
    assert.equal(rejected.ok, false);
    assert.match(rejected.ok ? '' : rejected.message, /不能再补材料/);
  } finally {
    await harness.cleanup();
  }
});

test('凭据文件：fs_* 一律拒绝读取 .env*', async () => {
  const harness = await createHarness({ worker: () => mockReply({ text: 'ok' }) });
  try {
    const { owner } = harness.runtime.createTask({ title: 't', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const context = {
      host: harness.runtime as never,
      worker: owner,
      task: harness.runtime.store.getTaskByGroup(owner.groupId)!,
      workDir: harness.config.workDir,
      materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
      signal: null,
    };
    const run = async (path: string): Promise<string> => {
      try {
        const tool = fileTools.find((item) => item.name === 'fs_read')!;
        const outcome = await tool.run({ path }, context);
        return outcome.type === 'ok' ? outcome.content : String((outcome as { content?: string }).content ?? '');
      } catch (error) {
        return `THROW: ${(error as Error).message}`;
      }
    };
    for (const path of ['.env.local', '.env', '.env.production']) {
      const text = await run(path);
      assert.match(text, /拒绝读取|凭据文件/, `${path} 必须被拒绝，实际：${text.slice(0, 60)}`);
    }
    // 普通文件不受影响
    const normal = await run('README.md');
    assert.doesNotMatch(normal, /拒绝读取/, '正常文件不能被误伤');
  } finally {
    await harness.cleanup();
  }
});
