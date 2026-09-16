import fs from 'fs';
import { NextResponse } from 'next/server';
import { getAnnotationByAssignment, getAssignmentForSurgeon } from '@/lib/store';
import { fromRelative } from '@/lib/paths';
import { getSessionSurgeon } from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * A surgeon's own saved mask, used to restore a frame they left mid-way.
 * Ownership is checked against the assignment, so one surgeon can never read
 * another's work.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ assignmentId: string; layer: string }> },
) {
  const { assignmentId: rawId, layer } = await context.params;
  const assignmentId = Number(rawId);
  if (!Number.isInteger(assignmentId) || (layer !== 'go' && layer !== 'nogo')) {
    return new NextResponse('Bad request', { status: 400 });
  }

  const surgeon = await getSessionSurgeon();
  if (!surgeon) return new NextResponse('Not authorised', { status: 401 });

  const assignment = getAssignmentForSurgeon(surgeon.id, assignmentId);
  if (!assignment) return new NextResponse('Not found', { status: 404 });

  const annotation = getAnnotationByAssignment(assignmentId);
  const relative = layer === 'go' ? annotation?.go_mask_path : annotation?.nogo_mask_path;
  if (!relative) return new NextResponse('Not found', { status: 404 });

  const absolute = fromRelative(relative);
  if (!fs.existsSync(absolute)) return new NextResponse('Not found', { status: 404 });

  const body = await fs.promises.readFile(absolute);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(body.length),
    },
  });
}
