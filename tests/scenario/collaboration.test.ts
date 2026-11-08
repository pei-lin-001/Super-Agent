import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, inboxOf, scripted, systemText, toolResult } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import type { MockHandler } from '../../src/model/mock.ts';
import type { ChatRequest } from '../../src/model/types.ts';

function firstMatch(pattern: RegExp, text: string | null | undefined): string {
  return pattern.exec(text ?? '')?.[1] ?? '';
}

/**
 * 综合协作场景：
 * Router 建任务（要求检查）→ A 创建 B 核对数据 → A 等待 → B 回复 → A 生成 v1
 * → A 尝试提前提交被拒 → A 创建 C 检查 → C 指出问题 → A 改出 v2 → A 交付。
 */
test('协作：自主创建协作者、直接沟通、检查引发修改、负责人交付', async () => {
  let aStep = 0;
  let collaboratorB = '';
  let artifactV1 = '';
  let checkerC = '';
  let requestToB = '';
  let requestToC = '';

  const ownerScript = (step: number, request: ChatRequest) => {
    switch (aStep++) {
      case 0:
        return mockReply({
          toolCalls: [
            {
              name: 'create_worker',
              arguments: { role: '数据核对', brief: '核对 materials/a.md 中的营收与增长率是否一致' },
            },
          ],
        });
      case 1: {
        collaboratorB = firstMatch(/已创建协作者 (w\d+_[0-9a-f]+)/, toolResult(request));
        return mockReply({
          toolCalls: [
            {
              name: 'message_send',
              arguments: {
                to: collaboratorB,
                kind: 'request',
                intent: 'verify',
                body: '请核对 materials/a.md 里的营收和增长率，指出不一致的地方，并说明依据。',
                refs: ['materials/a.md'],
              },
            },
          ],
        });
      }
      case 2:
        requestToB = firstMatch(/已投递消息 (\S+)/, toolResult(request));
        return mockReply({
          toolCalls: [
            { name: 'wait_for', arguments: { from: collaboratorB, kinds: ['reply'], timeout_seconds: 5 } },
          ],
        });
      case 3: {
        assert.ok(inboxOf(request).includes('缺少来源'), `A 应看到 B 的核对结论，实际收到：${inboxOf(request).slice(0, 300)}`);
        return mockReply({
          toolCalls: [
            {
              name: 'artifact_save',
              arguments: { name: 'report.md', content: '# 季度报告 v1\n\n营收 100 万元，增长 20%。\n' },
            },
          ],
        });
      }
      case 4: {
        artifactV1 = firstMatch(/id=(art_[0-9a-f]+)/, toolResult(request));
        assert.ok(artifactV1.startsWith('art_'), `应拿到产物 id，实际：${toolResult(request)}`);
        return mockReply({
          toolCalls: [
            { name: 'submit_result', arguments: { summary: '报告 v1 完成', artifacts: ['report.md'] } },
          ],
        });
      }
      case 5: {
        assert.match(
          toolResult(request) ?? '',
          /提交被拒绝/,
          '未经过检查就提交应被程序拒绝',
        );
        return mockReply({
          toolCalls: [
            { name: 'create_worker', arguments: { role: '检查', brief: '按完成条件检查 report.md，指出遗漏与依据' } },
          ],
        });
      }
      case 6: {
        checkerC = firstMatch(/已创建协作者 (w\d+_[0-9a-f]+)/, toolResult(request));
        return mockReply({
          toolCalls: [
            {
              name: 'message_send',
              arguments: {
                to: checkerC,
                kind: 'request',
                intent: 'review',
                body: '请按完成条件检查这份报告，指出遗漏和错误，并给出依据。',
                refs: [artifactV1],
              },
            },
          ],
        });
      }
      case 7:
        requestToC = firstMatch(/已投递消息 (\S+)/, toolResult(request));
        return mockReply({
          toolCalls: [{ name: 'wait_for', arguments: { from: checkerC, kinds: ['reply'], timeout_seconds: 5 } }],
        });
      case 8:
        assert.ok(inboxOf(request).includes('缺少数据来源'), `A 应看到检查意见，实际：${inboxOf(request).slice(0, 300)}`);
        return mockReply({
          toolCalls: [
            {
              name: 'artifact_save',
              arguments: {
                name: 'report.md',
                content: '# 季度报告 v2\n\n营收 100 万元（来源：materials/a.md），增长 20%。\n',
              },
            },
          ],
        });
      case 9:
        return mockReply({
          toolCalls: [
            {
              name: 'submit_result',
              arguments: { summary: '报告已按检查意见补充数据来源并交付。', artifacts: ['report.md'] },
            },
          ],
        });
      default:
        return mockReply({ text: '已交付。' });
    }
  };

  let bStep = 0;
  const verifierScript = (_step: number, request: ChatRequest) => {
    const index = bStep++;
    if (index === 0) {
      assert.match(systemText(request), /同组协作者/);
      return mockReply({ toolCalls: [{ name: 'fs_read', arguments: { path: 'materials/a.md' } }] });
    }
    if (index >= 2) return mockReply({ text: '核对已完成并回复负责人。' });
    const replyTo = firstMatch(/\[(msg_[0-9a-f]+)\]/, inboxOf(request));
    return mockReply({
      toolCalls: [
        {
          name: 'message_send',
          arguments: {
            to: firstMatch(/来自 (w\d+_[0-9a-f]+)/, inboxOf(request)),
            kind: 'reply',
            reply_to: replyTo,
            body: '核对结果：营收数据一致，但报告缺少来源标注，属于遗漏。',
          },
        },
      ],
    });
  };

  let cStep = 0;
  const checkerScript = (_step: number, request: ChatRequest) => {
    const index = cStep++;
    if (index === 0) {
      return mockReply({ toolCalls: [{ name: 'fs_read', arguments: { path: 'artifacts/report.md' } }] });
    }
    if (index >= 2) return mockReply({ text: '检查完成，已把意见回复负责人。' });
    const replyTo = firstMatch(/\[(msg_[0-9a-f]+)\]/, inboxOf(request));
    const owner = firstMatch(/来自 (w\d+_[0-9a-f]+)/, inboxOf(request));
    return mockReply({
      toolCalls: [
        {
          name: 'message_send',
          arguments: {
            to: owner,
            kind: 'reply',
            reply_to: replyTo,
            body: '检查意见：结论缺少数据来源，无法核对；请补充来源后再交付。',
          },
        },
      ],
    });
  };

  let routerStep = 0;
  const router: MockHandler = () => {
    if (routerStep++ === 0) {
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '季度报告',
              goal: '根据 materials/a.md 整理季度报告',
              brief: '材料在 materials/ 目录',
              done_criteria: '报告包含营收与增长结论，并标注数据来源',
              require_review: true,
              owner_role: '报告负责人',
              owner_brief: '组织核对与检查，整合并交付报告',
            },
          },
        ],
      });
    }
    return mockReply({ text: '任务已建立，负责人正在组织核对与检查。' });
  };

  const harness = await createHarness({
    materials: { 'a.md': '# 材料 A\n本季度营收 100 万元，同比增长 20%。\n' },
    router,
    worker: scripted({
      报告负责人: ownerScript,
      数据核对: verifierScript,
      检查: checkerScript,
    }),
  });

  try {
    await harness.router.handleUserMessage('根据材料整理一份季度报告，要经过检查');
    await harness.runtime.waitForIdle(15_000);

    const task = harness.store.listTasks()[0]!;
    assert.equal(task.status, 'completed');

    const workers = harness.runtime.listGroupWorkers(task.groupId);
    assert.equal(workers.length, 3, '应为负责人 + 核对者 + 检查者三个同层 Worker');
    const owner = workers.find((worker) => worker.id === task.ownerWorkerId)!;
    const others = workers.filter((worker) => worker.id !== owner.id);
    assert.ok(others.every((worker) => worker.parentId === owner.id), '协作者的 parentId 只记录来源');
    assert.ok(others.every((worker) => worker.groupId === task.groupId), '协作者必须继承同一群组');

    const messages = harness.store.listGroupMessages(task.groupId);
    const requests = messages.filter((message) => message.kind === 'request');
    const replies = messages.filter((message) => message.kind === 'reply');
    assert.equal(requests.length, 2);
    assert.equal(replies.length, 2);
    assert.ok(replies.every((reply) => reply.replyTo && requests.some((request) => request.id === reply.replyTo)));
    assert.ok(replies.every((reply) => reply.status === 'consumed'), '回复应被接收者实际读到');

    const reviews = harness.store.listReviews(task.id);
    assert.equal(reviews.length, 1, '检查请求应登记为 review');
    assert.equal(reviews[0]!.status, 'answered');
    assert.equal(reviews[0]!.artifactVersion, 1);

    const artifacts = harness.store.listArtifacts(task.id);
    assert.equal(artifacts.length, 2);
    assert.deepEqual(artifacts.map((artifact) => artifact.version), [1, 2]);

    const finalContent = await readFile(join(harness.config.workDir, artifacts[1]!.path), 'utf8');
    assert.match(finalContent, /来源：materials\/a\.md/, '检查意见应引发实际修改');

    assert.equal(owner.status, 'done');
    // 任务交付后群组关闭，协作者被系统收尾；这属于任务结束，不是创建者随意终止协作者。
    assert.ok(others.every((worker) => worker.status === 'cancelled'));
  } finally {
    await harness.cleanup();
  }
});
