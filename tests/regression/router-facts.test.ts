/**
 * Router 的事实边界。
 *
 * 三件事必须有确定答案，而不是靠提示词"请勿重复"：
 * 1) 当前会话的任务必须进上下文，别的会话（含 CLI）的任务不能混进来；
 * 2) 读取和修改用同一个归属判断，不能只有读取做校验；
 * 3) 决策完成与会话检查点同一事务，崩溃续接不会把同一批动作再做一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, systemText } from '../helpers.ts';
import { mockReply } from '../../src/model/mock.ts';
import { MockModel } from '../../src/model/mock.ts';
import { Router } from '../../src/runtime/router.ts';
import { sessionKeyOf } from '../../src/channels/types.ts';
import type { ChatRequest } from '../../src/model/types.ts';

const TG_KEY = sessionKeyOf({ channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1' });
const WX_KEY = sessionKeyOf({ channel: 'weixin', accountId: 'wx_1', peerId: 'owner-2' });

const ownerBrief = { ownerRole: '执行者', ownerBrief: '把活干完' };

test('任务卡：只看得到当前会话建的任务，CLI 与别的聊天互不串', async () => {
  const prompts: Record<string, string> = {};
  const harness = await createHarness({
    worker: () => mockReply({ text: '在跑' }),
    router: ({ request }: { request: ChatRequest }) => {
      const marker = request.messages.at(-1)?.content ?? '';
      prompts[marker] = systemText(request);
      return mockReply({ text: '好的' });
    },
  });
  try {
    const telegram = harness.runtime.createTask(
      {
        title: 'A 聊天的任务',
        goal: '验证会话归属',
        requireReview: false,
        ...ownerBrief,
        source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
      },
    );
    const cli = harness.runtime.createTask({ title: 'CLI 的任务', goal: '验证会话归属', requireReview: false, ...ownerBrief });

    await harness.router.handleUserMessage('tg-ask', { sessionKey: TG_KEY });
    await harness.router.handleUserMessage('cli-ask');
    await harness.router.handleUserMessage('wx-ask', { sessionKey: WX_KEY });

    assert.ok(prompts['tg-ask']!.includes(telegram.task.id), 'Telegram 会话必须看到自己建的任务');
    assert.ok(!prompts['tg-ask']!.includes(cli.task.id), 'Telegram 会话不能看到 CLI 的任务');

    assert.ok(prompts['cli-ask']!.includes(cli.task.id), 'CLI 会话必须看到 CLI 建的任务');
    assert.ok(!prompts['cli-ask']!.includes(telegram.task.id), 'CLI 会话不能看到聊天任务');

    assert.ok(!prompts['wx-ask']!.includes(telegram.task.id), '另一个聊天不能看到 Telegram 的任务');
    assert.ok(!prompts['wx-ask']!.includes(cli.task.id), '另一个聊天不能看到 CLI 的任务');
  } finally {
    await harness.cleanup();
  }
});

test('任务动作：别的会话既不能停止也不能改要求', async () => {
  let step = 0;
  const harness = await createHarness({
    worker: () => mockReply({ text: '在跑' }),
    router: () => {
      step += 1;
      if (step === 1) {
        return mockReply({
          toolCalls: [{ name: 'stop_task', arguments: { task_id: taskId, reason: '越权试试' } }],
        });
      }
      if (step === 2) {
        return mockReply({
          toolCalls: [
            {
              name: 'send_to_worker',
              arguments: { task_id: taskId, worker_id: workerId, kind: 'update', body: '越权补充要求' },
            },
          ],
        });
      }
      return mockReply({ text: '都拒绝了' });
    },
  });
  let taskId = '';
  let workerId = '';
  try {
    const created = harness.runtime.createTask(
      {
        title: 'A 聊天的任务',
        goal: '验证越权',
        requireReview: false,
        ...ownerBrief,
        source: { channel: 'telegram', accountId: 'bot_1', peerId: 'owner-1', sessionKey: TG_KEY },
      },
    );
    taskId = created.task.id;
    workerId = created.owner.id;

    await harness.router.handleUserMessage('帮我停掉这个任务', { sessionKey: WX_KEY });

    assert.equal(harness.store.getTask(taskId)!.status, 'active', '别的会话不能把任务停掉');
    const results = harness.store
      .listGroupMessages(created.task.groupId, 50)
      .filter((message) => message.kind === 'update');
    assert.equal(results.length, 0, '别的会话不能把补充要求投进任务');
  } finally {
    await harness.cleanup();
  }
});

test('决策检查点：崩溃后从已保存的工具结果续接，不重复建任务', async () => {
  let enteredSecond = (): void => {};
  const second = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });
  const hasTaskId = (request: ChatRequest): boolean =>
    request.messages.some((message) => /task_[0-9a-f]{6,}/.test(message.content ?? ''));

  const harness = await createHarness({
    worker: () => mockReply({ text: '在跑' }),
    router: ({ request }) => {
      const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      // 只有用户那条输入走"建任务 → 崩溃"的剧本；后台汇报走普通回复。
      if (lastUser !== '建个任务') return mockReply({ text: '收到进展。' });
      if (!hasTaskId(request)) {
        return mockReply({
          toolCalls: [
            {
              name: 'create_task',
              arguments: {
                title: '只应该建一次的任务',
                goal: '验证崩溃续接',
                require_review: false,
                owner_role: '执行者',
                owner_brief: '把活干完',
              },
            },
          ],
        });
      }
      // 真实进程在这里崩溃：这次模型调用永远不返回。
      enteredSecond();
      return new Promise(() => {});
    },
  });

  try {
    void harness.router.handleUserMessage('建个任务', { sessionKey: TG_KEY });
    await second;

    const tasks = harness.store.listTasks();
    assert.equal(tasks.length, 1, '第一轮只建一个任务');
    const taskId = tasks[0]!.id;

    // 崩溃后重启：上一个进程的 running 会被收回成待续接。
    const stale = harness.store.resumeStaleRouterSessions();
    assert.equal(stale, 1, '应该有一条 running 的会话被收回');
    const saved = harness.store.pendingRouterSession(TG_KEY);
    assert.ok(saved, '续接入口必须存在');
    assert.ok(
      JSON.stringify(saved.messages).includes(taskId),
      '检查点里必须有 create_task 的真实回执，否则模型会当成没做过',
    );

    let sawTaskId = false;
    const router = new Router(
      harness.runtime,
      new MockModel(async ({ request }) => {
        sawTaskId = request.messages.some((message) => (message.content ?? '').includes(taskId));
        return mockReply({ text: '任务在跑，稍后汇报。' });
      }),
      harness.config,
    );
    harness.runtime.attachRouter(router);
    await router.resume();

    assert.ok(sawTaskId, '续接的请求里必须带着上一轮的工具回执');
    assert.equal(harness.store.listTasks().length, 1, '续接不能重复建任务');
  } finally {
    await harness.cleanup();
  }
});

test('信道规范：IM 回复有 100 词硬约束，且禁报告体', async () => {
  let prompt = '';
  const harness = await createHarness({
    worker: () => mockReply({ text: '在跑' }),
    router: ({ request }: { request: ChatRequest }) => {
      prompt = systemText(request);
      return mockReply({ text: '好' });
    },
  });
  try {
    await harness.router.handleUserMessage('在吗', { sessionKey: TG_KEY });
    assert.match(prompt, /100 词/, 'IM 信道要写明确的长度上限');
    assert.match(prompt, /低打扰/, '要说明这是低打扰信道');
    assert.match(prompt, /不用表格/, '要禁掉报告体排版');
    assert.match(prompt, /例外/, '用户要求详细时要有例外，否则长任务说明会被硬截断');
  } finally {
    await harness.cleanup();
  }
});
