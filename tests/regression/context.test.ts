import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { allText, createHarness, isNoteRequest, roleOf, scripted, systemText } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { collectFileOps } from '../../src/runtime/note.ts';
import { buildNotePrompt, decideNote, renderTurnsForNote, runNote } from '../../src/runtime/note.ts';
import { planHistory, groupTurns, renderTaskFacts } from '../../src/runtime/context.ts';
import type { ChatRequest } from '../../src/model/types.ts';
import { newMessageId, nowIso } from '../../src/domain/ids.ts';
import type { ActorKind, WorkerTurn } from '../../src/domain/types.ts';

/** 往某个 Worker 的历史里灌入可控 turn，模拟一个很长的任务。 */
function seedTurns(
  store: import('../../src/storage/store.ts').Store,
  workerId: string,
  count: number,
  options: { chars?: number; prefix?: string; startSeq?: number } = {},
): number {
  const chars = options.chars ?? 400;
  const start = options.startSeq ?? 1;
  const existing = store.countWorkerTurns(workerId);
  for (let index = 0; index < count; index += 1) {
    const seq = existing + index + 1;
    store.appendWorkerTurn({
      id: `seed_${workerId}_${seq}`,
      workerId,
      seq,
      role: index % 4 === 3 ? 'assistant' : 'user',
      content: `${options.prefix ?? '历史'}第${start + index}条：${'数据'.repeat(Math.floor(chars / 2))}`,
      toolCalls: null,
      toolCallId: null,
      createdAt: nowIso(),
    });
  }
  return existing + count;
}

async function staticHarness(limits: Record<string, number> = {}) {
  return createHarness({
    limits: { maxConcurrentRuns: 0, ...limits },
    worker: () => mockReply({ text: '不应被调用' }),
  });
}

test('窗口：按字符预算取历史，且不拆开工具调用与结果', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '窗口', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    // 造 10 组「assistant 调用 + 两个结果」，每组约 300 字符。
    for (let index = 0; index < 10; index += 1) {
      const base = index * 3 + 1;
      harness.store.appendWorkerTurn({
        id: `g${index}_a`, workerId: owner.id, seq: base, role: 'assistant', content: null,
        toolCalls: [{ id: `call_${index}`, name: 'fs_read', arguments: '{"path":"materials/a.md"}' }],
        toolCallId: null, createdAt: nowIso(),
      });
      harness.store.appendWorkerTurn({
        id: `g${index}_t1`, workerId: owner.id, seq: base + 1, role: 'tool', content: 'x'.repeat(150),
        toolCalls: null, toolCallId: `call_${index}`, createdAt: nowIso(),
      });
      harness.store.appendWorkerTurn({
        id: `g${index}_t2`, workerId: owner.id, seq: base + 2, role: 'tool', content: 'y'.repeat(150),
        toolCalls: null, toolCallId: 'other', createdAt: nowIso(),
      });
    }

    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 500, overshootChars: 2000 });
    assert.ok(plan.turns.length > 0);
    assert.ok(plan.droppedTurns > 0, '应挤出部分历史');
    // 窗口第一组必须是完整的（第一个 turn 不能是 tool）
    assert.notEqual(plan.turns[0]!.role, 'tool', '窗口起点不能是孤立的结果');
    const groups = groupTurns(plan.turns);
    for (const group of groups) {
      if (group[0]!.role === 'assistant' && group[0]!.toolCalls) {
        assert.ok(group.length >= 2, '带调用的 assistant 必须带上结果');
      }
    }
  } finally {
    await harness.cleanup();
  }
});

test('触发：短任务即使 turn 多，只要装得进窗口就不整理', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({ title: '短', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 40, { chars: 40 });
    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 16_000, overshootChars: 2000 });
    const decision = decideNote({
      store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits,
    });
    assert.equal(decision.action, 'none');
    assert.match(decision.reason, /全部历史都在窗口内/);
  } finally {
    await harness.cleanup();
  }
});

test('触发：条数够但字符不够不整理；两者都够才整理', async () => {
  const harness = await staticHarness({ contextWindowChars: 400, noteTriggerChars: 3000, noteTriggerTurns: 5 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '阈值', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 30, { chars: 60 });
    let plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 400, overshootChars: 0 });
    let decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    assert.equal(decision.action, 'none', '字符不够时不应触发');
    assert.match(decision.reason, /字符/);

    seedTurns(harness.store, owner.id, 30, { chars: 400, prefix: '长' });
    plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 400, overshootChars: 0 });
    decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    assert.equal(decision.action, 'compact');
    assert.ok(decision.fromSeq > 0 && decision.toSeq >= decision.fromSeq);
  } finally {
    await harness.cleanup();
  }
});

test('累计记录：第二次整理带上第一份记录，仍然保留早期事实与失败原因', async () => {
  const prompts: string[] = [];
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0, contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '累计', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    let plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    let decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });

    const first = await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat(request: ChatRequest) {
          prompts.push(request.messages.at(-1)!.content ?? '');
          return mockReply({
            text: '## 已确认事实\n- 营收合计 5180 万（turn#3）\n## 已尝试但失败\n- 直接读 report.md 失败：文件不存在（turn#5）',
          });
        },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });
    assert.equal(first.ok, true);
    assert.equal(harness.store.latestSuccessfulNote(owner.id)!.coveredSeq, decision.toSeq);

    // 再来一段历史，触发第二次整理。
    seedTurns(harness.store, owner.id, 12, { chars: 200, prefix: '后续' });
    plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    assert.equal(decision.action, 'compact');
    assert.ok(decision.fromSeq > first.note!.coveredSeq, '第二次从上次覆盖点之后开始');
    assert.ok(decision.previous, '第二次整理应带上上一份记录');

    const second = await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat(request: ChatRequest) {
          prompts.push(request.messages.at(-1)!.content ?? '');
          return mockReply({
            text: '## 已确认事实\n- 营收合计 5180 万（turn#3）\n- 新增：满意度下降（turn#14）\n## 已尝试但失败\n- 直接读 report.md 失败：文件不存在（turn#5）',
          });
        },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });
    assert.equal(second.ok, true);
    assert.match(prompts[1]!, /已确认事实/, '第二次整理的输入包含上一份记录');
    assert.match(prompts[1]!, /turn#3/, '上一份记录里的来源仍然在输入里');
    const latest = harness.store.latestSuccessfulNote(owner.id)!;
    assert.match(latest.content, /5180/, '早期事实保留');
    assert.match(latest.content, /文件不存在/, '早期失败原因保留');
    assert.equal(latest.coveredSeq, decision.toSeq);
  } finally {
    await harness.cleanup();
  }
});

test('累计记录：第二次整理失败时，上一份仍生效且覆盖位置不前移', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '失败', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    let plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    let decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    const okResult = await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat() { return mockReply({ text: '## 已确认事实\n- 关键事实 A（turn#2）' }); },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });
    const coveredAfterFirst = okResult.note!.coveredSeq;

    seedTurns(harness.store, owner.id, 12, { chars: 200, prefix: '后续' });
    plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    const failed = await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat() { throw new Error('提供方不可用'); },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });
    assert.equal(failed.ok, false);
    const latest = harness.store.latestSuccessfulNote(owner.id)!;
    assert.equal(latest.coveredSeq, coveredAfterFirst, '覆盖位置不前移');
    assert.match(latest.content, /关键事实 A/, '上一份记录仍然有效');
    assert.equal(harness.store.latestNote(owner.id)!.failed, true);
    assert.equal(harness.store.listWorkerNotes(owner.id).filter((note) => !note.failed).length, 1);

    // 失败后立刻再判断：应因重试间隔跳过。
    const retry = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    assert.equal(retry.action, 'none');
    assert.match(retry.reason, /重试间隔/);
  } finally {
    await harness.cleanup();
  }
});

test('累计记录：整理期间要求版本变化时结果作废，不安装成有效记录', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '版本', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    const decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });

    const result = await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat() {
          // 模拟整理过程中用户补充了要求
          harness.store.bumpReviewEpoch(task.id);
          return mockReply({ text: '## 已确认事实\n- 旧要求下的计划' });
        },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /要求版本变化/);
    assert.equal(harness.store.latestSuccessfulNote(owner.id), null, '作废结果不能成为有效记录');
    assert.equal(harness.store.latestNote(owner.id)!.failed, true);
  } finally {
    await harness.cleanup();
  }
});

test('预算：产物变多、记录变大时，system prompt 有上限而不是无限增长', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({ title: '预算', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    for (let index = 0; index < 20; index += 1) {
      harness.runtime.saveArtifact(owner, `file-${String(index).padStart(2, '0')}.md`, `内容 ${index}`);
    }
    seedTurns(harness.store, owner.id, 10, { chars: 200 });
    const { renderArtifactTable, collectArtifactLines } = await import('../../src/runtime/context.ts');
    const lines = collectArtifactLines(task, harness.store.listArtifacts(task.id), []);
    const table = renderArtifactTable({ task, lines });
    assert.match(table, /另有 8 份产物未显示/, '超出上限的产物不进入常驻上下文');
    assert.ok(table.split('\n').length <= 15);
    assert.match(table, /检查门槛：可选/);
  } finally {
    await harness.cleanup();
  }
});

test('隔离：不同 Worker 的历史、记录与消息互相看不到', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({ title: '隔离', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const other = harness.runtime.createCollaborator(owner, '协作者', '协助');
    seedTurns(harness.store, owner.id, 6, { chars: 100, prefix: 'A' });
    seedTurns(harness.store, other.workerId!, 3, { chars: 100, prefix: 'B' });

    assert.equal(harness.store.listWorkerTurnsRange(other.workerId!, 1, 100).length, 3);
    assert.equal(harness.store.listWorkerTurnsRange(owner.id, 1, 100).length, 6);

    const message = harness.runtime.sendMessage({
      from: owner, to: other.workerId!, kind: 'request', intent: 'help', body: '请核对',
    });
    assert.ok(harness.runtime.getMessageForWorker(owner.id, message.messageId!));
    assert.ok(harness.runtime.getMessageForWorker(other.workerId!, message.messageId!));
    const third = harness.runtime.createCollaborator(owner, '第三人', '协助');
    assert.equal(harness.runtime.getMessageForWorker(third.workerId!, message.messageId!), null, '第三方不能读别人的消息');
    assert.equal(harness.store.listWorkerTurnsRange(third.workerId!, 1, 100).length, 0);
    assert.equal(harness.store.listWorkerNotes(owner.id).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('检索：摘要之外的关键依据能通过原文读取取回', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '检索', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    const longBody = `${'铺垫内容。'.repeat(200)}关键结论：华南下滑来自两个大客户续约延后。${'尾部内容。'.repeat(200)}`;
    harness.store.appendWorkerTurn({
      id: 'search_1', workerId: owner.id, seq: 1, role: 'tool', content: longBody,
      toolCalls: null, toolCallId: 'c1', createdAt: nowIso(),
    });
    const hits = harness.runtime.searchWorkerTurns(owner.id, { fromSeq: 1, toSeq: 1, role: null, limit: 5 });
    assert.equal(hits.length, 1);
    assert.ok(!longBody.includes(hits[0]!.content!.slice(0, 20)) === false);

    const { historyTools } = await import('../../src/tools/history.ts');
    const readTool = historyTools.find((tool) => tool.name === 'history_read')!;
    const context = {
      host: harness.runtime, worker: owner, task: harness.store.getTaskByGroup(owner.groupId)!,
      workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
    };
    const firstRead = await readTool.run({ from_seq: 1, limit: 500 }, context);
    assert.equal(firstRead.type, 'ok');
    assert.ok(!firstRead.content.includes('关键结论'), '第一次读取不应包含中段内容');
    const offset = Number(/offset=(\d+)/.exec(firstRead.content)![1]);
    const secondRead = await readTool.run({ from_seq: 1, offset, limit: 3000 }, context);
    assert.match(secondRead.content, /关键结论/, '续读能取回摘要之外的原文');
  } finally {
    await harness.cleanup();
  }
});

test('检索：按消息 id 读全文，支持分页', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '消息', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const helper = harness.runtime.createCollaborator(owner, '协作者', '协助');
    const body = `${'检查意见开头。'.repeat(100)}核心问题：来源未标注。${'结尾内容。'.repeat(100)}`;
    const message = harness.runtime.sendMessage({
      from: owner, to: helper.workerId!, kind: 'request', intent: 'help', body,
    });
    const { historyTools } = await import('../../src/tools/history.ts');
    const readTool = historyTools.find((tool) => tool.name === 'message_read')!;
    const context = {
      host: harness.runtime, worker: owner, task: harness.store.getTaskByGroup(owner.groupId)!,
      workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
    };
    const first = await readTool.run({ message_id: message.messageId!, limit: 400 }, context);
    assert.equal(first.type, 'ok');
    const offset = Number(/offset=(\d+)/.exec(first.content)![1]);
    const second = await readTool.run({ message_id: message.messageId!, offset, limit: 4000 }, context);
    assert.match(second.content, /核心问题/);
  } finally {
    await harness.cleanup();
  }
});

test('产物：相同内容复用版本并保留审查状态，改内容才新建', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '复用', goal: 'g', requireReview: true, ownerRole: '负责人', ownerBrief: 'b',
    });
    const first = harness.runtime.saveArtifact(owner, 'report.md', '内容一致\n');
    assert.equal(first.reused, false);
    assert.equal(first.artifact.version, 1);

    const again = harness.runtime.saveArtifact(owner, 'report.md', '内容一致\n');
    assert.equal(again.reused, true, '相同内容应复用');
    assert.equal(again.artifact.version, 1);
    assert.equal(harness.store.listArtifacts(task.id).length, 1, '不产生新版本');

    const checker = harness.runtime.createCollaborator(owner, '检查者', '检查');
    const reviewRequest = harness.runtime.sendMessage({
      from: owner,
      to: checker.workerId!,
      kind: 'request',
      intent: 'review',
      body: '检查 report',
      refs: { artifacts: [{ artifactId: first.artifact.id, name: 'report.md', version: 1 }] },
    });
    assert.equal(reviewRequest.ok, true, reviewRequest.reason);
    assert.equal(harness.runtime.sendMessage({
      from: harness.store.getWorker(checker.workerId!)!,
      to: owner.id,
      kind: 'reply',
      replyTo: reviewRequest.messageId!,
      outcome: 'approved',
      body: '通过',
    }).ok, true);

    const approvedReuse = await import('../../src/tools/artifacts.ts');
    const saveTool = approvedReuse.artifactTools.find((tool) => tool.name === 'artifact_save')!;
    const result = await saveTool.run({ name: 'report.md', content: '内容一致\n' }, {
      host: harness.runtime, worker: owner, task,
      workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot, signal: null,
    });
    assert.match(result.content, /没有创建新版本，也未改变该版本的审查状态/);
    assert.match(result.content, /有效 approved/);
    const { renderArtifactTable, collectArtifactLines } = await import('../../src/runtime/context.ts');
    const table = renderArtifactTable({ task, lines: collectArtifactLines(task, harness.store.listArtifacts(task.id), harness.store.listReviews(task.id)) });
    assert.match(table, /approved（要求版本 0）/);

    const { artifactTools } = await import('../../src/tools/artifacts.ts');
    const importTool = artifactTools.find((tool) => tool.name === 'artifact_import')!;
    const sourcePath = join(harness.config.workDir, task.id, 'report-source.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(sourcePath, '内容一致\n', 'utf8');
    const importedReuse = await importTool.run({ source: 'report-source.md', name: 'report.md' }, {
      host: harness.runtime, worker: owner, task,
      workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot, signal: null,
    });
    assert.match(importedReuse.content, /没有创建新版本，也未改变该版本的审查状态/);
    assert.match(importedReuse.content, /有效 approved/);

    // 新版本仍须对自己的指纹取得检查；旧版本的批准不放行。
    const changed = harness.runtime.saveArtifact(owner, 'report.md', '内容改了\n');
    assert.equal(changed.reused, false);
    assert.equal(changed.artifact.version, 2);
    assert.equal(harness.store.listArtifacts(task.id).length, 2, '旧版本保留');

    const submit = await harness.runtime.submitResult(owner, '交付', ['report.md']);
    assert.equal(submit.ok, false, '未检查的产物不能被复用绕过');
    assert.equal(harness.store.listReviews(task.id).length, 1, 'v1 的批准记录仍保留');
  } finally {
    await harness.cleanup();
  }
});

test('产物：登记快照被改写或丢失时，不能谎称同内容复用成功', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '快照', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', '原文').artifact;
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(harness.config.workDir, artifact.path);
    writeFileSync(path, '被改写');
    assert.throws(() => harness.runtime.saveArtifact(owner, 'report.md', '原文'), /不一致.*不能复用/);
    unlinkSync(path);
    assert.throws(() => harness.runtime.saveArtifact(owner, 'report.md', '原文'), /缺失.*不能复用/);
  } finally { await harness.cleanup(); }
});

test('产物：二进制导入校验原始字节，读取时说明文本限制', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({ title: '二进制', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(harness.config.workDir, task.id), { recursive: true });
    writeFileSync(join(harness.config.workDir, task.id, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    harness.runtime.importArtifact(owner, 'image.png', 'image.png');
    await assert.rejects(harness.runtime.readArtifactVersion(task.id, 'image.png'), /不是 UTF-8 文本/);
  } finally { await harness.cleanup(); }
});

test('三态：未执行与执行结果未知在历史与工作记录输入中都不混淆', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '三态', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    const call = { id: 'call_x', name: 'fs_write', arguments: '{"path":"a.md","content":"x"}' };
    harness.store.appendWorkerTurn({
      id: 'tri_1', workerId: owner.id, seq: 1, role: 'assistant', content: null,
      toolCalls: [call], toolCallId: null, createdAt: nowIso(),
    });
    harness.store.appendWorkerTurn({
      id: 'tri_2', workerId: owner.id, seq: 2, role: 'tool', content: '[未执行] fs_write：本次等待打断了后续调用',
      toolCalls: null, toolCallId: 'call_y', createdAt: nowIso(),
    });

    const rendered = renderTurnsForNote(harness.store.listWorkerTurnsRange(owner.id, 1, 5));
    const lines = rendered.split('\n');
    const unexecuted = lines.filter((line) => line.includes('[未执行]'));
    const unknown = lines.filter((line) => line.includes('执行结果未知'));
    assert.equal(unexecuted.length, 1, '确定的未执行保留原样');
    assert.equal(unknown.length, 1, '缺结果标注为未知');
    assert.notEqual(unexecuted[0], unknown[0], '两种状态不能合并成一句');

    // 重启后仍然是未知，不会被改写成未执行。
    const before = harness.store.listWorkerTurnsRange(owner.id, 1, 5);
    harness.store.close();
    const { Store } = await import('../../src/storage/store.ts');
    const reopened = new Store(harness.config.dbPath);
    const after = reopened.listWorkerTurnsRange(owner.id, 1, 5);
    assert.deepEqual(after.map((turn) => turn.content), before.map((turn) => turn.content));
    reopened.close();
  } finally {
    await harness.cleanup();
  }
});

test('提示词：长任务触发整理后，输入里包含工作记录、产物表和提交门槛', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0, contextWindowChars: 700, noteTriggerTurns: 4, noteTriggerChars: 200 },
    worker: scripted(
      { 执行者: () => mockReply({ text: '不应被调用' }) },
      { note: () => mockReply({ text: '## 已确认事实\n- 早期结论：营收 5180 万（turn#2）' }) },
    ),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '长任务', goal: '整理验证', ownerRole: '执行者', ownerBrief: 'b',
    });
    harness.runtime.saveArtifact(owner, 'report.md', 'v1');
    seedTurns(harness.store, owner.id, 14, { chars: 300 });

    // 直接组装上下文：这一步会先判断是否需要整理，再注入最新记录。
    const build = (
      harness.runtime as unknown as {
        buildWorkerMessages: (worker: unknown, target: unknown) => Promise<{ role: string; content: string | null }[]>;
      }
    ).buildWorkerMessages.bind(harness.runtime);
    const messages = await build(owner, task);
    // 任务状态、产物表、工作记录都在最后那条 user 消息里（system 只留稳定规则，
    // 否则提示缓存的前缀每轮都会变）。断言"在输入里"而不是"在 system 里"。
    const whole = messages.map((message) => message.content ?? '').join('\n');
    const system = messages[0]!.content ?? '';

    assert.match(whole, /Task state \(program record/, '任务状态来自程序');
    assert.match(whole, /Current artifacts/, '产物表常驻');
    assert.match(whole, /Working record/, '整理结果进入输入');
    assert.match(whole, /5180/, '工作记录内容真的进了输入');
    assert.match(whole, /提交门槛/, '提交门槛来自任务事实，跟着状态走');
    assert.doesNotMatch(system, /Task state \(program record/, '易变的状态不能留在 system，否则缓存失效');
    assert.doesNotMatch(system, /Current artifacts/, '产物表每轮都变，同样不能留在 system');
    const note = harness.store.latestSuccessfulNote(owner.id);
    assert.ok(note, '整理记录已落库');
    assert.equal(note!.taskId, task.id);
  } finally {
    await harness.cleanup();
  }
});

test('检查入口：没有有效产物 id 的正式检查当场拒绝，不产生检查记录', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '入口校验', goal: 'g', requireReview: true, ownerRole: '负责人', ownerBrief: 'b',
    });
    const checker = harness.runtime.createCollaborator(owner, '检查者', '检查');
    const artifact = harness.runtime.saveArtifact(owner, 'report.md', 'v1').artifact;

    // 只写文件路径：真实运行里出现过，之前会返回“已投递”但没有任何检查记录
    const byPath = harness.runtime.sendMessage({
      from: owner, to: checker.workerId!, kind: 'request', intent: 'review',
      body: '请检查 report.md', refs: { files: ['report.md'] },
    });
    assert.equal(byPath.ok, false);
    assert.match(byPath.reason ?? '', /refs\.artifacts/);
    assert.equal(harness.store.listReviews(task.id).length, 0, '不应产生检查记录');

    // 不存在的产物 id
    const missing = harness.runtime.sendMessage({
      from: owner, to: checker.workerId!, kind: 'request', intent: 'review',
      body: '请检查', refs: { artifacts: [{ artifactId: 'art_not_exist', name: 'x', version: 1 }] },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? '', /检查对象不存在/);

    // 别的任务的产物
    const otherTask = harness.runtime.createTask({ title: '别的任务', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const otherArtifact = harness.runtime.saveArtifact(otherTask.owner, 'other.md', 'x').artifact;
    const foreign = harness.runtime.sendMessage({
      from: owner, to: checker.workerId!, kind: 'request', intent: 'review',
      body: '请检查', refs: { artifacts: [{ artifactId: otherArtifact.id, name: 'other.md', version: 1 }] },
    });
    assert.equal(foreign.ok, false);
    assert.match(foreign.reason ?? '', /不属于本任务/);

    // 没有消息被投递出去
    assert.equal(harness.store.listInbox(checker.workerId!).length, 0, '被拒绝的请求不应进入收件箱');

    // 正确写法仍然可用
    const ok = harness.runtime.sendMessage({
      from: owner, to: checker.workerId!, kind: 'request', intent: 'review',
      body: '请检查', refs: { artifacts: [{ artifactId: artifact.id, name: artifact.name, version: artifact.version }] },
    });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(harness.store.listReviewsByRequest(ok.messageId!).length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('请求结构：窗口把 user 全部挤出后，输入仍然包含 user 轮次', async () => {
  const harness = await createHarness({
    limits: { maxConcurrentRuns: 0, contextWindowChars: 400, pairingOvershootChars: 0 },
    worker: () => mockReply({ text: '不应被调用' }),
  });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '无 user 历史', goal: 'g', ownerRole: '执行者', ownerBrief: 'b',
    });
    // 只造 assistant + tool 的历史，确保窗口内一条 user 都没有。
    for (let index = 0; index < 8; index += 1) {
      const base = index * 3 + 1;
      harness.store.appendWorkerTurn({
        id: `nu${index}_a`, workerId: owner.id, seq: base, role: 'assistant', content: null,
        toolCalls: [{ id: `c${index}`, name: 'fs_list', arguments: '{"path":"."}' }],
        toolCallId: null, createdAt: nowIso(),
      });
      harness.store.appendWorkerTurn({
        id: `nu${index}_t`, workerId: owner.id, seq: base + 1, role: 'tool', content: 'x'.repeat(120),
        toolCalls: null, toolCallId: `c${index}`, createdAt: nowIso(),
      });
      harness.store.appendWorkerTurn({
        id: `nu${index}_b`, workerId: owner.id, seq: base + 2, role: 'assistant', content: '继续',
        toolCalls: null, toolCallId: null, createdAt: nowIso(),
      });
    }

    const build = (
      harness.runtime as unknown as {
        buildWorkerMessages: (worker: unknown, target: unknown) => Promise<{ role: string; content: string | null }[]>;
      }
    ).buildWorkerMessages.bind(harness.runtime);
    const messages = await build(owner, task);

    const users = messages.filter((message) => message.role === 'user');
    assert.ok(users.length >= 1, '请求里必须至少有一条 user 消息');
    assert.match(users[0]!.content ?? '', /稳定执行上下文/, 'user 轮次由程序稳定提供');
    // 历史里没有被拆开的工具调用
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role !== 'assistant') continue;
      const calls = (message as { toolCalls?: { id: string }[] }).toolCalls ?? [];
      for (const call of calls) {
        assert.ok(
          messages.slice(index + 1).some((item) => item.role === 'tool' && (item as { toolCallId?: string }).toolCallId === call.id),
          `调用 ${call.id} 缺少结果`,
        );
      }
    }
  } finally {
    await harness.cleanup();
  }
});

test('提示词：整理期间到达的新消息不会被算进已覆盖范围', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '并发', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    const decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    const toSeq = decision.toSeq;

    await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat() {
          // 整理进行中又来了一条新历史
          harness.store.appendWorkerTurn({
            id: 'late_1', workerId: owner.id, seq: toSeq + 1, role: 'user', content: '整理期间到达的新消息',
            toolCalls: null, toolCallId: null, createdAt: nowIso(),
          });
          return mockReply({ text: '## 已确认事实\n- 旧事实（turn#2）' });
        },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });

    const note = harness.store.latestSuccessfulNote(owner.id)!;
    assert.equal(note.coveredSeq, toSeq, '覆盖到整理开始时的边界');
    const uncovered = harness.store.listWorkerTurnsRange(owner.id, note.coveredSeq + 1, 999);
    assert.ok(uncovered.length >= 1, '整理期间的新消息仍待处理，没有被误算进覆盖范围');
  } finally {
    await harness.cleanup();
  }
});

test('工具：note_read 能读回工作记录与失败记录', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '读取', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    const decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });
    await runNote({
      model: {
        kind: 'mock', label: 'note',
        async chat() { return mockReply({ text: '## 已确认事实\n- 关键事实 B（turn#3）' }); },
      } as never,
      modelName: 'mock', store: harness.store, worker: owner, task, decision, limits: harness.config.limits,
    });

    const { historyTools } = await import('../../src/tools/history.ts');
    const readTool = historyTools.find((tool) => tool.name === 'note_read')!;
    const context = {
      host: harness.runtime, worker: owner, task, workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
    };
    const outcome = await readTool.run({}, context);
    assert.equal(outcome.type, 'ok');
    assert.match(outcome.content, /关键事实 B/);
    assert.match(outcome.content, /累计覆盖到 turn#/);
  } finally {
    await harness.cleanup();
  }
});

test('搜索：history_search 只返回自己的历史，并给出可读的序号', async () => {
  const harness = await staticHarness();
  try {
    const { owner } = harness.runtime.createTask({ title: '搜索', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const other = harness.runtime.createCollaborator(owner, '协作者', '协助');
    seedTurns(harness.store, owner.id, 4, { chars: 100, prefix: '甲方材料' });
    seedTurns(harness.store, other.workerId!, 4, { chars: 100, prefix: '乙方材料' });

    const { historyTools } = await import('../../src/tools/history.ts');
    const searchTool = historyTools.find((tool) => tool.name === 'history_search')!;
    const context = {
      host: harness.runtime, worker: owner,
      task: harness.store.getTaskByGroup(owner.groupId)!,
      workDir: harness.config.workDir, materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
    };
    const outcome = await searchTool.run({ query: '乙方材料' }, context);
    assert.equal(outcome.type, 'ok');
    assert.match(outcome.content, /没有在自己历史里找到/, '不能搜到别的 Worker 的历史');

    const own = await searchTool.run({ query: '甲方材料' }, context);
    assert.match(own.content, /turn#/);
  } finally {
    await harness.cleanup();
  }
});

test('整理失败：连续失败达到上限后不再反复调用', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 4, noteTriggerChars: 200 });
  try {
    const { task, owner } = harness.runtime.createTask({ title: '上限', goal: 'g', ownerRole: '执行者', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 12, { chars: 200 });
    const plan = planHistory({ store: harness.store, workerId: owner.id, windowChars: 600, overshootChars: 0 });
    const decision = decideNote({ store: harness.store, worker: owner, task, history: plan, limits: harness.config.limits });

    const failing = {
      kind: 'mock' as const,
      label: 'note',
      async chat() { throw new Error('持续失败'); },
    };
    for (let index = 0; index < 3; index += 1) {
      await runNote({
        model: failing as never, modelName: 'mock', store: harness.store, worker: owner, task, decision,
        limits: harness.config.limits,
      });
    }
    assert.equal(harness.store.consecutiveNoteFailures(owner.id), 3);
    const blocked = decideNote({
      store: harness.store, worker: owner, task, history: plan,
      limits: harness.config.limits, now: Date.now() + 10 * 60_000,
    });
    assert.equal(blocked.action, 'none');
    assert.match(blocked.reason, /连续整理失败/);
    assert.equal(harness.store.latestSuccessfulNote(owner.id), null);
  } finally {
    await harness.cleanup();
  }
});

test('工作记录：从调用中提取涉及的路径', async () => {
  const harness = await staticHarness({ contextWindowChars: 600, noteTriggerTurns: 2, noteTriggerChars: 100 });
  try {
    const { owner, task } = harness.runtime.createTask({
      title: '文件清单', goal: 'g', ownerRole: '负责人', ownerBrief: 'b',
    });
    harness.store.appendWorkerTurn({
      id: `turn_${owner.id}_1`, workerId: owner.id, seq: 1, role: 'assistant',
      content: '读材料', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"materials/a.md"}' }],
      toolCallId: null, createdAt: new Date().toISOString(),
    });
    harness.store.appendWorkerTurn({
      id: `turn_${owner.id}_2`, workerId: owner.id, seq: 2, role: 'tool',
      content: '内容', toolCalls: null, toolCallId: 'c1', createdAt: new Date().toISOString(),
    });
    harness.store.appendWorkerTurn({
      id: `turn_${owner.id}_3`, workerId: owner.id, seq: 3, role: 'assistant',
      content: '写产物', toolCalls: [{ id: 'c2', name: 'artifact_save', arguments: '{"name":"out.md"}' }],
      toolCallId: null, createdAt: new Date().toISOString(),
    });

    const turns = harness.store.listWorkerTurns(owner.id, 10);
    const ops = collectFileOps(turns);
    assert.deepEqual(ops.read, ['materials/a.md'], '读取类操作路径从调用里提取，不代表成功');
    assert.deepEqual(ops.written, ['out.md'], '写入类操作路径同理');
    void task;
  } finally {
    await harness.cleanup();
  }
});


test('整理输入：截断可查回，结果按调用编号关联且路径不是成功证据', async () => {
  const harness = await staticHarness();
  try {
    const { owner, task } = harness.runtime.createTask({ title: '片段', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const base = { workerId: owner.id, createdAt: nowIso() };
    const turns: WorkerTurn[] = [
      { ...base, id: 'a', seq: 1, role: 'assistant', content: null, toolCallId: null,
        toolCalls: [{ id: 'read-1', name: 'fs_read', arguments: JSON.stringify({ path: 'a.md', offset: 30, limit: 40, content: '不应泄露的正文' }) }] },
      { ...base, id: 'b', seq: 2, role: 'tool', content: 'x'.repeat(601), toolCalls: null, toolCallId: 'read-1' },
      { ...base, id: 'c', seq: 3, role: 'user', content: 'y'.repeat(801), toolCalls: null, toolCallId: null },
    ];
    const rendered = renderTurnsForNote(turns);
    assert.match(rendered, /调用 read-1.*fs_read.*path="a.md".*offset=30.*limit=40/);
    assert.match(rendered, /结果 read-1/);
    assert.equal((rendered.match(/本次整理输入截断/g) ?? []).length, 2);
    assert.doesNotMatch(rendered, /不应泄露的正文/);
    const decision = { action: 'compact' as const, reason: '', fromSeq: 1, toSeq: 3, turns, chars: 0, coveredSeq: 0, previous: null };
    const input = buildNotePrompt({ task, worker: owner, decision, limits: harness.config.limits })[1]!.content ?? '';
    assert.match(input, /not evidence of success/);
    assert.match(input, /does not prove/);
    assert.match(input, /unknown execution status/);
  } finally {
    await harness.cleanup();
  }
});

test('Worker 请求：变更状态时缓存前缀稳定，状态不进入持久历史', async () => {
  const harness = await staticHarness();
  try {
    const { owner, task } = harness.runtime.createTask({ title: '缓存契约', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    seedTurns(harness.store, owner.id, 2, { chars: 40 });
    const build = (harness.runtime as unknown as { buildWorkerMessages: (worker: unknown, task: unknown) => Promise<{ role: string; content: string | null }[]> }).buildWorkerMessages.bind(harness.runtime);
    const before = await build(owner, task);
    harness.runtime.saveArtifact(owner, '缓存产物.md', '内容');
    const after = await build({ ...owner, stepCount: owner.stepCount + 1 }, task);
    assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
    assert.match(after.at(-1)!.content ?? '', /缓存产物.md/);
    assert.doesNotMatch(before.at(-1)!.content ?? '', /缓存产物.md/);
    assert.ok(harness.store.listWorkerTurns(owner.id, 100).every((turn) => !(turn.content ?? '').includes('Current system state')));
  } finally {
    await harness.cleanup();
  }
});


test('整理输入：同名调用按编号关联逆序结果并标明缺失结果', () => {
  const base = { workerId: 'w', createdAt: nowIso() };
  const longPath = 'a'.repeat(201);
  const turns: WorkerTurn[] = [
    { ...base, id: 'a', seq: 1, role: 'assistant', content: null, toolCallId: null,
      toolCalls: [
        { id: 'c1', name: 'fs_read', arguments: JSON.stringify({ path: 'first.md' }) },
        { id: 'c2', name: 'fs_read', arguments: JSON.stringify({ path: 'second.md' }) },
        { id: 'c3', name: 'fs_read', arguments: JSON.stringify({ path: longPath, content: '不应进入整理输入的正文' }) },
      ] },
    { ...base, id: 'b', seq: 2, role: 'tool', content: 'second-result', toolCalls: null, toolCallId: 'c2' },
    { ...base, id: 'c', seq: 3, role: 'tool', content: 'first-result', toolCalls: null, toolCallId: 'c1' },
  ];
  const rendered = renderTurnsForNote(turns);
  assert.match(rendered, /调用 c1.*first\.md/);
  assert.match(rendered, /调用 c2.*second\.md/);
  assert.match(rendered, /结果 c2.*second-result/);
  assert.match(rendered, /结果 c1.*first-result/);
  assert.ok(rendered.includes(`path=${JSON.stringify(longPath)}`), '长路径应完整保留');
  assert.doesNotMatch(rendered, /不应进入整理输入的正文/);
  assert.match(rendered, /执行结果未知 c3.*fs_read/);
});

test('检索：调用参数和消息引用可按自己的历史分页查回', async () => {
  const harness = await staticHarness();
  try {
    const { owner, task } = harness.runtime.createTask({ title: '证据', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const helper = harness.runtime.createCollaborator(owner, '协作者', 'b');
    const message = harness.runtime.sendMessage({ from: owner, to: helper.workerId!, kind: 'request', intent: 'help', body: '请看', refs: { files: ['materials/evidence.txt'] } });
    harness.store.appendWorkerTurn({ id: 'turn_args_test', workerId: owner.id, seq: 1, role: 'assistant', content: null,
      toolCalls: [{ id: 'call_args', name: 'fs_search', arguments: JSON.stringify({ path: 'materials', query: '独特关键词' }) }], toolCallId: null, createdAt: new Date().toISOString() });
    const { historyTools } = await import('../../src/tools/history.ts');
    const context = { host: harness.runtime, worker: owner, task, workDir: harness.config.workDir, materialsDir: harness.config.materialsDir, readRoot: harness.config.readRoot };
    const read = historyTools.find((tool) => tool.name === 'history_read')!;
    const first = await read.run({ from_seq: 1, limit: 30 }, context);
    const offset = Number(/offset=(\d+)/.exec(first.content)![1]);
    const second = await read.run({ from_seq: 1, offset, limit: 2000 }, context);
    assert.match(second.content, /独特关键词/);
    const messageRead = await historyTools.find((tool) => tool.name === 'message_read')!.run({ message_id: message.messageId! }, context);
    assert.match(messageRead.content, /materials\/evidence\.txt/);
  } finally { await harness.cleanup(); }
});

test('协作：运行中收到请求时立即看到身份、请求编号与引用并可回复', async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0; let seen = '';
  const harness = await createHarness({ worker: async ({ request }) => {
    if (roleOf(request) !== '协作者') return mockReply({ text: '等待协作者' });
    calls += 1;
    if (calls === 1) { started(); await gate; return mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: '.' } }] }); }
    seen = allText(request);
    return mockReply({ text: '收到' });
  } });
  try {
    const { owner } = harness.runtime.createTask({ title: '运行中', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const helper = harness.runtime.createCollaborator(owner, '协作者', 'b');
    const worker = harness.store.getWorker(helper.workerId!)!;
    harness.runtime.enqueue(worker.id);
    await startedPromise;
    const msg = harness.runtime.sendMessage({ from: owner, to: worker.id, kind: 'request', intent: 'help', body: '请调查', refs: { files: ['materials/evidence.txt'] } });
    release();
    for (let i = 0; i < 100 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(seen, new RegExp(msg.messageId!));
    assert.match(seen, new RegExp(owner.id));
    assert.match(seen, /intent: help/);
    assert.match(seen, /materials\/evidence\.txt/);
    const reply = harness.runtime.sendMessage({ from: worker, to: owner.id, kind: 'reply', replyTo: msg.messageId!, body: '已核查' });
    assert.equal(reply.ok, true);
  } finally { release(); await harness.cleanup(); }
});

test('历史检索：旧记录、工具参数、字面符号和 Unicode 不因最近 200 条被漏掉', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({ title: '检索', goal: 'g', ownerRole: '负责人', ownerBrief: 'b' });
    const other = harness.runtime.createCollaborator(owner, '协作者', '协助');
    harness.store.appendWorkerTurn({ id: 'early-search', workerId: owner.id, seq: 1, role: 'assistant', content: '旧证据 Ä%_\\', toolCalls: [{ id: 'c', name: 'fs_read', arguments: '{"path":"target-file"}' }], toolCallId: null, createdAt: nowIso() });
    seedTurns(harness.store, owner.id, 240, { chars: 8, prefix: '无关' });
    seedTurns(harness.store, other.workerId!, 1, { chars: 8, prefix: '私有 evidence' });
    const { historyTools } = await import('../../src/tools/history.ts');
    const tool = historyTools.find((item) => item.name === 'history_search')!;
    const context = { host: harness.runtime, worker: owner, task, workDir: harness.config.workDir, materialsDir: harness.config.materialsDir, readRoot: harness.config.readRoot };
    for (const query of ['ä%_\\', 'target-file']) {
      const result = await tool.run({ query }, context);
      assert.match(result.content, /turn#1/);
    }
    assert.match((await tool.run({ query: '私有 evidence' }, context)).content, /没有在自己历史/);
    assert.match((await tool.run({ query: '旧证据', from_seq: 2 }, context)).content, /没有在自己历史/);
    assert.match((await tool.run({ query: '旧证据', role: 'user' }, context)).content, /没有在自己历史/);
  } finally { await harness.cleanup(); }
});

test('任务事实：Router update 是任务级要求，成员 update 只保留真实来源和接收对象', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '更新作用域',
      goal: '只落实真实要求',
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const helper = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, '协作者', '协助').workerId!,
    )!;
    const local = harness.runtime.sendMessage({
      from: owner,
      to: helper.id,
      kind: 'update',
      body: '只给该成员的局部指示',
    });
    assert.equal(local.ok, true, local.reason);
    assert.equal(harness.store.getTask(task.id)!.reviewEpoch, 0, '局部指示不能抬升任务要求版本');

    const internal = harness.runtime as unknown as {
      taskLevelUpdateFor(currentTask: typeof task): string | null;
      assignedInstructionsFor(currentTask: typeof task, worker: typeof helper): {
        body: string;
        fromKind: ActorKind;
        fromId: string;
      }[];
    };
    assert.equal(internal.taskLevelUpdateFor(task), null);
    assert.deepEqual(internal.assignedInstructionsFor(task, helper), [{
      body: '只给该成员的局部指示',
      fromKind: 'worker',
      fromId: owner.id,
    }]);

    const factsBefore = renderTaskFacts({
      task,
      isOwner: false,
      latestUpdate: internal.taskLevelUpdateFor(task),
      assignedInstructions: internal.assignedInstructionsFor(task, helper),
    });
    assert.match(factsBefore, /指派给你的工作指示/);
    assert.match(factsBefore, new RegExp(`来自 Worker ${owner.id}`));
    assert.doesNotMatch(factsBefore, /最新任务级补充要求/);

    const routed = harness.runtime.sendRouterMessage({
      taskId: task.id,
      kind: 'update',
      workerId: owner.id,
      body: '用户真正新增的任务要求',
    });
    assert.equal(routed.ok, true, routed.reason);
    const currentTask = harness.store.getTask(task.id)!;
    assert.equal(currentTask.reviewEpoch, 1);
    assert.equal(internal.taskLevelUpdateFor(currentTask), '用户真正新增的任务要求');
    const factsAfter = renderTaskFacts({
      task: currentTask,
      isOwner: false,
      latestUpdate: internal.taskLevelUpdateFor(currentTask),
      assignedInstructions: internal.assignedInstructionsFor(currentTask, helper),
    });
    assert.match(factsAfter, /最新任务级补充要求.*用户真正新增的任务要求/);
    assert.match(factsAfter, /指派给你的工作指示.*只给该成员的局部指示/);
  } finally {
    await harness.cleanup();
  }
});

test('正式检查意见定向回流作者，长文明确截断，引用读取不能借猜 id 越权', async () => {
  const harness = await staticHarness();
  try {
    const { task, owner } = harness.runtime.createTask({
      title: '检查回流',
      goal: '修正草稿',
      ownerRole: '负责人',
      ownerBrief: '汇总',
      requireReview: false,
    });
    const author = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, '作者', '维护报告').workerId!,
    )!;
    const reviewer = harness.store.getWorker(
      harness.runtime.createCollaborator(owner, '检查者', '检查报告').workerId!,
    )!;

    const ownArtifact = harness.runtime.saveArtifact(owner, 'owner.md', '负责人草稿').artifact;
    const ownRequest = harness.runtime.sendMessage({
      from: owner,
      to: reviewer.id,
      kind: 'request',
      intent: 'review',
      body: '检查负责人草稿',
      refs: { artifacts: [{ artifactId: ownArtifact.id, name: ownArtifact.name, version: ownArtifact.version }] },
    });
    assert.equal(ownRequest.ok, true, ownRequest.reason);
    assert.equal(harness.runtime.sendMessage({
      from: reviewer,
      to: owner.id,
      kind: 'reply',
      replyTo: ownRequest.messageId!,
      outcome: 'approved',
      body: '负责人自己请求的检查结论',
    }).ok, true);
    assert.equal(
      harness.store.listInbox(owner.id).filter((message) => message.body.includes('收到正式检查结论')).length,
      0,
      '作者就是请求者时原 reply 已足够，不能重复整段意见',
    );

    const authoredArtifact = harness.runtime.saveArtifact(author, 'authored.md', '协作者草稿').artifact;
    const reviewRequest = harness.runtime.sendMessage({
      from: owner,
      to: reviewer.id,
      kind: 'request',
      intent: 'review',
      body: '检查协作者草稿',
      refs: { artifacts: [{ artifactId: authoredArtifact.id, name: authoredArtifact.name, version: authoredArtifact.version }] },
    });
    assert.equal(reviewRequest.ok, true, reviewRequest.reason);
    const longFeedback = `开头引用有效范围\n${'具体意见'.repeat(400)}\nTAIL_ONLY_MARKER`;
    const reviewReply = harness.runtime.sendMessage({
      from: reviewer,
      to: owner.id,
      kind: 'reply',
      replyTo: reviewRequest.messageId!,
      outcome: 'changes_required',
      body: longFeedback,
    });
    assert.equal(reviewReply.ok, true, reviewReply.reason);

    const feedbackNotices = harness.store
      .listInbox(author.id)
      .filter((message) => message.body.includes('收到正式检查结论'));
    assert.equal(feedbackNotices.length, 1);
    assert.match(feedbackNotices[0]!.body, /authored\.md v1/);
    assert.match(feedbackNotices[0]!.body, /检查记录/);
    assert.match(feedbackNotices[0]!.body, /检查意见摘录/);
    assert.match(feedbackNotices[0]!.body, /不完整/);
    assert.doesNotMatch(feedbackNotices[0]!.body, /TAIL_ONLY_MARKER/);
    assert.match(feedbackNotices[0]!.body, /不代表任务其他产物/);
    assert.match(feedbackNotices[0]!.body, new RegExp(reviewReply.messageId!));

    const { historyTools } = await import('../../src/tools/history.ts');
    const messageRead = historyTools.find((tool) => tool.name === 'message_read')!;
    const context = {
      host: harness.runtime,
      worker: author,
      task: harness.store.getTask(task.id)!,
      workDir: harness.config.workDir,
      materialsDir: harness.config.materialsDir,
      readRoot: harness.config.readRoot,
    };
    const full = await messageRead.run({ message_id: reviewReply.messageId!, limit: 20_000 }, context);
    assert.match(full.content, /TAIL_ONLY_MARKER/);

    // 同一任务的普通 Worker 即使猜中另一条请求/回复 id，并自行写 refs.messages，也不能获得读取权。
    const secret = harness.runtime.sendMessage({
      from: owner,
      to: reviewer.id,
      kind: 'request',
      intent: 'help',
      body: '不属于作者的私有请求',
    });
    const forgedPeer = harness.runtime.sendMessage({
      from: reviewer,
      to: author.id,
      kind: 'notice',
      body: '伪造引用',
      refs: { messages: [secret.messageId!] },
    });
    assert.equal(forgedPeer.ok, true, forgedPeer.reason);
    assert.equal(harness.runtime.getMessageForWorker(author.id, secret.messageId!), null);

    harness.store.insertMessage({
      id: newMessageId(),
      groupId: task.groupId,
      taskId: task.id,
      fromKind: 'worker',
      fromId: author.id,
      toKind: 'worker',
      toId: author.id,
      kind: 'notice',
      body: '伪造自己的引用',
      payload: null,
      replyTo: null,
      refs: { messages: [secret.messageId!] },
      dedupeKey: null,
      broadcastId: null,
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
      consumedAt: null,
      error: null,
    });
    assert.equal(harness.runtime.getMessageForWorker(author.id, secret.messageId!), null);

    // 另一任务的 reply 不能借本任务检查通知跨任务读取。
    const other = harness.runtime.createTask({
      title: '另一任务',
      goal: '隔离',
      ownerRole: '负责人',
      ownerBrief: '执行',
    });
    const otherChecker = harness.store.getWorker(
      harness.runtime.createCollaborator(other.owner, '检查者', '检查').workerId!,
    )!;
    const crossRequest = harness.runtime.sendMessage({
      from: other.owner,
      to: otherChecker.id,
      kind: 'request',
      intent: 'help',
      body: '跨任务秘密',
    });
    assert.equal(harness.runtime.getMessageForWorker(author.id, crossRequest.messageId!), null);

    // 可选检查不变成硬闸门：changes_required 仍允许负责人提交。
    const submitted = await harness.runtime.submitResult(owner, '交付协作者报告', ['authored.md']);
    assert.equal(submitted.ok, true, submitted.reason);
  } finally {
    await harness.cleanup();
  }
});

test('正式检查回流不会随迁移后的作者注入新任务', async () => {
  const harness = await staticHarness();
  try {
    const first = harness.runtime.createTask({
      title: '旧任务',
      goal: '检查旧产物',
      ownerRole: '负责人',
      ownerBrief: '发起检查',
    });
    const author = harness.store.getWorker(
      harness.runtime.createCollaborator(first.owner, '作者', '维护旧报告').workerId!,
    )!;
    const reviewer = harness.store.getWorker(
      harness.runtime.createCollaborator(first.owner, '检查者', '检查旧报告').workerId!,
    )!;
    const artifact = harness.runtime.saveArtifact(author, 'old-report.md', '旧报告').artifact;
    const request = harness.runtime.sendMessage({
      from: first.owner,
      to: reviewer.id,
      kind: 'request',
      intent: 'review',
      body: '检查旧报告',
      refs: { artifacts: [{ artifactId: artifact.id, name: artifact.name, version: artifact.version }] },
    });
    assert.equal(request.ok, true, request.reason);

    // 先按真实生命周期休眠，再通过公开 wakeWorker 把同一成员迁移到同空间的新任务。
    harness.store.setWorkerStatus(author.id, 'dormant', '旧协作结束');
    harness.store.setWorkerCurrentTask(author.id, null);
    const second = harness.runtime.createTask({
      title: '新任务',
      goal: '处理新工作',
      ownerRole: '负责人',
      ownerBrief: '开始新任务',
      workspaceId: first.task.workspaceId,
    });
    const wake = harness.runtime.wakeWorker({
      workerId: author.id,
      taskId: second.task.id,
      brief: '接手新任务',
    });
    assert.equal(wake.ok, true, wake.reason);
    assert.equal(harness.store.getWorker(author.id)?.currentTaskId, second.task.id);

    const reply = harness.runtime.sendMessage({
      from: reviewer,
      to: first.owner.id,
      kind: 'reply',
      replyTo: request.messageId!,
      outcome: 'changes_required',
      body: 'OLD_TASK_FEEDBACK_MUST_NOT_ENTER_NEW_TASK',
    });
    assert.equal(reply.ok, true, reply.reason);

    const leaked = harness.store.listTaskMessages(second.task.id).filter((message) =>
      message.toId === author.id &&
      (message.body.includes('OLD_TASK_FEEDBACK_MUST_NOT_ENTER_NEW_TASK') ||
        message.refs?.messages?.includes(reply.messageId!)),
    );
    assert.deepEqual(leaked, [], '作者迁移后不能收到旧任务的检查正文或跨任务 refs');
    assert.equal(
      harness.store.listInbox(author.id).filter((message) =>
        message.body.includes('OLD_TASK_FEEDBACK_MUST_NOT_ENTER_NEW_TASK'),
      ).length,
      0,
    );
  } finally {
    await harness.cleanup();
  }
});
