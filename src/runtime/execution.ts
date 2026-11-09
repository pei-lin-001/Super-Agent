/**
 * 执行生命周期。
 *
 * 一个执行过程（Worker 一轮、Router 一次协调、一次工作记录整理）在取消之后
 * 必须彻底失去写库资格。这里用 AsyncLocalStorage 把「当前执行」带到存储层，
 * 而不是在每个调用点手动检查——手动检查总会漏掉 finally 和异常分支。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export class ExecutionRevoked extends Error {
  constructor(message = '执行已结束，不能再访问存储') {
    super(message);
    this.name = 'ExecutionRevoked';
  }
}

interface ExecutionState {
  revoked: boolean;
  reason: string;
}

const storage = new AsyncLocalStorage<ExecutionState>();

/** 当前执行是否已经失去写库资格。没有执行上下文时返回 false。 */
export function isRevoked(): boolean {
  return storage.getStore()?.revoked === true;
}

export function revocationReason(): string | null {
  const state = storage.getStore();
  return state && state.revoked ? state.reason : null;
}

/**
 * 一次执行过程。
 *
 * - `run()` 把执行上下文绑定到整段异步流程；
 * - `revoke()` 之后，这段流程里任何一次存储访问都会抛 `ExecutionRevoked`；
 * - `attach()` 接管底层 Promise：迟到结果只被观察，不进入业务流程。
 */
export class Execution {
  private readonly state: ExecutionState = { revoked: false, reason: '' };
  private readonly controller = new AbortController();
  private settled = false;

  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get active(): boolean {
    return !this.state.revoked;
  }

  /** 绑定执行上下文。同步与异步调用都在这段流程内。 */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    return storage.run(this.state, async () => fn());
  }

  revoke(reason: string): void {
    if (this.state.revoked) return;
    this.state.revoked = true;
    this.state.reason = reason;
    this.controller.abort();
  }

  /**
   * 接管底层调用。
   *
   * 底层即使完全不理会取消，最终总会 resolve 或 reject；这里保证：
   * - 已撤销时，迟到结果被丢弃，不返回给业务；
   * - 迟到的 reject 不会变成未处理拒绝；
   * - 业务方拿到的只有「撤销」这一种结局。
   */
  async attach<T>(work: Promise<T>): Promise<T> {
    if (this.state.revoked) {
      work.catch(() => undefined);
      throw new ExecutionRevoked();
    }
    const guarded = work.then(
      (value) => {
        this.settled = true;
        if (this.state.revoked) throw new ExecutionRevoked();
        return value;
      },
      (error: unknown) => {
        this.settled = true;
        if (this.state.revoked) throw new ExecutionRevoked();
        throw error;
      },
    );
    // 撤销时不再等底层：直接结束业务侧等待，迟到结果由上面的分支吞掉。
    return Promise.race([
      guarded,
      new Promise<never>((_, reject) => {
        if (this.controller.signal.aborted) {
          reject(new ExecutionRevoked());
          return;
        }
        this.controller.signal.addEventListener(
          'abort',
          () => {
            reject(new ExecutionRevoked());
          },
          { once: true },
        );
      }),
    ]).catch((error: unknown) => {
      if (error instanceof ExecutionRevoked) {
        // 保证底层结果最终被消费掉，不会变成未处理拒绝
        work.catch(() => undefined);
      }
      throw error;
    });
  }

  get finished(): boolean {
    return this.settled;
  }
}

/** 执行是否还能继续：撤销后一律不能。 */
export function ensureActive(): void {
  if (isRevoked()) throw new ExecutionRevoked();
}

/**
 * 在撤销上下文之外执行一段代码。
 *
 * 只给记账这类「停机后仍然必须落盘」的收尾用：业务执行已经撤销，
 * 但"这次调用被取消了"这件事本身必须留下记录，否则账目会漏。
 */
export function outsideRevocation<T>(fn: () => T): T {
  return storage.exit(fn);
}
