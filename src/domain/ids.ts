import { randomBytes } from 'node:crypto';

function short(): string {
  return randomBytes(4).toString('hex');
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

export function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
