import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertInsideRoot, resolveInside, ToolError } from './paths.ts';
import {
  argNumber,
  argOptionalNumber,
  argOptionalString,
  argString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';
import { taskDir } from './files.ts';

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
      const maxBytes = Math.max(1024, argOptionalNumber(args, 'max_bytes') ?? DEFAULT_MAX_BYTES);
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
      try {
        response = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal });
      } catch (error) {
        const reason = controller.signal.aborted ? `请求超时或已取消（${timeoutSeconds} 秒）` : (error as Error).message;
        throw new ToolError(`获取 ${url.href} 失败：${reason}`);
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? 'unknown';
      const finalUrl = response.url || url.href;
      const truncated = buffer.length > maxBytes;
      const bytes = truncated ? buffer.subarray(0, maxBytes) : buffer;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const isText =
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv');

      const saveTo = argOptionalString(args, 'save_to');
      let savedPath: string | null = null;
      const needSave = saveTo !== null || truncated || (!isText && response.ok);
      if (needSave) {
        const logical = saveTo ?? `downloads/${url.pathname.split('/').filter(Boolean).at(-1) || 'index'}.bin`;
        const root = taskDir(context);
        const absolute = resolveInside(root, logical);
        assertInsideRoot(root, absolute);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes);
        savedPath = logical;
      }

      const head = [
        `状态码：${response.status}`,
        `最终 URL：${finalUrl}`,
        `内容类型：${contentType}`,
        `字节：${bytes.length}${truncated ? `（已截断，原始至少 ${buffer.length}）` : ''}`,
        `sha256：${digest.slice(0, 12)}…`,
        savedPath ? `已保存：${savedPath}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      if (!isText) {
        return ok(
          `${head}\n二进制内容${savedPath ? `已保存为 ${savedPath}，可用 fs_read / artifact_import 处理` : '未保存，请指定 save_to'}。`,
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
      const endpoint = process.env['SEARCH_API_URL'] ?? 'https://api.tavily.com/search';
      const apiKey = process.env['SEARCH_API_KEY'] ?? process.env['TAVILY_API_KEY'] ?? '';
      if (apiKey.trim() === '') {
        throw new ToolError(
          '尚未配置搜索服务凭据：需要 SEARCH_API_KEY（或 TAVILY_API_KEY）。' +
            '可以在 .env.local 里设置后重启；在此之前请改用 net_fetch 直接访问已知 URL。',
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      context.signal?.addEventListener('abort', () => controller.abort(), { once: true });
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: limit }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ToolError(`搜索请求失败：${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new ToolError(`搜索服务返回 ${response.status}：${detail}`);
      }
      const payload = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      const results = payload.results ?? [];
      if (results.length === 0) return ok(`没有找到与「${query}」相关的结果`);
      return ok(
        results
          .map((item, index) => {
            const title = item.title ?? '(无标题)';
            const url = item.url ?? '(无链接)';
            const snippet = (item.content ?? '').replace(/\s+/g, ' ').slice(0, 240);
            return `${index + 1}. ${title}\n   ${url}\n   ${snippet}`;
          })
          .join('\n\n') + '\n\n（以上是搜索摘要，不是网页正文；需要确认细节请用 net_fetch 打开来源）',
      );
    },
  },
];
