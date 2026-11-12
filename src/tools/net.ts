import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ToolError } from './paths.ts';
import {
  argOptionalNumber,
  argOptionalString,
  argString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';
import { resolveWritePath } from './files.ts';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_INLINE_CHARS = 8_000;

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`不是合法的 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`只支持 http/https，当前是 ${url.protocol}`);
  }
  return url;
}

async function readLimited(response: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(chunks, size), truncated: false };
      const available = maxBytes - size;
      if (value.length > available) {
        chunks.push(Buffer.from(value.subarray(0, available)));
        size += available;
        await reader.cancel();
        return { bytes: Buffer.concat(chunks, size), truncated: true };
      }
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 极简 HTML → 文本：去掉脚本样式与标签，保留段落换行。只用于阅读，不追求渲染精度。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 搜索后端。两种协议长得一样（POST {query,max_results} → {results:[{title,url,content}]}），
 * 所以只是端点与凭据来源不同，不需要两套实现。
 *
 * ollama 那条是自动推导的：它的检索端点在根路径 `/api/web_search`（不是 `/v1`），
 * 凭据与模型调用同一个 key，所以配过 ollama 模型就不必再填一遍。
 */
export function resolveSearchTarget(): { name: string; endpoint: string; apiKey: string; keyHint: string } {
  const explicitUrl = process.env['SEARCH_API_URL'];
  const explicitKey = process.env['SEARCH_API_KEY'] ?? process.env['TAVILY_API_KEY'] ?? '';
  const provider = (process.env['SEARCH_PROVIDER'] ?? '').trim().toLowerCase();

  if (provider === 'ollama' || explicitUrl?.includes('ollama.com')) {
    const base = (process.env['OLLAMA_BASE_URL'] ?? 'https://ollama.com/v1').replace(/\/+$/, '');
    return {
      name: 'ollama cloud 检索',
      endpoint: explicitUrl ?? `${base.replace(/\/v1$/, '')}/api/web_search`,
      apiKey: explicitKey || (process.env['SEARCH_API_KEY'] ?? process.env['OLLAMA_API_KEY'] ?? ''),
      keyHint: 'SEARCH_API_KEY（或 OLLAMA_API_KEY）',
    };
  }
  return {
    name: '搜索服务',
    endpoint: explicitUrl ?? 'https://api.tavily.com/search',
    apiKey: explicitKey,
    keyHint: 'SEARCH_API_KEY（或 TAVILY_API_KEY）',
  };
}

export const netTools: ToolDefinition[] = [
  {
    name: 'net_fetch',
    description:
      '获取一个已知 URL 的内容（http/https）。返回最终 URL、状态码、内容类型与正文。' +
      'HTML 会提取可读正文；JSON 与纯文本原样返回；超过 inline 上限或 save_to 指定时会落盘到任务目录，' +
      '再用 fs_read 分段读取。二进制内容会按字节保存，不会塞进字符串。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'HEAD'], description: '默认 GET' },
        headers: { type: 'object', description: '附加请求头，例如 {"accept":"application/json"}' },
        body: { type: 'string', description: '请求体（POST/PUT）' },
        save_to: { type: 'string', description: '保存到任务目录的路径；省略时超过上限才自动落盘' },
        timeout_seconds: { type: 'number', description: '请求超时，默认 30 秒' },
        max_bytes: { type: 'number', description: '下载上限，默认 2MB' },
      },
      required: ['url'],
    },
    async run(args, context) {
      const url = assertHttpUrl(argString(args, 'url'));
      const method = (argOptionalString(args, 'method') ?? 'GET').toUpperCase();
      const timeoutSeconds = Math.max(1, Math.min(300, argOptionalNumber(args, 'timeout_seconds') ?? 30));
      const maxBytes = Math.max(1024, Math.trunc(argOptionalNumber(args, 'max_bytes') ?? DEFAULT_MAX_BYTES));
      const rawHeaders = args['headers'];
      const headers: Record<string, string> = { 'user-agent': 'super-agent/0.1' };
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
          if (typeof value === 'string') headers[key] = value;
        }
      }
      const body = typeof args['body'] === 'string' ? (args['body'] as string) : undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      const onAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      let bytes: Buffer;
      let truncated: boolean;
      try {
        if (context.signal?.aborted) controller.abort();
        response = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal });
        ({ bytes, truncated } = await readLimited(response, maxBytes));
      } catch (error) {
        const reason = controller.signal.aborted ? `请求超时或已取消（${timeoutSeconds} 秒）` : (error as Error).message;
        throw new ToolError(`获取 ${url.href} 失败：${reason}`);
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      }

      const contentType = response.headers.get('content-type') ?? 'unknown';
      const finalUrl = response.url || url.href;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const isText =
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv');

      const saveTo = argOptionalString(args, 'save_to');
      let savedPath: string | null = null;
      const needSave = saveTo !== null || truncated || (isText && bytes.toString('utf8').length > DEFAULT_INLINE_CHARS) || (!isText && response.ok);
      if (needSave) {
        const logical = saveTo ?? `downloads/${url.pathname.split('/').filter(Boolean).at(-1) || 'index'}.bin`;
        const absolute = resolveWritePath(context, logical);
        await mkdir(dirname(absolute), { recursive: true });
        resolveWritePath(context, logical);
        await writeFile(absolute, bytes);
        savedPath = logical;
      }

      const head = [
        `状态码：${response.status}`,
        `最终 URL：${finalUrl}`,
        `内容类型：${contentType}`,
        `字节：${bytes.length}${truncated ? '（已截断）' : ''}`,
        `sha256：${digest.slice(0, 12)}…`,
        savedPath ? `已保存：${savedPath}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      if (!isText) {
        return ok(
          `${head}\n二进制内容${savedPath ? `已保存为 ${savedPath}，可用 artifact_import 登记` : '未保存，请指定 save_to'}。`,
        );
      }

      const text = bytes.toString('utf8');
      const readable = contentType.includes('html') ? htmlToText(text) : text;
      const inline = readable.slice(0, DEFAULT_INLINE_CHARS);
      const more =
        readable.length > inline.length
          ? `\n…（正文共 ${readable.length} 字符${savedPath ? `，已保存到 ${savedPath}` : ''}；继续请用 offset 读取或先保存）`
          : '';
      return ok(`${head}\n\n${inline}${more}`);
    },
  },
  {
    name: 'net_search',
    description:
      '联网搜索（需要配置搜索服务凭据）。返回标题、URL 与摘要；摘要不等于正文，需要细节时用 net_fetch 打开来源。' +
      '未配置凭据时直接报错，不会用模拟结果或编造链接代替。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回条数，默认 5，上限 10' },
      },
      required: ['query'],
    },
    async run(args, context) {
      const query = argString(args, 'query');
      const limit = Math.max(1, Math.min(10, argOptionalNumber(args, 'limit') ?? 5));
      const target = resolveSearchTarget();
      const { endpoint, apiKey } = target;
      if (apiKey.trim() === '') {
        throw new ToolError(
          `${target.name} 尚未配置搜索凭据：需要 ${target.keyHint}。` +
            '可以在 .env.local 里设置后重启；在此之前请改用 net_fetch 直接访问已知 URL。',
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const onAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      try {
        if (context.signal?.aborted) controller.abort();
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: limit }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const { bytes } = await readLimited(response, 1024);
          throw new ToolError(`搜索服务返回 ${response.status}：${bytes.toString('utf8').slice(0, 300)}`);
        }
        const { bytes, truncated } = await readLimited(response, DEFAULT_MAX_BYTES);
        if (truncated) throw new ToolError('搜索服务响应超过 2MB 上限');
        const payload = JSON.parse(bytes.toString('utf8')) as { results?: { title?: string; url?: string; content?: string }[] };
        const results = payload.results ?? [];
        if (!Array.isArray(results)) throw new ToolError('搜索服务返回的 results 不是数组');
        if (results.length === 0) return ok(`没有找到与「${query}」相关的结果`);
        return ok(
          results.slice(0, limit)
            .map((item, index) => {
              const title = item.title ?? '(无标题)';
              const url = item.url ?? '(无链接)';
              const snippet = (item.content ?? '').replace(/\s+/g, ' ').slice(0, 240);
              return `${index + 1}. ${title}\n   ${url}\n   ${snippet}`;
            })
            .join('\n\n') + '\n\n（以上是搜索摘要，不是网页正文；需要确认细节请用 net_fetch 打开来源）',
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(`搜索请求失败：${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      }
    },
  },
];
