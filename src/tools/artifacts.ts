import { argOptionalNumber, argOptionalString, argString, type ToolDefinition, type ToolOutcome } from './types.ts';

function ok(content: string): ToolOutcome {
  return { type: 'ok', content };
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
          `内容与当前最新版本完全相同，已复用 ${artifact.name} v${artifact.version}（id=${artifact.id}），没有创建新版本。` +
            '复用不会自动获得检查通过；如果要求检查，仍需针对这个版本取得结论。',
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
      '把任务目录里的真实文件登记为正式产物（按字节快照）。用于脚本生成的 CSV/JSON/代码/图片/PDF 等。' +
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
          `文件内容与当前最新版本完全相同，已复用 ${artifact.name} v${artifact.version}（id=${artifact.id}），没有创建新版本。` +
            '复用不会自动获得检查通过。',
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
      '按名字与版本读取已登记产物（版本默认最新）。返回内容与总长度；内容过长时用 offset 继续读取。',
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
      const offset = Math.max(0, argOptionalNumber(args, 'offset') ?? 0);
      const limit = Math.max(1, Math.min(20_000, argOptionalNumber(args, 'limit') ?? 8000));
      const { artifact, content } = await context.host.readArtifactVersion(context.task.id, name, version);
      const slice = content.slice(offset, offset + limit);
      const end = offset + slice.length;
      const suffix =
        end < content.length
          ? `\n…（${artifact.name} v${artifact.version} 共 ${content.length} 字符，已读到 ${end}；继续请用 offset=${end}）`
          : '';
      return ok(`# ${artifact.name} v${artifact.version}（${content.length} 字符）\n${slice}${suffix}`);
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
          .map((item) => `${item.id} ${item.name} v${item.version} ${item.bytes}B ${item.createdAt}`)
          .join('\n'),
      );
    },
  },
];
