import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { DATA_DIR, FRAMES_DIR, MASKS_DIR } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness for Docker and whatever sits in front of it.
 *
 * A bare SELECT 1 passes even when the data volume has failed to mount, because
 * SQLite will happily open a brand new empty database on the container's own
 * filesystem — the application looks healthy while every annotation written to
 * it is lost on the next restart. These checks catch that.
 *
 * Reason codes only: no paths, counts or configuration leave this endpoint,
 * because it is reachable without authentication.
 */
export async function GET() {
  const fail = (reason: string) =>
    NextResponse.json({ ok: false, reason }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    return fail('database_unavailable');
  }

  // The volume must be mounted and writable, or annotations go nowhere durable.
  const probe = path.join(MASKS_DIR, `.health-${process.pid}`);
  try {
    if (!fs.existsSync(DATA_DIR)) return fail('data_dir_missing');
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe, { force: true });
  } catch {
    await fs.promises.rm(probe, { force: true }).catch(() => {});
    return fail('data_dir_not_writable');
  }

  // Frames are seeded before the study opens; an empty directory means the
  // volume is mounted but the wrong one, or seeding never ran.
  try {
    if (!fs.existsSync(FRAMES_DIR)) return fail('frames_dir_missing');
    const entries = await fs.promises.readdir(FRAMES_DIR);
    if (entries.filter((name) => !name.startsWith('.')).length === 0) return fail('frames_dir_empty');
  } catch {
    return fail('frames_dir_unreadable');
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
