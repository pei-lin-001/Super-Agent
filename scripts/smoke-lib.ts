import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import type { Store } from '../src/storage/store.ts';

export interface SmokeVerdict {
  ok: boolean;
  /** 0 通过；1 任务未完成或产物不合格；2 超时；3 环境问题。 */
  code: number;
  lines: string[];
}

/** 每次冒烟使用独立的数据库与工作目录，避免把上次的产物当成本次结果。 */
export function isolateRun(config: Config, runId: string): Config {
  return {
    ...config,
    dbPath: join('.data', `${runId}.db`),
    workDir: join('work', runId),
    materialsDir: join('work', runId, 'materials'),
  };
}

/**
 * 只认本次任务的真实结果：
 * 任务必须 completed，产物文件必须存在且指纹一致，要求检查时每份产物都要有本版本的 approved。
 */
export function judgeTask(store: Store, config: Config, taskId: string): SmokeVerdict {
  const lines: string[] = [];
  const task = store.getTask(taskId);
  if (!task) return { ok: false, code: 1, lines: [`任务不存在：${taskId}`] };
  lines.push(`任务状态：${task.status}`);
  if (task.closeReason) lines.push(`结项说明：${task.closeReason.slice(0, 300)}`);
  if (task.status !== 'completed') {
    return { ok: false, code: 1, lines: [...lines, '任务未完成，不判定为通过'] };
  }

  // 只校验「本次交付实际引用的版本」，而不是历史上保存过的每个中间版本。
  const resultMessage = store
    .listGroupMessages(task.groupId, 500)
    .filter((message) => message.kind === 'result' && message.toKind === 'router')
    .at(-1);
  const deliveredRefs = resultMessage?.refs?.artifacts ?? [];
  if (deliveredRefs.length === 0) {
    return { ok: false, code: 1, lines: [...lines, '没有找到引用产物的交付消息'] };
  }
  const allArtifacts = store.listArtifacts(taskId);
  const artifacts = deliveredRefs
    .map((ref) => allArtifacts.find((item) => item.id === ref.artifactId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (artifacts.length !== deliveredRefs.length) {
    return { ok: false, code: 1, lines: [...lines, '交付引用的产物在登记表中缺失'] };
  }
  lines.push(`交付引用：${artifacts.map((artifact) => `${artifact.name} v${artifact.version}`).join('、')}`);

  for (const artifact of artifacts) {
    const absolute = join(config.workDir, artifact.path);
    if (!existsSync(absolute)) {
      return { ok: false, code: 1, lines: [...lines, `产物文件缺失：${artifact.path}`] };
    }
    const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (digest !== artifact.sha256) {
      return { ok: false, code: 1, lines: [...lines, `产物内容与登记不一致：${artifact.name} v${artifact.version}`] };
    }
    lines.push(`产物：${artifact.name} v${artifact.version}（${artifact.bytes} 字节，指纹一致）`);
  }

  if (task.requireReview) {
    const reviews = store.listReviews(taskId);
    for (const artifact of artifacts) {
      const approved = reviews.some(
        (review) =>
          review.artifactId === artifact.id &&
          review.artifactSha256 === artifact.sha256 &&
          review.epoch === task.reviewEpoch &&
          review.outcome === 'approved',
      );
      if (!approved) {
        return {
          ok: false,
          code: 1,
          lines: [...lines, `产物没有本版本的有效检查通过结论：${artifact.name} v${artifact.version}`],
        };
      }
    }
    lines.push(`检查：${reviews.length} 条记录，当前要求版本 ${task.reviewEpoch} 下全部通过`);
  }

  return { ok: true, code: 0, lines };
}

export function report(verdict: SmokeVerdict): never {
  for (const line of verdict.lines) console.log(line);
  console.log(verdict.ok ? '结论：通过' : '结论：未通过');
  process.exit(verdict.code);
}

/**
 * 基线检查：区分「预期的代码缺陷」和「验收环境问题」。
 *
 * 只有 pytest 正常跑完、并按预期失败的那几个用例，才算基线成立；
 * 缺 pytest、导入失败、收集失败、被信号终止都属于环境错误，不能当成"缺陷已复现"。
 */
export interface BaselineReport {
  ok: boolean;
  reason: string;
  failed: string[];
  passed: string[];
  summary: string;
}

export function runBaseline(cwd: string): BaselineReport {
  const probe = spawnSync('python3', ['-c', 'import pytest; print(pytest.__version__)'], { cwd, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `缺少可用的 pytest（退出码 ${probe.status}，错误 ${probe.error?.message ?? '无'}）：${(probe.stderr ?? '').trim().slice(0, 300)}`,
      failed: [],
      passed: [],
      summary: '',
    };
  }
  const run = spawnSync('python3', ['-m', 'pytest', '-q', '--no-header', '-rA'], { cwd, encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.error) {
    return { ok: false, reason: `pytest 无法启动：${run.error.message}`, failed: [], passed: [], summary: '' };
  }
  if (run.signal) {
    return { ok: false, reason: `pytest 被信号 ${run.signal} 终止`, failed: [], passed: [], summary: out.slice(-500) };
  }
  // 退出码语义：0 全过；1 有用例失败；2 被中断或收集中断；3 内部错误；4 用法错误；5 没有收集到用例
  if (run.status === 5) {
    return { ok: false, reason: 'pytest 没有收集到任何用例（收集失败或路径错误）', failed: [], passed: [], summary: out.slice(-500) };
  }
  if (run.status !== 0 && run.status !== 1) {
    return {
      ok: false,
      reason: `pytest 异常退出（退出码 ${run.status}），属于验收环境或收集错误，不是代码缺陷`,
      failed: [],
      passed: [],
      summary: out.slice(-500),
    };
  }
  const failed = [...out.matchAll(/^FAILED (\S+)/gm)].map((match) => match[1]!);
  const passed = [...out.matchAll(/^PASSED (\S+)/gm)].map((match) => match[1]!);
  const summary = (out.match(/\d+ (?:failed|passed)[^\n]*/) ?? [''])[0]!;
  return { ok: true, reason: '', failed, passed, summary };
}
