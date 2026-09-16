import { getQueueItem, getQueueState, type QueueItem, type QueueState } from '@/lib/store';
import type { QueueItemPayload } from '@/lib/types';

/** How far ahead a surgeon's browser may fetch, so frames are never loading. */
export const PRELOAD_AHEAD = 3;

/**
 * Navigation is deliberately tight: one frame back to fix a misclick, and no
 * free browsing forward. Reads reach a little further than writes only so the
 * next few frames can be preloaded.
 */
export function canRead(state: QueueState, index: number): boolean {
  if (index < 0 || index >= state.total) return false;
  return index >= state.currentIndex - 1 && index <= state.currentIndex + PRELOAD_AHEAD;
}

export function canWrite(state: QueueState, index: number): boolean {
  if (index < 0 || index >= state.total) return false;
  return index === state.currentIndex || index === state.currentIndex - 1;
}

export function toPayload(item: QueueItem, total: number): QueueItemPayload {
  return {
    assignmentId: item.assignmentId,
    index: item.index,
    total,
    frameId: item.frameId,
    width: item.width,
    height: item.height,
    frameUrl: `/api/frames/${item.frameId}`,
    isPractice: item.isPractice,
    status: item.status,
    confidence: item.confidence,
    // Cache-busted by updated time so a resumed frame never shows a stale mask.
    goMaskUrl: item.hasGoMask ? `/api/masks/${item.assignmentId}/go` : null,
    nogoMaskUrl: item.hasNogoMask ? `/api/masks/${item.assignmentId}/nogo` : null,
    secondsSpent: item.secondsSpent,
    undoCount: item.undoCount,
    submitted: item.submitted,
  };
}

export interface QueueWindow {
  state: QueueState;
  items: QueueItemPayload[];
}

/** The current frame, the one behind it, and the next few for preloading. */
export function buildWindow(surgeonId: number): QueueWindow {
  const state = getQueueState(surgeonId);
  const items: QueueItemPayload[] = [];
  for (let index = state.currentIndex - 1; index <= state.currentIndex + PRELOAD_AHEAD; index++) {
    if (!canRead(state, index)) continue;
    const item = getQueueItem(surgeonId, index);
    if (item) items.push(toPayload(item, state.total));
  }
  return { state, items };
}
