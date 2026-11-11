/**
 * 渠道文件落盘。
 *
 * 平台给的文件名只用于展示和默认命名，绝不直接拼成路径：
 * 统一清洗成安全文件名，落在受控目录里，并记下大小与指纹。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { assertInsideRoot } from '../tools/paths.ts';

/** 把平台文件名清洗成安全的单段文件名。 */
export function safeFileName(raw: string, fallback = 'file.bin'): string {
  const base = basename(String(raw ?? '').replace(/\\/g, '/')).normalize('NFC');
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  // 只剩标点的名字没有信息量，用回退名，避免生成 "_" 这类无法辨认的文件。
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return fallback;
  // 控制长度，保留扩展名
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0 || dot < cleaned.length - 16) return cleaned.slice(0, 120);
  return `${cleaned.slice(0, 100)}${cleaned.slice(dot)}`;
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 入站附件的存放目录（相对 workDir），按渠道与账号分开。 */
export function inboxRelativePath(channel: string, accountId: string, eventId: string): string {
  const safeEvent = eventId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return ['.inbox', channel, safeFileName(accountId, 'account'), safeEvent].join('/');
}

export interface StoredAttachment {
  kind: 'file' | 'image' | 'voice' | 'video' | 'other';
  name: string;
  mime: string | null;
  bytes: number;
  /** 相对 workDir 的受控路径。 */
  path: string;
  sha256: string;
}

export function writeInboundAttachment(input: {
  workDir: string;
  channel: string;
  accountId: string;
  eventId: string;
  /** 平台给出的名字，只用于清洗后的文件名。 */
  name: string;
  kind: StoredAttachment['kind'];
  mime: string | null;
  bytes: Buffer;
}): StoredAttachment {
  const dirRel = inboxRelativePath(input.channel, input.accountId, input.eventId);
  const dirAbs = resolve(input.workDir, dirRel);
  mkdirSync(dirAbs, { recursive: true });
  const name = safeFileName(input.name);
  const abs = join(dirAbs, name);
  writeFileSync(abs, input.bytes, { mode: 0o600 });
  return {
    kind: input.kind,
    name,
    mime: input.mime,
    bytes: input.bytes.byteLength,
    path: [dirRel, name].join('/'),
    sha256: sha256Of(input.bytes),
  };
}

/**
 * 把入站附件复制进任务目录。
 *
 * Worker 的文件权限范围是 workDir/<taskId>，所以材料必须真的落到那里；
 * 只给一个它读不到的缓存路径等于没给。重名时加序号，不覆盖已有材料。
 */
export function stageMaterials(input: {
  workDir: string;
  taskId: string;
  attachments: StoredAttachment[];
  directory?: string;
}): { name: string; path: string; bytes: number; sha256: string; source: string }[] {
  const destRel = [input.taskId, input.directory ?? 'materials'].join('/');
  const destAbs = resolve(input.workDir, destRel);
  mkdirSync(destAbs, { recursive: true });
  const staged: { name: string; path: string; bytes: number; sha256: string; source: string }[] = [];
  for (const attachment of input.attachments) {
    const sourceAbs = resolve(input.workDir, attachment.path);
    if (!existsSync(sourceAbs)) continue;
    let name = safeFileName(attachment.name);
    let target = join(destAbs, name);
    let index = 1;
    while (existsSync(target)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      name = `${stem}-${index}${ext}`;
      target = join(destAbs, name);
      index += 1;
    }
    copyFileSync(sourceAbs, target);
    const bytes = statSync(target).size;
    const digest = sha256Of(readFileSync(target));
    staged.push({
      name,
      path: [destRel, name].join('/'),
      bytes,
      sha256: digest,
      source: attachment.path,
    });
  }
  return staged;
}

/**
 * 产物路径必须落在 workDir 内，且真实存在。
 *
 * 只比字符串不够：workDir 里一个指向外部的符号链接同样会通过 resolve/relative，
 * 于是"任务目录内的文件"能读到别的路径。这里复用工具层已有的 realpath 校验，
 * 并要求最终是一个普通文件。
 */
export function resolveArtifactPath(workDir: string, artifactPath: string): string | null {
  const abs = resolve(workDir, artifactPath);
  const rel = relative(workDir, abs);
  if (rel.startsWith('..') || rel === '' || rel.split(sep).includes('..')) return null;
  if (!existsSync(abs)) return null;
  try {
    assertInsideRoot(workDir, abs);
  } catch {
    return null;
  }
  return statSync(abs).isFile() ? abs : null;
}
