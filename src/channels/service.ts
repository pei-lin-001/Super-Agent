/**
 * 渠道服务：把平台的收发接到现有 Runtime / Router 上。
 *
 * 它只做四件事——可靠收、按会话交接、可靠发、记录真实结果。
 * 不解释业务、不概括技术结论、不规定模型怎么工作。
 */
import { readFileSync, statSync } from 'node:fs';
import type { Config } from '../config.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { Store } from '../storage/store.ts';
import type { InboundAttachment, ChannelAdapter, OutboundSegment, SendOutcome } from './types.ts';
import { ChannelAuthError } from './types.ts';
import { resolveArtifactPath, sha256Of } from './storage.ts';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../domain/ids.ts';

/** 平台单条文本上限。超过就分段，不静默截断。 */
const TEXT_LIMITS: Record<string, number> = {
  telegram: 4000,
  weixin: 2000,
};

/**
 * 按码点切分文本，尽量落在段落、换行、句子边界上。
 * 不切断代理对，也不丢任何一截。
 */
export function splitText(text: string, limit: number): string[] {
  const chars = [...text];
  if (chars.length <= limit) return [text];
  const parts: string[] = [];
  let rest = chars;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const candidates = ['\n\n', '\n', '。', '；', '，', ' '];
    let cut = -1;
    for (const separator of candidates) {
      const sepChars = [...separator];
      for (let index = window.length - sepChars.length; index > limit * 0.4; index -= 1) {
        if (sepChars.every((char, offset) => window[index + offset] === char)) {
          cut = index + sepChars.length;
          break;
        }
      }
      if (cut > 0) break;
    }
    if (cut <= 0) cut = limit;
    parts.push(window.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest.join(''));
  return parts;
}

interface AdapterRuntime {
  adapter: ChannelAdapter;
  abort: AbortController;
  loop: Promise<void> | null;
  consecutiveFailures: number;
  /** 登录/令牌失效：暂停轮询，等人工重新登录。 */
  blocked: string | null;
  lastPollAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export class ChannelService {
  private readonly runtime: Runtime;
  private readonly store: Store;
  private readonly config: Config;
  private readonly log: (message: string) => void;
  private readonly runtimes = new Map<string, AdapterRuntime>();
  private readonly inFlight = new Set<string>();
  /** 正在发送的 (channel,account)：同一账号的发件保持顺序。 */
  private readonly sending = new Set<string>();
  private outboundBusy = false;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private readonly sleeps = new Set<NodeJS.Timeout>();

  constructor(options: {
    runtime: Runtime;
    store: Store;
    config: Config;
    log?: (message: string) => void;
  }) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.config = options.config;
    this.log = options.log ?? ((message) => console.log(`[渠道] ${message}`));
  }

  get isStarted(): boolean {
    return this.started;
  }

  register(adapter: ChannelAdapter): void {
    const key = this.keyOf(adapter.name, adapter.accountId);
    if (this.runtimes.has(key)) {
      throw new Error(`渠道账号重复注册：${key}；同一账号只能有一个接收实例`);
    }
    this.runtimes.set(key, {
      adapter,
      abort: new AbortController(),
      loop: null,
      consecutiveFailures: 0,
      blocked: null,
      lastPollAt: null,
      lastEventAt: null,
      lastError: null,
    });
  }

  private keyOf(channel: string, accountId: string): string {
    return `${channel}::${accountId}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Router 面向聊天的可投递内容 → 发件记录。
    this.unsubscribe = this.runtime.on((event) => {
      if (event.type !== 'channel.outbound') return;
      this.enqueueOutbound(event.sessionKey, event.text, event.taskId, event.artifact);
    });
    for (const [key, entry] of this.runtimes) {
      entry.loop = this.pollLoop(key, entry);
    }
    void this.outboundLoop();
  }

  /**
   * 发件推进循环。
   *
   * 与接收循环分开：某条聊天发送失败不影响继续收消息，也不阻塞业务执行。
   */
  private async outboundLoop(): Promise<void> {
    while (this.started) {
      try {
        await this.drainOutbound();
      } catch (error) {
        this.log(`发件推进失败：${(error as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const entry of this.runtimes.values()) entry.abort.abort();
    for (const timer of this.sleeps) clearTimeout(timer);
    this.sleeps.clear();
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.loop ?? Promise.resolve()));
    // 发送中的调用交给它自己结束：这里只关连接，不改业务状态。
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.adapter.close()));
  }

  /** 一轮轮询 + 一次收发推进；测试与进程级验收直接调用它。 */
  async tick(): Promise<void> {
    for (const [key, entry] of this.runtimes) {
      if (entry.blocked) continue;
      await this.pollOnce(key, entry);
    }
    this.drainInbound();
    await this.drainOutbound();
  }

  private async pollLoop(key: string, entry: AdapterRuntime): Promise<void> {
    while (!entry.abort.signal.aborted && this.started) {
      try {
        await this.pollOnce(key, entry);
        entry.consecutiveFailures = 0;
      } catch (error) {
        if (entry.abort.signal.aborted) return;
        entry.consecutiveFailures += 1;
        entry.lastError = (error as Error).message;
        if (error instanceof ChannelAuthError) {
          // 登录失效不是网络问题：继续忙重试只会持续失败，停下来等人处理。
          entry.blocked = error.message;
          this.log(`${key} 需要重新登录：${error.message}`);
          return;
        }
        const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(entry.consecutiveFailures, 5));
        this.log(`${key} 拉取失败（${entry.consecutiveFailures}）：${(error as Error).message}；${backoff}ms 后重试`);
        await this.sleep(backoff, entry.abort.signal);
        continue;
      }
      // 后台业务与收消息解耦：这里只推进接收与发送，不等 Worker。
      this.drainInbound();
      void this.drainOutbound();
      // 平台没给消息时不要空转：假适配器和短轮询都会立刻返回，空转会占满 CPU。
      await this.sleep(200, entry.abort.signal);
    }
  }

  private dbg(message: string): void {
    if (process.env['CH_DEBUG']) console.error(`[ch] ${message}`);
  }

  private async pollOnce(key: string, entry: AdapterRuntime): Promise<void> {
    this.dbg(`pollOnce start ${key}`);
    const cursor = this.store.getChannelCursor(entry.adapter.name, entry.adapter.accountId);
    const result = await entry.adapter.poll({ cursor, signal: entry.abort.signal });
    entry.lastPollAt = nowIso();
    if (result.events.length === 0 && result.cursor === null) return;
    const ownerIds = entry.adapter.ownerIds();
    const events = result.events.map((event) => ({
      id: `${event.source.channel}::${event.source.accountId}::${event.source.eventId}`,
      eventId: event.source.eventId,
      peerId: event.source.peerId,
      senderId: event.source.senderId,
      platformMessageId: event.source.platformMessageId,
      sessionKey: sessionKeyFrom(event.source),
      threadId: event.source.threadId ?? null,
      body: event.text,
      attachments: event.attachments,
      unsupported: event.unsupported ?? null,
      silent: event.silent === true,
      receivedAt: event.receivedAt,
    }));
    // 先事务性落库、再前移游标：写库失败时游标不动。
    const recorded = this.store.recordInboundBatch({
      channel: entry.adapter.name,
      accountId: entry.adapter.accountId,
      ownerIds,
      events,
      cursor: result.cursor,
    });
    if (recorded.accepted.length > 0 || recorded.rejected.length > 0) {
      entry.lastEventAt = nowIso();
    }
    if (recorded.rejected.length > 0 && ownerIds.length === 0) {
      this.log(`${key} 收到 ${recorded.rejected.length} 条消息，但尚未绑定主人身份；已记录，不执行`);
    }
    this.dbg(`pollOnce done ${key} accepted=${recorded.accepted.length}`);
    void this.drainInbound();
  }

  /**
   * 把待交接的入站消息交给 Router。
   *
   * 同一会话内保持顺序；不同会话并行——一条聊天的长协调不能卡住另一条聊天。
   */
  drainInbound(): void {
    const pending = this.store.listPendingInbound(50);
    const bySession = new Map<string, typeof pending>();
    for (const item of pending) {
      if (this.inFlight.has(item.sessionKey)) {
        // 该会话正在交接：先不取，等它处理完，保证顺序。
        continue;
      }
      const list = bySession.get(item.sessionKey) ?? [];
      list.push(item);
      bySession.set(item.sessionKey, list);
    }
    this.dbg(`drainInbound pending=${pending.length} sessions=${bySession.size}`);
    for (const [sessionKey, items] of bySession) {
      this.inFlight.add(sessionKey);
      this.dbg(`handoff start ${sessionKey} items=${items.length}`);
      void this.handoffSession(sessionKey, items).finally(() => {
        this.inFlight.delete(sessionKey);
        if (this.started) this.drainInbound();
      });
    }
  }

  private async handoffSession(
    sessionKey: string,
    items: {
      id: string;
      channel: string;
      accountId: string;
      peerId: string;
      body: string;
      attachments: unknown;
      unsupported: string | null;
      silent: boolean;
    }[],
  ): Promise<void> {
    const router = this.runtime.routerBridge;
    for (const item of items) {
      const attachments = (Array.isArray(item.attachments) ? item.attachments : []) as InboundAttachment[];
      if (item.unsupported) {
        // 本轮不支持的平台类型：记录原因，不交给模型猜。
        this.store.markInbound(item.id, 'rejected', item.unsupported);
        if (!item.silent) {
          // 群聊这类来源连回信都不发：只留痕，避免在别人的群里冒泡。
          this.enqueueOutbound(
            sessionKey,
            `${item.unsupported}。这条消息已记录，但没有交给执行流程。`,
            null,
            null,
          );
        }
        continue;
      }
      if (!router) {
        this.store.markInbound(item.id, 'failed', 'Router 尚未就绪');
        continue;
      }
      const text = composeInboundText(item.body, attachments);
      this.dbg(`calling router for ${item.id}`);
      let accepted = false;
      try {
        await router.handleUserMessage(text, {
          sessionKey,
          // 用户输入一旦持久化就标记已交接：之后崩溃走续接，不重复派工。
          onAccepted: () => {
            accepted = true;
            this.store.markInbound(item.id, 'handed');
            this.store.upsertChannelSession({
              sessionKey,
              channel: item.channel,
              accountId: item.accountId,
              peerId: item.peerId,
              touch: 'inbound',
            });
          },
        });
      } catch (error) {
        if (!accepted) this.store.markInbound(item.id, 'failed', (error as Error).message);
        this.log(`交接失败 ${item.id}：${(error as Error).message}`);
        continue;
      }
      this.dbg(`router returned for ${item.id} accepted=${accepted}`);
      if (!accepted) {
        // Router 停机或没有落库：保留 pending，重启后重试，不丢消息。
        this.store.markInbound(item.id, 'failed', 'Router 未接收');
      }
    }
  }

  /** 面向聊天的一条可投递内容写入发件记录。 */
  enqueueOutbound(
    sessionKey: string,
    text: string,
    taskId: string | null,
    artifact: string | null,
  ): void {
    const session = this.store.getChannelSession(sessionKey);
    const parts = sessionKey.split('|').map((part) => decodeURIComponent(part));
    const channel = session?.channel ?? parts[0] ?? '';
    const accountId = session?.accountId ?? parts[1] ?? '';
    const peerId = session?.peerId ?? parts[2] ?? '';
    if (channel === '' || accountId === '' || peerId === '') return;
    const limit = TEXT_LIMITS[channel] ?? 4000;
    const segments: OutboundSegment[] = [];
    let index = 0;
    for (const chunk of splitText(text, limit)) {
      segments.push({ index, kind: 'text', text: chunk, status: 'pending', platformMessageId: null, error: null });
      index += 1;
    }
    if (artifact) {
      segments.push({
        index,
        kind: 'file',
        name: artifact,
        status: 'pending',
        platformMessageId: null,
        error: null,
      });
    }
    if (segments.length === 0) return;
    this.store.upsertChannelSession({ sessionKey, channel, accountId, peerId, touch: 'outbound' });
    this.store.enqueueOutbound({
      id: `ob_${randomBytes(6).toString('hex')}`,
      channel,
      accountId,
      peerId,
      sessionKey,
      taskId,
      body: text,
      segments,
    });
  }

  /**
   * 推进发件。
   *
   * 已确认发出的分段不重发；只有未确认的分段会继续尝试。
   * 发送结果未知时如实记录为 unknown，不当成功、也不整条重来。
   */
  async drainOutbound(): Promise<void> {
    if (this.outboundBusy) return;
    this.outboundBusy = true;
    try {
      const pending = this.store.listPendingOutbound(10);
      for (const record of pending) {
        if (!this.started) return;
        const key = this.keyOf(record.channel, record.accountId);
        const entry = this.runtimes.get(key);
        if (!entry) continue;
        if (this.sending.has(key)) continue;
        this.sending.add(key);
        try {
          this.dbg(`deliver ${record.id}`);
          await this.deliver(record, entry.adapter);
          this.dbg(`delivered ${record.id}`);
        } finally {
          this.sending.delete(key);
        }
      }
    } finally {
      this.outboundBusy = false;
    }
  }

  private async deliver(
    record: {
      id: string;
      channel: string;
      accountId: string;
      peerId: string;
      sessionKey: string;
      taskId: string | null;
      segments: unknown;
      attempts: number;
    },
    adapter: ChannelAdapter,
  ): Promise<void> {
    const segments = (Array.isArray(record.segments) ? record.segments : []) as OutboundSegment[];
    const target = {
      channel: adapter.name,
      accountId: adapter.accountId,
      peerId: record.peerId,
      sessionKey: record.sessionKey,
    };
    let attempts = record.attempts;
    let lastError: string | null = null;
    let unknown = false;
    let fatal = false;
    let waitMs: number | null = null;

    for (const segment of segments) {
      if (segment.status === 'sent') continue;
      if (fatal) break;
      if (segment.kind === 'file' && !segment.path) {
        // 引用真实产物版本，文件不存在或指纹不符就不发。
        const resolved = this.resolveArtifactSegment(record.taskId, segment.name ?? '');
        if (!resolved.ok) {
          segment.status = 'failed';
          segment.error = resolved.reason;
          lastError = resolved.reason;
          fatal = true;
          break;
        }
        segment.path = resolved.path;
      }
      attempts += 1;
      let outcome: SendOutcome;
      try {
        outcome = await adapter.send({ target, segment, signal: new AbortController().signal });
      } catch (error) {
        outcome = { status: 'failed', error: (error as Error).message, retryable: true };
      }
      if (outcome.status === 'sent') {
        segment.status = 'sent';
        segment.platformMessageId = outcome.platformMessageId;
        segment.error = null;
        continue;
      }
      if (outcome.status === 'unknown') {
        // 平台可能已经收到：不再重复发送这一段，记录真实的不确定状态。
        segment.status = 'unknown';
        segment.error = outcome.error;
        unknown = true;
        lastError = outcome.error;
        continue;
      }
      segment.status = 'failed';
      segment.error = outcome.error;
      lastError = outcome.error;
      fatal = !outcome.retryable;
      // 平台给了等待时间就按它等；否则按尝试次数退避，别对着限速接口空转。
      waitMs = fatal ? null : (outcome.retryAfterMs ?? backoffMs(attempts));
      break;
    }

    const sent = segments.filter((segment) => segment.status === 'sent').length;
    let status: 'pending' | 'partial' | 'sent' | 'failed' | 'unknown';
    if (sent === segments.length) status = 'sent';
    else if (unknown) status = 'unknown';
    else if (fatal) status = 'failed';
    else status = sent > 0 ? 'partial' : 'pending';
    this.store.updateOutbound({
      id: record.id,
      segments,
      status,
      attempts,
      lastError,
      nextAttemptAt: waitMs === null ? null : new Date(Date.now() + waitMs).toISOString(),
    });
  }

  /** 文件段只能取本任务已登记的产物版本。 */
  private resolveArtifactSegment(
    taskId: string | null,
    name: string,
  ): { ok: true; path: string } | { ok: false; reason: string } {
    if (!taskId) return { ok: false, reason: '没有关联任务，不能发送文件' };
    const artifact = this.store
      .listArtifacts(taskId)
      .filter((item) => item.name === name)
      .at(-1);
    if (!artifact) return { ok: false, reason: `任务没有名为 ${name} 的产物` };
    const absolute = resolveArtifactPath(this.config.workDir, artifact.path);
    if (!absolute) return { ok: false, reason: `产物文件不在工作目录内或已不存在：${artifact.path}` };
    const size = statSync(absolute).size;
    const digest = sha256Of(readFileSync(absolute));
    if (digest !== artifact.sha256) {
      return { ok: false, reason: `产物指纹不符，拒绝发送：登记 ${artifact.sha256.slice(0, 12)}，实际 ${digest.slice(0, 12)}` };
    }
    if (size !== artifact.bytes) {
      return { ok: false, reason: `产物大小不符：登记 ${artifact.bytes}，实际 ${size}` };
    }
    return { ok: true, path: absolute };
  }

  status(): {
    channel: string;
    accountId: string;
    blocked: string | null;
    lastPollAt: string | null;
    lastEventAt: string | null;
    lastError: string | null;
    pendingInbound: number;
    pendingOutbound: number;
  }[] {
    return [...this.runtimes.entries()].map(([key, entry]) => {
      const [channel, accountId] = key.split('::');
      return {
        channel: channel ?? '',
        accountId: accountId ?? '',
        blocked: entry.blocked,
        lastPollAt: entry.lastPollAt,
        lastEventAt: entry.lastEventAt,
        lastError: entry.lastError,
        pendingInbound: this.store
          .listPendingInbound(200)
          .filter((item) => item.channel === channel && item.accountId === accountId).length,
        pendingOutbound: this.store
          .listPendingOutbound(200)
          .filter((item) => item.channel === channel && item.accountId === accountId).length,
      };
    });
  }

  /** 等待交接与发送都停下来；测试与停机使用。 */
  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.inFlight.size === 0 && this.sending.size === 0 && !this.outboundBusy) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      // 每轮都要清理监听器：长轮询会调用很多次，累计的监听器会让进程越跑越慢。
      const onAbort = (): void => {
        clearTimeout(timer);
        this.sleeps.delete(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.sleeps.delete(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      this.sleeps.add(timer);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 发送失败后的退避：2s 起翻倍，最多 60s。 */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(attempts - 1, 5)));
}

function sessionKeyFrom(source: { channel: string; accountId: string; peerId: string; threadId?: string | null }): string {
  const parts = [source.channel, source.accountId, source.peerId];
  if (source.threadId) parts.push(`thread:${source.threadId}`);
  return parts.map((part) => encodeURIComponent(part)).join('|');
}

/**
 * 把一条入站消息拼成交给 Router 的文本。
 *
 * 附件只描述"收到了什么、放在哪"，不说内容——当前模型没有视觉/音频输入，
 * 也不能从文件名推断内容。
 */
export function composeInboundText(body: string, attachments: InboundAttachment[]): string {
  const lines: string[] = [];
  if (body.trim() !== '') lines.push(body.trim());
  for (const attachment of attachments) {
    const size = `${Math.max(1, Math.round(attachment.bytes / 1024))} KB`;
    if (attachment.kind === 'image') {
      lines.push(`（用户发来一张图片：${attachment.name}，${size}，已保存；当前模型没有视觉输入，不能解读画面内容）`);
    } else if (attachment.kind === 'voice' || attachment.kind === 'video') {
      lines.push(`（用户发来一段${attachment.kind === 'voice' ? '语音' : '视频'}：${attachment.name}，${size}，已保存；本轮不处理这类内容）`);
    } else {
      lines.push(`（用户发来文件：${attachment.name}，${size}，已保存；建任务时会复制进该任务的 materials/）`);
    }
  }
  return lines.join('\n');
}
