import type { ToolOutcome, ToolDefinition, ToolContext } from './types.ts';
import type { ToolSchema } from '../model/types.ts';

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  readonly label: string;

  constructor(label: string, definitions: ToolDefinition[]) {
    this.label = label;
    for (const definition of definitions) {
      if (this.definitions.has(definition.name)) {
        throw new Error(`工具名重复：${definition.name}`);
      }
      this.definitions.set(definition.name, definition);
    }
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /**
   * 执行工具。参数解析失败或工具抛错都转换为 failed 结果返回给模型，
   * 让它有机会修正；调用次数由步数预算兜底。
   */
  async execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
    const definition = this.definitions.get(name);
    if (!definition) {
      return { type: 'failed', content: `未知工具：${name}。可用工具：${[...this.definitions.keys()].join(', ')}` };
    }
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { type: 'failed', content: `工具 ${name} 的参数必须是 JSON 对象` };
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      return { type: 'failed', content: `工具 ${name} 参数不是合法 JSON：${(error as Error).message}` };
    }
    try {
      return await definition.run(args, context);
    } catch (error) {
      return { type: 'failed', content: `工具 ${name} 执行失败：${(error as Error).message}` };
    }
  }
}
