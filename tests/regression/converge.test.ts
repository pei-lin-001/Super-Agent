/**
 * 任务终结后，所有协作者必须收敛到真实状态。
 * 重点：不能把没干完活的协作者伪装成成功，也不能让它的迟到回调继续动业务。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { sendSse, sseTools } from '../sse.ts';
import { PiModel } from '../../src/model/pi.ts';
import { Runtime } from '../../src/runtime/runtime.ts';
import { Store } from '../../src/storage/store.ts';

interface Ctx {
  runtime: Runtime;
  store: Store;
  dir: string;
  release: () => void;
  requests: () => number;
  cleanup: () => Promise<void>;
}

async function makeCtx(port: number): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-converge-'));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    DB_PATH: join(dir, 'db.sqlite'),
    WORK_DIR: join(dir, 'work'),
    OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OLLAMA_API_KEY: 'test',
    MODEL_NAME: 'm',
    MODEL_TIMEOUT_MS: '60000',
    MODEL_RETRY: '1',
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const model = new PiModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: 1,
    reasoningEffort: 'low',
    maxTokens: 64,
  }, 'test-model');
  const runtime = new Runtime({ store, config, workerModel: model });
  runtime.start();
  return {
    runtime,
    store,
    dir,
    release: () => undefined,
    requests: () => 0,
    cleanup: async () => {
      await runtime.stop();
      if (!store.isClosed) store.close();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

test('负责人完成、协作者仍在等待时：任务终结后协作者收敛，迟到响应不产生副作用', async () => {
  // 负责人：立即 artifact_save → submit_result
  // 协作者：永远等（由测试控制释放时机）
  let holds = 0;
  const releaseRef: { fn?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    releaseRef.fn = resolve;
  });
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c.toString();
    });
    req.on('end', () => {
      let parsed: { messages?: { role?: string; content?: string }[] } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        parsed = {};
      }
      const outputs = (parsed.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => m.content ?? '')
        .join('\n');
      // 用各自独有的 brief 区分：负责人先做完，协作者的请求一直挂着。
      const isOwner = !raw.includes('会迟到');
      const reply = (name: string, args: Record<string, unknown>, id: string): string =>
        sseTools([{ id, name, args }]);
      if (isOwner) {
        if (!outputs.includes('deliverable.md')) {
          sendSse(res, reply('artifact_save', { name: 'deliverable.md', content: '# done\n' }, 'o1'));
        } else {
          sendSse(res, reply('submit_result', { summary: '负责人完成', artifacts: ['deliverable.md'] }, 'o2'));
        }
        return;
      }
      // 协作者：挂住不返回，直到测试释放
      holds += 1;
      void held.then(() => {
        try {
          sendSse(res, reply('fs_write', { path: 'late.txt', content: '迟到写入\n' }, 'l1'));
        } catch {
          // 已断开
        }
      });
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;

  const h = await makeCtx(port);
  try {
    const { task, owner } = h.runtime.createTask({
      title: '收敛验收',
      goal: 'g',
      doneCriteria: '交付 deliverable.md',
      ownerRole: '负责人角色',
      ownerBrief: '完成交付',
    });
    // 协作者在负责人完成之前就已经在等模型响应——这才是要覆盖的场景
    const collaborator = h.store.createWorker({
      id: 'w2_late',
      groupId: task.groupId,
      parentId: owner.id,
      role: '协作者',
      brief: '会迟到',
      status: 'queued',
      model: null,
      stepCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
    });
    h.runtime.enqueue(collaborator.id);
    assert.ok(await waitFor(() => holds > 0, 10_000), '协作者必须真的发出了模型请求');
    assert.equal(h.store.getWorker(collaborator.id)?.status, 'running', '完成之前协作者确实在执行');
    assert.ok(await waitFor(() => h.store.getTask(task.id)?.status === 'completed', 15_000), '负责人应完成任务');

    // 释放迟到响应
    releaseRef.fn?.();
    await new Promise((r) => setTimeout(r, 1_500));

    const taskAfter = h.store.getTask(task.id);
    assert.equal(taskAfter?.status, 'completed', '已完成的任务不能因为协作者收尾退回别的状态');

    const workerAfter = h.store.getWorker(collaborator.id);
    assert.ok(workerAfter, '协作者必须仍然存在');
    assert.notEqual(workerAfter?.status, 'done', '没干完活的协作者不能被标成 done');
    // 任务完成 → 成员休眠，不是销毁：下次在同一个空间里遇到相似问题还能叫醒它。
    // 取消/失败走的是 closeGroup，那条路仍然是 cancelled。
    assert.equal(workerAfter?.status, 'dormant', `协作者应收敛为 dormant（实际 ${workerAfter?.status}）`);
    assert.match(workerAfter?.lastError ?? '', /任务已完成/, '必须写明终止原因');

    // 迟到响应不应产生业务副作用
    const fs = await import('node:fs');
    assert.equal(
      fs.existsSync(join(h.dir, 'work', task.id, 'late.txt')),
      false,
      '任务终结后，协作者的迟到工具调用不能落地',
    );
    assert.equal(h.runtime.stats().running, 0, '不应有执行槽被占住');
  } finally {
    await h.cleanup();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
