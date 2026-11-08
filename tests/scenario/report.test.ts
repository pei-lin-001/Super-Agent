import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, scripted } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import type { MockHandler } from '../../src/model/mock.ts';

test('单 Worker：读材料 → 保存产物 → 提交 → 任务完成', async () => {
  let routerStep = 0;
  const router: MockHandler = () => {
    const step = routerStep++;
    if (step === 0) {
      return mockReply({
        toolCalls: [
          {
            name: 'create_task',
            arguments: {
              title: '整理材料报告',
              goal: '根据 materials 下的材料整理一份报告',
              brief: '材料在 materials/ 目录，产物写到任务目录',
              done_criteria: '产出一份 report.md，结论可对应到材料内容',
              owner_role: '报告负责人',
              owner_brief: '读取材料并撰写报告',
            },
          },
        ],
      });
    }
    return mockReply({ text: '已安排负责人整理报告，完成后我会汇总。' });
  };

  const harness = await createHarness({
    materials: { 'a.md': '# 材料 A\n本季度营收 100 万元。' },
    router,
    worker: scripted({
      报告负责人: (step) => {
        switch (step) {
          case 0:
            return mockReply({ toolCalls: [{ name: 'fs_list', arguments: { path: 'materials' } }] });
          case 1:
            return mockReply({ toolCalls: [{ name: 'fs_read', arguments: { path: 'materials/a.md' } }] });
          case 2:
            return mockReply({
              toolCalls: [
                {
                  name: 'artifact_save',
                  arguments: { name: 'report.md', content: '# 报告\n\n本季度营收 100 万元。\n' },
                },
              ],
            });
          case 3:
            return mockReply({
              toolCalls: [
                { name: 'submit_result', arguments: { summary: '报告已完成，引用材料 A 的营收数据。', artifacts: ['report.md'] } },
              ],
            });
          default:
            return mockReply({ text: '工作已交付。' });
        }
      },
    }),
  });

  try {
    await harness.router.handleUserMessage('根据材料整理一份报告');
    await harness.runtime.waitForIdle(10_000);

    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    assert.equal(task.status, 'completed');
    assert.equal(task.groupId, `grp_${task.id.slice(5)}`);

    const artifacts = harness.store.listArtifacts(task.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.name, 'report.md');
    assert.equal(artifacts[0]!.version, 1);

    const content = await readFile(join(harness.config.workDir, artifacts[0]!.path), 'utf8');
    assert.match(content, /100 万元/);

    const messages = harness.store.listGroupMessages(task.groupId);
    const result = messages.filter((message) => message.kind === 'result');
    assert.equal(result.length, 1, '程序应自动生成一条 result 消息给 Router');
    assert.equal(result[0]!.fromId, task.ownerWorkerId);

    const owner = harness.store.getWorker(task.ownerWorkerId!)!;
    assert.equal(owner.status, 'done');
    assert.equal(owner.parentId, null);
  } finally {
    await harness.cleanup();
  }
});
