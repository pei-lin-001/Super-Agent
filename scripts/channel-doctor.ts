/**
 * 真实平台联调前的自检。
 *
 * 只做只读检查，不发任何消息、不消费任何消息：
 * - Telegram：getMe 验证令牌；getChat 验证主人 id 且确认是私聊。
 * - 微信：读取本地凭据，getconfig 验证令牌仍然有效。
 *
 * 退出码 0 = 至少一个渠道完全就绪；1 = 还缺条件（逐条给出补法）。
 * 它不能替代真实收发联调：能证明的是"凭据有效、目标正确"，不是"消息能收发"。
 */
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { WeixinCredentialStore } from '../src/channels/weixin.ts';
import { existsSync } from 'node:fs';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** 缺条件时怎么补。 */
  fix?: string;
}

const checks: Check[] = [];
const add = (check: Check): void => {
  checks.push(check);
};

const config = loadConfig({ requireModel: false });
const telegram = config.channels.telegram;
const weixin = config.channels.weixin;

// ---- Telegram ----
if (!telegram.enabled) {
  add({ name: 'Telegram 已启用', ok: false, detail: 'TELEGRAM_ENABLED 不是 1', fix: '在 .env.local 设 TELEGRAM_ENABLED=1' });
} else if (telegram.botToken === '') {
  add({ name: 'Telegram 令牌', ok: false, detail: 'TELEGRAM_BOT_TOKEN 为空', fix: '向 @BotFather 要令牌填进 .env.local' });
} else {
  const base = telegram.apiBase.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/bot${telegram.botToken}/getMe`);
    const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    add({
      name: 'Telegram 令牌有效',
      ok: body.ok === true,
      detail: body.ok === true ? `机器人 @${body.result?.username ?? '?'}` : (body.description ?? `HTTP ${response.status}`),
      fix: body.ok === true ? undefined : '令牌无效或已撤销，去 @BotFather 重新签发',
    });
  } catch (error) {
    add({
      name: 'Telegram 令牌有效',
      ok: false,
      detail: `请求失败：${(error as Error).message}`,
      fix: '检查网络或代理；TELEGRAM_API_BASE 是否可访问',
    });
  }

  if (telegram.ownerIds.length === 0) {
    add({
      name: 'Telegram 主人 id',
      ok: false,
      detail: 'TELEGRAM_OWNER_IDS 为空',
      fix: '给你的机器人发一条消息，再访问 getUpdates 拿 from.id（数字），填进 .env.local',
    });
  } else {
    for (const ownerId of telegram.ownerIds) {
      if (!/^\d+$/.test(ownerId)) {
        add({ name: `主人 id ${ownerId}`, ok: false, detail: '不是数字 id（@username 不算）', fix: '用数字 user id' });
        continue;
      }
      try {
        const response = await fetch(`${base}/bot${telegram.botToken}/getChat?chat_id=${ownerId}`);
        const body = (await response.json()) as {
          ok?: boolean;
          result?: { type?: string; first_name?: string; username?: string };
          description?: string;
        };
        const type = body.result?.type ?? '';
        add({
          name: `主人 ${ownerId} 可达`,
          ok: body.ok === true && type === 'private',
          detail: body.ok === true ? `类型 ${type}，${body.result?.first_name ?? ''}` : (body.description ?? `HTTP ${response.status}`),
          fix: body.ok === true && type === 'private' ? undefined : '先给机器人发一条消息，让它能主动给你发消息',
        });
      } catch (error) {
        add({ name: `主人 ${ownerId} 可达`, ok: false, detail: `请求失败：${(error as Error).message}` });
      }
    }
  }
}

// ---- 微信 ----
const weixinDir = join(config.channels.stateDir, 'weixin');
const credentials = new WeixinCredentialStore(weixinDir);
const accounts = existsSync(weixinDir) ? credentials.list() : [];
if (!weixin.enabled) {
  add({ name: '微信已启用', ok: false, detail: 'WEIXIN_ENABLED 不是 1', fix: '扫码后再设 WEIXIN_ENABLED=1' });
} else if (accounts.length === 0) {
  add({
    name: '微信凭据',
    ok: false,
    detail: `凭据目录里没有账号（${weixinDir}）`,
    fix: 'pnpm channel:weixin-login 扫码登录',
  });
} else {
  for (const accountId of accounts) {
    const saved = credentials.load(accountId);
    if (!saved || saved.botToken === '') {
      add({ name: `微信账号 ${accountId}`, ok: false, detail: '凭据不完整', fix: '重新扫码登录' });
      continue;
    }
    const owner = (weixin.ownerIds[0] ?? saved.ownerUserId ?? '').trim();
    if (owner === '') {
      add({
        name: `微信账号 ${accountId} 主人`,
        ok: false,
        detail: '扫码未返回用户 id，且 WEIXIN_OWNER_IDS 为空',
        fix: '在 .env.local 设 WEIXIN_OWNER_IDS',
      });
      continue;
    }
    try {
      // 只读校验：getconfig 不会取走待收消息。
      const response = await fetch(`${saved.baseUrl.replace(/\/+$/, '')}/ilink/bot/getconfig`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${saved.botToken}`,
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '65536',
        },
        body: JSON.stringify({
          ilink_user_id: owner,
          base_info: { channel_version: '1.0.0', bot_agent: 'Super-Agent' },
        }),
      });
      const body = (await response.json().catch(() => null)) as { ret?: number; errmsg?: string } | null;
      add({
        name: `微信账号 ${accountId} 令牌有效`,
        ok: response.ok && (body?.ret ?? 1) === 0,
        detail: response.ok ? `ret=${body?.ret ?? '?'} ${body?.errmsg ?? ''}`.trim() : `HTTP ${response.status}`,
        fix: response.ok && (body?.ret ?? 1) === 0 ? undefined : '令牌可能已过期，重新扫码登录',
      });
    } catch (error) {
      add({
        name: `微信账号 ${accountId} 令牌有效`,
        ok: false,
        detail: `请求失败：${(error as Error).message}`,
        fix: '检查网络；WEIXIN_API_BASE 是否可访问',
      });
    }
  }
}

add({
  name: '真实收发联调',
  ok: false,
  detail: '需要人在手机上实际收发；本脚本不代替它',
  fix: '条件齐了后：发一条消息 → 看回信 → 发一个文件 → 等任务跑完回文件',
});

console.log('渠道自检（只读，不发送也不消费消息）');
console.log('');
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
  if (!check.ok && check.fix) console.log(`    怎么补：${check.fix}`);
}
const ready = checks.filter((check) => check.name !== '真实收发联调').every((check) => check.ok);
console.log('');
if (ready) {
  console.log('凭据与目标都已就绪。下一步是手机上实测收发——这一步只能人来做，结果以真实聊天为准。');
  process.exitCode = 0;
} else {
  console.log('还缺条件：按上面「怎么补」逐条处理，齐了再跑一次本命令。');
  process.exitCode = 1;
}
