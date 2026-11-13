import {
  argOptionalNumber,
  argOptionalString,
  argString,
  type ToolDefinition,
  type ToolHost,
  type ToolOutcome,
} from './types.ts';
import { beijingTime } from '../domain/ids.ts';

const DEFAULT_READ_CHARS = 8000;
const MAX_READ_CHARS = 20_000;

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
}

/**
 * Worker 的 artifact_read 与 Router 的 read_artifact 共用这一实现。
 *
 * 产物查找、sha256 指纹校验和 UTF-8 检查都由 readArtifactVersion 完成；
 * 这里只负责统一的字符分页和续读位置，避免两个入口出现不同的截断规则。
 */
export async function formatArtifactRead(
  host: Pick<ToolHost, 'readArtifactVersion'>,
  taskId: string,
  name: string,
  version?: number | null,
  offset = 0,
  limit = DEFAULT_READ_CHARS,
): Promise<string> {
  const start = Math.max(0, Math.trunc(offset));
  const size = Math.max(1, Math.min(MAX_READ_CHARS, Math.trunc(limit)));
  const { artifact, content } = await host.readArtifactVersion(taskId, name, version ?? null);
  const slice = content.slice(start, start + size);
  const end = start + slice.length;
  const suffix =
    end < content.length
      ? `\n…（${artifact.name} v${artifact.version} 共 ${content.length} 字符，已读到 ${end}；继续请用 offset=${end}）`
      : '';
  return `# ${artifact.name} v${artifact.version}（${content.length} 字符）\n${slice}${suffix}`;
}

export const artifactTools: ToolDefinition[] = [
  {
    name: 'artifact_save',
    description:
      '把交付物保存为带版本号的产物（同名文件版本号递增，旧版本保留）。最终交付必须通过 submit_result 引用产物。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '产物文件名，例如 report.md' },
        content: { type: 'string', description: '完整内容' },
      },
      required: ['name', 'content'],
    },
    run(args, context) {
      const name = argString(args, 'name');
      const raw = args['content'];
      if (typeof raw !== 'string') throw new Error('参数 content 必须是字符串');
      const { artifact, reused } = context.host.saveArtifact(context.worker, name, raw);
      if (reused) {
        return ok(
          `内容与当前最新版本完全相同，已复用 ${artifact.name} v${artifact.version}（id=${artifact.id}，sha256=${artifact.sha256.slice(0, 12)}…），没有创建新版本，也未改变该版本的审查状态。` +
            '若产物表显示此版本在当前要求下已有有效 approved，该结论仍适用；否则复用本身不会产生通过结论。请以产物表中的实际状态为准。',
        );
      }
      return ok(
        `已保存产物 ${artifact.name} v${artifact.version}（id=${artifact.id}，${artifact.bytes} 字节，sha256=${artifact.sha256.slice(0, 12)}…）`,
      );
    },
  },
  {
    name: 'artifact_import',
    description:
      '把任务目录里已存在的文件登记为正式产物（按字节快照），包括文本报告及脚本生成的 CSV/JSON/代码/图片/PDF 等。局部修改可先用 fs_edit 修改原文件再登记，无需重生成全文。' +
      '登记后源文件再变化也不会改变已登记的版本；后续检查、提交都针对这个快照。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源文件路径（相对任务目录）' },
        name: { type: 'string', description: '产物文件名，默认取源文件名' },
      },
      required: ['source'],
    },
    run(args, context) {
      const source = argString(args, 'source');
      const name = argOptionalString(args, 'name') ?? source.split('/').at(-1) ?? source;
      const { artifact, reused } = context.host.importArtifact(context.worker, name, source);
      if (reused) {
        return ok(
          `文件内容与当前最新版本完全相同，已复用 ${artifact.name} v${artifact.version}（id=${artifact.id}，sha256=${artifact.sha256.slice(0, 12)}…），没有创建新版本，也未改变该版本的审查状态。` +
            '若产物表显示此版本在当前要求下已有有效 approved，该结论仍适用；否则复用本身不会产生通过结论。请以产物表中的实际状态为准。',
        );
      }
      return ok(
        `已登记产物 ${artifact.name} v${artifact.version}（id=${artifact.id}，${artifact.bytes} 字节，` +
          `sha256=${artifact.sha256.slice(0, 12)}…）`,
      );
    },
  },
  {
    name: 'artifact_read',
    description:
      '按名字与版本读取已登记的 UTF-8 文本产物（版本默认最新）。内容过长时用 offset 继续读取；图片可用 fs_view_image 查看。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '产物文件名，例如 report.md' },
        version: { type: 'number', description: '版本号；省略表示最新版本' },
        offset: { type: 'number', description: '字符偏移，默认 0' },
        limit: { type: 'number', description: '本次读取字符数，默认 8000' },
      },
      required: ['name'],
    },
    async run(args, context) {
      const name = argString(args, 'name');
      const version = argOptionalNumber(args, 'version') ?? null;
      const offset = argOptionalNumber(args, 'offset') ?? 0;
      const limit = argOptionalNumber(args, 'limit') ?? DEFAULT_READ_CHARS;
      return ok(await formatArtifactRead(context.host, context.task.id, name, version, offset, limit));
    },
  },
  {
    name: 'artifact_list',
    description: '列出本任务已登记的产物及其版本。',
    parameters: { type: 'object', properties: {}, required: [] },
    run(_args, context) {
      const artifacts = context.host.listArtifacts(context.task.id);
      if (artifacts.length === 0) return ok('(暂无产物)');
      return ok(
        artifacts
          .map((item) => `${item.id} ${item.name} v${item.version} ${item.bytes}B ${beijingTime(item.createdAt)}`)
          .join('\n'),
      );
    },
  },
];
