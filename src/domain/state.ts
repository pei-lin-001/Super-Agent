import type { MessageStatus, TaskStatus, WorkerStatus } from './types.ts';

/**
 * 状态迁移规则集中在一处，便于单测与审计。
 * 终态一律不可再变，迟到消息不能把任务"复活"。
 */

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['active', 'cancelled', 'failed'],
  active: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['active', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const WORKER_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  // done 表示工作完成，从任何非终态都可能直接到达（例如等待中由别人代提交）。
  queued: ['running', 'waiting', 'done', 'cancelled', 'failed', 'dormant'],
  idle: ['queued', 'running', 'done', 'cancelled', 'failed', 'dormant'],
  running: ['queued', 'waiting', 'done', 'failed', 'cancelled', 'dormant'],
  waiting: ['queued', 'running', 'done', 'cancelled', 'failed', 'dormant'],
  // 休眠可以唤醒：这是它和 done 的唯一区别。长期不用的休眠由归档流程转成 done。
  dormant: ['queued', 'idle', 'done'],
  done: [],
  failed: [],
  cancelled: [],
};

const MESSAGE_TRANSITIONS: Record<MessageStatus, readonly MessageStatus[]> = {
  queued: ['delivered', 'failed', 'expired'],
  delivered: ['consumed', 'failed', 'expired'],
  consumed: [],
  failed: [],
  expired: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionWorker(from: WorkerStatus, to: WorkerStatus): boolean {
  return WORKER_TRANSITIONS[from].includes(to);
}

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_TRANSITIONS[from].includes(to);
}

export class TransitionError extends Error {
  constructor(kind: string, from: string, to: string) {
    super(`非法状态迁移：${kind} ${from} → ${to}`);
    this.name = 'TransitionError';
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new TransitionError('task', from, to);
}

export function assertWorkerTransition(from: WorkerStatus, to: WorkerStatus): void {
  if (!canTransitionWorker(from, to)) throw new TransitionError('worker', from, to);
}

export function assertMessageTransition(from: MessageStatus, to: MessageStatus): void {
  if (!canTransitionMessage(from, to)) throw new TransitionError('message', from, to);
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalWorker(status: WorkerStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** 休眠不等于结束：还能被唤醒接到新任务上。调度层要把它和终态分开看。 */
export function isDormantWorker(status: WorkerStatus): boolean {
  return status === 'dormant';
}

/**
 * 不该被调度、也不该被"任务结束"顺手收掉的成员。
 *
 * 终态和休眠都不是"正在干活"：前者已经结束，后者在等下一次唤醒。
 * 凡是"把非活跃成员收掉"的路径都该问这个函数，而不是只问 isTerminalWorker——
 * 后者会把休眠成员当成活的，然后试图把它转成 cancelled，撞上状态机。
 */
export function isInactiveWorker(status: WorkerStatus): boolean {
  return isTerminalWorker(status) || isDormantWorker(status);
}
