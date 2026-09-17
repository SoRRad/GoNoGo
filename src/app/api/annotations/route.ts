import fs from 'fs';
import { NextResponse } from 'next/server';
import { getAssignmentForSurgeon, getQueueState, upsertAnnotation } from '@/lib/store';
import { getFrame } from '@/lib/store';
import { maskPath, toRelative, ensureDataDirs } from '@/lib/paths';
import { encodeBinaryMaskPng, isEmpty, occupancyFromUploadedPng } from '@/lib/masks';
import { getSessionSurgeon } from '@/server/auth';
import { buildWindow, canWrite } from '@/server/queue-access';
import type { AnnotationStatus, Confidence, Layer } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: AnnotationStatus[] = ['drawn', 'nothing_to_mark', 'cannot_assess'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];

/**
 * Autosave and submit share this endpoint: both upsert the single annotation
 * row for the assignment. Masks arrive as canvas PNGs and are rewritten as
 * binary grayscale at the frame's native resolution.
 */
export async function POST(request: Request) {
  const surgeon = await getSessionSurgeon();
  if (!surgeon) return NextResponse.json({ error: 'not_authorised' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'bad_body' }, { status: 400 });
  }

  const assignmentId = Number(form.get('assignmentId'));
  if (!Number.isInteger(assignmentId)) return NextResponse.json({ error: 'bad_assignment' }, { status: 400 });

  const assignment = getAssignmentForSurgeon(surgeon.id, assignmentId);
  if (!assignment) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const state = getQueueState(surgeon.id);
  if (!canWrite(state, assignment.display_order)) {
    return NextResponse.json({ error: 'out_of_range' }, { status: 403 });
  }

  const frame = getFrame(assignment.frame_id);
  if (!frame) return NextResponse.json({ error: 'frame_missing' }, { status: 404 });

  const rawStatus = String(form.get('status') || '');
  const status = STATUSES.includes(rawStatus as AnnotationStatus) ? (rawStatus as AnnotationStatus) : null;
  const rawConfidence = String(form.get('confidence') || '');
  const confidence = CONFIDENCES.includes(rawConfidence as Confidence) ? (rawConfidence as Confidence) : null;
  const submit = form.get('submit') === '1';
  const secondsSpent = Number(form.get('secondsSpent') || 0);
  const undoCount = Number(form.get('undoCount') || 0);

  ensureDataDirs();

  /**
   * Writes one layer. An empty or absent upload clears any mask already on
   * disk, so erasing everything and saving really does leave nothing behind.
   */
  const storeLayer = async (layer: Layer): Promise<string | null> => {
    const absolute = maskPath(frame.id, surgeon.id, assignmentId, layer);
    const uploaded = form.get(layer);

    if (!(uploaded instanceof File) || uploaded.size === 0) {
      await fs.promises.rm(absolute, { force: true });
      return null;
    }

    const buffer = Buffer.from(await uploaded.arrayBuffer());
    let mask;
    try {
      mask = occupancyFromUploadedPng(buffer);
    } catch {
      // Unreadable upload: drop any mask already on disk rather than leaving a
      // file the database no longer points at.
      console.warn(
        `[sadi] undecodable ${layer} mask upload for assignment ${assignmentId}, frame ${frame.id}`,
      );
      await fs.promises.rm(absolute, { force: true });
      return null;
    }
    if (mask.width !== frame.width || mask.height !== frame.height) {
      // Masks must line up with the frame pixel for pixel or they are useless.
      // Returning null here nulls the database column, so any file already at
      // this path would become an orphan: remove it in the same breath.
      console.warn(
        `[sadi] ${layer} mask upload for assignment ${assignmentId} was ` +
          `${mask.width}x${mask.height} but frame ${frame.id} is ${frame.width}x${frame.height}; ` +
          'discarded. This means the client drew at the wrong resolution.',
      );
      await fs.promises.rm(absolute, { force: true });
      return null;
    }
    if (isEmpty(mask.data)) {
      await fs.promises.rm(absolute, { force: true });
      return null;
    }

    await fs.promises.writeFile(absolute, encodeBinaryMaskPng(frame.width, frame.height, mask.data));
    return toRelative(absolute);
  };

  const goMaskPath = await storeLayer('go');
  const nogoMaskPath = await storeLayer('nogo');

  // A frame with strokes on it is 'drawn' regardless of what the client claimed.
  const effectiveStatus: AnnotationStatus | null =
    goMaskPath || nogoMaskPath ? 'drawn' : status === 'drawn' ? null : status;

  if (submit && !effectiveStatus) {
    return NextResponse.json({ error: 'nothing_to_submit' }, { status: 400 });
  }
  if (submit && effectiveStatus === 'drawn' && !confidence) {
    return NextResponse.json({ error: 'confidence_required' }, { status: 400 });
  }

  upsertAnnotation({
    assignmentId,
    surgeonId: surgeon.id,
    frameId: frame.id,
    status: effectiveStatus,
    goMaskPath,
    nogoMaskPath,
    confidence,
    secondsSpent,
    undoCount,
    submit,
  });

  return NextResponse.json({ ok: true, ...buildWindow(surgeon.id) });
}
