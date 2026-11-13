import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * 统一路径规整：拒绝空路径、绝对路径、`..` 段。
 * 反斜杠先归一，避免 Windows 风格写法绕过检查。
 */
export function normalizeRelativePath(input: string, label = '路径'): string {
  const raw = input.trim();
  if (raw === '') throw new ToolError(`${label}不能为空`);
  const unified = raw.replace(/\\/g, '/');
  if (isAbsolute(unified) || /^[a-zA-Z]:/.test(unified)) {
    throw new ToolError(`${label}必须是相对路径：${raw}`);
  }
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new ToolError(`${label}无效：${raw}`);
  for (const segment of segments) {
    if (segment === '..') throw new ToolError(`${label}不能包含 ..：${raw}`);
  }
  return segments.join('/');
}

/** 把相对路径解析到 root 内；越界（..、绝对路径逃逸）直接拒绝。 */
export function resolveInside(root: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return root;
  const normalized = normalizeRelativePath(trimmed);
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`路径越界：${trimmed}`);
  return absolute;
}

/** 将不存在的后缀拼到最深存在祖先的真实路径，悬空链接必须报错。 */
function realPathWithMissingSuffix(path: string): string {
  let probe = resolve(path);
  const suffix: string[] = [];
  while (true) {
    let exists: boolean;
    try {
      lstatSync(probe);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (exists) {
      try {
        return resolve(realpathSync(probe), ...suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ToolError(`路径包含无效符号链接或已失效：${probe}`);
        }
        throw error;
      }
    }
    const parent = dirname(probe);
    if (parent === probe) throw new ToolError(`无法解析路径：${path}`);
    suffix.unshift(basename(probe));
    probe = parent;
  }
}

/** 校验已有路径及尚未创建的后缀均位于根目录的真实路径内。 */
export function assertInsideRoot(root: string, absolute: string): void {
  const rootReal = realPathWithMissingSuffix(root);
  const targetReal = realPathWithMissingSuffix(absolute);
  const rel = relative(rootReal, targetReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`路径经符号链接指向任务目录之外：${absolute}`);
  }
}

export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel;
}
