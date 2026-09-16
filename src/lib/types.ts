/** Shared between server and browser. Keep free of runtime imports. */

export type Layer = 'go' | 'nogo';
export type Tool = 'lasso' | 'brush' | 'eraser';
export type Confidence = 'low' | 'medium' | 'high';
export type AnnotationStatus = 'drawn' | 'nothing_to_mark' | 'cannot_assess';

export const LAYER_COLORS: Record<Layer, string> = {
  go: '#22c55e',
  nogo: '#ef4444',
};

/** Masks are drawn over tissue, so they never fully hide it. */
export const MASK_OPACITY = 0.4;

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 80;
export const DEFAULT_BRUSH = 30;

export interface QueueItemPayload {
  assignmentId: number;
  index: number;
  total: number;
  frameId: number;
  width: number;
  height: number;
  frameUrl: string;
  isPractice: boolean;
  status: AnnotationStatus | null;
  confidence: Confidence | null;
  goMaskUrl: string | null;
  nogoMaskUrl: string | null;
  secondsSpent: number;
  undoCount: number;
  submitted: boolean;
}
