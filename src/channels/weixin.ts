/**
 * 个人微信（腾讯 iLink）适配器。
 *
 * 协议与文件加解密流程改写自腾讯官方 MIT 发布包
 * `@tencent-weixin/openclaw-weixin@2.4.10`（src/api/api.ts、src/cdn/*、
 * src/auth/login-qr.ts、src/messaging/inbound.ts）。原实现绑定 OpenClaw 宿主，
 * 这里只保留协议与媒体部分，路由、存储、日志和配置全部换成本仓库实现。
 * 版权与许可见 THIRD_PARTY_NOTICES.md。
 *
 * 与上游的差异（有意为之）：
 * - 上游先保存新游标再处理消息；这里由上层「先落库、再前移游标」。
 * - 上游空 allowFrom 仍可能放行普通消息；这里主人身份为空时不执行任何请求。
 * - context_token 存进本仓库的渠道会话表，不进入模型提示词。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChannelAdapter,
  ContextTokenStore,
  InboundAttachment,
  OutboundSegment,
  OutboundTarget,
  PlatformEvent,
  PollResult,
  SendOutcome,
  SourceRef,
} from './types.ts';
import { ChannelAuthError } from './types.ts';
import { writeInboundAttachment, type StoredAttachment } from './storage.ts';

/** 微信消息项类型。 */
const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;
/** 会话超时错误码：继续忙重试没有意义，需要重新登录。 */
const STALE_TOKEN_ERRCODE = -14;

interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string };
  voice_item?: { media?: CdnMedia };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia };
}

interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

interface WeixinMessage {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinCredentials {
  /** Bot 令牌；只在私密文件里，不写日志、不进业务表。 */
  botToken: string;
  ilinkBotId: string;
  /** 服务端登录后返回的 API 地址；不假定所有账号永远同一个。 */
  baseUrl: string;
  cdnBaseUrl: string;
  /** 扫码确认的用户 ID；用来绑定主人。 */
  ownerUserId: string | null;
  savedAt: string;
}

/** 凭据文件：0600，放在渠道状态目录。 */
export class WeixinCredentialStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathOf(accountId: string): string {
    return join(this.dir, `${accountId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  load(accountId: string): WeixinCredentials | null {
    const path = this.pathOf(accountId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as WeixinCredentials;
    } catch {
      return null;
    }
  }

  save(credentials: WeixinCredentials): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.pathOf(credentials.ilinkBotId);
    writeFileSync(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  }
}

/**
 * 无损解析：微信的 message_id 是 uint64，普通 JSON.parse 会先转成 double 丢精度。
 * 只重写属于 ID 字段的裸数字，不碰字符串内部。
 */
export function parseWeixinJson<T>(rawText: string): T {
  const idFields = new Set(['message_id', 'msg_id', 'svr_id']);
  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index];
      index += 1;
      continue;
    }
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index];
      index += 1;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const token = rawText.slice(stringStart, index);
    output += token;
    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !idFields.has(key)) continue;
    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? '')) {
      output += rawText[cursor];
      cursor += 1;
    }
    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

/** AES-128-ECB + PKCS#7，与平台媒体协议一致。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB 加密后的长度（PKCS#7 补到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * CDNMedia.aes_key 有两种编码：base64(16 字节裸 key)，或 base64(32 位 hex 字符串)。
 * 都要还原成真正的 16 字节 key，不能想当然只按一种解。
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`aes_key 必须是 16 字节或 32 位 hex，实际 ${decoded.length} 字节`);
}

export interface WeixinAdapterOptions {
  credentials: WeixinCredentials;
  ownerIds: string[];
  workDir: string;
  pollTimeoutMs: number;
  maxInboundBytes: number;
  contextTokens: ContextTokenStore;
  fetchImpl?: typeof fetch;
  /** 应用标识头；默认 `bot`，与官方客户端一致。 */
  appId?: string;
  appVersion?: string;
}

export class WeixinAdapter implements ChannelAdapter {
  readonly name = 'weixin' as const;
  readonly accountId: string;
  /** iLink 没有"改写已发消息"的接口：能显示正在输入，但做不到流式刷新。 */
  readonly capabilities = { typing: true, edit: false };
  /** 每个对端的 typing_ticket 缓存；过期就重新取。 */
  private readonly typingTickets = new Map<string, { ticket: string; at: number }>();

  private readonly options: WeixinAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private longPollTimeoutMs: number;

  constructor(options: WeixinAdapterOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accountId = options.credentials.ilinkBotId;
    this.longPollTimeoutMs = options.pollTimeoutMs;
  }

  ownerIds(): string[] {
    const fromScan = this.options.credentials.ownerUserId;
    const configured = this.options.ownerIds;
    // 显式配置优先；否则用扫码确认的那个人。两者都没有就等于未绑定。
    if (configured.length > 0) return configured;
    return fromScan ? [fromScan] : [];
  }

  private get baseUrl(): string {
    return this.options.credentials.baseUrl.replace(/\/+$/, '');
  }

  private get cdnBaseUrl(): string {
    return this.options.credentials.cdnBaseUrl.replace(/\/+$/, '');
  }

  private headers(withAuth: boolean): Record<string, string> {
    const version = this.options.appVersion ?? '1.0.0';
    const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const encoded = ((parts[0]! & 0xff) << 16) | ((parts[1]! & 0xff) << 8) | (parts[2]! & 0xff);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'iLink-App-Id': this.options.appId ?? 'bot',
      'iLink-App-ClientVersion': String(encoded),
    };
    if (withAuth) {
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
      headers['Authorization'] = `Bearer ${this.options.credentials.botToken}`;
    }
    return headers;
  }

  private baseInfo(): Record<string, unknown> {
    return { channel_version: this.options.appVersion ?? '1.0.0', bot_agent: 'Super-Agent' };
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ ...body, base_info: this.baseInfo() }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`${endpoint} HTTP ${response.status}：${raw.slice(0, 200)}`);
      }
      return parseWeixinJson<T>(raw);
    } finally {
      clearTimeout(timer);
    }
  }

  async poll(input: { cursor: string | null; signal: AbortSignal }): Promise<PollResult> {
    const body: Record<string, unknown> = { get_updates_buf: input.cursor ?? '' };
    let response: GetUpdatesResp;
    try {
      response = await this.post<GetUpdatesResp>('ilink/bot/getupdates', body, this.longPollTimeoutMs);
    } catch (error) {
      if (input.signal.aborted) return { events: [], cursor: null };
      const name = (error as Error).name;
      if (name === 'AbortError') {
        // 客户端超时：长轮询的正常结束方式，游标不推进。
        return { events: [], cursor: null };
      }
      throw error;
    }
    if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
      this.longPollTimeoutMs = response.longpolling_timeout_ms;
    }
    const code = response.errcode ?? response.ret ?? 0;
    if (code !== 0) {
      if (code === STALE_TOKEN_ERRCODE) {
        throw new ChannelAuthError('weixin', `登录已失效（errcode ${code}）：需要重新扫码登录`);
      }
      throw new Error(`getUpdates 返回错误 ret=${response.ret} errcode=${response.errcode} ${response.errmsg ?? ''}`);
    }

    const events: PlatformEvent[] = [];
    for (const message of response.msgs ?? []) {
      // 只处理别人发给机器人的消息；自己发出去的回显不当作输入。
      if (message.message_type === MESSAGE_TYPE_BOT) continue;
      if (!message.from_user_id) continue;
      try {
        events.push(await this.toEvent(message));
      } catch (error) {
        events.push({
          source: this.sourceOf(message),
          text: '',
          attachments: [],
          unsupported: `这条消息处理失败：${(error as Error).message}`,
          receivedAt: new Date().toISOString(),
        });
      }
    }
    const next = response.get_updates_buf && response.get_updates_buf !== '' ? response.get_updates_buf : null;
    return { events, cursor: next };
  }

  private sourceOf(message: WeixinMessage): SourceRef {
    const peer = message.from_user_id ?? '';
    const messageId = String(message.message_id ?? message.client_id ?? randomUUID());
    return {
      channel: 'weixin',
      accountId: this.accountId,
      peerId: peer,
      senderId: peer,
      platformMessageId: messageId,
      // 微信用 message_id 作为事件身份：同一个 message_id 重送只应交接一次。
      eventId: `msg:${messageId}`,
      threadId: null,
    };
  }

  private async toEvent(message: WeixinMessage): Promise<PlatformEvent> {
    const source = this.sourceOf(message);
    const receivedAt = new Date(message.create_time_ms ?? Date.now()).toISOString();
    const items = message.item_list ?? [];
    const texts: string[] = [];
    const attachments: StoredAttachment[] = [];
    let unsupported: string | null = null;

    // 回复上下文按对端保存：只在发送时使用，不进入模型提示词。
    if (message.context_token) {
      this.options.contextTokens.set(sessionKeyOfSource(source), message.context_token);
    }

    for (const item of items) {
      if (item.type === ITEM.TEXT) {
        const value = item.text_item?.text ?? '';
        if (value.trim() !== '') texts.push(value);
        continue;
      }
      if (item.type === ITEM.FILE && item.file_item?.media) {
        const name = item.file_item.file_name ?? 'weixin-file.bin';
        const bytes = await this.downloadMedia(item.file_item.media, `file ${name}`);
        if (bytes.byteLength > this.options.maxInboundBytes) {
          unsupported = `文件 ${name} 超过上限，未保存`;
          continue;
        }
        attachments.push(
          writeInboundAttachment({
            workDir: this.options.workDir,
            channel: 'weixin',
            accountId: this.accountId,
            eventId: source.eventId,
            name,
            kind: 'file',
            mime: null,
            bytes,
          }),
        );
        continue;
      }
      if (item.type === ITEM.IMAGE && item.image_item?.media) {
        const key = item.image_item.aeskey
          ? Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
          : item.image_item.media.aes_key;
        const bytes = await this.downloadMedia(item.image_item.media, 'image', key);
        attachments.push(
          writeInboundAttachment({
            workDir: this.options.workDir,
            channel: 'weixin',
            accountId: this.accountId,
            eventId: source.eventId,
            name: `image-${source.platformMessageId}.jpg`,
            kind: 'image',
            mime: 'image/jpeg',
            bytes,
          }),
        );
        continue;
      }
      if (item.type === ITEM.VOICE || item.type === ITEM.VIDEO) {
        unsupported ??= '语音与视频不在本轮支持范围内';
      }
    }

    return { source, text: texts.join('\n'), attachments, unsupported, receivedAt };
  }

  private async downloadMedia(media: CdnMedia, label: string, aesKeyOverride?: string): Promise<Buffer> {
    const url =
      media.full_url && media.full_url.trim() !== ''
        ? media.full_url
        : `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`${label} 下载失败：HTTP ${response.status}`);
    }
    const ciphertext = Buffer.from(await response.arrayBuffer());
    const keyBase64 = aesKeyOverride ?? media.aes_key;
    if (!keyBase64) return ciphertext;
    return decryptAesEcb(ciphertext, parseAesKey(keyBase64));
  }

  async send(input: {
    target: OutboundTarget;
    segment: OutboundSegment;
    signal: AbortSignal;
  }): Promise<SendOutcome> {
    const { target, segment } = input;
    const contextToken = this.options.contextTokens.get(target.sessionKey);
    try {
      if (segment.kind === 'text') {
        await this.sendMessage({
          to: target.peerId,
          clientId: `sa-${randomUUID()}`,
          contextToken,
          item: { type: ITEM.TEXT, text_item: { text: segment.text ?? '' } },
        });
        return { status: 'sent', platformMessageId: null };
      }
      const path = segment.path;
      if (!path) return { status: 'failed', error: '文件段缺少本地路径', retryable: false };
      const uploaded = await this.uploadFile(path, segment.name ?? 'file.bin', target.peerId);
      // 说明文字与文件拆成两个请求：与平台客户端行为一致，各自有独立 client_id。
      if (segment.name) {
        await this.sendMessage({
          to: target.peerId,
          clientId: `sa-${randomUUID()}`,
          contextToken,
          item: { type: ITEM.TEXT, text_item: { text: segment.name } },
        });
      }
      await this.sendMessage({
        to: target.peerId,
        clientId: `sa-${randomUUID()}`,
        contextToken,
        item: {
          type: ITEM.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aesKey).toString('base64'),
              encrypt_type: 1,
            },
            file_name: segment.name ?? 'file.bin',
            len: String(uploaded.plainSize),
          },
        },
      });
      return { status: 'sent', platformMessageId: null };
    } catch (error) {
      if (error instanceof ChannelAuthError) {
        return { status: 'failed', error: error.message, retryable: false };
      }
      const name = (error as Error).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { status: 'unknown', error: `请求超时，无法确认是否已送达：${(error as Error).message}` };
      }
      const message = (error as Error).message;
      // ret 非零是平台明确的业务拒绝：记失败，不当作已发送。
      if (/ret=-?\d+/.test(message)) {
        return { status: 'failed', error: message, retryable: false };
      }
      return { status: 'failed', error: message, retryable: true };
    }
  }

  private async sendMessage(input: {
    to: string;
    clientId: string;
    contextToken: string | null;
    item: unknown;
  }): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: input.to,
          client_id: input.clientId,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [input.item],
          ...(input.contextToken ? { context_token: input.contextToken } : {}),
        },
      },
      15_000,
    );
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`sendMessage ret=${response.ret} errmsg=${response.errmsg ?? '(none)'}`);
    }
  }

  /** 上传：取参数 → AES-128-ECB 加密 → CDN POST → 拿回下载参数。 */
  private async uploadFile(
    path: string,
    name: string,
    toUserId: string,
  ): Promise<{ downloadParam: string; aesKey: Buffer; plainSize: number }> {
    const plaintext = readFileSync(path);
    const rawSize = plaintext.byteLength;
    const rawMd5 = createHash('md5').update(plaintext).digest('hex');
    const cipherSize = aesEcbPaddedSize(rawSize);
    const filekey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);

    const uploadInfo = await this.post<{
      upload_full_url?: string;
      upload_param?: string;
      ret?: number;
      errmsg?: string;
    }>(
      'ilink/bot/getuploadurl',
      {
        filekey,
        media_type: UPLOAD_MEDIA_TYPE_FILE,
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: rawMd5,
        filesize: cipherSize,
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
      },
      15_000,
    );
    if (uploadInfo.ret !== undefined && uploadInfo.ret !== 0) {
      throw new Error(`getUploadUrl ret=${uploadInfo.ret} errmsg=${uploadInfo.errmsg ?? '(none)'}`);
    }
    const fullUrl = uploadInfo.upload_full_url?.trim();
    const cdnUrl =
      fullUrl && fullUrl !== ''
        ? fullUrl
        : `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadInfo.upload_param ?? '')}&filekey=${encodeURIComponent(filekey)}`;
    if (!fullUrl && !uploadInfo.upload_param) {
      throw new Error('getUploadUrl 没有返回上传地址');
    }

    const ciphertext = encryptAesEcb(plaintext, aesKey);
    const response = await this.fetchImpl(cdnUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
    });
    if (!response.ok) {
      const detail = response.headers.get('x-error-message') ?? `HTTP ${response.status}`;
      throw new Error(`CDN 上传失败：${detail}`);
    }
    const downloadParam = response.headers.get('x-encrypted-param');
    if (!downloadParam) throw new Error('CDN 上传响应缺少 x-encrypted-param');
    void name;
    return { downloadParam, aesKey, plainSize: rawSize };
  }

  /** 正在输入：先取 typing_ticket（有缓存就用缓存），再上报状态。 */
  async typing(input: { target: OutboundTarget; signal: AbortSignal }): Promise<void> {
    const peer = input.target.peerId;
    const cached = this.typingTickets.get(peer);
    let ticket = cached && Date.now() - cached.at < 10 * 60_000 ? cached.ticket : '';
    if (ticket === '') {
      const config = await this.post<{ ret?: number; typing_ticket?: string; errmsg?: string }>(
        'ilink/bot/getconfig',
        { ilink_user_id: peer },
        10_000,
      );
      if ((config.ret ?? 0) !== 0 || !config.typing_ticket) {
        throw new Error(`取 typing_ticket 失败：ret=${config.ret ?? '?'} ${config.errmsg ?? ''}`.trim());
      }
      ticket = config.typing_ticket;
      this.typingTickets.set(peer, { ticket, at: Date.now() });
    }
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/sendtyping',
      { ilink_user_id: peer, typing_ticket: ticket, status: 1 },
      10_000,
    );
    if ((response.ret ?? 0) !== 0) {
      // ticket 可能失效：丢掉缓存，下次重新取。
      this.typingTickets.delete(peer);
      throw new Error(`sendtyping 失败：ret=${response.ret} ${response.errmsg ?? ''}`.trim());
    }
  }

  async close(): Promise<void> {
    // 长轮询靠上层中止信号结束。
  }
}

function sessionKeyOfSource(source: SourceRef): string {
  const parts = [source.channel, source.accountId, source.peerId];
  return parts.map((part) => encodeURIComponent(part)).join('|');
}

export interface QrLoginResult {
  connected: boolean;
  credentials?: WeixinCredentials;
  message: string;
}

/**
 * 扫码登录：取二维码 → 轮询状态 → 保存凭据。
 *
 * 只把二维码链接返回给调用方显示，不在这里打印或存日志；
 * 服务器无桌面环境时把链接复制到任意浏览器打开即可。
 */
export async function loginWithQr(options: {
  apiBase: string;
  cdnBase: string;
  botType?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onQr: (url: string) => void;
  onStatus?: (status: string, hint?: string) => void;
  /** 需要输入手机验证码时调用；返回 null 表示放弃。 */
  askVerifyCode?: () => Promise<string | null>;
  signal?: AbortSignal;
}): Promise<QrLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const botType = options.botType ?? '3';
  const base = options.apiBase.replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '65536',
  };

  const qrResponse = await fetchImpl(`${base}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!qrResponse.ok) {
    return { connected: false, message: `获取二维码失败：HTTP ${qrResponse.status}` };
  }
  const qr = (await qrResponse.json()) as { qrcode?: string; qrcode_img_content?: string };
  if (!qr.qrcode || !qr.qrcode_img_content) {
    return { connected: false, message: '获取二维码失败：响应缺少 qrcode 字段' };
  }
  options.onQr(qr.qrcode_img_content);

  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  let pollBase = base;
  let pendingVerifyCode: string | undefined;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { connected: false, message: '登录已取消' };
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`;
    if (pendingVerifyCode) endpoint += `&verify_code=${encodeURIComponent(pendingVerifyCode)}`;
    let status: {
      status?: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
      redirect_host?: string;
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);
      const response = await fetchImpl(`${pollBase}/${endpoint}`, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      status = (await response.json()) as typeof status;
    } catch {
      // 网络抖动或长轮询超时：继续等。
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    options.onStatus?.(status.status ?? 'wait');
    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        pendingVerifyCode = undefined;
        break;
      case 'need_verifycode': {
        const code = options.askVerifyCode ? await options.askVerifyCode() : null;
        if (code === null) return { connected: false, message: '没有输入验证码，登录已停止' };
        pendingVerifyCode = code;
        continue;
      }
      case 'scaned_but_redirect': {
        if (status.redirect_host) pollBase = `https://${status.redirect_host}`;
        break;
      }
      case 'expired':
      case 'verify_code_blocked': {
        refreshCount += 1;
        if (refreshCount > 3) {
          return { connected: false, message: '二维码多次失效，请稍后重试' };
        }
        const refreshed = await fetchImpl(
          `${base}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
          { method: 'POST', headers, body: JSON.stringify({ local_token_list: [] }) },
        );
        if (!refreshed.ok) return { connected: false, message: `刷新二维码失败：HTTP ${refreshed.status}` };
        const next = (await refreshed.json()) as { qrcode?: string; qrcode_img_content?: string };
        if (!next.qrcode || !next.qrcode_img_content) {
          return { connected: false, message: '刷新二维码失败：响应缺少 qrcode 字段' };
        }
        qr.qrcode = next.qrcode;
        options.onQr(next.qrcode_img_content);
        pendingVerifyCode = undefined;
        break;
      }
      case 'binded_redirect':
        return { connected: false, message: '这个微信已经连接过，无需重复扫码' };
      case 'confirmed': {
        if (!status.ilink_bot_id) {
          return { connected: false, message: '登录失败：服务端没有返回 ilink_bot_id' };
        }
        return {
          connected: true,
          message: '已连接',
          credentials: {
            botToken: status.bot_token ?? '',
            ilinkBotId: status.ilink_bot_id,
            baseUrl: status.baseurl ?? options.apiBase,
            cdnBaseUrl: options.cdnBase,
            ownerUserId: status.ilink_user_id ?? null,
            savedAt: new Date().toISOString(),
          },
        };
      }
      default:
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { connected: false, message: '登录超时，请重试' };
}

export type { InboundAttachment };
