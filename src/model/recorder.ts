import { randomBytes } from 'node:crypto';
import type { Store } from '../storage/store.ts';
import { outsideRevocation } from '../runtime/execution.ts';
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
    // 存储已关闭时不再发起新的业务模型调用：迟到的调度不应该继续消耗资源。
    if (this.store.isClosed) {
      throw new Error('存储已关闭，拒绝发起新的模型调用');
    }
    const id = `mc_${randomBytes(6).toString('hex')}`;
    try {
      outsideRevocation(() => {
        this.store.startModelCall({ id, purpose: this.purpose, model: request.model, ...this.scope });
      });
    } catch {
      // 记账失败不能影响业务调用。
      return this.inner.chat(request);
    }
    try {
      const result = await this.inner.chat(request);
      this.safeFinish({
        id,
        status: 'ok',
        usage: result.usage ?? null,
        httpAttempts: result.httpAttempts ?? null,
        error: null,
      });
      return result;
    } catch (error) {
      const message = (error as Error).message;
      const cancelled = (error as Error).name === 'AbortError' || /abort|cancel|取消/i.test(message);
      this.safeFinish({
        id,
        status: cancelled ? 'cancelled' : 'failed',
        usage: null,
        httpAttempts: ((error as { httpAttempts?: number }).httpAttempts ?? null) as number | null,
        error: message,
      });
      throw error;
    }
  }

  private safeFinish(input: Parameters<Store['finishModelCall']>[0]): void {
    // 记账是停机收尾的一部分：业务已经撤销，但"这次调用被取消/失败"必须留下来。
    // 这里退出撤销上下文，只为了让这一条记录落盘，不会让业务逻辑重新活过来。
    try {
      outsideRevocation(() => {
        if (this.store.isClosed) {
          console.warn(`[记账] 存储已关闭，调用 ${input.id} 的状态未能写入`);
          return;
        }
        this.store.finishModelCall(input);
      });
    } catch (error) {
      // 记账失败要有可见诊断，不能静默吞掉。
      console.warn(`[记账] 写入调用 ${input.id} 失败：${(error as Error).message}`);
    }
  }
}
