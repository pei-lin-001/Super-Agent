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

const WORKER_SENDABLE: MessageKind[] = ['request', 'reply', 'notice', 'update', 'stop'];

export const collabTools: ToolDefinition[] = [
  {
    name: 'create_worker',
    description:
      '为当前任务创建一个空闲的同层协作者（会继承同一个 groupId）；收到消息后才开始工作。创建不产生上下级关系。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '一句话职责，例如「数据核对」' },
        brief: { type: 'string', description: '成员持续工作的背景，包括工作内容、交付内容、边界以及结果如何支持当前目标' },
        model: {
          type: 'string',
          description: '可选：协作者使用的模型别名，见当前可用模型目录；不填则沿用你自己的模型配置',
        },
      },
      required: ['role', 'brief'],
    },
    run(args, context) {
      const role = argString(args, 'role');
      const brief = argString(args, 'brief');
      const model = argOptionalString(args, 'model');
      const result = context.host.createCollaborator(context.worker, role, brief, model ? { model } : {});
      if (!result.ok) return { type: 'failed', content: `创建协作者失败：${result.reason ?? '未知原因'}` };
      return ok(`已创建协作者 ${result.workerId}｜职责=${role}｜群组=${context.worker.groupId}｜状态 idle；发送消息后开始工作。`);
    },
  },
  {
    name: 'message_send',
    description:
      '给同组 Worker 发消息。kind=request 用于求助/核对/检查；kind=reply 回复某条请求，必须带 reply_to；update/stop 仅任务负责人可用。'
      + '当 intent=review 时表示正式检查：必须给出 refs 里的产物，回复时用 outcome 给出 approved / changes_required / inconclusive 结论。'
      + 'notice 可点对点分享增量信息；reply_to 可选，关联时只能在原请求双方之间发送，不代替正式回复。每条请求只能正式回复一次。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '接收者 workerId' },
        kind: {
          type: 'string',
          enum: ['request', 'reply', 'notice', 'update', 'stop'],
          description: '消息用途',
        },
        body: { type: 'string', description: '消息正文' },
        reply_to: { type: 'string', description: 'reply 必填；notice 可选，关联原请求 id' },
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
          description: '相关产物 id 或任务目录内的文件路径。正式检查时，每个产物 id 都是检查对象，同一回复的 outcome 会分别记到所有对象；仅供参考的文件可用路径',
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
      '挂起等待消息。默认等待非 notice 消息；若只想等待 notice 事件，可在 kinds 指定 notice 而不包含 reply。等待 reply 时关联 notice 可临时唤醒，但不会解除回复等待。已有匹配消息则立即返回。',
    parameters: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: '等待对哪条消息的回复' },
        from: { type: 'string', description: '只接受来自该 workerId 的消息' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: '接受的消息类型，默认非 notice 消息',
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
      '任务负责人提交最终结果。程序校验所提交产物的存在和指纹、未处理的补充要求；仅任务要求正式检查时，所提交产物还须有当前要求和版本下的 approved。',
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
  {
    name: 'wake_worker',
    description:
      '叫醒本工作空间里休眠的成员，让它接手当前任务。' +
      '可按需查回既有记录，判断其是否适用于当前任务；旧任务结论不能直接沿用。' +
      '适合当前工作的已有成员可以复用；独立判断或不同工作可另建成员。',
    parameters: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '要叫醒的成员 id，见工作空间表单里的「可唤醒」' },
        brief: { type: 'string', description: '它这次要做什么：目标、交付内容、边界' },
      },
      required: ['worker_id', 'brief'],
    },
    run(args, context): ToolOutcome {
      const task = context.task;
      if (!task) return { type: 'failed', content: '当前没有可服务的任务' };
      const result = context.host.wakeWorker({
        worker: context.worker,
        workerId: argString(args, 'worker_id'),
        taskId: task.id,
        brief: argString(args, 'brief'),
      });
      if (!result.ok) return { type: 'failed', content: `唤醒失败：${result.reason ?? '未知原因'}` };
      return ok(`已唤醒 ${argString(args, 'worker_id')} 接手 ${task.id}。它会在下一轮调度里收到唤醒通知。`);
    },
  },
  {
    name: 'request_maintenance',
    description:
      '向 Watchdog 提维护申请。目前只有 kind=restart：你改的代码需要主系统重启才能生效时用。' +
      'Watchdog 是独立进程，会核验当前版本、范围、命令与结果位置，按缺口和风险复查并决定做不做。' +
      '调用前必须先 artifact_save 落盘：重启会中断你，成果不能只存在上下文里。' +
      '只给可核对的东西：commit、改了哪些文件、跑过什么命令，不要写"已完成""测试通过"这类结论。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['restart'], description: '申请类型，目前只有 restart' },
        reason: { type: 'string', description: '一句话说明要重启的原因' },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: '可核对的引用：commit 哈希、文件路径、跑过的命令。不要放结论。',
        },
      },
      required: ['kind', 'reason', 'refs'],
    },
    run(args, context): ToolOutcome {
      const kind = argString(args, 'kind');
      if (kind !== 'restart') return { type: 'failed', content: `未知申请类型：${kind}（目前只支持 restart）` };
      const refs = argStringArray(args, 'refs');
      if (refs.length === 0) {
        return {
          type: 'failed',
          content: 'refs 不能为空：维护者要据此核对，至少给出 commit 或改动文件路径',
        };
      }
      const result = context.host.requestMaintenance({
        worker: context.worker,
        kind,
        reason: argString(args, 'reason'),
        refs,
      });
      if (!result.ok) return { type: 'failed', content: `申请失败：${result.reason ?? '未知原因'}` };
      return ok(
        `已提交维护申请 ${result.id}。Watchdog 会自己核对后决定；` +
          '本轮请正常结束，不要反复提交，也不要自行杀进程。',
      );
    },
  },
];
