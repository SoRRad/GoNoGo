import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { MAX_IMAGE_BYTES, addUploadedImage } from '@/lib/upload';
import { refuseUnlessAdminAction } from '@/server/admin-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One image per request, sent as the raw file with its operation and name in
 * the query. One at a time keeps memory flat on a small machine, and a dropped
 * connection costs one image, not the batch.
 */
export async function POST(request: Request) {
  const refused = await refuseUnlessAdminAction(request);
  if (refused) return refused;

  const url = new URL(request.url);
  const operation = url.searchParams.get('operation') ?? '';
  const originalName = url.searchParams.get('name') ?? '';

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    return NextResponse.json({ kind: 'refused', reason: 'too_large' }, { status: 413 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());

  const outcome = addUploadedImage(getDb(), { operation, originalName, bytes });
  if (outcome.kind === 'added') {
    console.log(`[sadi] admin uploaded frame ${outcome.id}`);
  }
  return NextResponse.json(outcome);
}
