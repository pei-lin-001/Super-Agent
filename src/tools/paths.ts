import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

/**
 * 已存在的符号链接会把路径指到 root 之外。
 * 取最深的存在祖先做 realpath 校验，写入前调用即可。
 */
export function assertInsideRoot(root: string, absolute: string): void {
  const rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
  let probe = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new ToolError(`路径经符号链接指向任务目录之外：${absolute}`);
      }
      return;
    }
    const parent = dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel;
}
