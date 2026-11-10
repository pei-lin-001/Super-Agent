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
/** 北京时间的固定偏移。中国不实行夏令时，所以硬加 8 小时是安全的。 */
const BEIJING_OFFSET_MS = 8 * 3600_000;

export function clockStamp(date = new Date()): string {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(11, 19);
}

/**
 * 把库里存的 UTC 时间戳转成给人/模型看的北京时间「YYYY-MM-DD HH:MM:SS」。
 *
 * 只用于展示。存储、比较、过期判断一律用 UTC——把库里也改成北京时间会让
 * 新旧数据差 8 小时、排序全乱，而且跨时区就没有基准了。
 * 传进来的不是合法时间就原样返回，不制造 "Invalid Date" 噪音。
 */
export function beijingTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
