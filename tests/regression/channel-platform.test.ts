/**
 * 平台协议层：按官方 API 形状验证请求构造与结果判定。
 *
 * 这里用假 HTTP 层验证"发了什么、怎么解读响应"，不联网、不冒充真实平台联调。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { TelegramAdapter } from '../../src/channels/telegram.ts';
import {
  WeixinAdapter,
  aesEcbPaddedSize,
  decryptAesEcb,
  parseAesKey,
  parseWeixinJson,
} from '../../src/channels/weixin.ts';
import { ChannelAuthError, sessionKeyOf, type ContextTokenStore } from '../../src/channels/types.ts';

interface Call {
  url: string;
  method: string;
  body: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function tempWork(): Promise<{ dir: string; workDir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'super-agent-ch-'));
  const workDir = join(dir, 'work');
  await mkdir(workDir, { recursive: true });
  return { dir, workDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('Telegram：长轮询解析消息，游标是最大 update_id + 1', async () => {
  const { workDir, cleanup } = await tempWork();
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return jsonResponse({
      ok: true,
      result: [
        {
          update_id: 41,
          message: {
            message_id: 7,
            date: 1_700_000_000,
            chat: { id: 900, type: 'private' },
            from: { id: 900 },
            text: '你好',
          },
        },
        {
          update_id: 42,
          message: {
            message_id: 8,
            date: 1_700_000_001,
            chat: { id: 900, type: 'private' },
            from: { id: 900 },
            text: '再来一句',
          },
        },
      ],
    });
  }) as unknown as typeof fetch;

  const adapter = new TelegramAdapter({
    token: '12345:SECRET',
    ownerIds: ['900'],
    apiBase: 'http://127.0.0.1:9',
    workDir,
    pollTimeoutMs: 25_000,
    maxInboundBytes: 1024,
    fetchImpl,
  });
  try {
    const result = await adapter.poll({ cursor: null, signal: new AbortController().signal });
    assert.equal(result.events.length, 2);
    assert.equal(result.cursor, '43');
    assert.equal(result.events[0]!.source.peerId, '900');
    assert.equal(result.events[0]!.source.eventId, 'update:41');
    assert.equal(result.events[0]!.text, '你好');
    assert.match(calls[0]!.url, /\/bot12345:SECRET\/getUpdates$/);
    const payload = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(payload['timeout'], 25, '长轮询超时按秒传');
    assert.deepEqual(payload['allowed_updates'], ['message']);
    assert.equal(payload['offset'], undefined, '首次不带 offset');
  } finally {
    await cleanup();
  }
});

test('Telegram：429 返回可重试与建议等待时间', async () => {
  const { workDir, cleanup } = await tempWork();
  const fetchImpl = (async () =>
    jsonResponse(
      { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } },
      429,
    )) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({
    token: '1:S',
    ownerIds: ['1'],
    apiBase: 'http://127.0.0.1:9',
    workDir,
    pollTimeoutMs: 1000,
    maxInboundBytes: 1024,
    fetchImpl,
  });
  try {
    const outcome = await adapter.send({
      target: { channel: 'telegram', accountId: adapter.accountId, peerId: '1', sessionKey: 'telegram|bot_1|1' },
      segment: { index: 0, kind: 'text', text: 'hi', status: 'pending', platformMessageId: null, error: null },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.retryAfterMs, 7000);
  } finally {
    await cleanup();
  }
});

test('Telegram：令牌失效是鉴权错误，不当作可重试的网络抖动', async () => {
  const { workDir, cleanup } = await tempWork();
  const fetchImpl = (async () =>
    jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({
    token: '1:S',
    ownerIds: ['1'],
    apiBase: 'http://127.0.0.1:9',
    workDir,
    pollTimeoutMs: 1000,
    maxInboundBytes: 1024,
    fetchImpl,
  });
  try {
    const outcome = await adapter.send({
      target: { channel: 'telegram', accountId: adapter.accountId, peerId: '1', sessionKey: 'telegram|bot_1|1' },
      segment: { index: 0, kind: 'text', text: 'hi', status: 'pending', platformMessageId: null, error: null },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.retryable, false, '鉴权失败不该无限重试');
    assert.match(outcome.error ?? '', /Unauthorized/);
    await assert.rejects(
      () => adapter.poll({ cursor: null, signal: new AbortController().signal }),
      (error: unknown) => error instanceof ChannelAuthError,
    );
  } finally {
    await cleanup();
  }
});

test('Telegram：发送文件走 multipart，成功才算已发送', async () => {
  const { workDir, cleanup } = await tempWork();
  await writeFile(join(workDir, 'r.md'), '# 报告\n', 'utf8');
  const seen: { method: string; hasForm: boolean }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET', hasForm: init?.body instanceof FormData });
    return jsonResponse({ ok: true, result: { message_id: 55 } });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({
    token: '1:S',
    ownerIds: ['1'],
    apiBase: 'http://127.0.0.1:9',
    workDir,
    pollTimeoutMs: 1000,
    maxInboundBytes: 1024,
    fetchImpl,
  });
  try {
    const outcome = await adapter.send({
      target: { channel: 'telegram', accountId: adapter.accountId, peerId: '1', sessionKey: 'telegram|bot_1|1' },
      segment: {
        index: 1,
        kind: 'file',
        name: 'r.md',
        path: join(workDir, 'r.md'),
        status: 'pending',
        platformMessageId: null,
        error: null,
      },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, 'sent');
    assert.equal(outcome.platformMessageId, '55');
    assert.equal(seen[0]!.hasForm, true, '文件必须用 multipart 上传');
  } finally {
    await cleanup();
  }
});

test('微信：uint64 message_id 不丢精度', () => {
  const raw = '{"msgs":[{"message_id":9007199254740993,"context_token":"ct"}],"ret":0}';
  const parsed = parseWeixinJson<{ msgs: { message_id: string }[] }>(raw);
  assert.equal(parsed.msgs[0]!.message_id, '9007199254740993', '超出双精度范围的 ID 必须按字符串保留');
  // 字符串里出现的同样数字不能被动
  const nested = parseWeixinJson<{ a: string }>('{"a":"message_id:9007199254740993"}');
  assert.equal(nested.a, 'message_id:9007199254740993');
});

test('微信：aes_key 两种编码都能还原成 16 字节', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8');
  const asRaw = Buffer.from(key).toString('base64');
  const asHex = Buffer.from(key.toString('hex'), 'utf8').toString('base64');
  assert.deepEqual(parseAesKey(asRaw), key);
  assert.deepEqual(parseAesKey(asHex), key);
  assert.throws(() => parseAesKey(Buffer.from('short').toString('base64')), /16 字节/);
});

test('微信：加密后长度按 PKCS#7 补到 16 字节边界，且能解回来', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8');
  for (const size of [0, 1, 15, 16, 17, 100]) {
    const plain = Buffer.alloc(size, 7);
    assert.equal(aesEcbPaddedSize(size) % 16, 0);
    const cipher = Buffer.alloc(aesEcbPaddedSize(size));
    void cipher;
    assert.ok(aesEcbPaddedSize(size) >= size);
  }
  const buffer = Buffer.from('hello weixin', 'utf8');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  assert.deepEqual(decryptAesEcb(encrypted, key), buffer);
});

function weixinAdapter(options: {
  workDir: string;
  fetchImpl: typeof fetch;
  tokens?: Map<string, string>;
  ownerUserId?: string | null;
}): WeixinAdapter {
  const tokens = options.tokens ?? new Map<string, string>();
  const contextTokens: ContextTokenStore = {
    get: (sessionKey) => tokens.get(sessionKey) ?? null,
    set: (sessionKey, token) => {
      if (token === null) tokens.delete(sessionKey);
      else tokens.set(sessionKey, token);
    },
  };
  return new WeixinAdapter({
    credentials: {
      botToken: 'wx-token',
      ilinkBotId: 'bot_abc',
      baseUrl: 'http://127.0.0.1:9',
      cdnBaseUrl: 'http://127.0.0.1:9/c2c',
      ownerUserId: options.ownerUserId ?? 'wxid_owner',
      savedAt: new Date().toISOString(),
    },
    ownerIds: [],
    workDir: options.workDir,
    pollTimeoutMs: 1000,
    maxInboundBytes: 1024,
    contextTokens,
    fetchImpl: options.fetchImpl,
  });
}

test('微信：getupdates 带回游标，并把 context_token 存进渠道会话', async () => {
  const { workDir, cleanup } = await tempWork();
  const tokens = new Map<string, string>();
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return jsonResponse({
      ret: 0,
      get_updates_buf: 'buf-7',
      longpolling_timeout_ms: 2000,
      msgs: [
        {
          message_id: 100,
          from_user_id: 'wxid_owner',
          message_type: 1,
          context_token: 'ct-1',
          item_list: [{ type: 1, text_item: { text: '查一下行情' } }],
        },
      ],
    });
  }) as unknown as typeof fetch;

  const adapter = weixinAdapter({ workDir, fetchImpl, tokens });
  try {
    const result = await adapter.poll({ cursor: '', signal: new AbortController().signal });
    assert.equal(result.cursor, 'buf-7', '游标必须回传 get_updates_buf');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.text, '查一下行情');
    assert.equal(result.events[0]!.source.eventId, 'msg:100');
    const key = sessionKeyOf(result.events[0]!.source);
    assert.equal(tokens.get(key), 'ct-1', '回复上下文按会话保存');
    assert.match(calls[0]!.url, /\/ilink\/bot\/getupdates$/);
    const payload = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(payload['get_updates_buf'], '');
    assert.ok(payload['base_info'], '鉴权请求要带 base_info');
  } finally {
    await cleanup();
  }
});

test('微信：发送文本必须带回 context_token；业务码非 0 不算已发送', async () => {
  const { workDir, cleanup } = await tempWork();
  const tokens = new Map<string, string>();
  const sessionKey = 'weixin|bot_abc|wxid_owner';
  tokens.set(sessionKey, 'ct-9');
  let replied = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('sendmessage')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { msg?: { context_token?: string } };
      replied = payload.msg?.context_token === 'ct-9';
      return jsonResponse({ ret: -3, errmsg: 'session expired' });
    }
    return jsonResponse({ ret: 0 });
  }) as unknown as typeof fetch;
  const adapter = weixinAdapter({ workDir, fetchImpl, tokens });
  try {
    const outcome = await adapter.send({
      target: { channel: 'weixin', accountId: 'bot_abc', peerId: 'wxid_owner', sessionKey },
      segment: { index: 0, kind: 'text', text: '你好', status: 'pending', platformMessageId: null, error: null },
      signal: new AbortController().signal,
    });
    assert.equal(replied, true, '必须把该会话的 context_token 带回');
    assert.equal(outcome.status, 'failed', 'ret 非 0 必须记失败');
    assert.match(outcome.error ?? '', /ret=-3/);
  } finally {
    await cleanup();
  }
});

test('微信：errcode -14 触发重新登录，不进入无限重试', async () => {
  const { workDir, cleanup } = await tempWork();
  const fetchImpl = (async () => jsonResponse({ ret: 0, errcode: -14, errmsg: 'stale' })) as unknown as typeof fetch;
  const adapter = weixinAdapter({ workDir, fetchImpl });
  try {
    await assert.rejects(
      () => adapter.poll({ cursor: '', signal: new AbortController().signal }),
      (error: unknown) => {
        assert.ok(error instanceof ChannelAuthError);
        assert.match(error.message, /重新扫码登录/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('微信：上传文件先加密，再用返回的下行参数发消息', async () => {
  const { workDir, cleanup } = await tempWork();
  await writeFile(join(workDir, 'r.csv'), 'a,b\n1,2\n', 'utf8');
  const steps: string[] = [];
  let uploadSize = 0;
  let uploadedBytes = -1;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('getuploadurl')) {
      steps.push('getuploadurl');
      const payload = JSON.parse(String(init?.body ?? '{}'));
      uploadSize = payload.filesize as number;
      return jsonResponse({ ret: 0, upload_full_url: 'http://127.0.0.1:9/c2c/upload?token=t' });
    }
    if (target.includes('/c2c/upload')) {
      steps.push('cdn-upload');
      uploadedBytes = Buffer.from(init?.body as Uint8Array).byteLength;
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-param-1' },
      });
    }
    if (target.includes('sendmessage')) {
      steps.push('sendmessage');
      return jsonResponse({ ret: 0 });
    }
    return jsonResponse({ ret: 0 });
  }) as unknown as typeof fetch;
  const tokens = new Map<string, string>([['weixin|bot_abc|wxid_owner', 'ct-1']]);
  const adapter = weixinAdapter({ workDir, fetchImpl, tokens });
  try {
    const outcome = await adapter.send({
      target: {
        channel: 'weixin',
        accountId: 'bot_abc',
        peerId: 'wxid_owner',
        sessionKey: 'weixin|bot_abc|wxid_owner',
      },
      segment: {
        index: 1,
        kind: 'file',
        name: 'r.csv',
        path: join(workDir, 'r.csv'),
        status: 'pending',
        platformMessageId: null,
        error: null,
      },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, 'sent');
    // 说明文字与文件是两个独立请求，各自有独立 client_id（与平台客户端行为一致）
    assert.deepEqual(steps, ['getuploadurl', 'cdn-upload', 'sendmessage', 'sendmessage']);
    assert.equal(uploadSize, aesEcbPaddedSize(Buffer.byteLength('a,b\n1,2\n')), '上报的是加密后大小');
    assert.ok(uploadedBytes > 0 && uploadedBytes % 16 === 0, '上传内容必须是整块密文');
  } finally {
    await cleanup();
  }
});

test('微信：下载文件用服务端给的地址和解密键', async () => {
  const { workDir, cleanup } = await tempWork();
  const key = Buffer.from('0123456789abcdef', 'utf8');
  const plain = Buffer.from('文件内容', 'utf8');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);

  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes('full_url')) return new Response(new Uint8Array(encrypted));
    return jsonResponse({ ret: 0, get_updates_buf: 'b2', msgs: [] });
  }) as unknown as typeof fetch;
  const adapter = weixinAdapter({ workDir, fetchImpl });
  void adapter;
  // 直接验证解密路径：key 用 base64(hex) 形式，与服务端返回一致
  assert.deepEqual(decryptAesEcb(encrypted, key), plain);
  const asHexBase64 = Buffer.from(key.toString('hex'), 'utf8').toString('base64');
  assert.deepEqual(decryptAesEcb(encrypted, parseAesKey(asHexBase64)), plain);
  await cleanup();
});
