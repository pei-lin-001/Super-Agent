import { createHash } from 'node:crypto';
import { beijingTime } from '../domain/ids.ts';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { ToolError } from './paths.ts';
import { resolveReadPath, resolveWritePath } from './files.ts';
import {
  argOptionalNumber,
  argOptionalString,
  argString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './types.ts';

const MAX_EDIT_BYTES = 2_000_000;
const MAX_GLOB_RESULTS = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.cache']);

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

/** glob → 正则：支持 **、*、?，其余字符按字面量处理。 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function walk(base: string, out: string[], depth = 0): void {
  if (depth > 12 || out.length > MAX_GLOB_RESULTS * 4) return;
  const entries = readdirSync(base, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length > MAX_GLOB_RESULTS * 4) return;
    const absolute = resolve(base, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absolute, out, depth + 1);
      continue;
    }
    if (entry.isFile()) out.push(absolute);
  }
}

/** 生成简短的差异摘要，便于 Worker 核对改动。 */
function diffSummary(before: string, after: string, label: string): string {
  if (before === after) return `${label}：内容未变化`;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const removed = afterLines.length - beforeLines.length;
  const changed = beforeLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !afterLines.includes(line))
    .slice(0, 5);
  const lines = [`${label}：${before.length} → ${after.length} 字符，行数 ${beforeLines.length} → ${afterLines.length}（${removed >= 0 ? '+' : ''}${removed}）`];
  if (changed.length > 0) {
    lines.push('移出的行（最多 5 条）：');
    for (const item of changed) lines.push(`- ${item.line.slice(0, 160)}`);
  }
  return lines.join('\n');
}

export const editTools: ToolDefinition[] = [
  {
    name: 'fs_glob',
    description:
      '按文件名或 glob 模式查找文件（例如 `**/*.py`、`src/**/*.ts`）。返回仓库相对路径与大小。' +
      '在只读根（仓库）内查找，自动跳过 node_modules/.git 等目录。找内容请用 fs_search。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 **/*.py' },
        path: { type: 'string', description: '起始目录（相对任务目录），默认任务目录' },
        limit: { type: 'number', description: '最多返回条数，默认 100' },
      },
      required: ['pattern'],
    },
    run(args, context) {
      const pattern = argString(args, 'pattern');
      // 只在读文件时放开到仓库；写入仍然限制在任务目录（fs_write/fs_edit 没变）。
      const logical = argOptionalString(args, 'path') ?? '.';
      const start = resolveReadPath(context, logical);
      if (!statSync(start).isDirectory()) throw new ToolError(`不是目录：${logical}`);
      const limit = Math.max(1, Math.min(MAX_GLOB_RESULTS, argOptionalNumber(args, 'limit') ?? 100));
      const files: string[] = [];
      walk(start, files);
      const matcher = globToRegExp(pattern.replace(/^\.\//, ''));
      const root = isAbsolute(logical) ? context.readRoot : start;
      const prefix = isAbsolute(logical) ? relative(context.readRoot, start) : logical === '.' ? '' : logical.replace(/\/$/, '');
      const matched = files
        .map((absolute) => ({ absolute, local: relative(start, absolute), path: prefix ? `${prefix}/${relative(start, absolute)}` : relative(start, absolute) }))
        .filter((item) => matcher.test(item.path) || matcher.test(item.local))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (matched.length === 0) return ok(`没有匹配 ${pattern} 的文件`);
      const shown = matched.slice(0, limit).map((item) => {
        const info = statSync(item.absolute);
        return `${isAbsolute(logical) ? resolve(root, item.path) : item.path}（${info.size}B）`;
      });
      const suffix = matched.length > limit ? `\n…共 ${matched.length} 个，已显示 ${limit} 个` : '';
      return ok(shown.join('\n') + suffix);
    },
  },
  {
    name: 'fs_stat',
    description: '查看文件或目录的基本信息：类型、大小、修改时间、sha256（文件）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对任务目录的路径' } },
      required: ['path'],
    },
    async run(args, context) {
      const logical = argString(args, 'path');
      const absolute = resolveReadPath(context, logical);
      if (!existsSync(absolute)) throw new ToolError(`路径不存在：${logical}`);
      const info = await stat(absolute);
      const lines = [
        `${logical}`,
        `类型：${info.isDirectory() ? '目录' : '文件'}`,
        `大小：${info.size} 字节`,
        `修改时间：${beijingTime(info.mtime)}（北京时间）`,
      ];
      if (info.isFile() && info.size <= MAX_EDIT_BYTES) {
        const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
        lines.push(`sha256：${digest}`);
      }
      lines.push(`绝对路径：${absolute}`);
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'fs_edit',
    description:
      '按原文精确替换修改文本文件。语义严格：' +
      '① old_string 必须原样出现，匹配不到直接失败；' +
      '② 匹配到多处且未指定 replace_all 时拒绝执行，避免改错位置；' +
      '③ 可以传 edits 数组一次改多处，全部预校验通过后才写盘，不会只改成功一半；' +
      '④ 传 expected_sha256（取自上次 fs_read/fs_stat 的结果）可在文件被其他人改动时识别冲突。' +
      '返回改动前后的字符数、行数和移出的行，便于核对。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对任务目录的路径' },
        old_string: { type: 'string', description: '要替换的原文（单处修改）' },
        new_string: { type: 'string', description: '替换后的内容' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false' },
        edits: {
          type: 'array',
          description: '多处修改：[{old_string,new_string,replace_all?}]，与 old_string 二选一',
          items: { type: 'object' },
        },
        expected_sha256: { type: 'string', description: '期望的文件指纹；不一致表示已被改动' },
      },
      required: ['path'],
    },
    async run(args, context) {
      const logical = argString(args, 'path');
      const absolute = resolveWritePath(context, logical);
      if (!existsSync(absolute)) throw new ToolError(`文件不存在：${logical}（新建请用 fs_write）`);
      const info = await stat(absolute);
      if (!info.isFile()) throw new ToolError(`不是文件：${logical}`);
      if (info.size > MAX_EDIT_BYTES) throw new ToolError(`文件过大（${info.size} 字节），不适合精确编辑`);

      const buffer = await readFile(absolute);
      const before = buffer.toString('utf8');
      const digest = createHash('sha256').update(buffer).digest('hex');
      const expected = argOptionalString(args, 'expected_sha256');
      if (expected && !digest.startsWith(expected)) {
        throw new ToolError(
          `文件已被改动，拒绝覆盖：期望 sha256 前缀 ${expected}，实际 ${digest.slice(0, 12)}…。` +
            '请重新读取内容后再决定修改。',
        );
      }

      const ops: { oldText: string; newText: string; all: boolean }[] = [];
      const list = args['edits'];
      if (Array.isArray(list) && list.length > 0) {
        for (const item of list) {
          if (item === null || typeof item !== 'object') throw new ToolError('edits 每项必须是对象');
          const record = item as Record<string, unknown>;
          const oldText = record['old_string'];
          const newText = record['new_string'];
          if (typeof oldText !== 'string' || oldText === '') throw new ToolError('edits 里 old_string 必须是非空字符串');
          if (typeof newText !== 'string') throw new ToolError('edits 里 new_string 必须是字符串');
          ops.push({ oldText, newText, all: record['replace_all'] === true });
        }
      } else {
        const oldText = argString(args, 'old_string');
        const newText = args['new_string'];
        if (typeof newText !== 'string') throw new ToolError('参数 new_string 必须是字符串');
        ops.push({ oldText, newText, all: args['replace_all'] === true });
      }

      // 先整体校验：任何一处不合法都不写盘。
      let after = before;
      const counts = ops.map((op, index) => {
        const count = after.split(op.oldText).length - 1;
        if (count === 0) throw new ToolError(`第 ${index + 1} 处修改没有找到原文，未做任何改动：${op.oldText.slice(0, 80)}`);
        if (count > 1 && !op.all) {
          throw new ToolError(
            `第 ${index + 1} 处修改匹配到 ${count} 个位置，存在歧义，未做任何改动。` +
              '请提供更长的上下文，或显式设置 replace_all=true。',
          );
        }
        after = op.all ? after.split(op.oldText).join(op.newText) : after.replace(op.oldText, op.newText);
        return count;
      });
      resolveWritePath(context, logical);
      await writeFile(absolute, after, 'utf8');
      const nextDigest = createHash('sha256').update(Buffer.from(after, 'utf8')).digest('hex');
      const total = counts.reduce((sum, count) => sum + count, 0);
      return ok(
        `已修改 ${logical}（${ops.length} 处规则，共替换 ${total} 个匹配）\n` +
          `${diffSummary(before, after, logical)}\n新的 sha256=${nextDigest.slice(0, 12)}…`,
      );
    },
  },
];
