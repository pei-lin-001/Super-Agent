import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { resolveInside } from './paths.ts';
import { argOptionalString, argString, type ToolContext, type ToolDefinition, type ToolOutcome } from './types.ts';

const MAX_READ_BYTES = 60_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 80;
const MAX_SEARCH_FILES = 300;
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.ts', '.js', '.html', '.xml', '.log',
]);

export function taskDir(context: ToolContext): string {
  return resolve(context.workDir, context.task.id);
}

/** 逻辑路径 → 实际路径。`materials/` 前缀映射到只读材料目录，其余落在任务目录。 */
function resolveReadPath(context: ToolContext, logicalPath: string): string {
  if (logicalPath === 'materials' || logicalPath.startsWith('materials/')) {
    const rest = logicalPath.slice('materials'.length).replace(/^\/+/, '');
    return resolveInside(context.materialsDir, rest);
  }
  return resolveInside(taskDir(context), logicalPath);
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
    description: '读取文本文件内容。路径相对任务目录；以 materials/ 开头表示只读材料目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径' } },
      required: ['path'],
    },
    async run(args, context) {
      const logical = argString(args, 'path');
      const absolute = resolveReadPath(context, logical);
      const text = await readTextFile(absolute);
      return ok(text.length > MAX_READ_BYTES ? `${text.slice(0, MAX_READ_BYTES)}\n…（已截断）` : text);
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
      if (logical.startsWith('materials')) throw new Error('materials 目录只读');
      const content = argString({ ...args, content: args['content'] ?? '' }, 'content');
      const absolute = resolveInside(taskDir(context), logical);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      return ok(`已写入 ${logical}（${Buffer.byteLength(content, 'utf8')} 字节）`);
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
