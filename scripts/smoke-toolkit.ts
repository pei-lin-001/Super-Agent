/**
 * 工具底座端到端验收（场景 A：小型代码维护）。
 * 造一个带失败测试的小项目，让真实模型：跑测试 → 定位 → 改文件 → 复跑 →
 * 拉协作者核对 → 登记真实文件产物 → 对具体版本取得 approved → 提交。
 * 使用独立数据库与工作目录，退出码 0 表示验收脚本自身通过。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { clockStamp } from '../src/domain/ids.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PiModel } from '../src/model/pi.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { judgeTask, isolateRun, report, runBaseline } from './smoke-lib.ts';

const runId = `toolkit-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 6)}`;
const config = isolateRun(loadConfig(), runId);
const store = new Store(config.dbPath);
const model = () =>
  new PiModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    retry: config.limits.modelRetry,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  }, config.modelName);
const runtime = new Runtime({ store, config, workerModel: model() });
const router = new Router(runtime, model(), config);
runtime.attachRouter(router);

const log = (message: string): void => {
  console.log(`[${clockStamp()}] ${message}`);
};

log(`本次运行：${runId}`);
log(`数据库：${config.dbPath}`);

const { task, owner } = runtime.createTask({
  title: '修复折扣计算并交付',
  goal: '定位并修复 calc.py 中的折扣计算错误，用测试证明修复有效，交付修复后的文件与说明。',
  brief:
    '任务目录里有 calc.py 与 test_calc.py。先运行测试看失败信息，定位原因，做最小必要修改，再运行测试确认。' +
    '修复后把 calc.py 与一份说明文件登记为正式产物，请同组协作者检查后交付。',
  doneCriteria:
    'test_calc.py 全部通过（含取整约定与价格校验两组用例）；交付的 calc.py 与说明文件是对应版本的正式产物；' +
    '每份交付产物都有当前要求下的 approved 检查记录。',
  requireReview: true,
  ownerRole: '修复负责人',
  ownerBrief: '运行测试、定位并修复 calc.py、复跑测试、登记产物并交付',
});

const taskDir = join(config.workDir, task.id);
await mkdir(taskDir, { recursive: true });
await writeFile(
  join(taskDir, 'calc.py'),
  [
    'def apply_discount(price, percent):',
    '    """按百分比折扣计算最终价格。',
    '',
    '    约定：',
    '    - price 必须是正数，否则抛 ValueError；',
    '    - 返回值保留两位小数。',
    '    """',
    '    if percent < 0 or percent > 100:',
    '        raise ValueError("percent out of range")',
    '    return price - price * percent / 100',
    '',
    'def total(prices, percent):',
    '    """对一组价格依次应用同一个折扣，返回合计。"""',
    '    result = 0',
    '    for price in prices:',
    '        result += apply_discount(price, percent)',
    '    return round(result, 2)',
    '',
  ].join('\n'),
  'utf8',
);
await writeFile(
  join(taskDir, 'test_calc.py'),
  [
    'import pytest',
    '',
    'from calc import apply_discount, total',
    '',
    'def test_discount():',
    '    assert apply_discount(100, 10) == 90',
    '',
    'def test_total():',
    '    # 两件各 100 元、整体 10% 折扣应得 180',
    '    assert total([100, 100], 10) == 180, total([100, 100], 10)',
    '',
    'def test_discount_rounding():',
    '    # 199.99 打 85 折，按约定保留两位小数',
    '    assert apply_discount(199.99, 15) == 169.99, apply_discount(199.99, 15)',
    '',
    'def test_negative_price_rejected():',
    '    # 约定：价格必须为正数',
    '    with pytest.raises(ValueError):',
    '        apply_discount(-10, 10)',
    '',
  ].join('\n'),
  'utf8',
);

const EXPECTED_FAILED = ['test_calc.py::test_discount_rounding', 'test_calc.py::test_negative_price_rejected'];
const EXPECTED_PASSED = ['test_calc.py::test_discount', 'test_calc.py::test_total'];

const baseline = runBaseline(taskDir);
if (!baseline.ok) {
  console.error(`验收环境错误：${baseline.reason}`);
  console.error(baseline.summary);
  await runtime.stop();
  store.close();
  process.exit(2);
}
log(`初始测试摘要：${baseline.summary}`);
log(`初始失败用例：${baseline.failed.join('、') || '（无）'}`);
log(`初始通过用例：${baseline.passed.join('、') || '（无）'}`);

const missingFailures = EXPECTED_FAILED.filter((name) => !baseline.failed.includes(name));
if (missingFailures.length > 0 || baseline.failed.length !== EXPECTED_FAILED.length) {
  console.error(`初始实现没有按预期失败：缺少 ${missingFailures.join('、') || '（数量不符）'}`);
  console.error('这个验收场景依赖"两个约定被违反"，请先确认 fixture 未被改动。');
  await runtime.stop();
  store.close();
  process.exit(1);
}
const unexpectedFailures = baseline.failed.filter((name) => !EXPECTED_FAILED.includes(name));
if (unexpectedFailures.length > 0) {
  console.error(`出现了预期之外的失败用例：${unexpectedFailures.join('、')}`);
  await runtime.stop();
  store.close();
  process.exit(1);
}
const missingPassed = EXPECTED_PASSED.filter((name) => !baseline.passed.includes(name));
if (missingPassed.length > 0) {
  console.error(`原本应当通过的用例没有通过：${missingPassed.join('、')}`);
  await runtime.stop();
  store.close();
  process.exit(1);
}

log(`任务 ${task.id}｜负责人 ${owner.id}`);
runtime.enqueue(owner.id);

const deadline = Date.now() + Number(process.env['SMOKE_TIMEOUT_MS'] ?? 1_200_000);
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const current = store.getTask(task.id);
  if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) break;
}

await runtime.waitForIdle(60_000);
const verdict = judgeTask(store, config, task.id);
for (const worker of store.listWorkers()) {
  verdict.lines.push(`Worker ${worker.id}｜${worker.status}｜${worker.stepCount} 步｜${worker.lastError ?? '-'}`);
}
for (const job of store.listJobs(task.id)) {
  verdict.lines.push(`作业 ${job.id}｜${job.status}｜退出码 ${job.exitCode ?? '-'}`);
}
await runtime.stop();
store.close();
void mkdtemp;
report(verdict);
