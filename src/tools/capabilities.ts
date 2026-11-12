import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolOutcome } from './types.ts';
import { resolveSearchTarget } from './net.ts';

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

function probe(binary: string): { ok: boolean; version: string | null } {
  if (!existsSync(binary) && !existsSync(`/usr/bin/${binary}`) && !existsSync(`/usr/local/bin/${binary}`)) {
    try {
      execFileSync('which', [binary], { stdio: 'ignore' });
    } catch {
      return { ok: false, version: null };
    }
  }
  try {
    const raw = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, version: raw.trim().split('\n')[0] ?? null };
  } catch {
    return { ok: true, version: null };
  }
}

/**
 * 环境能力自检：让 Worker 知道哪些能力现在真的可用。
 * 只报告状态，不输出任何凭据内容。
 */
export const capabilityTools: ToolDefinition[] = [
  {
    name: 'env_capabilities',
    description:
      '查询当前环境实际可用的能力：工作目录、可用的解释器与系统工具、搜索是否配置、PDF 提取与图片输入是否可用。' +
      '在需要运行命令、读 PDF 或联网前调用一次，可以避免反复试错。不会输出任何密钥内容。',
    parameters: { type: 'object', properties: {}, required: [] },
    run(_args, context) {
      const lines: string[] = [];
      lines.push('# 工作范围');
      lines.push(`任务目录：${join(context.workDir, context.task.id)}`);
      lines.push(`只读材料目录：${context.materialsDir}`);
      lines.push(`额外只读根：${context.readRoot}`);
      lines.push('文件写入限于任务目录；命令执行不受此限制（见下方隔离说明）。');

      lines.push('\n# 解释器与系统工具');
      for (const binary of ['python3', 'python', 'node', 'git', 'rg', 'jq', 'pdftotext', 'pdfinfo', 'make', 'curl']) {
        const result = probe(binary);
        lines.push(`- ${binary}：${result.ok ? `可用${result.version ? `（${result.version}）` : ''}` : '不可用'}`);
      }

      lines.push('\n# 联网');
      const target = resolveSearchTarget();
      lines.push(`- net_fetch：可用（HTTP/HTTPS，未知地址请勿猜测）`);
      lines.push(
        `- net_search：${
          target.apiKey.trim() === ''
            ? `不可用（未配置 ${target.keyHint}）`
            : `已配置（${target.name}，未测试连接）`
        }`,
      );

      lines.push('\n# 资料读取');
      lines.push(`- PDF 文本：${probe('pdftotext').ok ? '可用（不支持扫描件 OCR）' : '不可用（缺少 pdftotext）'}`);
      lines.push('- Notebook：可用（读取单元格与文本输出）');
      const vision = process.env['MODEL_VISION'] !== '0';
      lines.push(
        `- 图片视觉输入：${vision ? 'fs_view_image 可加载图片；实际识别取决于模型是否支持视觉' : '按配置标记为不可用'}。`,
      );

      lines.push('\n# 执行与隔离边界');
      lines.push('- proc_run 以程序名 + 参数数组执行，不经过 shell；只继承基础环境变量（不含模型/搜索凭据）。');
      lines.push('- 工作目录只是进程的起始目录，**不是操作系统级隔离**：命令仍可访问运行用户可读写的其他路径。');
      lines.push('- 不要运行来源不明的脚本；需要隔离时请使用容器或虚拟机。');

      return ok(lines.join('\n'));
    },
  },
];
