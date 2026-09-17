import fs from 'fs';
import Database from 'better-sqlite3';
import { applySchema } from '@/lib/db';
import { encodeBinaryMaskPng } from '@/lib/masks';
import { MASKS_DIR, maskPath, toRelative } from '@/lib/paths';
import type { Occupancy } from '@/lib/masks';

/** An in-memory database carrying the application's real schema. */
export function testDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

export function addSurgeon(db: Database.Database, name: string): number {
  const info = db
    .prepare('INSERT INTO surgeons (name, email, access_token, created_at) VALUES (?, ?, ?, ?)')
    .run(name, `${name.replace(/\W+/g, '.').toLowerCase()}@example.org`, `token-${name}-${Date.now()}${Math.random()}`, '2026-01-01T00:00:00.000Z');
  return Number(info.lastInsertRowid);
}

export function addFrame(
  db: Database.Database,
  options: { width?: number; height?: number; sourceVideo?: string | null; isPractice?: 0 | 1 } = {},
): number {
  const { width = 8, height = 8, sourceVideo = 'case01', isPractice = 0 } = options;
  const info = db
    .prepare('INSERT INTO frames (filename, source_video, width, height, is_practice) VALUES (?, ?, ?, ?, ?)')
    .run(`frame-${Math.random().toString(36).slice(2)}.png`, sourceVideo, width, height, isPractice);
  return Number(info.lastInsertRowid);
}

export function addAssignment(
  db: Database.Database,
  surgeonId: number,
  frameId: number,
  displayOrder: number,
  options: { isRepeat?: 0 | 1; repeatOf?: number | null } = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO assignments (surgeon_id, frame_id, display_order, is_repeat, repeat_of_assignment_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(surgeonId, frameId, displayOrder, options.isRepeat ?? 0, options.repeatOf ?? null);
  return Number(info.lastInsertRowid);
}

/** Writes a mask file and returns the DATA_DIR-relative path stored in the database. */
export function writeMask(
  frameId: number,
  surgeonId: number,
  layer: 'go' | 'nogo',
  width: number,
  height: number,
  occupancy: Occupancy,
): string {
  fs.mkdirSync(MASKS_DIR, { recursive: true });
  const absolute = maskPath(frameId, surgeonId, layer);
  fs.writeFileSync(absolute, encodeBinaryMaskPng(width, height, occupancy));
  return toRelative(absolute);
}

export function addAnnotation(
  db: Database.Database,
  options: {
    assignmentId: number;
    surgeonId: number;
    frameId: number;
    status: string | null;
    goMaskPath?: string | null;
    nogoMaskPath?: string | null;
    confidence?: string | null;
    secondsSpent?: number;
    undoCount?: number;
    submitted?: boolean;
  },
): number {
  const now = '2026-01-02T00:00:00.000Z';
  const info = db
    .prepare(
      `INSERT INTO annotations (
         assignment_id, surgeon_id, frame_id, status, go_mask_path, nogo_mask_path,
         confidence, seconds_spent, undo_count, created_at, updated_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.assignmentId,
      options.surgeonId,
      options.frameId,
      options.status,
      options.goMaskPath ?? null,
      options.nogoMaskPath ?? null,
      options.confidence ?? null,
      options.secondsSpent ?? 10,
      options.undoCount ?? 0,
      now,
      now,
      options.submitted === false ? null : now,
    );
  return Number(info.lastInsertRowid);
}

/** A rectangle mask, for building predictable overlaps. */
export function rect(width: number, height: number, x0: number, y0: number, x1: number, y1: number): Occupancy {
  const occupancy = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) occupancy[y * width + x] = 1;
  return occupancy;
}
