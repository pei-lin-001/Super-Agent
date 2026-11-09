/**
 * 个人微信（iLink）扫码登录。
 *
 * 用法：pnpm channel:weixin-login
 *
 * 只做一件事：拿到二维码 → 等手机确认 → 把凭据写进渠道状态目录（0600）。
 * 不打印、不记录 bot token；二维码内容只输出到标准输出，供你用任意方式转成二维码。
 * 服务器没有桌面环境时，把这个链接复制到手机或任意设备的二维码工具里打开即可。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.ts';
import { loginWithQr, WeixinCredentialStore } from '../src/channels/weixin.ts';

async function main(): Promise<void> {
  const config = loadConfig({ requireModel: false });
  const weixin = config.channels.weixin;
  const dir = join(config.channels.stateDir, 'weixin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  console.log(`API 地址：${weixin.apiBase}`);
  console.log(`凭据目录：${dir}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  const result = await loginWithQr({
    apiBase: weixin.apiBase,
    cdnBase: weixin.cdnBase,
    timeoutMs: 300_000,
    signal: controller.signal,
    onQr: (url) => {
      console.log('');
      console.log('请用手机微信扫描下面这串内容对应的二维码：');
      console.log('');
      console.log(url);
      console.log('');
      console.log('（把上面这行复制进任意二维码工具即可生成可扫的图；本工具不内置渲染，避免引入新依赖。）');
      // 同时写一份到文件，方便转发到手机。
      const outPath = join(dir, 'last-qr.txt');
      writeFileSync(outPath, `${url}\n`, { mode: 0o600 });
      console.log(`已另存一份：${outPath}`);
      console.log('');
    },
    onStatus: (status) => {
      if (status === 'scaned') console.log('已扫码，等待确认…');
      if (status === 'wait') return;
    },
    askVerifyCode: async () => {
      // 后台运行时没有可交互的终端：不要假装能收输入，直接说明要重跑。
      if (!process.stdin.isTTY) {
        console.log('需要输入手机验证码，但当前没有可交互终端；请在前台重跑本命令。');
        return null;
      }
      const code = await rl.question('手机微信上显示的数字：');
      return code.trim() === '' ? null : code.trim();
    },
  });

  rl.close();

  if (!result.connected || !result.credentials) {
    console.error(`登录未完成：${result.message}`);
    process.exitCode = 1;
    return;
  }
  const store = new WeixinCredentialStore(dir);
  const path = store.save(result.credentials);
  console.log(`已保存凭据：${path}（权限 0600）`);
  console.log(`机器人 ID：${result.credentials.ilinkBotId}`);
  console.log(`扫码用户：${result.credentials.ownerUserId ?? '（服务端未返回，需要显式配置 WEIXIN_OWNER_IDS）'}`);
  console.log('');
  console.log('下一步：在 .env.local 里设置 WEIXIN_ENABLED=1，然后重启 daemon。');
}

main().catch((error: unknown) => {
  console.error('登录失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
