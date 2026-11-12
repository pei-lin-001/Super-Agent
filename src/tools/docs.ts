import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { resolveReadPath, resolveWritePath } from './files.ts';

const MAX_TEXT = 8_000;

/** 把转换后的全文写进任务目录，并做与 fs_write 相同的越界检查。 */
function saveText(context: ToolContext, relative: string, text: string): string {
  const target = resolveWritePath(context, relative);
  mkdirSync(dirname(target), { recursive: true });
  resolveWritePath(context, relative);
  writeFileSync(target, text, 'utf8');
  return relative;
}

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

function readPath(context: ToolContext, logical: string): string {
  const absolute = resolveReadPath(context, logical);
  if (!existsSync(absolute)) throw new ToolError(`文件不存在：${logical}`);
  return absolute;
}

function hasBinary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const docTools: ToolDefinition[] = [
  {
    name: 'doc_pdf',
    description:
      '提取 PDF 的文字内容，按页返回并标注页码。可指定起止页，只读需要的那几页。' +
      '依赖系统 pdftotext（未安装时直接报错）。扫描件是图片，本工具读不到其中的文字，需要 OCR。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 路径（相对任务目录，或以 materials/ 开头）' },
        from_page: { type: 'number', description: '起始页，从 1 开始' },
        to_page: { type: 'number', description: '结束页（含）' },
        limit: { type: 'number', description: '返回字符上限，默认 8000' },
        save_to: {
          type: 'string',
          description:
            '把全文另存为任务目录下的文本文件（如 pdf/paper.txt），返回路径而不返回正文。' +
            '要在文档里反复检索时用它：转换一次，之后用 fs_search / fs_read / proc_run 直接处理，' +
            '不必每次调用都重新解析 PDF。',
        },
      },
      required: ['path'],
    },
    run(args, context) {
      const logical = argString(args, 'path');
      if (!logical.toLowerCase().endsWith('.pdf')) throw new ToolError('doc_pdf 只处理 .pdf 文件');
      const absolute = readPath(context, logical);
      if (!hasBinary('pdftotext')) {
        throw new ToolError('当前环境没有 pdftotext（poppler-utils），无法提取 PDF 文本；请改用其他方式或先安装该工具。');
      }
      const limit = Math.max(500, Math.min(40_000, argOptionalNumber(args, 'limit') ?? MAX_TEXT));
      const from = argOptionalNumber(args, 'from_page');
      const to = argOptionalNumber(args, 'to_page');
      if ((from !== null && (!Number.isInteger(from) || from < 1)) || (to !== null && (!Number.isInteger(to) || to < 1)) || (from !== null && to !== null && to < from)) {
        throw new ToolError('页码必须为正整数，结束页不能早于起始页');
      }
      const argv = ['-layout'];
      if (from !== null) {
        argv.push('-f', String(Math.max(1, Math.trunc(from))));
        argv.push('-l', String(Math.max(1, Math.trunc(to ?? from))));
      } else if (to !== null) {
        argv.push('-l', String(Math.max(1, Math.trunc(to))));
      }
      argv.push(absolute, '-');
      let text: string;
      try {
        text = execFileSync('pdftotext', argv, { encoding: 'utf8', timeout: 60_000, maxBuffer: 40_000_000 });
      } catch (error) {
        throw new ToolError(`PDF 文本提取失败：${(error as Error).message}`);
      }
      const pages = text.split('\f');

      // 落盘模式：转换一次，之后用 fs_search / fs_read 反复检索。
      // 每次调用都重新解析一个 9.5MB 的 PDF 是纯浪费，而且模型为了按关键词定位
      // 只能自己 proc_run pdftotext，等于绕开所有文件工具。
      const saveTo = argOptionalString(args, 'save_to');
      if (saveTo !== null) {
        if (text.trim() === '') {
          return ok(`${logical}：没有提取到文字。可能是扫描件（图片型 PDF），需要 OCR。`);
        }
        const target = saveText(context, saveTo, text);
        const lines = text.split('\n').length;
        return ok(
          `${logical}｜共 ${pages.filter((page) => page.trim() !== '').length} 页有文字，已存为 ${target}（${lines} 行，${text.length} 字符）。\n` +
            '后续用 fs_search 定位关键词、fs_read 按行读；不要再用 proc_run 重新解析 PDF。',
        );
      }

      const shown: string[] = [];
      let used = 0;
      for (let index = 0; index < pages.length; index += 1) {
        const pageText = pages[index]!.trim();
        if (pageText === '') continue;
        const block = `--- 第 ${(from ?? 1) + index} 页 ---\n${pageText}`;
        if (used + block.length > limit) {
          const remaining = Math.max(0, limit - used - 100);
          if (shown.length === 0 && remaining > 0) shown.push(`${block.slice(0, remaining)}\n…（该页超过输出上限；请用 save_to 保存全文后分段读取）`);
          else shown.push(`…（已达输出上限 ${limit} 字符；请从第 ${(from ?? 1) + index} 页继续读取）`);
          break;
        }
        shown.push(block);
        used += block.length;
      }
      if (shown.length === 0) {
        return ok(
          `${logical}：没有提取到文字。可能是扫描件（图片型 PDF），需要 OCR 才能读取，当前不具备该能力。`,
        );
      }
      return ok(`${logical}｜共 ${pages.filter((page) => page.trim() !== '').length} 页有文字\n\n${shown.join('\n\n')}`);
    },
  },
  {
    name: 'doc_notebook',
    description: '读取 Jupyter Notebook（.ipynb）的单元格：按顺序给出单元格类型、源码和文本输出。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'notebook 路径' },
        limit: { type: 'number', description: '返回字符上限，默认 8000' },
      },
      required: ['path'],
    },
    run(args, context) {
      const logical = argString(args, 'path');
      const absolute = readPath(context, logical);
      const info = statSync(absolute);
      if (info.size > 10_000_000) throw new ToolError(`notebook 过大（${info.size} 字节）`);
      let parsed: { cells?: { cell_type?: string; source?: string[] | string; outputs?: { text?: string[] | string }[] }[] };
      try {
        parsed = JSON.parse(readFileSync(absolute, 'utf8'));
      } catch (error) {
        throw new ToolError(`不是合法的 notebook JSON：${(error as Error).message}`);
      }
      const cells = parsed?.cells ?? [];
      if (!Array.isArray(cells)) throw new ToolError('notebook 的 cells 必须是数组');
      if (cells.length === 0) return ok(`${logical}：没有单元格`);
      const limit = Math.max(500, Math.min(40_000, argOptionalNumber(args, 'limit') ?? MAX_TEXT));
      const blocks: string[] = [];
      let used = 0;
      for (const [index, cell] of cells.entries()) {
        if (!cell || typeof cell !== 'object') throw new ToolError(`notebook 第 ${index + 1} 个单元格无效`);
        const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
        const outputs = (cell.outputs ?? [])
          .map((output) => (Array.isArray(output.text) ? output.text.join('') : (output.text ?? '')))
          .filter((text) => text !== '')
          .join('\n');
        const block =
          `--- 单元格 ${index + 1}（${cell.cell_type ?? 'unknown'}）---\n` +
          `${source.trim()}` +
          (outputs ? `\n[输出]\n${outputs.trim()}` : '');
        if (used + block.length > limit) {
          blocks.push(`…（从第 ${index + 1} 个单元格起超过输出上限；可用 fs_read 读取原文件）`);
          break;
        }
        blocks.push(block);
        used += block.length;
      }
      return ok(`${logical}｜共 ${cells.length} 个单元格\n\n${blocks.join('\n\n')}`);
    },
  },
];
