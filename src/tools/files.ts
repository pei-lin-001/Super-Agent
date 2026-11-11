import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { assertInsideRoot, normalizeRelativePath, resolveInside, ToolError } from './paths.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from '../vendor/pi/truncate.ts';
import {
  argOptionalNumber,
  argOptionalString,
  argString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';

const MAX_READ_BYTES = 2_000_000;
const DEFAULT_READ_LIMIT = 8000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 80;
const MAX_SEARCH_FILES = 300;
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.ts', '.js', '.html', '.xml', '.log',
]);

export function taskDir(context: ToolContext): string {
  return resolve(context.workDir, context.task.id);
}

/**
 * 逻辑路径 → 实际路径（只读）。
 *
 * `materials/` 映射到只读材料目录；绝对路径必须在 readRoot 内；
 * 相对路径先看任务目录，没有就按仓库根解释——这样 Worker 像用 pi 一样
 * 直接读代码库，而不是被迫走 shell（shell 输出无界，会撑爆上下文窗口）。
 */
/**
 * 凭据文件一律不读。
 *
 * 读文件工具能到仓库根，`.env.local` 就在根目录——一条 `fs_read(".env.local")`
 * 就能把全部密钥送进模型上下文，而且之后每一轮都会重发。实测发生过：
 * 2026-11-10 的 task_cae7d504 里 Worker 用 shell 读出了整个 .env.local。
 * shell 那条拦不住（proc_run 本来就没沙箱），这里至少堵住 fs_* 这一路。
 */
function assertNotSecret(absolute: string): string {
  const name = basename(absolute);
  if (name === '.env' || name.startsWith('.env.')) {
    throw new Error(
      `拒绝读取 ${name}：凭据文件不进入模型上下文。需要某个配置项时，请让程序读出非敏感字段，或由维护者说明取值。`,
    );
  }
  return absolute;
}

export function resolveReadPath(context: ToolContext, logicalPath: string): string {
  if (logicalPath === 'materials' || logicalPath.startsWith('materials/')) {
    const rest = logicalPath.slice('materials'.length).replace(/^\/+/, '');
    return assertNotSecret(resolveInside(context.materialsDir, rest));
  }
  const trimmed = logicalPath.trim();
  if (isAbsolute(trimmed)) {
    const absolute = assertNotSecret(resolve(trimmed));
    assertInsideRoot(context.readRoot, absolute);
    return absolute;
  }
  const inTask = assertNotSecret(resolveInside(taskDir(context), trimmed));
  if (existsSync(inTask)) return inTask;
  return assertNotSecret(resolveInside(context.readRoot, trimmed));
}

async function readTextFile(absolute: string): Promise<string> {
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`不是文件：${absolute}`);
  if (info.size > MAX_READ_BYTES) throw new Error(`文件过大（${info.size} 字节），上限 ${MAX_READ_BYTES}`);
  return readFile(absolute, 'utf8');
}

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

/** 图片只接受这几种：提供方对 svg/bmp 之类支持不一，给过去只会得到解析错误。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function readImageFile(absolute: string, size: number): Promise<{ mimeType: string; data: string }> {
  const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase();
  const mimeType = IMAGE_MIME[ext];
  if (!mimeType) {
    throw new ToolError(
      `不支持的图片格式 ${ext || '(无扩展名)'}：只能看 ${Object.keys(IMAGE_MIME).join(' / ')}。` + '其他格式请先转换。',
    );
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new ToolError(`图片 ${formatSize(size)} 超过 ${formatSize(MAX_IMAGE_BYTES)} 上限，请先缩小。`);
  }
  const bytes = await readFile(absolute);
  return { mimeType, data: bytes.toString('base64') };
}

export const fileTools: ToolDefinition[] = [
  {
    name: 'fs_list',
    description: '列出目录内容。路径相对任务目录；以 materials/ 开头表示只读材料目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，默认 "."' } },
      required: [],
    },
    async run(args, context) {
      const logical = argOptionalString(args, 'path') ?? '.';
      const absolute = resolveReadPath(context, logical);
      const entries = await readdir(absolute, { withFileTypes: true });
      const lines = entries
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => {
          const suffix = entry.isDirectory() ? '/' : '';
          return `${entry.name}${suffix}`;
        });
      if (entries.length > MAX_LIST_ENTRIES) lines.push(`…共 ${entries.length} 项，已截断`);
      return ok(lines.length > 0 ? lines.join('\n') : '(空目录)');
    },
  },
  {
      name: 'fs_read',
      description:
        '读取文本文件。路径可以是任务目录相对、仓库相对或绝对路径；以 materials/ 开头表示只读材料目录。' +
        `一次最多返回 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（先到者为准），` +
        '超出时尾部会提示下一次的行号，用 offset 续读直到读完。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '路径（任务目录相对 / 仓库相对 / 绝对）' },
          offset: { type: 'number', description: '起始行号，从 1 开始，默认 1' },
          limit: { type: 'number', description: `本次最多读多少行，默认 ${DEFAULT_MAX_LINES}` },
        },
        required: ['path'],
      },
      async run(args, context) {
        const logical = argString(args, 'path');
        const offset = Math.max(1, Math.trunc(argOptionalNumber(args, 'offset') ?? 1));
        const limit = Math.max(1, Math.min(DEFAULT_MAX_LINES, Math.trunc(argOptionalNumber(args, 'limit') ?? DEFAULT_MAX_LINES)));
        const absolute = resolveReadPath(context, logical);
        const text = await readTextFile(absolute);
        const all = text.split('\n');
        // 行号越界直接说清楚，不要返回空串让模型以为文件是空的。
        if (offset > all.length) {
          return ok(`（文件共 ${all.length} 行，offset=${offset} 超出末尾）`);
        }
        const slice = all.slice(offset - 1, offset - 1 + limit).join('\n');
        const clipped = truncateHead(slice, { maxLines: limit, maxBytes: DEFAULT_MAX_BYTES });
        const lastLine = offset - 1 + clipped.outputLines;
        const parts: string[] = [clipped.content];
        if (clipped.firstLineExceedsLimit) {
          parts.push(`\n…（第 ${offset} 行就超过 ${formatSize(DEFAULT_MAX_BYTES)}，无法整行返回）`);
        } else if (clipped.truncated) {
          parts.push(
            `\n…（本次按${clipped.truncatedBy === 'lines' ? '行数' : '字节数'}截断到第 ${lastLine} 行；继续请用 offset=${lastLine + 1}）`,
          );
        }
        if (lastLine < all.length) {
          parts.push(`\n…（文件共 ${all.length} 行；继续请用 offset=${lastLine + 1}）`);
        }
        return ok(parts.join(''));
      },
  },
  {
    name: 'fs_view_image',
    description:
      '看图片（截图、照片、图表、设计稿）。返回图片本身，你能真的看到画面内容——' +
      '和 fs_read 不同，它读不了二进制。支持 png/jpeg/gif/webp；' +
      '路径规则与 fs_read 相同（任务目录相对 / materials/ 开头 / 仓库相对 / 绝对）。' +
      '一次一张；每张都计入当轮上下文，不要为了"确认一下"反复看同一张。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片路径（任务目录相对 / materials/ 开头 / 仓库相对 / 绝对）' },
      },
      required: ['path'],
    },
    async run(args, context) {
      const logical = argString(args, 'path');
      const absolute = resolveReadPath(context, logical);
      const info = await stat(absolute).catch(() => null);
      if (!info || !info.isFile()) throw new ToolError(`图片不存在：${logical}`);
      const view = await readImageFile(absolute, info.size);
      return {
        type: 'ok',
        content: `已加载 ${logical}（${view.mimeType}，${formatSize(info.size)}）。画面内容见随附图片。`,
        images: [{ mimeType: view.mimeType, data: view.data }],
      };
    },
  },
  {
    name: 'fs_write',
    description: '写入文本文件到任务目录（自动创建父目录，覆盖同名文件）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对任务目录的路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    async run(args, context) {
      const logical = argString(args, 'path');
      const normalized = normalizeRelativePath(logical, '写入路径');
      if (normalized === 'materials' || normalized.startsWith('materials/')) {
        throw new Error('materials 目录只读');
      }
      if (normalized === 'inputs' || normalized.startsWith('inputs/')) {
        throw new Error('inputs 目录只读');
      }
      if (normalized === 'artifacts' || normalized.startsWith('artifacts/')) {
        throw new Error('产物目录由 artifact_save 管理，不能用 fs_write 直接覆盖已登记的版本');
      }
      const content = argString({ ...args, content: args['content'] ?? '' }, 'content');
      const root = taskDir(context);
      const absolute = resolveInside(root, normalized);
      await mkdir(dirname(absolute), { recursive: true });
      assertInsideRoot(root, dirname(absolute));
      await writeFile(absolute, content, 'utf8');
      return ok(`已写入 ${normalized}（${Buffer.byteLength(content, 'utf8')} 字节）`);
    },
  },
  {
    name: 'fs_search',
    description: '在任务目录与材料目录中按正则搜索文本，返回 文件:行号: 内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则，忽略大小写' },
        path: { type: 'string', description: '搜索起点，默认 "."；materials/ 表示材料目录' },
      },
      required: ['pattern'],
    },
    async run(args, context) {
      const patternText = argString(args, 'pattern');
      const logical = argOptionalString(args, 'path') ?? '.';
      let regexp: RegExp;
      try {
        regexp = new RegExp(patternText, 'i');
      } catch (error) {
        throw new Error(`正则无效：${(error as Error).message}`);
      }
      const start = resolveReadPath(context, logical);
      const results: string[] = [];
      let scanned = 0;

      const walk = async (dir: string): Promise<void> => {
        if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_FILES) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_FILES) return;
          const absolute = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute);
            continue;
          }
          const ext = entry.name.slice(entry.name.lastIndexOf('.'));
          if (!TEXT_EXTENSIONS.has(ext.toLowerCase())) continue;
          const info = await stat(absolute);
          if (info.size > MAX_READ_BYTES) continue;
          scanned += 1;
          const text = await readFile(absolute, 'utf8');
          text.split('\n').forEach((line, index) => {
            if (results.length < MAX_SEARCH_RESULTS && regexp.test(line)) {
              results.push(`${basename(dir)}/${entry.name}:${index + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
      };

      await walk(start).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      });
      return ok(results.length > 0 ? results.join('\n') : `未找到匹配 ${patternText}`);
    },
  },
];
