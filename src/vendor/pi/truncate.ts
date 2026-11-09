/**
 * 移植自 pi @earendil-works/pi-coding-agent@1.5.0
 * 原文件：packages/coding-agent/dist/core/tools/truncate.js
 *
 * 只删掉类型断言，逻辑逐行保留。上游改动时需要重新对照这份源码。
 *
 * 截断按两个独立的限制取先到者：
 * - 行数（默认 2000）
 * - 字节数（默认 50KB）
 * 不返回半行（bash 尾部截断的极端情况除外）。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 从头部截断：保留前 N 行/字节。适合读文件时想看到开头。 */
export function truncateHead(content: string, options: TruncateOptions = {}): TruncateResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes,
      lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
    };
  }

  // 单行就超过字节上限：给空内容并标记，让调用方提示用户改用 offset。
  const firstLine = lines[0] ?? '';
  if (Buffer.byteLength(firstLine, 'utf-8') > maxBytes) {
    return {
      content: '', truncated: true, truncatedBy: 'bytes', totalLines, totalBytes,
      outputLines: 0, outputBytes: 0,
      lastLinePartial: false, firstLineExceedsLimit: true, maxLines, maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const line = lines[i] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = 'lines';

  const outputContent = outputLinesArr.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
  };
}

/** 从尾部截断：保留后 N 行/字节。适合看命令输出的结尾（报错、最终结果）。 */
export function truncateTail(content: string, options: TruncateOptions = {}): TruncateResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes,
      lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i -= 1) {
    const line = lines[i] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      // 一行都没加进去、而这一行本身就超限：取行尾，宁可半行也不给空。
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, 'utf-8');
        lastLinePartial = true;
      }
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = 'lines';

  const outputContent = outputLinesArr.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    lastLinePartial, firstLineExceedsLimit: false, maxLines, maxBytes,
  };
}

/** 按字节从末尾截断，且不切断多字节 UTF-8 字符。 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf-8');
}

export function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

/** 保留首尾各一半，中间替换成「…N chars truncated…」。 */
export function truncateMiddle(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean; removedChars: number; totalBytes: number; totalLines: number } {
  const buf = Buffer.from(content, 'utf-8');
  const totalLines = splitLinesForCounting(content).length;
  if (buf.length <= maxBytes) {
    return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
  }
  const isBoundary = (index: number): boolean => index >= buf.length || ((buf[index] ?? 0) & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd -= 1;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart += 1;

  const head = buf.subarray(0, headEnd).toString('utf-8');
  const tail = buf.subarray(tailStart).toString('utf-8');
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString('utf-8')).length;
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    removedChars,
    totalBytes: buf.length,
    totalLines,
  };
}
