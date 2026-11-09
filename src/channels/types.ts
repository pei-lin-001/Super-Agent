/**
 * 渠道层的平台无关契约。
 *
 * 这一层只负责「谁发的、发到哪里、收到了什么、发出去没有」，
 * 不解释业务、不决定模型怎么工作，也不替 Router 概括技术结论。
 */

export type ChannelName = 'telegram' | 'weixin';

/** 一条消息的来源。平台 ID 一律按原样保存，不转小写、不拼接有歧义的分隔符。 */
export interface SourceRef {
  channel: ChannelName;
  /** 平台账号（Telegram bot id / 微信 ilink bot id）。 */
  accountId: string;
  /** 回复目标（聊天窗口）。 */
  peerId: string;
  /** 发信人稳定 ID。 */
  senderId: string;
  /** 平台消息 ID。Telegram 是 message_id，微信是 uint64 的 message_id 字符串。 */
  platformMessageId: string;
  /**
   * 事件身份，用于持久去重。
   *
   * Telegram 用 update_id（平台重送的是同一个 update），微信用 message_id。
   * 不能用文本内容哈希：用户合法地连续发两次相同文字，仍然是两条消息。
   */
  eventId: string;
  threadId?: string | null;
}

/**
 * 会话键：平台 + 账号 + 对端。
 *
 * 结构化保存，避免「用分隔符拼起来再 split」的歧义：
 * 三个部分各自 encodeURIComponent，读回来可以无损还原。
 */
export function sessionKeyOf(source: Pick<SourceRef, 'channel' | 'accountId' | 'peerId' | 'threadId'>): string {
  const parts = [source.channel, source.accountId, source.peerId];
  if (source.threadId) parts.push(`thread:${source.threadId}`);
  return parts.map((part) => encodeURIComponent(part)).join('|');
}

export function parseSessionKey(key: string): { channel: string; accountId: string; peerId: string } | null {
  const parts = key.split('|').map((part) => decodeURIComponent(part));
  if (parts.length < 3) return null;
  return { channel: parts[0]!, accountId: parts[1]!, peerId: parts[2]! };
}

/** 入站附件：已经落到受控位置的真实文件。 */
export interface InboundAttachment {
  kind: 'file' | 'image' | 'voice' | 'video' | 'other';
  /** 平台给的原始名称，只用于展示与默认文件名，不能直接当路径。 */
  name: string;
  mime: string | null;
  bytes: number;
  /** 相对 workDir 的受控路径。 */
  path: string;
  sha256: string;
}

/** 平台送来的一条原始消息。 */
export interface PlatformEvent {
  /**
   * 只记录、不回信。
   *
   * 用于群聊这类本轮不支持、也不该在群里回话的来源：消息仍落库留痕，
   * 但不进入执行流程，也不向该会话发送任何内容。
   */
  silent?: boolean;
  source: SourceRef;
  /** 合并后的正文；纯附件消息为空字符串。 */
  text: string;
  attachments: InboundAttachment[];
  /** 平台不认识或本轮不支持的类型说明，用于给用户可理解的反馈。 */
  unsupported?: string | null;
  receivedAt: string;
}

/** 一次轮询的结果。cursor 为空表示这一批没有推进游标。 */
export interface PollResult {
  events: PlatformEvent[];
  cursor: string | null;
}

/** 出站目标。由程序根据任务来源确定，不接受模型生成的 chatId。 */
export interface OutboundTarget {
  channel: ChannelName;
  accountId: string;
  peerId: string;
  sessionKey: string;
}

export type SegmentKind = 'text' | 'file';

export interface OutboundSegment {
  index: number;
  kind: SegmentKind;
  /** 文本段内容。 */
  text?: string;
  /** 文件段的受控路径与展示名。 */
  path?: string;
  name?: string;
  /**
   * 文件段固定的产物身份。排队时就写死，发送时按它重新核验，
   * 不能到发送那一刻再去挑"这个名字的最新版本"。
   */
  artifactId?: string;
  version?: number;
  sha256?: string;
  bytes?: number;
  /**
   * sending 是"已经交给平台、还没拿到回执"的中间态。
   * 进程在这里中断，重启后只能记 unknown，不能当没发过。
   */
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  platformMessageId: string | null;
  error: string | null;
}

/** 发送结果：成功、明确失败、以及「不确定是否到达」。 */
export type SendOutcome =
  | { status: 'sent'; platformMessageId: string | null }
  | { status: 'failed'; error: string; retryable: boolean; retryAfterMs?: number | null }
  /** 请求可能已经到达平台，但客户端没拿到回执；不能标成成功，也不能当没发生。 */
  | { status: 'unknown'; error: string };

/** 平台登录/令牌失效等需要人介入的状态。 */
export class ChannelAuthError extends Error {
  readonly channel: ChannelName;
  constructor(channel: ChannelName, message: string) {
    super(message);
    this.name = 'ChannelAuthError';
    this.channel = channel;
  }
}

/**
 * 微信对端回复上下文的存储。
 *
 * 这是渠道私有状态：只在适配器发送时读写，不进入模型提示词，也不进调用转储。
 * 写入时机在收到消息那一刻——那时渠道会话可能还没建，所以实现必须能自己建。
 */
export interface ContextTokenStore {
  get(sessionKey: string): string | null;
  set(sessionKey: string, token: string | null): void;
}

/** 渠道适配器：平台收发 + 登录状态，不含业务判断。 */
/**
 * 渠道可选能力。
 *
 * 平台支持就实现，不支持就不实现——上层据此决定用哪种展示方式，
 * 不假装微信也能编辑消息。
 */
export interface ChannelCapabilities {
  /** 正在输入提示。 */
  typing: boolean;
  /** 能否原地修改已发消息（流式更新的载体）。 */
  edit: boolean;
  /**
   * 能否发"正在生成的草稿"（Telegram sendMessageDraft）。
   *
   * 草稿是临时预览：没有 message_id，不会留在聊天里，最终答案仍要正常发送。
   * 有它就不需要先发一条占位消息再改写——那会多出一条真实气泡。
   */
  draft?: boolean;
}

export interface ChannelAdapter {
  readonly name: ChannelName;
  readonly accountId: string;
  /** 主人绑定状态：为空时只记录消息，不触发执行。 */
  ownerIds(): string[];
  /** 拉一批消息。实现必须自己处理长轮询超时，不抛普通超时。 */
  poll(input: { cursor: string | null; signal: AbortSignal }): Promise<PollResult>;
  send(input: { target: OutboundTarget; segment: OutboundSegment; signal: AbortSignal }): Promise<SendOutcome>;
  /** 停止时释放连接；不抛错。 */
  close(): Promise<void>;
  /** 这个平台支持哪些展示能力；缺省表示都不支持。 */
  readonly capabilities?: ChannelCapabilities;
  /** 发送"正在输入"；到期由平台自动消失，上层按节奏补发。 */
  typing?(input: { target: OutboundTarget; signal: AbortSignal }): Promise<void>;
  /**
   * 更新"正在生成"的草稿预览。draftId 在同一次回答内保持不变，平台才会做动画。
   * 没有 message_id，也不能编辑或删除；最终答案必须走 send。
   */
  draft?(input: {
    target: OutboundTarget;
    draftId: number;
    text: string;
    signal: AbortSignal;
  }): Promise<SendOutcome>;
  /** 原地改写一条已发送消息（流式展示的载体）。 */
  edit?(input: {
    target: OutboundTarget;
    messageId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<SendOutcome>;
}
