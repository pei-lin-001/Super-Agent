/**
 * 领域模型：任务（=群组）、Worker、消息、产物、等待、检查、对话轮次。
 *
 * 设计约束：
 * - 任务与群组 1:1，groupId 就是可见性边界。
 * - Worker 只有一个 parentId 字段，仅用于记录来源，不构成任何权限关系。
 * - 消息状态只描述投递事实，完成与否由任务状态和产物校验决定。
 */

export type TaskStatus = 'pending' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/**
 * queued 表示「需要跑，但还没跑」：单轮步数用完、恢复后待调度都落在这个状态，
 * 因此重启后可以直接从数据库重建调度，而不靠内存队列。
 * idle 仅用于兼容历史数据。
 */
export type WorkerStatus = 'queued' | 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type MessageStatus = 'queued' | 'delivered' | 'consumed' | 'failed' | 'expired';

export type ActorKind = 'user' | 'router' | 'worker' | 'system';

/** 消息用途。request/reply 覆盖求助、核对、检查三种协作意图。 */
export type MessageKind =
  | 'assign'
  | 'update'
  | 'stop'
  | 'progress'
  | 'result'
  | 'fail'
  | 'question'
  | 'request'
  | 'reply'
  | 'notice';

/** 检查结论。只有 approved 能放行交付；其余一律视为未通过。 */
export type ReviewOutcome = 'pending' | 'approved' | 'changes_required' | 'inconclusive';

/** 等待原因，决定恢复时如何处理。 */
export type WaitReason = 'reply' | 'provider' | 'user';

export interface Task {
  id: string;
  groupId: string;
  title: string;
  goal: string;
  brief: string;
  doneCriteria: string;
  /** 是否必须经过一次同组检查（由 Router 建任务时声明，程序据此校验）。 */
  requireReview: boolean;
  /** 要求版本号：用户每次补充要求时递增，旧检查不再算数。 */
  reviewEpoch: number;
  ownerWorkerId: string | null;
  status: TaskStatus;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Worker {
  id: string;
  groupId: string;
  parentId: string | null;
  role: string;
  brief: string;
  status: WorkerStatus;
  model: string | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface MessageRefs {
  artifacts?: { artifactId: string; name: string; version: number }[];
  files?: string[];
  messages?: string[];
}

export interface Message {
  id: string;
  groupId: string;
  taskId: string | null;
  fromKind: ActorKind;
  fromId: string;
  toKind: 'worker' | 'router' | 'group';
  toId: string;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown> | null;
  replyTo: string | null;
  refs: MessageRefs | null;
  /** 发送方提供的去重键：同一群组内相同键只落一条消息。 */
  dedupeKey: string | null;
  /** 广播时指向同一次广播的编号；每个接收者各有一条独立消息。 */
  broadcastId: string | null;
  status: MessageStatus;
  createdAt: string;
  deliveredAt: string | null;
  consumedAt: string | null;
  error: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  workerId: string;
  name: string;
  path: string;
  version: number;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface WaitRecord {
  id: string;
  workerId: string;
  groupId: string;
  reason: WaitReason;
  matchFrom: string | null;
  matchReplyTo: string | null;
  matchKinds: MessageKind[] | null;
  deadlineAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * 一条检查记录对应「一次检查请求」与「一份产物版本」。
 * 一次请求检查多份产物时会有多行，同一事务写入。
 * 产物 id 本身唯一标识一个版本，sha256 再固定内容，防止登记后被改写。
 */
export interface Review {
  id: string;
  taskId: string;
  artifactId: string;
  artifactVersion: number;
  artifactSha256: string;
  epoch: number;
  requestedBy: string;
  reviewerId: string | null;
  requestMessageId: string;
  replyMessageId: string | null;
  outcome: ReviewOutcome;
  createdAt: string;
}

export interface WorkerTurn {
  id: string;
  workerId: string;
  seq: number;
  role: 'assistant' | 'tool' | 'system' | 'user';
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  createdAt: string;
}

export interface RouterTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  taskId: string | null;
  workerId: string | null;
  type: string;
  detail: string | null;
  createdAt: string;
}

/** 程序向界面广播的运行时事件。 */
export type RuntimeEvent =
  | { type: 'task.created'; taskId: string; title: string }
  | { type: 'task.status'; taskId: string; status: TaskStatus; reason?: string }
  | { type: 'worker.created'; workerId: string; role: string; parentId: string | null }
  | { type: 'worker.status'; workerId: string; status: WorkerStatus }
  | { type: 'message.sent'; messageId: string; from: string; to: string; kind: MessageKind }
  | { type: 'router.start' }
  | { type: 'router.reply'; text: string }
  | { type: 'router.notice'; text: string }
  | { type: 'error'; text: string };
