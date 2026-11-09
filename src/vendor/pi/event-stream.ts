/**
 * 移植自 pi @earendil-works/pi-coding-agent@1.5.0
 * 原文件：packages/ai/dist/utils/event-stream.js
 *
 * 逻辑逐行保留，只补了类型。上游改动时需要重新对照。
 */

class FifoQueue<T> {
  private incoming: T[] = [];
  private outgoing: T[] = [];

  get length(): number {
    return this.incoming.length + this.outgoing.length;
  }

  enqueue(value: T): void {
    this.incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        const item = this.incoming.pop();
        if (item !== undefined) this.outgoing.push(item);
      }
    }
    return this.outgoing.pop();
  }
}

interface StreamResult<T> {
  value: T | undefined;
  done: boolean;
}

/** 通用事件流：生产者 push/end，消费者 for-await 或 result()。 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  private readonly queue = new FifoQueue<TEvent>();
  private readonly waiting = new FifoQueue<(result: StreamResult<TEvent>) => void>();
  private done = false;
  private readonly finalResultPromise: Promise<TResult>;
  private resolveFinalResult!: (value: TResult) => void;
  private readonly isComplete: (event: TEvent) => boolean;
  private readonly extractResult: (event: TEvent) => TResult;

  constructor(isComplete: (event: TEvent) => boolean, extractResult: (event: TEvent) => TResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise<TResult>((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: TEvent): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  end(result?: TResult): void {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TEvent> {
    while (true) {
      if (this.queue.length > 0) {
        const next = this.queue.dequeue();
        if (next !== undefined) yield next;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<StreamResult<TEvent>>((resolve) => this.waiting.enqueue(resolve));
        if (result.done) return;
        if (result.value !== undefined) yield result.value;
      }
    }
  }

  result(): Promise<TResult> {
    return this.finalResultPromise;
  }
}
