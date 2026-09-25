/**
 * Study management from the admin panel: adding, pausing and removing
 * surgeons, replacing a surgeon's link, and removing a frame.
 *
 * Every function takes the database explicitly so it can be tested against an
 * in-memory copy of the real schema. Files on disk (masks, the frame image)
 * are removed only after the database change has committed, so a failure can
 * leave an orphaned file behind but never a row pointing at a missing one.
 */
import fs from 'fs';
import type Database from 'better-sqlite3';
import type { Frame, Surgeon } from './db';
import { buildQueues } from './assign';
import type { BuiltQueue } from './assign';
import { generateAccessToken, nowIso } from './ids';
import { framePath, fromRelative } from './paths';
import { INDIVIDUAL_TARGET } from './queue';

export type ManageErrorCode =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_email'
  | 'duplicate_email'
  | 'no_images'
  | 'not_enough_images';

export class ManageError extends Error {
  constructor(
    readonly code: ManageErrorCode,
    message: string,
    readonly detail: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and checks a new surgeon's details. The email is stored lower-case, as seed:surgeons does. */
export function normaliseSurgeonInput(input: { name: string; email: string }): { name: string; email: string } {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const email = input.email.trim().toLowerCase();
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f]/.test(name)) {
    throw new ManageError('invalid_name', 'Enter the surgeon’s name (up to 120 characters).');
  }
  if (email.length > 254 || !EMAIL.test(email)) {
    throw new ManageError('invalid_email', 'Enter a valid email address.');
  }
  return { name, email };
}

function uniqueToken(db: Database.Database): string {
  let token = generateAccessToken();
  while (db.prepare('SELECT 1 FROM surgeons WHERE access_token = ?').get(token)) {
    token = generateAccessToken();
  }
  return token;
}

function requireSurgeon(db: Database.Database, id: number): Surgeon {
  const surgeon = db.prepare('SELECT * FROM surgeons WHERE id = ?').get(id) as Surgeon | undefined;
  if (!surgeon) throw new ManageError('not_found', 'That surgeon no longer exists.');
  return surgeon;
}

function requireFrame(db: Database.Database, id: number): Frame {
  const frame = db.prepare('SELECT * FROM frames WHERE id = ?').get(id) as Frame | undefined;
  if (!frame) throw new ManageError('not_found', 'That image no longer exists.');
  return frame;
}

/**
 * Adds a surgeon and builds their queue in one step, by the same rules as
 * `npm run assign`. If there are not enough unused frames for a full set of
 * their own, nothing is added: a surgeon with no queue would only get an empty
 * screen when they opened their link.
 */
export function addSurgeon(
  db: Database.Database,
  input: { name: string; email: string },
): { surgeon: Surgeon; queue: BuiltQueue } {
  const { name, email } = normaliseSurgeonInput(input);
  if (db.prepare('SELECT 1 FROM surgeons WHERE email = ?').get(email)) {
    throw new ManageError('duplicate_email', `${email} is already a surgeon in this study.`, { email });
  }

  return db.transaction(() => {
    const info = db
      .prepare('INSERT INTO surgeons (name, email, access_token, created_at) VALUES (?, ?, ?, ?)')
      .run(name, email, uniqueToken(db), nowIso());
    const id = Number(info.lastInsertRowid);

    // Throwing rolls the insert back with everything else.
    const result = buildQueues(db, { surgeonIds: [id], requireFullIndividual: true });
    if (result.kind === 'built') {
      return { surgeon: requireSurgeon(db, id), queue: result.built[0] };
    }
    if (result.kind === 'refused') {
      throw new ManageError(
        'not_enough_images',
        `Only ${result.perSurgeon} unused images are left, and each surgeon needs ${INDIVIDUAL_TARGET} ` +
          'of their own. Load more images, or remove a surgeon who is not taking part, then try again.',
        { available: result.perSurgeon, needed: INDIVIDUAL_TARGET },
      );
    }
    throw new ManageError('no_images', 'No study images are loaded yet.');
  })();
}

export function pauseSurgeon(db: Database.Database, id: number): Surgeon {
  requireSurgeon(db, id);
  db.prepare('UPDATE surgeons SET paused_at = COALESCE(paused_at, ?) WHERE id = ?').run(nowIso(), id);
  return requireSurgeon(db, id);
}

export function resumeSurgeon(db: Database.Database, id: number): Surgeon {
  requireSurgeon(db, id);
  db.prepare('UPDATE surgeons SET paused_at = NULL WHERE id = ?').run(id);
  return requireSurgeon(db, id);
}

/**
 * Issues a new link. The old one stops working at once, including in any
 * browser that had already opened it, because sessions are bound to the link.
 */
export function replaceLink(db: Database.Database, id: number): Surgeon {
  requireSurgeon(db, id);
  db.prepare('UPDATE surgeons SET access_token = ? WHERE id = ?').run(uniqueToken(db), id);
  return requireSurgeon(db, id);
}

export interface SurgeonImpact {
  surgeon: Surgeon;
  /** Frames in their queue, repeats included. */
  queued: number;
  /** Annotation rows, saved or submitted. */
  annotations: number;
  submitted: number;
  maskFiles: number;
}

function maskPathsWhere(db: Database.Database, column: 'surgeon_id' | 'frame_id', id: number): string[] {
  const rows = db
    .prepare(`SELECT go_mask_path AS go, nogo_mask_path AS nogo FROM annotations WHERE ${column} = ?`)
    .all(id) as { go: string | null; nogo: string | null }[];
  return rows.flatMap((row) => [row.go, row.nogo]).filter((value): value is string => Boolean(value));
}

export function surgeonImpact(db: Database.Database, id: number): SurgeonImpact {
  const surgeon = requireSurgeon(db, id);
  const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
  return {
    surgeon,
    queued: count('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ?'),
    annotations: count('SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ?'),
    submitted: count('SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ? AND submitted_at IS NOT NULL'),
    maskFiles: maskPathsWhere(db, 'surgeon_id', id).length,
  };
}

/**
 * Deletes a surgeon with everything they did: queue, annotations and mask
 * files. Their unique frames become free for surgeons added later. For someone
 * whose finished work should stay in the study, pause them instead.
 */
export function removeSurgeon(db: Database.Database, id: number): SurgeonImpact {
  const impact = surgeonImpact(db, id);
  const masks = maskPathsWhere(db, 'surgeon_id', id);
  db.transaction(() => {
    db.prepare('DELETE FROM annotations WHERE surgeon_id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE surgeon_id = ?').run(id);
    db.prepare('DELETE FROM surgeons WHERE id = ?').run(id);
  })();
  for (const relative of masks) fs.rmSync(fromRelative(relative), { force: true });
  return impact;
}

export interface FrameImpact {
  frame: Frame;
  /** Surgeons with this frame in their queue. */
  surgeons: number;
  /** Queue entries, a hidden repeat counting separately from its first showing. */
  queued: number;
  annotations: number;
  submitted: number;
  maskFiles: number;
}

export function frameImpact(db: Database.Database, id: number): FrameImpact {
  const frame = requireFrame(db, id);
  const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
  return {
    frame,
    surgeons: count('SELECT COUNT(DISTINCT surgeon_id) AS n FROM assignments WHERE frame_id = ?'),
    queued: count('SELECT COUNT(*) AS n FROM assignments WHERE frame_id = ?'),
    annotations: count('SELECT COUNT(*) AS n FROM annotations WHERE frame_id = ?'),
    submitted: count('SELECT COUNT(*) AS n FROM annotations WHERE frame_id = ? AND submitted_at IS NOT NULL'),
    maskFiles: maskPathsWhere(db, 'frame_id', id).length,
  };
}

/**
 * Renumbers a surgeon's queue 0..n-1, keeping its order.
 *
 * The queue position is read as "the display_order of the first unsubmitted
 * entry", and its length as the row count, so a gap left by a removed frame
 * would make the last frame unreachable. Ascending order with each row moved to
 * its rank never collides with the UNIQUE (surgeon_id, display_order): a row's
 * rank is never above its old position, and every lower rank is already held
 * by a row that has moved.
 */
export function compactQueue(db: Database.Database, surgeonId: number): void {
  const rows = db
    .prepare('SELECT id, display_order AS displayOrder FROM assignments WHERE surgeon_id = ? ORDER BY display_order')
    .all(surgeonId) as { id: number; displayOrder: number }[];
  const move = db.prepare('UPDATE assignments SET display_order = ? WHERE id = ?');
  rows.forEach((row, rank) => {
    if (row.displayOrder !== rank) move.run(rank, row.id);
  });
}

/**
 * Removes a frame from the study: out of every queue it is in (a hidden repeat
 * with it), with every annotation and mask drawn on it, and the image file.
 * Each affected queue is renumbered so it stays contiguous; a surgeon's work
 * on other frames is untouched.
 *
 * A core frame removed this way leaves the core set one smaller for everyone,
 * including surgeons added later, which is the point: the set stays identical
 * across surgeons.
 */
export function removeFrame(db: Database.Database, id: number): FrameImpact {
  const impact = frameImpact(db, id);
  const masks = maskPathsWhere(db, 'frame_id', id);
  const affected = (
    db.prepare('SELECT DISTINCT surgeon_id AS id FROM assignments WHERE frame_id = ?').all(id) as { id: number }[]
  ).map((row) => row.id);

  db.transaction(() => {
    db.prepare('DELETE FROM annotations WHERE frame_id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE frame_id = ?').run(id);
    db.prepare('DELETE FROM frames WHERE id = ?').run(id);
    for (const surgeonId of affected) compactQueue(db, surgeonId);
  })();

  for (const relative of masks) fs.rmSync(fromRelative(relative), { force: true });
  fs.rmSync(framePath(impact.frame.filename), { force: true });
  return impact;
}
