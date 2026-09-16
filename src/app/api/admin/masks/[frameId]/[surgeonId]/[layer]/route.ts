import fs from 'fs';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { fromRelative } from '@/lib/paths';
import { isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** Any surgeon's mask, for the admin overlay. Never reachable by a surgeon. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ frameId: string; surgeonId: string; layer: string }> },
) {
  if (!(await isAdmin())) return new NextResponse('Not authorised', { status: 401 });

  const { frameId, surgeonId, layer } = await context.params;
  if (layer !== 'go' && layer !== 'nogo') return new NextResponse('Bad request', { status: 400 });

  const row = getDb()
    .prepare(
      `SELECT go_mask_path AS goPath, nogo_mask_path AS nogoPath
         FROM annotations
        WHERE frame_id = ? AND surgeon_id = ? AND submitted_at IS NOT NULL`,
    )
    .get(Number(frameId), Number(surgeonId)) as { goPath: string | null; nogoPath: string | null } | undefined;

  const relative = layer === 'go' ? row?.goPath : row?.nogoPath;
  if (!relative) return new NextResponse('Not found', { status: 404 });

  const absolute = fromRelative(relative);
  if (!fs.existsSync(absolute)) return new NextResponse('Not found', { status: 404 });

  const body = await fs.promises.readFile(absolute);
  return new NextResponse(new Uint8Array(body), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' },
  });
}
