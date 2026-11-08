import { randomBytes } from 'node:crypto';
import type { Store } from '../storage/store.ts';
import type { ChatRequest, ModelClient, StepResult } from './types.ts';

export type CallPurpose = 'router' | 'worker' | 'note' | 'watchdog' | 'context';

/**
 * 模型调用的独立记账。
 * 对话条数不等于调用次数：一次巡检可能调 3 次模型但只留 1 条总结。
 * 这里每次 chat() 都开一条记录，失败、取消、中断都能追踪。
 */
export class RecordingModel implements ModelClient {
  readonly kind: ModelClient['kind'];
  readonly label: string;
  private readonly inner: ModelClient;
  private readonly store: Store;
  private readonly purpose: CallPurpose;
  private readonly scope: { taskId?: string | null; workerId?: string | null; sessionId?: string | null };

  constructor(
    inner: ModelClient,
    store: Store,
    purpose: CallPurpose,
    scope: { taskId?: string | null; workerId?: string | null; sessionId?: string | null } = {},
  ) {
    this.inner = inner;
    this.store = store;
    this.purpose = purpose;
    this.scope = scope;
    this.kind = inner.kind;
    this.label = inner.label;
  }

  async chat(request: ChatRequest): Promise<StepResult> {
    if (this.store.isClosed) return this.inner.chat(request);
    const id = `mc_${randomBytes(6).toString('hex')}`;
    try {
      this.store.startModelCall({ id, purpose: this.purpose, model: request.model, ...this.scope });
    } catch {
      // 记账失败不能影响业务调用。
      return this.inner.chat(request);
    }
    try {
      const result = await this.inner.chat(request);
      this.safeFinish({ id, status: 'ok', usage: result.usage ?? null, error: null });
      return result;
    } catch (error) {
      const message = (error as Error).message;
      const cancelled = (error as Error).name === 'AbortError' || /abort|cancel|取消/i.test(message);
      this.safeFinish({
        id,
        status: cancelled ? 'cancelled' : 'failed',
        usage: null,
        error: message,
      });
      throw error;
    }
  }

  private safeFinish(input: Parameters<Store['finishModelCall']>[0]): void {
    try {
      this.store.finishModelCall(input);
    } catch {
      // 存储已关闭时不再写库。
    }
  }
}
