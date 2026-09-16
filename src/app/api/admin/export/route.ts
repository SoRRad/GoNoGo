import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { createExportArchive } from '@/lib/export';
import { isAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A full export of a finished study can take a while to compress.
export const maxDuration = 300;

/** Streams the whole study as a zip, so nothing is buffered in memory. */
export async function GET() {
  if (!(await isAdmin())) return new NextResponse('Not authorised', { status: 401 });

  const { archive } = createExportArchive();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');

  return new NextResponse(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="sadi-export-${stamp}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
