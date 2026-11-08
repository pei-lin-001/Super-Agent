import type { MessageKind } from '../domain/types.ts';
import {
  argOptionalString,
  argString,
  argStringArray,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

const WORKER_SENDABLE: MessageKind[] = ['request', 'reply', 'update', 'stop'];

export const collabTools: ToolDefinition[] = [
  {
    name: 'create_worker',
    description:
      '为当前任务创建一个同层协作者（会继承同一个 groupId）。用于求助、核对、检查等。创建不产生上下级关系。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '一句话职责，例如「数据核对」' },
        brief: { type: 'string', description: '具体工作说明：要做什么、交付什么、边界在哪' },
      },
      required: ['role', 'brief'],
    },
    run(args, context) {
      const role = argString(args, 'role');
      const brief = argString(args, 'brief');
      const result = context.host.createCollaborator(context.worker, role, brief);
      if (!result.ok) return { type: 'failed', content: `创建协作者失败：${result.reason ?? '未知原因'}` };
      return ok(`已创建协作者 ${result.workerId}｜职责=${role}｜群组=${context.worker.groupId}`);
    },
  },
  {
    name: 'message_send',
    description:
      '给同组 Worker 发消息。kind=request 用于求助/核对/检查；kind=reply 回复某条请求，必须带 reply_to；update/stop 仅任务负责人可用。'
      + '当 intent=review 时表示正式检查：必须给出 refs 里的产物，回复时用 outcome 给出 approved / changes_required / inconclusive 结论。'
      + '普通求助用 intent=help，不会产生检查记录。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收者 workerId' },
        kind: {
          type: 'string',
          enum: ['request', 'reply', 'update', 'stop'],
          description: '消息用途',
        },
        body: { type: 'string', description: '消息正文' },
        reply_to: { type: 'string', description: 'reply 时必填：被回复的消息 id' },
        intent: {
          type: 'string',
          enum: ['help', 'review'],
          description: 'request 的用途：help 普通求助；review 正式检查（回复必须给 outcome）',
        },
        outcome: {
          type: 'string',
          enum: ['approved', 'changes_required', 'inconclusive'],
          description: '回复正式检查时的结论，只在 reply 上使用',
        },
        dedupe_key: {
          type: 'string',
          description: '可选去重键。同组内重复发送相同键只会保留一条消息，用于安全重试。',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: '相关产物 id 或任务目录内的文件路径',
        },
      },
      required: ['to', 'kind', 'body'],
    },
    run(args, context) {
      const to = argString(args, 'to');
      const kind = argString(args, 'kind') as MessageKind;
      const body = argString(args, 'body');
      const replyTo = argOptionalString(args, 'reply_to');
      const intent = argOptionalString(args, 'intent');
      const outcome = argOptionalString(args, 'outcome') as 'approved' | 'changes_required' | 'inconclusive' | null;
      const refs = argStringArray(args, 'refs');
      const dedupeKey = argOptionalString(args, 'dedupe_key');
      if (!WORKER_SENDABLE.includes(kind)) {
        return { type: 'failed', content: `Worker 不能发送 kind=${kind} 的消息` };
      }
      const result = context.host.sendMessage({
        from: context.worker,
        to,
        kind,
        body,
        replyTo,
        refs: refs.length > 0 ? { files: refs } : null,
        intent,
        outcome,
        dedupeKey,
      });
      if (!result.ok) return { type: 'failed', content: `发送失败：${result.reason ?? '未知原因'}` };
      const ids = result.messageIds ?? (result.messageId ? [result.messageId] : []);
      return ok(`已投递消息 ${ids.join(', ')}（${context.worker.id} → ${to}，kind=${kind}，接收者 ${ids.length} 个）`);
    },
  },
  {
    name: 'wait_for',
    description:
      '挂起等待指定回复。等待期间不消耗模型调用。若收件箱已有匹配消息则立即返回。',
    parameters: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: '等待对哪条消息的回复' },
        from: { type: 'string', description: '只接受来自该 workerId 的消息' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: '接受的消息类型，默认任意',
        },
        timeout_seconds: { type: 'number', description: '超时秒数，默认取系统配置' },
      },
      required: [],
    },
    run(args, context): ToolOutcome {
      const replyTo = argOptionalString(args, 'reply_to');
      const from = argOptionalString(args, 'from');
      const rawKinds = args['kinds'];
      let kinds: MessageKind[] | null = null;
      if (Array.isArray(rawKinds) && rawKinds.length > 0) {
        kinds = rawKinds.filter((item): item is string => typeof item === 'string') as MessageKind[];
      }
      const rawTimeout = args['timeout_seconds'];
      const timeoutMs =
        typeof rawTimeout === 'number' && rawTimeout > 0
          ? Math.min(rawTimeout * 1000, 3_600_000)
          : context.host.defaultWaitTimeoutMs;

      const result = context.host.registerWait(context.worker, { replyTo, from, kinds, timeoutMs });
      if (result.reason) return { type: 'failed', content: `无法进入等待：${result.reason}` };
      if (result.immediate) {
        return ok('收件箱已有匹配消息，无需等待，请继续处理。');
      }
      return {
        type: 'wait',
        content: `已挂起等待（wait=${result.waitId}）。收到匹配消息或超时后会被唤醒。`,
        wait: { replyTo, from, kinds, timeoutMs },
      };
    },
  },
  {
    name: 'submit_result',
    description:
      '任务负责人提交最终结果。程序会校验产物是否存在、检查是否覆盖最新版本、是否存在未处理的补充要求；校验不通过会退回并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '给 Router 与用户的结论摘要' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '产物文件名（如 report.md），必须是已 artifact_save 的文件',
        },
      },
      required: ['summary', 'artifacts'],
    },
    async run(args, context): Promise<ToolOutcome> {
      const summary = argString(args, 'summary');
      const artifacts = argStringArray(args, 'artifacts');
      const result = await context.host.submitResult(context.worker, summary, artifacts);
      if (!result.ok) return { type: 'failed', content: `提交被拒绝：${result.reason ?? '未知原因'}` };
      return { type: 'finish', content: `结果已受理：${result.artifactIds?.join(', ') ?? ''}` };
    },
  },
  {
    name: 'report_to_router',
    description: '向 Router 汇报进展、报告失败或提出问题。只在阶段变化或需要用户决策时使用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['progress', 'fail', 'question'], description: '汇报类型' },
        body: { type: 'string', description: '内容' },
        refs: { type: 'array', items: { type: 'string' }, description: '相关产物 id 或文件路径' },
      },
      required: ['kind', 'body'],
    },
    run(args, context): ToolOutcome {
      const kind = argString(args, 'kind') as 'progress' | 'fail' | 'question';
      const body = argString(args, 'body');
      const refs = argStringArray(args, 'refs');
      if (!['progress', 'fail', 'question'].includes(kind)) {
        return { type: 'failed', content: `未知汇报类型：${kind}` };
      }
      const result = context.host.report(context.worker, kind, body, refs.length > 0 ? { files: refs } : undefined);
      if (!result.ok) return { type: 'failed', content: `汇报失败：${result.reason ?? '未知原因'}` };
      return ok(`已向 Router 发送 ${kind}（${result.messageId}）`);
    },
  },
];
