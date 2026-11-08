import { isAbsolute, relative, resolve } from 'node:path';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** 把相对路径解析到 root 内；越界（..、绝对路径逃逸）直接拒绝。 */
export function resolveInside(root: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return root;
  if (isAbsolute(trimmed)) throw new ToolError(`路径必须是相对路径：${trimmed}`);
  const absolute = resolve(root, trimmed);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`路径越界：${trimmed}`);
  return absolute;
}

export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel;
}
