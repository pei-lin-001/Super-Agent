/**
 * 基线检查：只有"pytest 正常跑完且按预期失败"才算缺陷复现。
 * 环境问题必须被识别出来，不能混成"初始实现有问题"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBaseline } from '../../scripts/smoke-lib.ts';

const CALC = [
  'def apply_discount(price, percent):',
  '    if percent < 0 or percent > 100:',
  '        raise ValueError("percent out of range")',
  '    return price - price * percent / 100',
  '',
].join('\n');

const TESTS = [
  'import pytest',
  '',
  'from calc import apply_discount',
  '',
  'def test_discount():',
  '    assert apply_discount(100, 10) == 90',
  '',
  'def test_discount_rounding():',
  '    assert apply_discount(199.99, 15) == 169.99, apply_discount(199.99, 15)',
  '',
  'def test_negative_price_rejected():',
  '    with pytest.raises(ValueError):',
  '        apply_discount(-10, 10)',
  '',
].join('\n');

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-base-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}

test('基线检查：真实缺陷能被识别为"按预期失败"', () => {
  const dir = fixture({ 'calc.py': CALC, 'test_calc.py': TESTS });
  try {
    const report = runBaseline(dir);
    assert.equal(report.ok, true, `应为有效基线：${report.reason}`);
    assert.deepEqual(
      report.failed.sort(),
      ['test_calc.py::test_discount_rounding', 'test_calc.py::test_negative_price_rejected'],
      '失败用例必须精确匹配',
    );
    assert.deepEqual(report.passed, ['test_calc.py::test_discount'], '其余用例应处于通过状态');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('基线检查：测试收集失败属于环境错误，不是缺陷', () => {
  const dir = fixture({
    'calc.py': CALC,
    'test_calc.py': 'import nonexistent_module_xyz\n\ndef test_x():\n    pass\n',
  });
  try {
    const report = runBaseline(dir);
    assert.equal(report.ok, false, '收集失败不能当成缺陷复现');
    assert.match(report.reason, /环境|收集|异常退出/, `原因要说明是环境问题：${report.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('基线检查：没有可收集的用例也算环境错误', () => {
  const dir = fixture({ 'calc.py': CALC, 'empty.py': 'X = 1\n' });
  try {
    const report = runBaseline(dir);
    assert.equal(report.ok, false);
    assert.match(report.reason, /没有收集到|环境|异常退出/, report.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('基线检查：初始实现已经全过时，报告不成立', () => {
  const dir = fixture({
    'calc.py': [
      'def apply_discount(price, percent):',
      '    if percent < 0 or percent > 100:',
      '        raise ValueError("percent out of range")',
      '    return round(price - price * percent / 100, 2)',
      '',
    ].join('\n'),
    'test_calc.py': 'from calc import apply_discount\n\ndef test_discount():\n    assert apply_discount(100, 10) == 90\n',
  });
  try {
    const report = runBaseline(dir);
    assert.equal(report.ok, true, '跑通本身是成功的');
    assert.deepEqual(report.failed, [], '没有失败用例，脚本必须据此判定场景不成立');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
