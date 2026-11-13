import { beijingTime } from '../domain/ids.ts';
import type { TaskUsageBucket, TaskUsageReport } from '../storage/store.ts';

const PURPOSE_LABELS: Record<string, string> = {
  worker: 'Worker',
  note: 'Worker 工作记录整理',
  router: 'Router',
  'router-note': 'Router 历史整理',
  watchdog: 'Watchdog',
  context: '上下文处理',
};

function renderBucket(bucket: TaskUsageBucket): string {
  const label = PURPOSE_LABELS[bucket.purpose] ?? bucket.purpose;
  const usage =
    bucket.usageKnownCalls === 0
      ? 'token 未知'
      : `token 已知 ${bucket.usageKnownCalls} 次（其中明确为 0：${bucket.explicitZeroCalls} 次）｜` +
        `非缓存输入 ${bucket.promptTokens}｜缓存读取 ${bucket.cachedTokens}｜缓存写入 ${bucket.cacheWriteTokens}｜` +
        `输出 ${bucket.completionTokens}｜合计 ${bucket.totalTokens}`;
  return (
    `- ${label}：${bucket.calls} 次（ok ${bucket.ok}｜failed/cancelled/interrupted ${bucket.failed}｜running ${bucket.running}）｜` +
    `${usage}｜usage 未知 ${bucket.usageUnknownCalls} 次`
  );
}

function renderGroup(title: string, buckets: TaskUsageBucket[]): string[] {
  if (buckets.length === 0) return [`${title}：无调用`];
  return [`${title}：`, ...buckets.map(renderBucket)];
}

/**
 * CLI 用量视图。
 *
 * task_id 直接归属、会话级 Router 调用和全局 Watchdog 调用必须分栏；
 * 后两类与任务时间重叠，不能据此说是该任务自己消耗的 token。
 */
export function formatTaskUsage(report: TaskUsageReport): string {
  return [
    `任务 ${report.taskId}｜${report.taskTitle}`,
    `Router/Watchdog 同期窗口：${beijingTime(report.from)} 至 ${beijingTime(report.to)}（任务记录存续窗口，排除建任务前与交付后调用）`,
    ...renderGroup('任务直接归属调用（model_call.task_id；不受上述时间窗截断）', report.direct),
    '',
    ...renderGroup('同期 Router（会话/话题时间窗，非 task_id 直接归属）', report.routerContext),
    '',
    ...renderGroup('同期 Watchdog（全局调用，不属于该任务）', report.watchdogContext),
    '',
    '说明：token 仅汇总提供方明确回报的 usage；未知项不按 0 计，也不根据配置价格推算金额。',
  ].join('\n');
}
