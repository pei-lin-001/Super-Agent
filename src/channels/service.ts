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
import type {
  InboundAttachment,
  ChannelAdapter,
  OutboundSegment,
  OutboundTarget,
  SendOutcome,
} from './types.ts';
import { ChannelAuthError, parseSessionKey } from './types.ts';
import { resolveArtifactPath, sha256Of } from './storage.ts';
import { ConversationService } from './conversations.ts';
import { randomBytes, randomInt } from 'node:crypto';
import { nowIso } from '../domain/ids.ts';
import type { OutboundArtifact } from '../domain/types.ts';

/** 占位消息延迟：短任务只显示"正在输入"，不额外冒一条消息。 */
const PLACEHOLDER_DELAY_MS = 2_500;

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
  /** 话题：一个聊天窗口里可以有多个互相独立的话题。 */
  private readonly conversations: ConversationService;
  private readonly store: Store;
  private readonly config: Config;
  private readonly log: (message: string) => void;
  private readonly runtimes = new Map<string, AdapterRuntime>();
  private readonly inFlight = new Set<string>();
  /** 正在发送的 (channel,account)：同一账号的发件保持顺序。 */
  private readonly sending = new Set<string>();
  private outboundBusy = false;
  private started = false;
  /**
   * 正在进行的会话展示：占位消息 + 正在输入心跳。
   *
   * 只有支持编辑的平台才建占位消息；不支持的就只发"正在输入"，
   * 最终回复照常作为一条新消息发出。
   */
  private readonly live = new Map<
    string,
    {
      adapter: ChannelAdapter;
      /** draft：发临时草稿，最终答案正常发送；edit：先发占位消息再改写。 */
      mode: 'draft' | 'edit';
      messageId: string | null;
      draftId: number;
      lastText: string;
      lastEditAt: number;
      editing: boolean;
      /** 草稿调用失败过：这个会话本轮不再尝试，避免每条进度都撞一次。 */
      draftBroken?: boolean;
    }
  >();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  /** 占位消息的延迟创建定时器：短任务直接跳过。 */
  private readonly placeholderTimers = new Map<string, NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private readonly sleeps = new Set<NodeJS.Timeout>();
  /**
   * 服务生命周期取消信号：所有发送、草稿、正在输入都挂在它上面。
   *
   * 没有它的时候，stop() 返回了发送还在跑：主入口随后关数据库，
   * 迟到回执就会写一个已关闭的库。
   */
  private readonly lifecycle = new AbortController();
  /** 在途发送：停机要等它们收尾。 */
  private readonly pendingSends = new Set<Promise<unknown>>();
  /** 已经收完尾：此后的回执一律丢弃，不再写库。 */
  private stopped = false;

  constructor(options: {
    runtime: Runtime;
    store: Store;
    config: Config;
    log?: (message: string) => void;
  }) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.config = options.config;
    this.conversations = new ConversationService(options.store);
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
      if (event.type === 'router.start') {
        void this.beginLive(event.sessionKey ?? null);
        return;
      }
      if (event.type === 'router.progress') {
        this.updateLive(event.sessionKey ?? null, event.text);
        return;
      }
      if (event.type !== 'channel.outbound') return;
      const conversationId = event.conversationId ?? null;
      // 旧话题的回信不能写进当前话题的占位消息里：那会把两个话题的答案混在一起。
      if (conversationId !== null && conversationId !== this.store.currentConversationId(event.sessionKey)) {
        this.enqueueOutbound(
          event.sessionKey,
          this.labelTopic(conversationId, event.text),
          event.taskId,
          event.artifact,
        );
        return;
      }
      // 已经有占位消息的平台：把占位消息改成最终答案，不再多发一条。
      void this.finishLive(event.sessionKey, event.text).then((handled) => {
        if (!handled) {
          this.enqueueOutbound(event.sessionKey, event.text, event.taskId, event.artifact);
          return;
        }
        if (event.artifact) this.enqueueOutbound(event.sessionKey, '', event.taskId, event.artifact);
      });
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
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    for (const timer of this.placeholderTimers.values()) clearTimeout(timer);
    this.placeholderTimers.clear();
    this.live.clear();
    // 先取消在途发送（它们会按"结果未知"落库），再等它们真的收尾。
    // 顺序反了就是之前的缺陷：stop 返回时 send 还在跑，回执晚于数据库关闭。
    this.lifecycle.abort();
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.loop ?? Promise.resolve()));
    while (this.pendingSends.size > 0) {
      await Promise.allSettled([...this.pendingSends]);
    }
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.adapter.close()));
    // 收尾完成：此后任何迟到结果都不再写库。
    this.stopped = true;
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
      // 显式命令走代码：新建/列出/切换话题必须是确定的，不能让模型自由发挥。
      const commandReply = this.conversations.handleCommand(sessionKey, item.body);
      if (commandReply !== null) {
        this.store.markInbound(item.id, 'handed');
        this.enqueueOutbound(sessionKey, commandReply, null, null);
        continue;
      }
      // 话题归属在这一刻定下来：之后的追问、任务、续接都挂到同一个话题上。
      const conversation = this.conversations.ensureCurrent(sessionKey, item.body);
      this.store.touchConversation(conversation.id);
      const text = composeInboundText(item.body, attachments);
      this.dbg(`calling router for ${item.id}`);
      let accepted = false;
      try {
        await router.handleUserMessage(text, {
          sessionKey,
          conversationId: conversation.id,
          // 用户输入一旦持久化就标记已交接：之后崩溃走续接，不重复派工。
          onAccepted: () => {
            accepted = true;
            // 话题归属在交接这一刻固定下来：附件认领、材料补充都按它筛选，
            // 不再事后去读"这个聊天当前是哪个话题"。
            this.store.setInboundConversation(item.id, conversation.id);
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

  /** 会话开始处理：起"正在输入"心跳；能编辑的平台先发占位消息。 */
  private async beginLive(sessionKey: string | null): Promise<void> {
    if (sessionKey === null) return;
    const target = this.targetOf(sessionKey);
    if (!target) return;
    this.startTyping(sessionKey, target.adapter, target.outbound);
    // 平台支持草稿（Telegram sendMessageDraft）：进度用临时预览，最终答案正常发送。
    // 不再先发一条"正在处理…"的真实消息——那会多出一颗气泡，还得再改写它。
    if (target.adapter.capabilities?.draft && target.adapter.draft) {
      this.live.set(sessionKey, {
        adapter: target.adapter,
        mode: 'draft',
        messageId: null,
        draftId: randomInt(1, 2 ** 31 - 1),
        lastText: '',
        lastEditAt: 0,
        editing: false,
      });
      return;
    }
    if (!target.adapter.capabilities?.edit || !target.adapter.edit) return;
    // 占位消息不能一上来就发：短任务里它只会变成一条一闪而过的"正在处理…"气泡，
    // 看起来就像"正在输入被当成消息发出来了"。先等一会儿，真的慢了再建。
    const timer = setTimeout(() => {
      this.placeholderTimers.delete(sessionKey);
      void this.createPlaceholder(sessionKey, target.adapter, target.outbound);
    }, PLACEHOLDER_DELAY_MS);
    timer.unref?.();
    this.placeholderTimers.set(sessionKey, timer);
  }

  /** 任务确实慢了，才建一条占位消息，后续用改写的方式展示进展。 */
  private async createPlaceholder(
    sessionKey: string,
    adapter: ChannelAdapter,
    outbound: OutboundTarget,
  ): Promise<void> {
    if (this.live.has(sessionKey)) return;
    const outcome = await this.dispatch(sessionKey, adapter, {
      target: outbound,
      segment: {
        index: 0,
        kind: 'text',
        text: '正在处理…',
        status: 'pending',
        platformMessageId: null,
        error: null,
      },
      signal: this.lifecycle.signal,
    });
    if (outcome.status === 'sent' && outcome.platformMessageId) {
      this.live.set(sessionKey, {
        adapter,
        mode: 'edit',
        messageId: outcome.platformMessageId,
        draftId: 0,
        lastText: '正在处理…',
        lastEditAt: Date.now(),
        editing: false,
      });
    }
  }

  /** 进度：把占位消息改成当前进展（限流，避免打爆平台）。 */
  /** 旧话题的回信加上话题名，用户才知道这是哪件事的答案。 */
  private labelTopic(conversationId: string, text: string): string {
    if (text.trim() === '') return text;
    const title = this.conversations.titleOf(conversationId);
    return title === null ? text : `【${title}】${text}`;
  }

  private updateLive(sessionKey: string | null, text: string): void {
    if (sessionKey === null) return;
    const entry = this.live.get(sessionKey);
    if (!entry) return;
    const composed = text.trim();
    if (composed === '' || composed === entry.lastText) return;
    if (entry.mode === 'draft') {
      if (entry.draftBroken || !entry.adapter.draft) return;
    } else if (!entry.adapter.edit || entry.messageId === null) {
      return;
    }
    // 平台限流：同一会话每秒最多一次改写/草稿更新。
    if (Date.now() - entry.lastEditAt < 1_000) return;
    if (entry.editing) return;
    entry.editing = true;
    entry.lastText = composed;
    entry.lastEditAt = Date.now();
    const target = this.targetOf(sessionKey);
    if (!target) {
      entry.editing = false;
      return;
    }
    const adapter = entry.adapter;
    const done = (): void => {
      entry.editing = false;
    };
    if (entry.mode === 'draft' && adapter.draft) {
      void adapter
        .draft({
          target: target.outbound,
          draftId: entry.draftId,
          text: composed,
          signal: this.lifecycle.signal,
        })
        .then((outcome) => {
          // 平台不支持或参数不认：本轮不再试，最终答案照常发送，用户不会看到报错。
          if (outcome.status === 'failed') {
            entry.draftBroken = true;
            // 留一条日志：否则"为什么没有草稿预览"只能靠猜。
            this.log(`草稿预览不可用（${outcome.error}），本轮改为只发最终答案`);
          }
        })
        .catch((error: unknown) => {
          entry.draftBroken = true;
          this.log(`草稿预览不可用（${(error as Error).message}），本轮改为只发最终答案`);
        })
        .finally(done);
      return;
    }
    if (!adapter.edit || entry.messageId === null) {
      done();
      return;
    }
    void adapter
      .edit({
        target: target.outbound,
        messageId: entry.messageId,
        text: composed,
        signal: this.lifecycle.signal,
      })
      .catch(() => undefined)
      .finally(done);
  }

  /** 最终答案：改写占位消息。返回 false 表示这个会话没有占位消息，需要正常发送。 */
  private async finishLive(sessionKey: string, text: string): Promise<boolean> {
    this.stopTyping(sessionKey);
    const pending = this.placeholderTimers.get(sessionKey);
    if (pending) {
      clearTimeout(pending);
      this.placeholderTimers.delete(sessionKey);
    }
    const entry = this.live.get(sessionKey);
    // 草稿没有 message_id，也不需要"变成"最终答案：答案要作为一条真实消息发送，
    // 平台在 bot 发消息时会自动收掉草稿。
    if (entry?.mode === 'draft') {
      this.live.delete(sessionKey);
      return false;
    }
    if (!entry || entry.messageId === null || !entry.adapter.edit) {
      this.live.delete(sessionKey);
      return false;
    }
    this.live.delete(sessionKey);
    const target = this.targetOf(sessionKey);
    if (!target) return false;
    const limit = TEXT_LIMITS[target.adapter.name] ?? 4000;
    const [head, ...rest] = splitText(text.trim() === '' ? '（无内容）' : text, limit);
    const outcome = await entry.adapter.edit({
      target: target.outbound,
      messageId: entry.messageId,
      text: head ?? '',
      signal: this.lifecycle.signal,
    });
    if (outcome.status !== 'sent') return false;
    // 改写只能覆盖第一段，剩下的照常发。
    for (const chunk of rest) {
      this.enqueueOutbound(sessionKey, chunk, null, null);
    }
    return true;
  }

  private startTyping(sessionKey: string, adapter: ChannelAdapter, outbound: OutboundTarget): void {
    if (!adapter.capabilities?.typing || !adapter.typing) return;
    if (this.typingTimers.has(sessionKey)) return;
    const beat = (): void => {
      void adapter
        .typing!({ target: outbound, signal: this.lifecycle.signal })
        .catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, 4_000);
    timer.unref?.();
    this.typingTimers.set(sessionKey, timer);
  }

  private stopTyping(sessionKey: string): void {
    const timer = this.typingTimers.get(sessionKey);
    if (!timer) return;
    clearInterval(timer);
    this.typingTimers.delete(sessionKey);
  }

  /** 会话键 → 适配器与发送目标；账号没接上就返回 null。 */
  private targetOf(
    sessionKey: string,
  ): { adapter: ChannelAdapter; outbound: OutboundTarget } | null {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return null;
    const entry = this.runtimes.get(this.keyOf(parsed.channel, parsed.accountId));
    if (!entry) return null;
    return {
      adapter: entry.adapter,
      outbound: {
        channel: entry.adapter.name,
        accountId: entry.adapter.accountId,
        peerId: parsed.peerId,
        sessionKey,
      },
    };
  }

  /** 统一发送入口：便于流式与普通发送共用同一套错误处理。 */
  private async dispatch(
    sessionKey: string,
    adapter: ChannelAdapter,
    input: { target: OutboundTarget; segment: OutboundSegment; signal: AbortSignal },
  ): Promise<SendOutcome> {
    void sessionKey;
    try {
      return await adapter.send(input);
    } catch (error) {
      return { status: 'failed', error: (error as Error).message, retryable: true };
    }
  }

  /** 面向聊天的一条可投递内容写入发件记录。 */
  enqueueOutbound(
    sessionKey: string,
    text: string,
    taskId: string | null,
    artifact: OutboundArtifact | null,
  ): void {
    // 停机之后不再产生新的发件记录：数据库可能已经被关掉。
    if (this.stopped) return;
    const session = this.store.getChannelSession(sessionKey);
    const parts = sessionKey.split('|').map((part) => decodeURIComponent(part));
    const channel = session?.channel ?? parts[0] ?? '';
    const accountId = session?.accountId ?? parts[1] ?? '';
    const peerId = session?.peerId ?? parts[2] ?? '';
    if (channel === '' || accountId === '' || peerId === '') return;
    const limit = TEXT_LIMITS[channel] ?? 4000;
    const segments: OutboundSegment[] = [];
    let index = 0;
    // 空文本表示"这一条只有文件"：不要为了占位而发一条空消息。
    for (const chunk of text.trim() === '' ? [] : splitText(text, limit)) {
      segments.push({ index, kind: 'text', text: chunk, status: 'pending', platformMessageId: null, error: null });
      index += 1;
    }
    if (artifact) {
      segments.push({
        index,
        kind: 'file',
        name: artifact.name,
        // 版本、指纹、大小在这里就写死：发送时只核验，不再挑"最新版本"。
        artifactId: artifact.artifactId,
        version: artifact.version,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
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
    if (this.stopped) return;
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
        const sending = this.deliver(record, entry.adapter);
        this.pendingSends.add(sending);
        try {
          this.dbg(`deliver ${record.id}`);
          await sending;
          this.dbg(`delivered ${record.id}`);
        } finally {
          this.pendingSends.delete(sending);
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

    // 每段一有结果就落库：第一段已拿到平台回执、后一段还在等的时候崩溃，
    // 重启后必须知道第一段已经发出去了，不能整条重来再发一遍。
    const persist = (nextAttemptAt: string | null = null): void => {
      // 迟到回执：服务已经收尾、数据库可能已关闭，写入会把停机变成异常。
      if (this.stopped) return;
      const sent = segments.filter((segment) => segment.status === 'sent').length;
      // 还有没送完的段就保持可调度：unknown 只代表那一段不确定，
      // 不能因为一段 unknown 把后面确定没发的段一起冻结。
      const remaining = segments.some(
        (segment) => segment.status === 'pending' || segment.status === 'sending' || (segment.status === 'failed' && !fatal),
      );
      let status: 'pending' | 'partial' | 'sent' | 'failed' | 'unknown';
      if (sent === segments.length) status = 'sent';
      else if (fatal) status = 'failed';
      else if (remaining) status = sent > 0 ? 'partial' : 'pending';
      // 整条是否有"可能已到达但没拿到回执"的段，以分段状态为准：
      // 这一轮跳过了上次留下的 unknown 段，本地标记并不能反映它。
      else if (segments.some((segment) => segment.status === 'unknown')) status = 'unknown';
      else status = sent > 0 ? 'partial' : 'failed';
      this.store.updateOutbound({
        id: record.id,
        segments,
        status,
        attempts,
        lastError,
        nextAttemptAt,
      });
    };

    persist();
    for (const segment of segments) {
      // 已确认的和结果未知的都不再重发：unknown 可能已经到达平台。
      if (segment.status === 'sent' || segment.status === 'unknown') continue;
      if (fatal) break;
      // 上次进程把这一段交给了平台却没等到回执：结果未知，不能重发。
      if (segment.status === 'sending') {
        segment.status = 'unknown';
        segment.error = '进程在发送途中中断，无法确认平台是否收到';
        unknown = true;
        lastError = segment.error;
        persist();
        continue;
      }
      if (segment.kind === 'file') {
        // 只认排队时固定的产物版本，而且**每次**派发都重新核验。
        // 以前只在 segment.path 为空时核验：第一次发送限速后磁盘文件被改，
        // 重试直接把新内容发了出去，还登记成"已发送"。
        const resolved = this.resolveArtifactSegment(segment);
        if (!resolved.ok) {
          segment.status = 'failed';
          segment.error = resolved.reason;
          lastError = resolved.reason;
          fatal = true;
          persist();
          break;
        }
        segment.path = resolved.path;
      }
      attempts += 1;
      // 先记为"已交给平台"，再真正发：否则进程在等待回执时死掉，
      // 数据库里还是 pending，重启会重发一条平台其实已经收到的消息。
      segment.status = 'sending';
      persist();
      let outcome: SendOutcome;
      try {
        outcome = await adapter.send({ target, segment, signal: this.lifecycle.signal });
      } catch (error) {
        // 停机取消：请求可能已经到了平台，不能当"肯定没发出去"去重发。
        outcome = this.lifecycle.signal.aborted
          ? { status: 'unknown', error: `发送被取消：${(error as Error).message}` }
          : { status: 'failed', error: (error as Error).message, retryable: true };
      }
      if (outcome.status === 'sent') {
        segment.status = 'sent';
        segment.platformMessageId = outcome.platformMessageId;
        segment.error = null;
        persist();
        continue;
      }
      if (outcome.status === 'unknown') {
        // 平台可能已经收到：不再重复发送这一段，记录真实的不确定状态，
        // 但后面的段照常发，不陪着一起停。
        segment.status = 'unknown';
        segment.error = outcome.error;
        unknown = true;
        lastError = outcome.error;
        persist();
        continue;
      }
      segment.status = 'failed';
      segment.error = outcome.error;
      lastError = outcome.error;
      fatal = !outcome.retryable;
      // 平台给了等待时间就按它等；否则按尝试次数退避，别对着限速接口空转。
      waitMs = fatal ? null : (outcome.retryAfterMs ?? backoffMs(attempts));
      persist(waitMs === null ? null : new Date(Date.now() + waitMs).toISOString());
      break;
    }

    persist(waitMs === null ? null : new Date(Date.now() + waitMs).toISOString());
  }

  /**
   * 文件段只认排队时固定的那一份产物。
   *
   * 以前是按名字现场挑"最新版本"，于是用户说"发 v1"、Worker 随后又存了 v2，
   * 真正发出去的是 v2——指纹校验只能证明 v2 自身没被篡改，证明不了它就是承诺的那份。
   */
  private resolveArtifactSegment(segment: OutboundSegment): { ok: true; path: string } | { ok: false; reason: string } {
    const artifactId = segment.artifactId;
    if (!artifactId) return { ok: false, reason: '文件段没有固定的产物版本，拒绝发送' };
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return { ok: false, reason: `产物记录不存在：${artifactId}` };
    if (segment.version !== undefined && artifact.version !== segment.version) {
      return { ok: false, reason: `产物版本不符：排队时是 v${segment.version}，登记是 v${artifact.version}` };
    }
    if (segment.sha256 !== undefined && artifact.sha256 !== segment.sha256) {
      return { ok: false, reason: '产物指纹与排队时登记的不一致，拒绝发送' };
    }
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
