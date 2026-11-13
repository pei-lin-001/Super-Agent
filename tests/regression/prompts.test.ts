/**
 * 提示词关注角色边界与工具名正确性，不逐字锁死文案。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderModelCatalog, routerStateBlock, routerSystemPrompt, workerStateBlock, workerSystemPrompt } from '../../src/runtime/prompts.ts';
import { buildNotePrompt } from '../../src/runtime/note.ts';
import { WATCHDOG_SYSTEM } from '../../src/watchdog/prompts.ts';

function prompt(overrides: Partial<Parameters<typeof workerSystemPrompt>[0]> = {}): string {
  return workerSystemPrompt({
    task: {
      id: 'task_1',
      groupId: 'grp_1',
      title: '标题',
      goal: '目标',
      brief: '背景',
      doneCriteria: '完成条件',
      requireReview: true,
      reviewEpoch: 0,
      ownerWorkerId: 'w1',
      status: 'active',
      closeReason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      closedAt: null,
    },
    worker: {
      id: 'w1',
      groupId: 'grp_1',
      parentId: null,
      role: '执行者',
      brief: '负责执行',
      status: 'running',
      model: null,
      stepCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
    },
    isOwner: true,
    collaborators: [],
    taskFacts: '暂无',
    artifactTable: '暂无',
    noteText: null,
    noteStaleEpoch: null,
    noteCoveredSeq: 0,
    windowSummary: '',
    ...overrides,
  } as Parameters<typeof workerSystemPrompt>[0]);
}

test('检查提示词：用真实工具名，不出现缩写 send', () => {
  const text = prompt();
  assert.match(text, /message_send/, '必须使用实际工具名 message_send');
  assert.doesNotMatch(text, /(?<![a-z_])send\(/, '不应用缩写 send 指代工具');
});

test('检查提示词：不规定核对次数，不训斥', () => {
  const text = prompt();
  assert.doesNotMatch(text, /核对一次即可/, '不规定固定核对次数');
  assert.doesNotMatch(text, /这本身是失职|失职/, '不使用训斥式表达');
  assert.doesNotMatch(text, /只能核对|最多核对|必须恰好/, '不写死核对次数');
});

test('检查提示词：保留正式结论的必备要素', () => {
  const text = prompt();
  assert.match(text, /outcome/, '必须保留 outcome');
  assert.match(text, /approved/, '必须保留 approved');
  assert.match(text, /changes_required/, '必须保留 changes_required');
  assert.match(text, /inconclusive/, '必须保留 inconclusive');
  assert.match(text, /reply_to/, '必须保留 reply_to');
  assert.match(text, /版本/, '必须保留版本要求');
});

test('检查提示词：目标与证据导向，允许继续验证', () => {
  const text = prompt();
  assert.match(text, /证据/, '要围绕证据');
  assert.match(text, /可以继续验证|继续验证/, '允许在需要时继续验证');
});

test('角色边界：通用提示词不写具体用户画像', () => {
  const text = prompt();
  // 允许出现「不预设用户身份」这类否定式说明，不允许出现对用户的具体刻画。
  assert.doesNotMatch(text, /用户是[^，。；\n]{2,}/, '不描述用户是谁');
  assert.doesNotMatch(text, /用户(?:的)?(?:服务器|电脑|机器)是/, '不描述用户的运行环境');
  assert.doesNotMatch(text, /你服务的用户(?!在当前)/, '不预设服务对象的身份');
  assert.match(text, /不预设用户身份/, '应当明确说明不预设身份');
});

test('多模型目录：配置说明不冒充实测能力，单模型不引导换模型', () => {
  const models = [
    { alias: 'default', model: 'flash', note: '日常执行', costHint: null },
    { alias: 'pro', model: 'other', note: '规划与检查', costHint: '较高' },
  ];
  const multi = renderModelCatalog(models, 'default');
  assert.match(multi, /不代表实测能力/);
  assert.match(multi, /不绑定职责/);
  assert.match(multi, /没有自动选型/);
  assert.match(multi, /pro/);
  const single = renderModelCatalog([models[0]!], 'default');
  assert.doesNotMatch(single, /换用更强|没有自动选型/);
});

test('Router 保留用户约束与授权，不能增加方法性硬门槛', () => {
  const text = routerSystemPrompt();
  assert.match(text, /硬性要求|结果要求/);
  assert.match(text, /授权/);
  assert.doesNotMatch(text, /先形成方案与验收方法/);
  assert.match(text, /completed/);
});

test('提示词与最新能力对齐：申请重启、不读凭据、指派模型', () => {
  const system = workerSystemPrompt({
    task: {
      id: 't', groupId: 'g', title: 't', goal: 'g', brief: '', doneCriteria: '',
      requireReview: false, reviewEpoch: 0, ownerWorkerId: 'w', status: 'active',
      closeReason: null, createdAt: '', updatedAt: '', sourceChannel: null,
      sourceAccountId: null, sourcePeerId: null, sourceSessionKey: null,
      sourceConversationId: null, maintenance: 0, closedAt: null,
    },
    worker: {
      id: 'w', groupId: 'g', role: '负责人', brief: 'b', status: 'running',
      model: null, parentId: null, stepCount: 0, createdAt: '', updatedAt: '', lastError: null,
    },
    isOwner: true,
    collaborators: [],
    taskFacts: '',
    artifactTable: '',
    noteText: null,
    noteStaleEpoch: null,
    noteCoveredSeq: 0,
    windowSummary: '',
    modelCatalog: {
      models: [
        { alias: 'default', model: 'flash', note: '执行', costHint: null },
        { alias: 'pro', model: 'gpt-6.1-sol', note: '规划', costHint: '较高' },
      ],
      currentAlias: 'default',
    },
    override: null,
  });
  // 新能力必须出现在提示词里，否则 Worker 不知道自己能申请重启
  assert.match(system, /request_maintenance/);
  assert.match(system, /调用前先 artifact_save/, '重启会中断执行，必须要求先落盘');
  assert.match(system, /不要自己去 kill 进程/, '杀进程是维护者的活');
  assert.match(system, /共享仓库/, '切分支会影响别人，这条踩过');
  // 读文件的教训
  assert.match(system, /之后每一轮都重发一次/, '要说清 shell 读文件为什么更贵');
  assert.match(system, /\.env/, '凭据读不到要有解释，否则它会以为是工具坏了');
});

test('Router 提示词：支持用户指定已配置模型', () => {
  const text = routerSystemPrompt();
  assert.match(text, /create_task 的 model 参数/);
  assert.match(text, /已配置/);
  assert.match(text, /模型配置而不是角色/);
});

test('成员视图展示协作决策所需事实，运行中仍显示有效等待', () => {
  const input = {
    task: { groupId: 'g', title: '任务', reviewEpoch: 0, brief: '' },
    worker: { id: 'self', role: '负责人', brief: '整体交付', stepCount: 1 },
    collaborators: [
      { id: 'self', role: '负责人', status: 'running', parentId: null },
      { id: 'peer', role: '调查', status: 'running', parentId: 'self', brief: '核验证据', model: 'pro',
        wait: { reason: 'reply', replyTo: 'msg_1', from: 'self', jobId: null }, recent: ['msg_2 发现冲突'] },
    ],
    isOwner: true, taskFacts: '', artifactTable: '', noteText: null, noteStaleEpoch: null,
    noteCoveredSeq: 0, windowSummary: '',
  } as Parameters<typeof workerStateBlock>[0];
  const state = workerStateBlock(input);
  const peers = state.split('## 同组协作者')[1]!;
  assert.match(peers, /peer.*调查.*running.*pro/);
  assert.match(peers, /核验证据/);
  assert.match(peers, /有效等待.*reply.*msg_1/);
  assert.match(peers, /msg_2/);
  assert.doesNotMatch(peers, /- self｜/);
});

test('协作提示区分通知与正式答复，模型选择不固定角色', () => {
  const text = prompt();
  assert.match(text, /notice.*reply_to/);
  assert.match(text, /notice 不带 outcome.*不代替唯一 reply/);
  assert.match(text, /原等待仍有效/);
  assert.doesNotMatch(text, /同职责已有成员时不要新建|create_worker 会被拒绝/);
  assert.match(text, /模型不是固定|不把模型固定/);
  assert.match(text, /不同答案会如何影响下一步/);
  assert.doesNotMatch(text, /自己再跑一遍|可能先回滚/);
  assert.match(WATCHDOG_SYSTEM, /命令及结果位置/);
  assert.match(WATCHDOG_SYSTEM, /可以复用/);
});

test('工作记录保留明确要求，并允许淘汰已解决的决策状态', () => {
  const input = {
    task: { title: '任务', goal: '目标', doneCriteria: '逐项核验', reviewEpoch: 0 },
    worker: { id: 'w', role: '执行者' },
    decision: { previous: null, turns: [], fromSeq: 1, toSeq: 1 },
    limits: { noteMaxChars: 6000 },
  } as unknown as Parameters<typeof buildNotePrompt>[0];
  const text = buildNotePrompt(input).map((message) => message.content).join('\n');
  assert.match(text, /逐项核验/);
  assert.match(text, /未完成部分/);
  assert.match(text, /更新或淘汰/);
  assert.match(text, /不得因摘要压缩而降低明确要求/);
  assert.match(text, /执行结果未知/);
});
