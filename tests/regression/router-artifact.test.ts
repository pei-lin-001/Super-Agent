import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, toolResult } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';

const ownerBrief = { ownerRole: '负责人', ownerBrief: '完成工作' };
const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot', peerId: 'owner' });

test('Router read_artifact：已完成任务可按版本分页读取登记文本', async () => {
  let taskId = '';
  let toolIndex = 0;
  const results: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    router: ({ request }) => {
      const result = toolResult(request);
      if (result) results.push(result);
      if (toolIndex === 0) {
        toolIndex += 1;
        return mockReply({
          toolCalls: [{ id: 'c1', name: 'read_artifact', arguments: JSON.stringify({ task_id: taskId, name: 'report.md', version: 1, offset: 0, limit: 4 }) }],
        });
      }
      if (toolIndex === 1) {
        toolIndex += 1;
        return mockReply({
          toolCalls: [{ id: 'c2', name: 'read_artifact', arguments: JSON.stringify({ task_id: taskId, name: 'report.md', version: 1, offset: 4, limit: 4 }) }],
        });
      }
      return mockReply({ text: '已核对两段' });
    },
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({
      title: '报告读取',
      goal: 'g',
      ...ownerBrief,
      source: { channel: 'telegram', accountId: 'bot', peerId: 'owner', sessionKey: TG_KEY, conversationId: 'topic-a' },
    });
    taskId = created.task.id;
    harness.runtime.saveArtifact(created.owner, 'report.md', '0123456789');
    harness.store.setTaskStatus(taskId, 'completed', { reason: '测试完成' });

    await harness.router.handleUserMessage('核对报告', { sessionKey: TG_KEY, conversationId: 'topic-a' });
    assert.match(results[0]!, /# report\.md v1/);
    assert.match(results[0]!, /0123/);
    assert.match(results[0]!, /continue|继续请用 offset=4/);
    assert.match(results[1]!, /4567/);
    assert.match(results[1]!, /继续请用 offset=8/);
  } finally {
    await harness.cleanup();
  }
});

test('Router read_artifact：跨聊天和跨话题均拒绝，权限复用 taskForAction', async () => {
  let taskId = '';
  let toolIndex = 0;
  const results: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    router: ({ request }) => {
      if (request.messages.at(-1)?.role === 'tool') {
        const result = toolResult(request);
        assert.ok(result);
        results.push(result);
        return mockReply({ text: '收到' });
      }
      toolIndex += 1;
      return mockReply({
        toolCalls: [{ id: `c${toolIndex}`, name: 'read_artifact', arguments: JSON.stringify({ task_id: taskId, name: 'report.md' }) }],
      });
    },
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({
      title: '话题隔离',
      goal: 'g',
      ...ownerBrief,
      source: { channel: 'telegram', accountId: 'bot', peerId: 'owner', sessionKey: TG_KEY, conversationId: 'topic-a' },
    });
    taskId = created.task.id;
    harness.runtime.saveArtifact(created.owner, 'report.md', '正文');

    await harness.router.handleUserMessage('读一下', { sessionKey: TG_KEY, conversationId: 'topic-b' });
    await harness.router.handleUserMessage('再读一下', { sessionKey: 'telegram|bot|other', conversationId: 'topic-a' });
    assert.equal(results.length, 2);
    assert.match(results[0]!, /属于另一个会话/);
    assert.match(results[1]!, /属于另一个会话/);
  } finally {
    await harness.cleanup();
  }
});

test('Router read_artifact：未知版本、二进制和指纹损坏都明确失败', async () => {
  let taskId = '';
  let toolIndex = 0;
  const results: string[] = [];
  const tools = [
    { id: 'c1', name: 'read_artifact', arguments: JSON.stringify({ task_id: '', name: 'report.md', version: 99 }) },
    { id: 'c2', name: 'read_artifact', arguments: JSON.stringify({ task_id: '', name: 'image.bin' }) },
    { id: 'c3', name: 'read_artifact', arguments: JSON.stringify({ task_id: '', name: 'report.md', version: 1 }) },
  ];
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    router: ({ request }) => {
      if (request.messages.at(-1)?.role === 'tool') {
        const result = toolResult(request);
        assert.ok(result);
        results.push(result);
        return mockReply({ text: '本次失败已确认' });
      }
      const tool = tools[toolIndex++]!;
      const args = JSON.parse(tool.arguments) as Record<string, unknown>;
      args['task_id'] = taskId;
      return mockReply({ toolCalls: [{ ...tool, arguments: JSON.stringify(args) }] });
    },
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({ title: '失败核验', goal: 'g', ...ownerBrief });
    taskId = created.task.id;
    const report = harness.runtime.saveArtifact(created.owner, 'report.md', '已登记正文').artifact;
    harness.runtime.saveArtifact(created.owner, 'image.bin', '\0binary');
    await writeFile(join(harness.config.workDir, report.path), '被改写', 'utf8');

    await harness.router.handleUserMessage('检查未知版本');
    await harness.router.handleUserMessage('检查二进制');
    await harness.router.handleUserMessage('检查指纹');
    assert.match(results[0]!, /产物不存在：report\.md v99/);
    assert.match(results[1]!, /不是 UTF-8 文本/);
    assert.match(results[2]!, /内容与登记不一致/);
  } finally {
    await harness.cleanup();
  }
});

test('Router send_file：CLI 回执给出存在且有指纹快照的绝对路径', async () => {
  let taskId = '';
  let artifactPath = '';
  const results: string[] = [];
  const harness = await createHarness({
    worker: () => mockReply({ text: 'ok' }),
    router: ({ request }) => {
      if (request.messages.at(-1)?.role === 'tool') {
        const result = toolResult(request);
        assert.ok(result);
        results.push(result);
        return mockReply({ text: '文件定位结果已核对' });
      }
      return mockReply({
        toolCalls: [{ id: 'send', name: 'send_file', arguments: JSON.stringify({ task_id: taskId, name: 'report.md' }) }],
      });
    },
    limits: { maxConcurrentRuns: 0 },
  });
  try {
    const created = harness.runtime.createTask({ title: 'CLI 文件', goal: 'g', ...ownerBrief });
    taskId = created.task.id;
    const artifact = harness.runtime.saveArtifact(created.owner, 'report.md', '正文').artifact;
    artifactPath = join(harness.config.workDir, artifact.path);

    await harness.router.handleUserMessage('给我报告');
    assert.match(results[0]!, /CLI 会话不通过聊天发送文件/);
    assert.match(results[0]!, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    await rm(artifactPath);
    await harness.router.handleUserMessage('再给我报告');
    assert.match(results[1]!, /登记快照已缺失或被移动/);
  } finally {
    await harness.cleanup();
  }
});
