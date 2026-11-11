/**
 * 提示词关注角色边界与工具名正确性，不逐字锁死文案。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderModelCatalog, routerStateBlock, routerSystemPrompt, workerSystemPrompt } from '../../src/runtime/prompts.ts';

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
