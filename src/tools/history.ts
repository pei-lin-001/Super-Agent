import type { ToolDefinition } from './types.ts';
import type { WorkerTurn } from '../domain/types.ts';
import { argNumber, argOptionalNumber, argString } from './types.ts';

/** 摘要只给定位信息，完整原文一定通过 history_read / message_read 取。 */
function summarize(turn: WorkerTurn): string {
  const text = (turn.content ?? '').replace(/\s+/g, ' ').trim();
  const tool = Array.isArray(turn.toolCalls) ? turn.toolCalls.map((call) => call.name).join('、') : '';
  const head = tool ? `[调用 ${tool}] ` : '';
  return `${head}${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`;
}

const MAX_READ = 20_000;
const DEFAULT_READ = 8_000;

function slice(text: string, offset: number, limit: number): { body: string; next: number | null } {
  const start = Math.max(0, offset);
  const end = Math.min(text.length, start + limit);
  const body = text.slice(start, end);
  const next = end < text.length ? end : null;
  return { body, next };
}

export const historyTools: ToolDefinition[] = [
  {
    name: 'history_search',
    description:
      '在自己已经退出近期窗口的历史里按关键字检索，返回 turn 序号与摘要。定位到之后必须用 history_read 读原文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键字，可以是文件内容片段、消息 id、产物名或结论中的词' },
        role: { type: 'string', enum: ['user', 'assistant', 'tool'], description: '只看某一类记录' },
        from_seq: { type: 'number', description: '只查这个序号及之后' },
        to_seq: { type: 'number', description: '只查这个序号及之前' },
        limit: { type: 'number', description: '最多返回多少条，默认 8，最多 20' },
      },
      required: ['query'],
    },
    run(args, context) {
      const query = argString(args, 'query');
      const role = typeof args['role'] === 'string' ? args['role'] : null;
      const fromSeq = argOptionalNumber(args, 'from_seq') ?? 0;
      const toSeq = argOptionalNumber(args, 'to_seq') ?? Number.MAX_SAFE_INTEGER;
      const limit = Math.min(20, Math.max(1, argOptionalNumber(args, 'limit') ?? 8));

      const hits = context.host.searchWorkerTurns(context.worker.id, { fromSeq, toSeq, role, limit, query });

      if (hits.length === 0) {
        return { type: 'ok', content: `没有在自己历史里找到「${query}」。可以换关键词，或用 from_seq/to_seq 限定范围。` };
      }
      const lines = hits.map((turn: WorkerTurn) => `turn#${turn.seq}｜${turn.role}｜${summarize(turn)}`);
      return {
        type: 'ok',
        content: [`命中 ${hits.length} 条（摘要仅供定位，原文用 history_read 读）：`, ...lines].join('\n'),
      };
    },
  },
  {
    name: 'history_read',
    description: '按 turn 序号或序号区间读取自己的原始历史，支持分页续读。用来核对被摘要过的细节。',
    parameters: {
      type: 'object',
      properties: {
        from_seq: { type: 'number', description: '起始 turn 序号（含）' },
        to_seq: { type: 'number', description: '结束 turn 序号（含），默认与 from_seq 相同' },
        offset: { type: 'number', description: '从拼好的文本的第几个字符开始，默认 0' },
        limit: { type: 'number', description: '本次最多返回多少字符，默认 8000，最大 20000' },
      },
      required: ['from_seq'],
    },
    run(args, context) {
      const fromSeq = argNumber(args, 'from_seq');
      const toSeq = argOptionalNumber(args, 'to_seq') ?? fromSeq;
      const offset = Math.max(0, argOptionalNumber(args, 'offset') ?? 0);
      const limit = Math.min(MAX_READ, Math.max(1, argOptionalNumber(args, 'limit') ?? DEFAULT_READ));

      const turns = context.host.listWorkerTurnsRange(context.worker.id, fromSeq, Math.max(fromSeq, toSeq));
      if (turns.length === 0) {
        return { type: 'failed', content: `turn#${fromSeq}–${toSeq} 没有记录。可以先用 history_search 定位。` };
      }
      const text = turns
        .map((turn: WorkerTurn) => {
          const tool = Array.isArray(turn.toolCalls)
            ? `｜调用 ${turn.toolCalls.map((call: { name: string }) => call.name).join('、')}`
            : '';
          const calls = Array.isArray(turn.toolCalls) ? `\n工具调用参数：${JSON.stringify(turn.toolCalls)}` : '';
          return `--- turn#${turn.seq}｜${turn.role}${tool} ---\n${turn.content ?? ''}${calls}`;
        })
        .join('\n\n');
      const { body, next } = slice(text, offset, limit);
      const hint = next === null ? '（已读到结尾）' : `（共 ${text.length} 字符，已读到 ${next}；继续请用 offset=${next}）`;
      return { type: 'ok', content: `${body}\n${hint}` };
    },
  },
  {
    name: 'message_read',
    description: '按消息 id 读取收到的或发出的消息全文，支持分页续读。用于查回某次求助、回复或检查意见。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '形如 msg_xxxxxxxx' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0' },
        limit: { type: 'number', description: '本次最多返回多少字符，默认 8000，最大 20000' },
      },
      required: ['message_id'],
    },
    run(args, context) {
      const messageId = argString(args, 'message_id');
      const offset = Math.max(0, argOptionalNumber(args, 'offset') ?? 0);
      const limit = Math.min(MAX_READ, Math.max(1, argOptionalNumber(args, 'limit') ?? DEFAULT_READ));
      const message = context.host.getMessageForWorker(context.worker.id, messageId);
      if (!message) {
        return { type: 'failed', content: `没有找到消息 ${messageId}，或者它不属于你。` };
      }
      const head = [
        `消息 ${message.id}｜kind=${message.kind}｜${message.fromId} → ${message.toId}｜状态 ${message.status}`,
        message.replyTo ? `回复：${message.replyTo}` : '',
        message.payload ? `附加：${JSON.stringify(message.payload)}` : '',
        message.refs ? `引用：${JSON.stringify(message.refs)}` : '',
        '',
      ]
        .filter(Boolean)
        .join('\n');
      const { body, next } = slice(message.body, offset, limit);
      const hint = next === null ? '（已读到结尾）' : `（正文共 ${message.body.length} 字符，已读到 ${next}；继续请用 offset=${next}）`;
      return { type: 'ok', content: `${head}${body}\n${hint}` };
    },
  },
  {
    name: 'note_read',
    description: '读取自己的累计工作记录（整理结果），可以指定历史版本。',
    parameters: {
      type: 'object',
      properties: {
        latest_only: { type: 'boolean', description: '只看最新一条，默认 true' },
        limit: { type: 'number', description: '返回多少条记录，默认 1，最多 5' },
        offset: { type: 'number', description: '正文分页偏移，默认 0' },
        chars: { type: 'number', description: '每次返回多少字符，默认 6000' },
      },
      required: [],
    },
    run(args, context) {
      const latestOnly = args['latest_only'] !== false;
      const limit = Math.min(5, Math.max(1, argOptionalNumber(args, 'limit') ?? (latestOnly ? 1 : 3)));
      const offset = Math.max(0, argOptionalNumber(args, 'offset') ?? 0);
      const chars = Math.min(20_000, Math.max(1, argOptionalNumber(args, 'chars') ?? 6_000));
      const notes = context.host.listWorkerNotes(context.worker.id).slice(0, limit);
      if (notes.length === 0) {
        return { type: 'ok', content: '还没有工作记录。任务历史全部在近期窗口内时不会生成。' };
      }
      const parts = notes.map((note) => {
        const status = note.failed ? `失败（${note.failReason ?? '原因未记录'}）` : '有效';
        const header =
          `=== ${note.id}｜${status}｜新增 turn#${note.fromSeq}–${note.toSeq}｜累计覆盖到 turn#${note.coveredSeq}` +
          `｜要求版本 ${note.epoch}｜${note.sourceTurns} 条 / ${note.sourceChars} 字符 ===`;
        return `${header}\n${note.failed ? '（这条是失败记录，内容为空，不参与后续上下文）' : note.content}`;
      });
      const text = parts.join('\n\n');
      const { body, next } = slice(text, offset, chars);
      const hint = next === null ? '（已读到结尾）' : `（共 ${text.length} 字符，已读到 ${next}；继续请用 offset=${next}）`;
      return { type: 'ok', content: `${body}\n${hint}` };
    },
  },
];
