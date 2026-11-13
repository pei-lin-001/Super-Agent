import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { allText, createHarness, inboxOf, scripted, systemText, toolResult } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import type { MockHandler } from '../../src/model/mock.ts';
import type { ChatRequest } from '../../src/model/types.ts';

function firstMatch(pattern: RegExp, text: string | null | undefined): string {
  return pattern.exec(text ?? '')?.[1] ?? '';
}

/** 历史 inbox 会保留多条消息，取最后一条才是这次要处理的那条。 */
function lastMatch(pattern: RegExp, text: string | null | undefined): string {
  const all = [...(text ?? '').matchAll(new RegExp(pattern.source, 'g'))];
  return all.at(-1)?.[1] ?? '';
}

/**
 * 综合协作场景：
 * Router 建任务（要求检查）→ A 创建 B 核对 → A 等待 → B 回复 → A 生成 v1
 * → A 创建 C 检查 v1 → C 判定「需修改」→ A 改出 v2
 * → A 用 v2 直接提交被拒（v1 的检查结论不能覆盖 v2）
 * → A 请 C 复检 v2 → C 通过 → A 交付成功。
 */
test('协作：自主创建协作者、直接沟通、检查引发修改、旧检查不能放行新版本', async () => {
  let aStep = 0;
  let collaboratorB = '';
  let checkerC = '';
  let artifactV1 = '';
  let artifactV2 = '';
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
                intent: 'help',
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
        assert.match(toolResult(request) ?? '', /提交被拒绝/, '未经过检查就提交应被程序拒绝');
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
                body: '请按完成条件正式检查这份报告，给出明确结论。',
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
      case 8: {
        const inbox = inboxOf(request);
        assert.ok(inbox.includes('缺少数据来源'), `A 应看到检查结论，实际收到：${inbox.slice(0, 300)}`);
        assert.ok(inbox.includes('changes_required'), 'A 应看到结构化结论 changes_required');
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
      }
      case 9: {
        artifactV2 = firstMatch(/id=(art_[0-9a-f]+)/, toolResult(request));
        assert.ok(artifactV2.startsWith('art_'), `应拿到 v2 产物 id，实际：${toolResult(request)}`);
        return mockReply({
          toolCalls: [
            { name: 'submit_result', arguments: { summary: '报告 v2 完成，沿用刚才的检查结论', artifacts: ['report.md'] } },
          ],
        });
      }
      case 10: {
        const rejected = toolResult(request) ?? '';
        if (!rejected.includes('提交被拒绝')) console.error('DEBUG case10 rejected:', JSON.stringify(rejected).slice(0, 500));
        assert.match(rejected, /提交被拒绝/, '改了产物之后沿用旧检查结论，应被拒绝');
        assert.match(rejected, /report\.md v2/, '拒绝原因应指出具体版本');
        return mockReply({
          toolCalls: [
            {
              name: 'message_send',
              arguments: {
                to: checkerC,
                kind: 'request',
                intent: 'review',
                body: '已按意见补充来源，请复检 v2 并给出结论。',
                refs: [artifactV2],
              },
            },
          ],
        });
      }
      case 11:
        return mockReply({
          toolCalls: [{ name: 'wait_for', arguments: { from: checkerC, kinds: ['reply'], timeout_seconds: 5 } }],
        });
      case 12: {
        assert.ok(inboxOf(request).includes('approved'), 'A 应看到复检通过的结构化结论');
        return mockReply({
          toolCalls: [
            {
              name: 'submit_result',
              arguments: { summary: '报告已按检查意见补充数据来源，并取得新版本检查通过。', artifacts: ['report.md'] },
            },
          ],
        });
      }
      default:
        return mockReply({ text: '已交付。' });
    }
  };

  let bStep = 0;
  const verifierScript = (_step: number, request: ChatRequest) => {
    const index = bStep++;
    if (index === 0) {
      // 协作者列表在「系统当前状态」块里，跟着最后那条 user 消息走。
      assert.match(allText(request), /Collaborators/);
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
  let cReplyTo = '';
  let cOwner = '';
  const checkerScript = (_step: number, request: ChatRequest) => {
    const index = cStep++;
    const inbox = inboxOf(request);

    if (index === 0) {
      return mockReply({ toolCalls: [{ name: 'artifact_read', arguments: { name: 'report.md', version: 1 } }] });
    }
    if (index === 1) {
      const replyTo = firstMatch(/\[(msg_[0-9a-f]+)\]/, inbox);
      return mockReply({
        toolCalls: [
          {
            name: 'message_send',
            arguments: {
              to: firstMatch(/来自 (w\d+_[0-9a-f]+)/, inbox),
              kind: 'reply',
              reply_to: replyTo,
              outcome: 'changes_required',
              body: '检查结论：结论缺少数据来源，无法核对；请补充来源后再交付。',
            },
          },
        ],
      });
    }
    if (index === 2) {
      return mockReply({ text: '检查结论已回复，等待下一步。' });
    }
    if (index === 3) {
      assert.ok(inbox.includes('复检'), `C 应收到复检请求，实际：${inbox.slice(0, 200)}`);
      // 历史 inbox 里可能有上一次请求，取最后一条才是本次复检。
      cReplyTo = lastMatch(/\[(msg_[0-9a-f]+)\]/, inbox);
      cOwner = lastMatch(/来自 (w\d+_[0-9a-f]+)/, inbox);
      return mockReply({ toolCalls: [{ name: 'artifact_read', arguments: { name: 'report.md', version: 2 } }] });
    }
    if (index === 4) {
      return mockReply({
        toolCalls: [
          {
            name: 'message_send',
            arguments: {
              to: cOwner,
              kind: 'reply',
              reply_to: cReplyTo,
              outcome: 'approved',
              body: '复检结论：v2 已补充来源标注，approved。',
            },
          },
        ],
      });
    }
    return mockReply({ text: '检查完毕。' });
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
    assert.equal(
      harness.store.getTask(task.id)!.status,
      'completed',
      `任务应完成，实际 ${harness.store.getTask(task.id)!.status}：${harness.store.getTask(task.id)!.closeReason ?? ''}`,
    );
    const workers = harness.runtime.listGroupWorkers(task.groupId);
    assert.equal(workers.length, 3, '应为负责人 + 核对者 + 检查者三个同层 Worker');
    const owner = workers.find((worker) => worker.id === task.ownerWorkerId)!;
    const others = workers.filter((worker) => worker.id !== owner.id);
    assert.ok(others.every((worker) => worker.parentId === owner.id), '协作者的 parentId 只记录来源');
    assert.ok(others.every((worker) => worker.groupId === task.groupId), '协作者必须继承同一群组');

    const messages = harness.store.listGroupMessages(task.groupId);
    const requests = messages.filter((message) => message.kind === 'request');
    const replies = messages.filter((message) => message.kind === 'reply');
    // 三次请求：普通核对 1 次 + 正式检查 2 次（v1 判定需修改，v2 复检通过）。
    assert.equal(requests.length, 3);
    assert.equal(replies.length, 3);
    assert.ok(replies.every((reply) => reply.replyTo && requests.some((request) => request.id === reply.replyTo)));
    assert.ok(replies.every((reply) => reply.status === 'consumed'), '回复应被接收者实际读到');

    const reviews = harness.store.listReviews(task.id);
    assert.equal(reviews.length, 2, '只有 intent=review 的请求才登记检查记录');
    assert.deepEqual(reviews.map((review) => review.artifactVersion), [1, 2]);
    assert.deepEqual(reviews.map((review) => review.outcome), ['changes_required', 'approved']);
    assert.equal(reviews[0]!.epoch, 0);

    const artifacts = harness.store.listArtifacts(task.id);
    assert.equal(artifacts.length, 2);
    assert.deepEqual(artifacts.map((artifact) => artifact.version), [1, 2]);
    // 版本各自独立落盘：v1 内容不会被 v2 覆盖。
    const v1Content = await readFile(join(harness.config.workDir, artifacts[0]!.path), 'utf8');
    assert.match(v1Content, /季度报告 v1/, 'v1 文件必须保持原内容');
    assert.ok(artifacts[0]!.path !== artifacts[1]!.path, '不同版本必须写到不同路径');

    const finalContent = await readFile(join(harness.config.workDir, artifacts[1]!.path), 'utf8');
    assert.match(finalContent, /来源：materials\/a\.md/, '检查意见应引发实际修改');

    assert.equal(owner.status, 'done');
    // 任务交付后协作者被系统收尾——现在收成 dormant 而不是 cancelled：
    // 它还记得这次协作的内容，下次在同一空间遇到相似问题不用从头再来。
    // 真正的终止（用户取消、任务失败）仍然走 closeGroup，那条路是 cancelled。
    assert.ok(others.every((worker) => worker.status === 'dormant' || worker.status === 'cancelled'));
  } finally {
    await harness.cleanup();
  }
});
