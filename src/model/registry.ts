import type { ModelProfile } from '../config.ts';
import type { ModelClient } from './types.ts';

/**
 * 模型目录的运行时视图。
 *
 * 只做「别名 → 客户端 + 模型名」的解析，不参与选型、不做复杂度评分，
 * 也不把别名和职责绑定。未配置的别名必须显式报错，不能悄悄回退到默认模型。
 */
export class ModelRegistry {
  private readonly profiles: Map<string, ModelProfile>;
  private readonly clients: Map<string, ModelClient>;

  constructor(profiles: ModelProfile[], clients: Map<string, ModelClient>) {
    this.profiles = new Map(profiles.map((profile) => [profile.alias, profile]));
    this.clients = clients;
  }

  /** 供提示词展示：只有来自配置的信息，不伪装成实测能力。 */
  list(): { alias: string; model: string; note: string | null; costHint: string | null }[] {
    return [...this.profiles.values()].map((profile) => ({
      alias: profile.alias,
      model: profile.model,
      note: profile.note,
      costHint: profile.costHint,
    }));
  }

  /**
   * 该别名真实的上下文窗口；没配就返回 null，调用方退回全局配置。
   * 填大了会被提供方 400，所以宁可让它在目录里显式写出来。
   */
  contextWindowOf(alias: string | null): number | null {
    if (!alias) return null;
    return this.profiles.get(alias)?.contextWindow ?? null;
  }

  has(alias: string): boolean {
    return this.profiles.has(alias);
  }

  /** 未配置的别名在这里就失败，不返回兜底客户端。 */
  resolve(alias: string): { client: ModelClient; model: string; alias: string } {
    const profile = this.profiles.get(alias);
    if (!profile) {
      throw new Error(`未配置的模型别名：${alias}；可用别名：${[...this.profiles.keys()].join(', ')}`);
    }
    const client = this.clients.get(alias);
    if (!client) throw new Error(`模型别名 ${alias} 没有可用的客户端`);
    return { client, model: profile.model, alias };
  }
}
