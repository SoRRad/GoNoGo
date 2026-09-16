import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getFrame, surgeonCanSeeFrame } from '@/lib/store';
import { framePath } from '@/lib/paths';
import { getSessionSurgeon, isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Frames are never public: a surgeon may only fetch frames on their own queue. */
export async function GET(_request: Request, context: { params: Promise<{ frameId: string }> }) {
  const { frameId: rawId } = await context.params;
  const frameId = Number(rawId);
  if (!Number.isInteger(frameId)) return new NextResponse('Bad request', { status: 400 });

  const surgeon = await getSessionSurgeon();
  const admin = await isAdmin();
  if (!surgeon && !admin) return new NextResponse('Not authorised', { status: 401 });
  if (surgeon && !admin && !surgeonCanSeeFrame(surgeon.id, frameId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const frame = getFrame(frameId);
  if (!frame) return new NextResponse('Not found', { status: 404 });

  const absolute = framePath(frame.filename);
  if (!fs.existsSync(absolute)) return new NextResponse('Frame file missing', { status: 404 });

  const body = await fs.promises.readFile(absolute);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': CONTENT_TYPES[path.extname(frame.filename).toLowerCase()] || 'application/octet-stream',
      // Frames are immutable once ingested, so preloading costs one fetch each.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': String(body.length),
    },
  });
}
