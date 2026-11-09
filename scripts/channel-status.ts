/**
 * 查看渠道状态：账号、主人绑定、游标、待处理收发与需要人介入的问题。
 *
 * 只读；不打印任何凭据。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/storage/store.ts';
import { WeixinCredentialStore } from '../src/channels/weixin.ts';

const config = loadConfig({ requireModel: false });
if (!existsSync(config.dbPath)) {
  console.log(`数据库还不存在：${config.dbPath}`);
}
const store = new Store(config.dbPath, { instanceId: 'channel-status' });
try {
  console.log(`Telegram：${config.channels.telegram.enabled ? '已启用' : '未启用'}` +
    `｜主人 ${config.channels.telegram.ownerIds.join('、') || '未绑定'}` +
    `｜token ${config.channels.telegram.botToken === '' ? '缺失' : '已配置'}`);

  const weixinDir = join(config.channels.stateDir, 'weixin');
  const credentials = new WeixinCredentialStore(weixinDir);
  const accounts = credentials.list();
  console.log(`微信：${config.channels.weixin.enabled ? '已启用' : '未启用'}` +
    `｜已登录账号 ${accounts.length > 0 ? accounts.join('、') : '无'}`);
  for (const accountId of accounts) {
    const saved = credentials.load(accountId);
    console.log(`  - ${accountId}｜扫码用户 ${saved?.ownerUserId ?? '未知'}｜API ${saved?.baseUrl ?? '-'}`);
  }

  const rows = ['telegram', 'weixin'].flatMap((channel) => {
    const accountsOfChannel = channel === 'weixin' ? accounts : [config.channels.telegram.botToken.split(':')[0] ?? ''];
    return accountsOfChannel
      .filter((accountId) => accountId !== '')
      .map((accountId) => {
        const account = channel === 'weixin' ? accountId : `bot_${accountId}`;
        return {
          channel,
          account,
          cursor: store.getChannelCursor(channel, account),
        };
      });
  });
  console.log('');
  console.log('游标：');
  for (const row of rows) {
    console.log(`  - ${row.channel}/${row.account}：${row.cursor ?? '（尚无）'}`);
  }

  const pending = store.listPendingInbound(100);
  const outbound = store.listPendingOutbound(100);
  console.log('');
  console.log(`待处理入站：${pending.length}｜待发送：${outbound.length}`);
  for (const item of outbound.slice(0, 10)) {
    const segments = (Array.isArray(item.segments) ? item.segments : []) as { status: string }[];
    const states = segments.map((segment) => segment.status).join(',');
    console.log(`  - ${item.id}｜${item.channel}/${item.peerId}｜尝试 ${item.attempts}｜分段 ${states}`);
  }

  const sessions = store.listChannelSessions();
  if (sessions.length > 0) {
    console.log('');
    console.log('渠道会话：');
    for (const session of sessions) {
      console.log(
        `  - ${session.channel}/${session.peerId}｜回复上下文 ${session.hasContextToken ? '已保存' : '无'}` +
          `｜最近入站 ${session.lastInboundAt ?? '-'}｜最近出站 ${session.lastOutboundAt ?? '-'}`,
      );
    }
  }
} finally {
  store.close();
}
