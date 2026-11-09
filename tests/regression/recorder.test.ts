/**
 * 记账层自身的失败处理。
 *
 * 记账是为了事后能查，所以它自己出错时：业务不受影响，但必须留下可见诊断，
 * 不能静默漏记——否则调用次数会永久对不上，且没有任何线索。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordingModel } from '../../src/model/recorder.ts';
import { MockModel } from '../../src/model/mock.ts';
import type { Store } from '../../src/storage/store.ts';

function reply(): { text: string; reasoning: null; toolCalls: never[]; finishReason: 'stop'; model: string; usage: null } {
  return { text: '业务结果', reasoning: null, toolCalls: [], finishReason: 'stop', model: 'm', usage: null };
}

/** 只实现记账层实际用到的方法，其余按需抛错，确保没有隐式依赖。 */
function brokenStore(where: 'start' | 'finish'): Store {
  const stub = {
    isClosed: false,
    startModelCall: () => {
      if (where === 'start') throw new Error('磁盘已满');
    },
    finishModelCall: () => {
      if (where === 'finish') throw new Error('写入被锁');
    },
  };
  return stub as unknown as Store;
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(' '));
  };
  return { lines, restore: () => (console.warn = original) };
}

test('开始记账失败：业务照常返回，但必须打印诊断', async () => {
  const warnings = captureWarnings();
  try {
    const recorder = new RecordingModel(new MockModel(() => reply()), brokenStore('start'), 'worker');
    const result = await recorder.chat({ model: 'm', messages: [], tools: [] });
    assert.equal(result.text, '业务结果', '记账失败不能影响业务结果');
    assert.equal(warnings.lines.length, 1, `必须留下一条诊断（实际 ${warnings.lines.length} 条）`);
    assert.match(warnings.lines[0]!, /\[记账\]/, '诊断要带统一前缀，便于检索');
    assert.match(warnings.lines[0]!, /磁盘已满/, '诊断要说明真实原因，不能只写"记账失败"');
    assert.match(warnings.lines[0]!, /不会被统计/, '要说明后果：这次调用没有进统计');
  } finally {
    warnings.restore();
  }
});

test('结束记账失败：业务结果仍然返回，诊断可见', async () => {
  const warnings = captureWarnings();
  try {
    const recorder = new RecordingModel(new MockModel(() => reply()), brokenStore('finish'), 'worker');
    const result = await recorder.chat({ model: 'm', messages: [], tools: [] });
    assert.equal(result.text, '业务结果');
    assert.equal(warnings.lines.length, 1, '结束记账失败也要有诊断');
    assert.match(warnings.lines[0]!, /写入被锁/);
  } finally {
    warnings.restore();
  }
});

test('存储已关闭：拒绝发起新调用，且不写任何记录', async () => {
  const warnings = captureWarnings();
  try {
    let started = 0;
    const stub = {
      isClosed: true,
      startModelCall: () => {
        started += 1;
      },
      finishModelCall: () => undefined,
    } as unknown as Store;
    const recorder = new RecordingModel(new MockModel(() => reply()), stub, 'worker');
    await assert.rejects(() => recorder.chat({ model: 'm', messages: [], tools: [] }), /存储已关闭/);
    assert.equal(started, 0, '关闭之后不能再开新的记账');
  } finally {
    warnings.restore();
  }
});
