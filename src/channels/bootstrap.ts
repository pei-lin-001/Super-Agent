/**
 * 按配置把渠道接上：只装配已启用且配置完整的平台。
 *
 * 未启用任何 IM 时返回 null，主系统行为与之前完全一致。
 */
import type { Config } from '../config.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { Store } from '../storage/store.ts';
import { ChannelService } from './service.ts';
import { TelegramAdapter } from './telegram.ts';
import { WeixinAdapter, WeixinCredentialStore } from './weixin.ts';
import { parseSessionKey, type ChannelAdapter, type ContextTokenStore } from './types.ts';
import { join } from 'node:path';

/**
 * 用渠道会话表当 context_token 的存取点。
 *
 * 入站那一刻会话行往往还不存在：不能因为"没有行"就把令牌丢掉，
 * 否则回复时会缺上下文。这里按会话键自己把行建出来。
 */
export function createContextTokenStore(store: Store): ContextTokenStore {
  return {
    get: (sessionKey) => store.getChannelSession(sessionKey)?.contextToken ?? null,
    set: (sessionKey, token) => {
      const identity = parseSessionKey(sessionKey);
      if (!identity) return;
      store.upsertChannelSession({
        sessionKey,
        channel: identity.channel,
        accountId: identity.accountId,
        peerId: identity.peerId,
        touch: 'inbound',
      });
      store.setChannelContextToken(sessionKey, token);
    },
  };
}

export interface ChannelBootstrap {
  service: ChannelService;
  /** 已接上的平台说明，用于启动日志（不含任何凭据）。 */
  summary: string[];
  /** 已启用但缺条件、因此没有接上的平台说明。 */
  problems: string[];
}

export function createChannelService(options: {
  runtime: Runtime;
  store: Store;
  config: Config;
  log?: (message: string) => void;
}): ChannelBootstrap | null {
  const { runtime, store, config } = options;
  const adapters: ChannelAdapter[] = [];
  const summary: string[] = [];
  const problems: string[] = [];

  const telegram = config.channels.telegram;
  if (telegram.enabled) {
    if (telegram.botToken === '') {
      problems.push('Telegram 已启用但缺少 TELEGRAM_BOT_TOKEN');
    } else {
      const adapter = new TelegramAdapter({
        token: telegram.botToken,
        ownerIds: telegram.ownerIds,
        apiBase: telegram.apiBase,
        workDir: config.workDir,
        pollTimeoutMs: config.channels.pollTimeoutMs,
        maxInboundBytes: config.channels.maxInboundBytes,
      });
      adapters.push(adapter);
      summary.push(
        `telegram 账号 ${adapter.accountId}：主人 ${telegram.ownerIds.length > 0 ? telegram.ownerIds.join('、') : '未绑定'}`,
      );
    }
  }

  const weixin = config.channels.weixin;
  if (weixin.enabled) {
    const credentialsDir = join(config.channels.stateDir, 'weixin');
    const credentials = new WeixinCredentialStore(credentialsDir);
    const accountIds = credentials.list();
    if (accountIds.length === 0) {
      problems.push(
        `微信已启用但还没有登录凭据；先运行 pnpm channel:weixin-login 扫码（凭据目录 ${credentialsDir}）`,
      );
    }
    for (const accountId of accountIds) {
      const saved = credentials.load(accountId);
      if (!saved || saved.botToken === '') {
        problems.push(`微信账号 ${accountId} 的凭据不完整，已跳过`);
        continue;
      }
      const adapter = new WeixinAdapter({
        credentials: saved,
        ownerIds: weixin.ownerIds,
        workDir: config.workDir,
        pollTimeoutMs: config.channels.pollTimeoutMs,
        maxInboundBytes: config.channels.maxInboundBytes,
        contextTokens: createContextTokenStore(store),
      });
      adapters.push(adapter);
      const owners = adapter.ownerIds();
      summary.push(
        `weixin 账号 ${accountId}：主人 ${owners.length > 0 ? owners.join('、') : '未绑定（扫码时未返回用户 ID）'}`,
      );
    }
  }

  if (adapters.length === 0) {
    // 只有真正接上了才创建服务；否则返回 null，避免主系统多出一个空循环。
    if (problems.length > 0) {
      return { service: new ChannelService({ runtime, store, config, log: options.log }), summary, problems };
    }
    return null;
  }

  const service = new ChannelService({ runtime, store, config, log: options.log });
  for (const adapter of adapters) service.register(adapter);
  return { service, summary, problems };
}
