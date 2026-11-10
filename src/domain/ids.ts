import { randomBytes } from 'node:crypto';

function short(): string {
  return randomBytes(4).toString('hex');
}

export function newConversationId(): string {
  return `cv_${short()}`;
}

export function newTaskId(): string {
  return `task_${short()}`;
}

export function newWorkerId(seq: number): string {
  return `w${seq}_${short()}`;
}

export function newMessageId(): string {
  return `msg_${short()}`;
}

export function newArtifactId(): string {
  return `art_${short()}`;
}

export function newWaitId(): string {
  return `wait_${short()}`;
}

export function newJobId(): string {
  return `job_${short()}`;
}

export function newReviewId(): string {
  return `rev_${short()}`;
}

export function newEventId(): string {
  return `evt_${short()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 给人看的日志时间：「北京时间 HH:MM:SS」。
 *
 * 硬加 8 小时，不依赖机器时区——服务器可能是 UTC，也可能是别的时区，
 * 日志却必须是你抬眼就能对上墙钟的时间。
 *
 * 注意：数据库里的时间戳仍然走 nowIso()（UTC ISO）。排序、跨时区比较
 * 都必须用 UTC，只有日志这一层换成北京时间。
 */
export function clockStamp(date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(11, 19);
}

export function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
