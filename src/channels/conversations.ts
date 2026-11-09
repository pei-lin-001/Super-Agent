/**
 * 对话话题：一个聊天窗口（session_key）里可以有多个互相独立的话题。
 *
 * 三层身份要分清：
 *   - 聊天入口 = session_key（平台地址：谁在哪个机器人/群里说话），不随话题变化；
 *   - 对话话题 = conversation_id，历史、任务、待续接执行都挂在它上面；
 *   - 一次 Router 执行 = router_session，属于某一个话题。
 *
 * 只有程序决定"当前是哪个话题"，模型只表达意图。
 */
import { newConversationId, nowIso } from '../domain/ids.ts';
import type { Store } from '../storage/store.ts';
import { parseSessionKey } from './types.ts';

export interface Conversation {
  id: string;
  sessionKey: string;
  title: string;
  status: string;
  lastMessageAt: string | null;
}

/** 自动起名：按码点取首条消息前 20 字，压掉换行。 */
export function autoTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length === 0) return '新话题';
  return chars.length <= 20 ? chars.join('') : `${chars.slice(0, 20).join('')}…`;
}

export type ConversationCommand =
  | { kind: 'new'; title: string | null }
  | { kind: 'list' }
  | { kind: 'use'; ref: string }
  | { kind: 'name'; title: string }
  | { kind: 'archive' };

/** 解析显式命令；不是话题命令返回 null（交给 Router 当普通话说）。 */
export function parseCommand(text: string): ConversationCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();
  if (name === 'new' || name === 'topic') return { kind: 'new', title: rest === '' ? null : rest };
  if (name === 'list' || name === 'topics') return { kind: 'list' };
  if (name === 'use') return rest === '' ? null : { kind: 'use', ref: rest };
  if (name === 'name' || name === 'rename') return rest === '' ? null : { kind: 'name', title: rest };
  if (name === 'archive' || name === 'close') return { kind: 'archive' };
  return null;
}

export class ConversationService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * 取当前话题；这个聊天还没有任何话题时自动建默认话题。
   *
   * 指针失效（话题被归档/删掉）也走这里重建，避免把消息丢进不存在的话题。
   */
  ensureCurrent(sessionKey: string, firstMessage?: string): Conversation {
    const currentId = this.store.currentConversationId(sessionKey);
    if (currentId !== null) {
      const current = this.store.getConversation(currentId);
      if (current && current.status === 'active') return current;
    }
    const active = this.store.listConversations(sessionKey).at(-1);
    if (active) {
      this.ensureSessionRow(sessionKey);
      this.store.setCurrentConversation(sessionKey, active.id);
      return active;
    }
    const created = this.create(
      sessionKey,
      firstMessage === undefined ? '默认话题' : autoTitle(firstMessage),
    );
    // 第一次有话题时，把升级前的历史与入站记录收进来，避免"升级后突然失忆"、
    // 以及"文件不知道属于哪个话题"。
    this.store.adoptOrphanRouterTurns(sessionKey, created.id);
    this.store.adoptOrphanInbound(sessionKey, created.id);
    return created;
  }

  /**
   * 确保聊天会话行存在。
   *
   * "当前话题"指针存在 channel_session 上；第一句话就是 /new 时这行还没建，
   * 指针会写空，之后的 /use 就会静悄悄失效。
   */
  private ensureSessionRow(sessionKey: string): void {
    if (this.store.getChannelSession(sessionKey)) return;
    const parts = parseSessionKey(sessionKey);
    if (!parts) return;
    this.store.upsertChannelSession({
      sessionKey,
      channel: parts.channel,
      accountId: parts.accountId,
      peerId: parts.peerId,
    });
  }

  create(sessionKey: string, title: string): Conversation {
    const id = newConversationId();
    this.store.createConversation({ id, sessionKey, title: autoTitle(title), now: nowIso() });
    this.ensureSessionRow(sessionKey);
    this.store.setCurrentConversation(sessionKey, id);
    return { id, sessionKey, title: autoTitle(title), status: 'active', lastMessageAt: nowIso() };
  }

  list(sessionKey: string, status: 'active' | 'archived' | 'all' = 'active'): Conversation[] {
    return this.store.listConversations(sessionKey, status);
  }

  /**
   * 按 /list 里显示的编号（从 1 开始）或话题 id 找话题。
   *
   * 编号覆盖归档话题：归档一个话题不该让后面所有话题的编号往前跳，
   * 用户记忆中的「3 号」必须一直是同一个话题。
   */
  resolve(sessionKey: string, ref: string): Conversation | null {
    const list = this.store.listConversations(sessionKey, 'all');
    const byId = list.find((item) => item.id === ref);
    if (byId) return byId;
    const index = Number(ref.replace(/^#/, ''));
    if (Number.isInteger(index) && index >= 1 && index <= list.length) return list[index - 1]!;
    return list.find((item) => item.title === ref) ?? null;
  }

  switchTo(sessionKey: string, ref: string): Conversation | null {
    const target = this.resolve(sessionKey, ref);
    if (!target) return null;
    this.ensureSessionRow(sessionKey);
    // 切到归档话题 = 恢复它：用户没有别的入口能把归档翻回来。
    if (target.status === 'archived') {
      this.store.setConversationStatus(target.id, 'active');
      target.status = 'active';
    }
    this.store.setCurrentConversation(sessionKey, target.id);
    return target;
  }

  rename(sessionKey: string, title: string): Conversation | null {
    const current = this.ensureCurrent(sessionKey);
    const clean = title.replace(/\s+/g, ' ').trim();
    if (clean === '') return null;
    this.store.renameConversation(current.id, autoTitle(clean));
    return { ...current, title: autoTitle(clean) };
  }

  archive(sessionKey: string): Conversation | null {
    const current = this.store.currentConversationId(sessionKey);
    if (current === null) return null;
    const conversation = this.store.getConversation(current);
    if (!conversation) return null;
    this.store.setConversationStatus(conversation.id, 'archived');
    return conversation;
  }

  /** 当前话题的标题（回信标注用）；话题不存在返回 null。 */
  titleOf(conversationId: string | null): string | null {
    if (conversationId === null) return null;
    return this.store.getConversation(conversationId)?.title ?? null;
  }

  /**
   * 处理一条显式命令，返回要回给用户的确定性文本；不是话题命令返回 null。
   *
   * 命令走代码而不是模型：新建、切换、列出必须是确定的，不能让模型自由发挥。
   */
  handleCommand(sessionKey: string, text: string): string | null {
    const command = parseCommand(text);
    if (!command) return null;
    if (command.kind === 'list') {
      const list = this.store.listConversations(sessionKey, 'all');
      const currentId = this.ensureCurrent(sessionKey).id;
      if (list.length === 0) return '还没有任何话题。直接说话就会自动建一个。';
      const lines = list.map((item, index) => {
        const mark = item.id === currentId ? '●' : '○';
        const tag = item.status === 'archived' ? '（已归档）' : '';
        return `${mark} ${index + 1}. ${item.title}${tag}`;
      });
      return `话题（● 当前）：\n${lines.join('\n')}\n用 /use 编号 切换（切到归档话题会恢复它）。`;
    }
    if (command.kind === 'new') {
      const title = command.title ?? '新话题';
      const created = this.create(sessionKey, title);
      return `已新建并切换到话题「${created.title}」。之前的任务仍在后台跑，完成后会标注话题名发回这里。`;
    }
    if (command.kind === 'use') {
      const wasArchived = this.resolve(sessionKey, command.ref)?.status === 'archived';
      const target = this.switchTo(sessionKey, command.ref);
      if (!target) return `没找到话题「${command.ref}」。用 /list 看已有话题。`;
      return wasArchived ? `已恢复并切换到话题「${target.title}」。` : `已切换到话题「${target.title}」。`;
    }
    if (command.kind === 'name') {
      const renamed = this.rename(sessionKey, command.title);
      if (!renamed) return '话题名不能为空。';
      return `当前话题已改名为「${renamed.title}」。`;
    }
    const archived = this.archive(sessionKey);
    if (!archived) return '当前没有可归档的话题。';
    const next = this.store.listConversations(sessionKey).at(-1);
    if (next) {
      this.ensureSessionRow(sessionKey);
      this.store.setCurrentConversation(sessionKey, next.id);
    }
    return `已归档话题「${archived.title}」。${next ? `已切换到「${next.title}」。` : ''}`;
  }
}
