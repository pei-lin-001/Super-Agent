/**
 * 真实双模型协作验收。
 *
 * 条件（这条验收任务的条件，不是所有任务的默认流程）：
 * - 默认模型负责主要执行；
 * - 另一种模型（strong）提供一次有实质内容的方案建议或正式检查；
 * - 最终交付真实文件，满足任务规定的完成条件。
 *
 * 调查方法与协作顺序交给模型决定，脚本只检查证据。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { clockStamp } from '../src/domain/ids.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PiModel } from '../src/model/pi.ts';
import { ModelRegistry } from '../src/model/registry.ts';
import { Router } from '../src/runtime/router.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Store } from '../src/storage/store.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const runId = `multimodel-${Date.now().toString(36)}`;
const base = await mkdtemp(join(tmpdir(), 'sa-multimodel-'));
const config = {
  ...loadConfig(),
  dbPath: join(base, 'db.sqlite'),
  workDir: join(base, 'work'),
  materialsDir: join(base, 'work', 'materials'),
};
await mkdir(config.workDir, { recursive: true });

const log = (message: string): void => console.log(`[${clockStamp()}] ${message}`);
const failures: string[] = [];
const check = (ok: boolean, message: string): void => {
  log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

log(`本次运行：${runId}`);
log(`数据库：${config.dbPath}`);
log(`模型目录：${config.models.map((m) => `${m.alias}=${m.model}`).join('，')}`);

const aliases = config.models.map((m) => m.alias);
if (!aliases.includes('default') || !aliases.includes('strong')) {
  console.error(`需要 default 与 strong 两个模型配置，当前只有：${aliases.join(', ')}`);
  process.exit(2);
}

const clients = new Map<string, ReturnType<typeof makeClient>>();
function makeClient(profile: (typeof config.models)[number]) {
  return new PiModel({
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    timeoutMs: config.timeoutMs,
    retry: 1,
    reasoningEffort: 'low',
    maxTokens: config.maxTokens,
    label: `accept:${profile.alias}`,
  }, profile.model);
}
for (const profile of config.models) clients.set(profile.alias, makeClient(profile));

const store = new Store(config.dbPath, { instanceId: `accept_${runId}` });
const registry = new ModelRegistry(config.models, clients);
const runtime = new Runtime({ store, config, workerModel: clients.get('default')!, models: registry });
const router = new Router(runtime, clients.get('default')!, config);
runtime.attachRouter(router);

const { task, owner } = runtime.createTask({
  title: '修复折扣计算的边界缺陷（双模型协作）',
  goal: '修复 calc.py 中违反约定的两处缺陷，让 test_calc.py 全部通过，并交付修复后的文件和说明。',
  brief:
    '任务目录里有 calc.py 与 test_calc.py。先运行测试看失败信息，定位原因，做最小必要修改。' +
    '这份任务明确要求：主要执行由你（默认模型）完成；需要方案建议或独立判断时，' +
    '用 create_worker 的 model 参数拉一个 strong 模型的同层协作者，把目标、材料位置、已知事实和待解决问题写清楚。' +
    'strong 协作者给出的建议要结合实际材料和工具结果判断，不自动等于通过。',
  doneCriteria:
    'test_calc.py 全部通过（含取整约定与价格校验）；交付 calc.py 与一份说明文件，都是对应版本的正式产物；' +
    '交付前至少有一次来自 strong 模型的实质协作信息（建议或检查结论）。',
  requireReview: false,
  ownerRole: '修复负责人',
  ownerBrief: '运行测试、定位修复、拉 strong 协作者讨论关键判断、登记产物并提交',
  model: 'default',
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
    '    assert total([100, 100], 10) == 180, total([100, 100], 10)',
    '',
    'def test_discount_rounding():',
    '    assert apply_discount(199.99, 15) == 169.99, apply_discount(199.99, 15)',
    '',
    'def test_negative_price_rejected():',
    '    with pytest.raises(ValueError):',
    '        apply_discount(-10, 10)',
    '',
  ].join('\n'),
  'utf8',
);

const probe = spawnSync('python3', ['-m', 'pytest', '-q', '--no-header'], { cwd: taskDir, encoding: 'utf8' });
const probeOut = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
check(probe.status === 1, `初始测试确实失败（退出码 ${probe.status}）`);
check((probeOut.match(/\d+ failed/) ?? [''])[0].length > 0, `失败摘要可读：${(probeOut.match(/\d+ failed, \d+ passed[^\n]*/) ?? [''])[0]}`);

log(`任务 ${task.id}｜负责人 ${owner.id}｜模型 ${store.getWorker(owner.id)?.model}`);
const deadline = Date.now() + Number(process.env['ACCEPT_TIMEOUT_MS'] ?? 1_800_000);
runtime.enqueue(owner.id);
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const current = store.getTask(task.id);
  if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) break;
}
await runtime.waitForIdle(60_000);

const finalTask = store.getTask(task.id);
check(finalTask?.status === 'completed', `任务完成（实际 ${finalTask?.status}）`);

// ---- 证据 1：两种模型是否真的分别收到请求 ----
const calls = store.listModelCalls(4000).filter((row) => row.taskId === task.id);
const byAlias = new Map<string, number>();
for (const call of calls) {
  const key = call.modelAlias ?? '(无别名)';
  byAlias.set(key, (byAlias.get(key) ?? 0) + 1);
}
log(`调用分布：${[...byAlias.entries()].map(([alias, count]) => `${alias}×${count}`).join('，')}`);
check((byAlias.get('default') ?? 0) > 0, '默认模型确实收到请求');
check((byAlias.get('strong') ?? 0) > 0, 'strong 模型确实收到请求');

const strongModels = calls.filter((row) => row.modelAlias === 'strong').map((row) => row.model);
check(
  strongModels.every((model) => model === 'glm-5.3-flash'),
  `strong 请求发往 glm-5.3-flash（实际 ${[...new Set(strongModels)].join(', ')}）`,
);

// ---- 证据 2：协作消息是否承载实际问题与有效回复 ----
const messages = store.listGroupMessages(task.groupId, 500);
const requests = messages.filter((m) => m.fromId === owner.id && m.toKind === 'worker' && m.kind === 'request');
const replies = messages.filter((m) => m.toKind === 'worker' && m.kind === 'reply');
const strongWorker = store.listGroupWorkers(task.groupId).find((w) => w.model === 'strong');
check(strongWorker !== undefined, `strong 协作者被创建（${strongWorker?.id ?? '无'}）`);
if (strongWorker) {
  const toStrong = requests.filter((m) => m.toId === strongWorker.id);
  check(toStrong.length > 0, `负责人向 strong 协作者发出了 ${toStrong.length} 条协作请求`);
  const strongReplies = replies.filter((m) => m.fromId === strongWorker.id);
  check(strongReplies.length > 0, `strong 协作者回复了 ${strongReplies.length} 条`);
  const substance = strongReplies.map((m) => m.body).join('\n');
  check(substance.length >= 80, `回复有实质内容（${substance.length} 字）`);
  if (substance.length > 0) log(`strong 回复摘要：${substance.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ---- 证据 3：最终文件是否正确 ----
const artifacts = store.listArtifacts(task.id);
const calcArtifact = artifacts.filter((a) => a.name === 'calc.py').at(-1);
check(calcArtifact !== undefined, 'calc.py 被登记为产物');
if (calcArtifact) {
  const absolute = join(config.workDir, calcArtifact.path);
  check(existsSync(absolute), `产物文件存在：${calcArtifact.path}`);
  if (existsSync(absolute)) {
    const bytes = await readFile(absolute);
    const digest = createHash('sha256').update(bytes).digest('hex');
    check(digest === calcArtifact.sha256, `文件指纹与登记一致（${digest.slice(0, 16)}）`);
    // 独立复跑测试：把交付的 calc.py 放进干净目录，配原始测试跑一遍
    const verifyDir = join(base, 'verify');
    await mkdir(verifyDir, { recursive: true });
    await writeFile(join(verifyDir, 'calc.py'), bytes);
    await writeFile(join(verifyDir, 'test_calc.py'), await readFile(join(taskDir, 'test_calc.py')));
    const verify = spawnSync('python3', ['-m', 'pytest', '-q', '--no-header'], { cwd: verifyDir, encoding: 'utf8' });
    const verifyOut = `${verify.stdout ?? ''}${verify.stderr ?? ''}`;
    check(verify.status === 0, `交付文件独立复跑通过（退出码 ${verify.status}）：${(verifyOut.match(/\d+ passed[^\n]*/) ?? [''])[0]}`);
  }
}

// ---- 证据 4：最终提交 ----
const result = messages.filter((m) => m.kind === 'result' && m.toKind === 'router').at(-1);
check(result !== undefined, '存在最终提交结果');

await runtime.stop();
store.close();
log(`工作目录：${base}`);

if (failures.length > 0) {
  console.log(`\n验收失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('\n验收通过');
