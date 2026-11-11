import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { fileTools } from '../../src/tools/files.ts';
import { editTools } from '../../src/tools/edit.ts';

test('后续任务固定交接已登记版本并校验归属与内容', async () => {
  const h = await createHarness({ worker: () => mockReply({ text: '等待' }) });
  try {
    const source = h.runtime.createTask({ title: '原任务', goal: 'g', ownerRole: 'r', ownerBrief: 'b' });
    const first = h.runtime.saveArtifact(source.owner, 'report.md', '原版本').artifact;
    h.runtime.saveArtifact(source.owner, 'report.md', '新版本');
    const call = (h.router as any).executeTool.bind(h.router);
    const args = JSON.stringify({ title: '后续', goal: 'g', owner_role: 'r', owner_brief: 'b', input_artifact_ids: [first.id] });
    const crossSession = await call('create_task', args, { sessionId: 'x', actionKey: 'x', sessionKey: 'telegram|a|b', scope: { conversationId: null } });
    assert.match(crossSession, /不属于当前会话和话题/);
    const crossTopic = await call('create_task', args, { sessionId: 'x', actionKey: 'x', sessionKey: null, scope: { conversationId: 'other' } });
    assert.match(crossTopic, /不属于当前会话和话题/);
    const ok = await call('create_task', args);
    assert.match(ok, /已创建任务/);
    const dest = h.store.listTasks().find((task) => task.title === '后续')!;
    assert.match(dest.brief, new RegExp(first.id));
    const snapshot = join(h.config.workDir, dest.id, 'inputs', 'report.md');
    assert.equal(readFileSync(snapshot, 'utf8'), '原版本');
    const context = { workDir: h.config.workDir, task: dest } as any;
    for (const tool of [fileTools.find((item) => item.name === 'fs_write')!, editTools.find((item) => item.name === 'fs_edit')!]) {
      await assert.rejects(async () => tool.run({ path: 'inputs/report.md', content: '改动', old_string: '原版本', new_string: '改动' }, context), /只读/);
    }
    assert.equal(readFileSync(snapshot, 'utf8'), '原版本');
    writeFileSync(join(h.config.workDir, first.path), '损坏');
    const rejected = await call('create_task', args);
    assert.match(rejected, /内容与登记不一致/);
    assert.equal(h.store.listTasks().filter((task) => task.title === '后续').length, 1);
  } finally { await h.cleanup(); }
});
