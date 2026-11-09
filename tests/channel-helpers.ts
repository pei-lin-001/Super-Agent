/**
 * 渠道测试用的假适配器与装配。
 *
 * 假适配器只模拟平台收发，不模拟业务；所有断言落在真实 SQLite 与真实 Runtime 上。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { ChannelService } from '../src/channels/service.ts';
import type {
  ChannelAdapter,
  ChannelName,
  OutboundSegment,
  OutboundTarget,
  PlatformEvent,
  PollResult,
  SendOutcome,
  SourceRef,
} from '../src/channels/types.ts';
import type { Store } from '../src/storage/store.ts';
import type { Runtime } from '../src/runtime/runtime.ts';

export interface RecordedSend {
  target: OutboundTarget;
  segment: OutboundSegment;
}

/** 可编排的假平台：poll 返回预置批次，send 按策略返回结果。 */
export class FakeAdapter implements ChannelAdapter {
  readonly name: ChannelName;
  readonly accountId: string;
  readonly sent: RecordedSend[] = [];
  polls = 0;
  closed = false;
  /** 下一次 poll 抛出的错误（模拟断网）。 */
  failWith: Error | null = null;
  /** 预置批次：每次 poll 取一个。 */
  batches: PollResult[] = [];
  /** 发送策略：默认成功。 */
  sendPolicy: (input: { target: OutboundTarget; segment: OutboundSegment }) => SendOutcome = () => ({
    status: 'sent',
    platformMessageId: 'p1',
  });

  private readonly owners: string[];

  constructor(name: ChannelName, accountId: string, owners: string[]) {
    this.name = name;
    this.accountId = accountId;
    this.owners = owners;
  }

  ownerIds(): string[] {
    return this.owners;
  }

  async poll(): Promise<PollResult> {
    this.polls += 1;
    if (this.failWith) throw this.failWith;
    return this.batches.shift() ?? { events: [], cursor: null };
  }

  async send(input: { target: OutboundTarget; segment: OutboundSegment }): Promise<SendOutcome> {
    this.sent.push({ target: input.target, segment: input.segment });
    return this.sendPolicy(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** 构造一条平台事件。 */
export function eventOf(input: {
  channel: ChannelName;
  accountId: string;
  peerId: string;
  senderId?: string;
  eventId: string;
  text: string;
  platformMessageId?: string;
  attachments?: PlatformEvent['attachments'];
  unsupported?: string | null;
}): PlatformEvent {
  const source: SourceRef = {
    channel: input.channel,
    accountId: input.accountId,
    peerId: input.peerId,
    senderId: input.senderId ?? input.peerId,
    platformMessageId: input.platformMessageId ?? input.eventId,
    eventId: input.eventId,
    threadId: null,
  };
  return {
    source,
    text: input.text,
    attachments: input.attachments ?? [],
    unsupported: input.unsupported ?? null,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * 把退避时间拨到过去，模拟"等到了"。
 *
 * 渠道会按 retry_after / 指数退避延后重试，测试不该真的等，也不该绕过退避逻辑。
 */
export function expireOutboundBackoff(store: Store, sessionKey: string): void {
  for (const row of store.listOutboundBySession(sessionKey)) {
    if (row.status !== 'pending' && row.status !== 'partial') continue;
    store.updateOutbound({
      id: row.id,
      segments: row.segments,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    });
  }
}

export function serviceOf(options: {
  runtime: Runtime;
  store: Store;
  config: Config;
  log?: (message: string) => void;
}): ChannelService {
  mkdirSync(join(options.config.channels.stateDir), { recursive: true });
  return new ChannelService(options);
}
