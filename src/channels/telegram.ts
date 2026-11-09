/**
 * Telegram Bot API 适配器：长轮询收、sendMessage / sendDocument 发。
 *
 * 只做平台收发。授权、会话、去重和落库都在上层，这里不判断业务。
 * 协议依据：https://core.telegram.org/bots/api （getUpdates 与 webhook 互斥，
 * 本轮只用长轮询，不开放公网回调）。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  ChannelAdapter,
  OutboundSegment,
  OutboundTarget,
  PlatformEvent,
  PollResult,
  SendOutcome,
  SourceRef,
} from './types.ts';
import { ChannelAuthError } from './types.ts';
import { writeInboundAttachment, type StoredAttachment } from './storage.ts';
import { toPlainText, toTelegramHtml } from './render.ts';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; file_size?: number };
  video?: { file_id: string; file_size?: number };
  audio?: { file_id: string; file_size?: number };
  sticker?: { file_id: string };
  message_thread_id?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramAdapterOptions {
  /** Bot token；只来自私密配置，不写日志。 */
  token: string;
  /** 授权主人稳定 user id。 */
  ownerIds: string[];
  apiBase: string;
  workDir: string;
  pollTimeoutMs: number;
  maxInboundBytes: number;
  fetchImpl?: typeof fetch;
}

/** 把 fetch 层错误分成"肯定没发出去"和"可能已经到了"。 */
function classifyFailure(error: unknown): SendOutcome {
  const name = (error as Error)?.name ?? '';
  const code = ((error as { cause?: { code?: string } })?.cause?.code ?? '') as string;
  if (name === 'AbortError' || name === 'TimeoutError' || /UND_ERR_(CONNECT_)?TIMEOUT/.test(code)) {
    // 超时可能已经到达平台：记录成"结果未知"，不能当没发生。
    return { status: 'unknown', error: `请求超时，无法确认是否已到达平台：${code || name}` };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET/.test(code)) {
    return { status: 'failed', error: `网络不可达（${code}）`, retryable: true };
  }
  return {
    status: 'failed',
    error: `发送失败：${(error as Error)?.message ?? String(error)}`,
    retryable: true,
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const;
  readonly accountId: string;
  readonly capabilities = { typing: true, edit: true, draft: true };

  private readonly options: TelegramAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private botUserId: string | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // 账号标识用 token 的稳定片段，避免每次启动都变；不使用完整 token。
    this.accountId = `bot_${options.token.split(':')[0] ?? 'unknown'}`;
  }

  ownerIds(): string[] {
    return this.options.ownerIds;
  }

  private url(method: string): string {
    return `${this.options.apiBase.replace(/\/+$/, '')}/bot${this.options.token}/${method}`;
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(this.url(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const raw = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } }
      | null;
    if (!raw) {
      throw new Error(`${method} 返回了无法解析的内容（HTTP ${response.status}）`);
    }
    if (raw.ok !== true) {
      const description = raw.description ?? `HTTP ${response.status}`;
      // 401/403/404 属于凭据或 bot 身份问题：继续重试没有意义。
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new ChannelAuthError('telegram', `${method} 被拒绝：${description}`);
      }
      const error = new Error(`${method} 失败：${description}`) as Error & { retryAfterMs?: number };
      if (raw.parameters?.retry_after) error.retryAfterMs = raw.parameters.retry_after * 1000;
      throw error;
    }
    return raw.result as T;
  }

  async poll(input: { cursor: string | null; signal: AbortSignal }): Promise<PollResult> {
    const offset = input.cursor === null ? undefined : Number(input.cursor);
    let updates: TelegramUpdate[];
    try {
      updates = await this.call<TelegramUpdate[]>(
        'getUpdates',
        {
          ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}),
          timeout: Math.max(0, Math.floor(this.options.pollTimeoutMs / 1000)),
          allowed_updates: ['message'],
        },
        input.signal,
      );
    } catch (error) {
      if (input.signal.aborted) return { events: [], cursor: null };
      // 长轮询超时是正常控制流，不是故障。
      if ((error as Error).name === 'AbortError') return { events: [], cursor: null };
      throw error;
    }
    if (!Array.isArray(updates) || updates.length === 0) return { events: [], cursor: null };

    const events: PlatformEvent[] = [];
    let maxUpdateId = -1;
    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const message = update.message;
      // 本轮只处理私聊文字与普通文件；编辑、频道消息、群聊都不交给执行流程。
      if (!message) continue;
      const event = await this.toEvent(update, message, input.signal).catch((error: Error) => {
        return {
          source: this.sourceOf(update, message),
          text: '',
          attachments: [],
          unsupported: `这条消息处理失败：${error.message}`,
          receivedAt: new Date().toISOString(),
        } satisfies PlatformEvent;
      });
      events.push(event);
    }
    // 先让上层落库，再由上层决定游标；这里只给出建议值。
    return { events, cursor: String(maxUpdateId + 1) };
  }

  private sourceOf(update: TelegramUpdate, message: TelegramMessage): SourceRef {
    return {
      channel: 'telegram',
      accountId: this.accountId,
      peerId: String(message.chat.id),
      senderId: String(message.from?.id ?? message.chat.id),
      platformMessageId: String(message.message_id),
      eventId: `update:${update.update_id}`,
      threadId: message.message_thread_id ? String(message.message_thread_id) : null,
    };
  }

  private async toEvent(
    update: TelegramUpdate,
    message: TelegramMessage,
    signal: AbortSignal,
  ): Promise<PlatformEvent> {
    const source = this.sourceOf(update, message);
    // 本轮只支持私聊：群、超级群、频道里的消息只留痕，不进执行流程，也不在群里回话。
    if (message.chat.type !== 'private') {
      return {
        source,
        text: message.text ?? message.caption ?? '',
        attachments: [],
        unsupported: `仅支持与机器人的私聊，${message.chat.type} 里的消息不处理`,
        receivedAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        silent: true,
      };
    }
    const receivedAt = new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const text = (message.text ?? message.caption ?? '').trim();
    const attachments: StoredAttachment[] = [];
    let unsupported: string | null = null;

    if (message.document) {
      const doc = message.document;
      if ((doc.file_size ?? 0) > this.options.maxInboundBytes) {
        unsupported = `文件 ${doc.file_name ?? doc.file_id} 超过 ${Math.round(this.options.maxInboundBytes / 1024 / 1024)}MB 上限，未下载`;
      } else {
        const bytes = await this.downloadFile(doc.file_id, signal);
        attachments.push(
          writeInboundAttachment({
            workDir: this.options.workDir,
            channel: 'telegram',
            accountId: this.accountId,
            eventId: source.eventId,
            name: doc.file_name ?? `telegram-${doc.file_id}`,
            kind: 'file',
            mime: doc.mime_type ?? null,
            bytes,
          }),
        );
      }
    }

    if (message.photo && message.photo.length > 0) {
      const largest = message.photo.reduce((best, item) =>
        (item.file_size ?? 0) > (best.file_size ?? 0) ? item : best,
      );
      if ((largest.file_size ?? 0) > this.options.maxInboundBytes) {
        unsupported = `图片超过 ${Math.round(this.options.maxInboundBytes / 1024 / 1024)}MB 上限，未下载`;
      } else {
        const bytes = await this.downloadFile(largest.file_id, signal);
        attachments.push(
          writeInboundAttachment({
            workDir: this.options.workDir,
            channel: 'telegram',
            accountId: this.accountId,
            eventId: source.eventId,
            name: `photo-${message.message_id}.jpg`,
            kind: 'image',
            mime: 'image/jpeg',
            bytes,
          }),
        );
      }
    }

    if (message.voice || message.video || message.audio || message.sticker) {
      unsupported ??= '语音、视频与表情包不在本轮支持范围内';
    }

    return { source, text, attachments, unsupported, receivedAt };
  }

  private async downloadFile(fileId: string, signal: AbortSignal): Promise<Buffer> {
    const info = await this.call<{ file_path?: string }>('getFile', { file_id: fileId }, signal);
    if (!info.file_path) throw new Error('getFile 没有返回 file_path');
    // 停机时不能把大文件下载跑完：取消信号要传到实际下载请求上。
    const response = await this.fetchImpl(
      `${this.options.apiBase.replace(/\/+$/, '')}/file/bot${this.options.token}/${info.file_path}`,
      { signal },
    );
    if (!response.ok) throw new Error(`下载文件失败：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async send(input: {
    target: OutboundTarget;
    segment: OutboundSegment;
    signal: AbortSignal;
  }): Promise<SendOutcome> {
    const { target, segment, signal } = input;
    try {
      if (segment.kind === 'text') {
        return await this.sendText(target.peerId, segment.text ?? '', signal);
      }
      const path = segment.path;
      if (!path) return { status: 'failed', error: '文件段缺少本地路径', retryable: false };
      const bytes = readFileSync(path);
      const form = new FormData();
      form.set('chat_id', target.peerId);
      form.set('document', new Blob([new Uint8Array(bytes)]), segment.name ?? basename(path));
      const response = await this.fetchImpl(this.url('sendDocument'), {
        method: 'POST',
        body: form,
        signal,
      });
      const raw = (await response.json().catch(() => null)) as
        | { ok?: boolean; result?: { message_id: number }; description?: string }
        | null;
      if (!raw?.ok) {
        return {
          status: 'failed',
          error: `sendDocument 失败：${raw?.description ?? `HTTP ${response.status}`}`,
          retryable: response.status >= 500 || raw !== null,
        };
      }
      return { status: 'sent', platformMessageId: String(raw.result?.message_id ?? '') };
    } catch (error) {
      if (error instanceof ChannelAuthError) {
        return { status: 'failed', error: error.message, retryable: false };
      }
      const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs ?? null;
      if (retryAfterMs !== null) {
        return { status: 'failed', error: (error as Error).message, retryable: true, retryAfterMs };
      }
      return classifyFailure(error);
    }
  }

  /**
   * 发文本：先按 HTML 渲染。
   *
   * 平台解析实体失败（400 can't parse entities）时退回纯文本——
   * 宁可少渲染，也不能让整条消息发不出去。
   */
  private async sendText(chatId: string, markdown: string, signal: AbortSignal): Promise<SendOutcome> {
    const html = toTelegramHtml(markdown);
    try {
      const result = await this.call<{ message_id: number }>(
        'sendMessage',
        { chat_id: chatId, text: html, parse_mode: 'HTML' },
        signal,
      );
      return { status: 'sent', platformMessageId: String(result.message_id) };
    } catch (error) {
      if (!/parse entities|can't parse|unsupported start tag|unclosed/i.test((error as Error).message)) {
        throw error;
      }
      const fallback = await this.call<{ message_id: number }>(
        'sendMessage',
        { chat_id: chatId, text: toPlainText(markdown) },
        signal,
      );
      return { status: 'sent', platformMessageId: String(fallback.message_id) };
    }
  }

  /**
   * 流式预览：sendMessageDraft。
   *
   * 它是临时草稿（30 秒后自行消失、没有 message_id），最终答案仍要正常 send。
   * 好处是不用先发一条占位消息再改写——聊天里不会多出一颗真实气泡。
   */
  async draft(input: {
    target: OutboundTarget;
    draftId: number;
    text: string;
    signal: AbortSignal;
  }): Promise<SendOutcome> {
    const chatId = Number(input.target.peerId);
    if (!Number.isFinite(chatId)) {
      return { status: 'failed', error: `草稿只支持数字 chat_id，实际 ${input.target.peerId}`, retryable: false };
    }
    try {
      await this.call(
        'sendMessageDraft',
        {
          chat_id: chatId,
          draft_id: input.draftId,
          // 草稿是临时预览：用纯文本，避免半截 Markdown 触发解析错误。
          text: [...toPlainText(input.text)].slice(0, 4000).join(''),
        },
        input.signal,
      );
      return { status: 'sent', platformMessageId: null };
    } catch (error) {
      if (error instanceof ChannelAuthError) {
        return { status: 'failed', error: (error as Error).message, retryable: false };
      }
      return { status: 'failed', error: (error as Error).message, retryable: true };
    }
  }

  /** "正在输入"：平台侧约 5 秒后自动消失，上层负责按节奏补发。 */
  async typing(input: { target: OutboundTarget; signal: AbortSignal }): Promise<void> {
    await this.call(
      'sendChatAction',
      { chat_id: input.target.peerId, action: 'typing' },
      input.signal,
    );
  }

  /** 原地改写：用于把占位消息逐步变成最终回答。 */
  async edit(input: {
    target: OutboundTarget;
    messageId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<SendOutcome> {
    try {
      await this.call(
        'editMessageText',
        {
          chat_id: input.target.peerId,
          message_id: Number(input.messageId),
          text: toTelegramHtml(input.text),
          parse_mode: 'HTML',
        },
        input.signal,
      );
      return { status: 'sent', platformMessageId: input.messageId };
    } catch (error) {
      const message = (error as Error).message;
      // "消息内容未变化"是平台侧的幂等提示，不是失败。
      if (/message is not modified/i.test(message)) {
        return { status: 'sent', platformMessageId: input.messageId };
      }
      if (/parse entities|can't parse|unsupported start tag|unclosed/i.test(message)) {
        // 渲染失败就退回纯文本改写，不让占位消息停在半成品。
        try {
          await this.call(
            'editMessageText',
            {
              chat_id: input.target.peerId,
              message_id: Number(input.messageId),
              text: toPlainText(input.text),
            },
            input.signal,
          );
          return { status: 'sent', platformMessageId: input.messageId };
        } catch (fallbackError) {
          return classifyFailure(fallbackError);
        }
      }
      if (error instanceof ChannelAuthError) return { status: 'failed', error: message, retryable: false };
      return classifyFailure(error);
    }
  }

  async close(): Promise<void> {
    // 长轮询靠上层的中止信号结束，这里没有额外连接需要释放。
  }
}
