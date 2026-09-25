/**
 * Adding one uploaded image to the study, from the admin page.
 *
 * New images join the spare pool: surgeons added from now on can be dealt
 * them, and nobody's existing list changes. An image already in the study is
 * recognised by its content, not only its name, so uploading the same folder
 * twice, or a folder whose files were renamed, adds nothing twice.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { imageSize } from 'image-size';
import { FRAMES_DIR, framePath } from './paths';

/**
 * Far above any video frame; stops a stray video file or archive being read
 * into memory. Below Caddy's 32 MB request limit, so this check is the one
 * that answers, with a reason the upload page can show.
 */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** Room kept free on the data disk for the database, masks and exports. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;

export type UploadRefusal = 'empty' | 'too_large' | 'not_an_image' | 'no_operation' | 'practice' | 'disk_full';

export type UploadOutcome =
  | { kind: 'added'; id: number; filename: string; operation: string }
  | { kind: 'duplicate'; reason: 'same_image' | 'same_name'; id: number; filename: string }
  | { kind: 'refused'; reason: UploadRefusal };

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The operation as shown in the admin page and the export: the folder's name, tidied. */
export function normaliseOperation(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** A filename-safe version of a name: letters, digits, dot, dash and underscore only. */
export function safeNamePart(value: string): string {
  const safe = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return safe || 'image';
}

/**
 * How the image is stored: "<operation>__<file name>", as the command-line
 * loader names images from an operation's folder, with the extension taken
 * from what the file really is.
 */
export function storedNameFor(operation: string, originalName: string, type: 'png' | 'jpg'): string {
  const base = originalName.replace(/\.[^.]*$/, '');
  return `${safeNamePart(operation)}__${safeNamePart(base)}.${type}`;
}

/**
 * Records the content hash of images loaded before hashes were kept, so a
 * re-upload of them is recognised. Runs once in practice: afterwards there is
 * nothing left without one.
 */
export function backfillContentHashes(db: Database.Database): number {
  const missing = db.prepare('SELECT id, filename FROM frames WHERE content_sha256 IS NULL').all() as {
    id: number;
    filename: string;
  }[];
  const update = db.prepare('UPDATE frames SET content_sha256 = ? WHERE id = ?');
  let filled = 0;
  for (const frame of missing) {
    const file = framePath(frame.filename);
    if (!fs.existsSync(file)) continue;
    update.run(sha256(fs.readFileSync(file)), frame.id);
    filled++;
  }
  return filled;
}

function freeBytes(dir: string): number {
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function addUploadedImage(
  db: Database.Database,
  input: { operation: string; originalName: string; bytes: Buffer },
  options: { freeBytes?: (dir: string) => number } = {},
): UploadOutcome {
  const { bytes } = input;
  if (bytes.length === 0) return { kind: 'refused', reason: 'empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { kind: 'refused', reason: 'too_large' };

  const operation = normaliseOperation(input.operation);
  if (!operation) return { kind: 'refused', reason: 'no_operation' };
  // Practice images are the same five for everyone and were chosen at setup.
  if (operation.toLowerCase() === 'practice') return { kind: 'refused', reason: 'practice' };

  let type: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const size = imageSize(bytes);
    type = size.type;
    width = size.width ?? 0;
    height = size.height ?? 0;
  } catch {
    return { kind: 'refused', reason: 'not_an_image' };
  }
  // Judged by the bytes, not the file name: a renamed file is still what it is.
  if ((type !== 'png' && type !== 'jpg') || width <= 0 || height <= 0) {
    return { kind: 'refused', reason: 'not_an_image' };
  }

  backfillContentHashes(db);
  const hash = sha256(bytes);
  const sameImage = db.prepare('SELECT id, filename FROM frames WHERE content_sha256 = ?').get(hash) as
    | { id: number; filename: string }
    | undefined;
  if (sameImage) return { kind: 'duplicate', reason: 'same_image', ...sameImage };

  const filename = storedNameFor(operation, input.originalName, type);
  const sameName = db.prepare('SELECT id, filename FROM frames WHERE filename = ?').get(filename) as
    | { id: number; filename: string }
    | undefined;
  if (sameName) return { kind: 'duplicate', reason: 'same_name', ...sameName };

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  if ((options.freeBytes ?? freeBytes)(FRAMES_DIR) < MIN_FREE_BYTES + bytes.length) {
    return { kind: 'refused', reason: 'disk_full' };
  }

  // Written aside first and moved into place only once the row exists, so a
  // second upload racing this one can never leave a row without its file or
  // delete a file another row points at.
  const temporary = path.join(FRAMES_DIR, `.upload-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(temporary, bytes);
  let id: number;
  try {
    id = Number(
      db
        .prepare(
          `INSERT INTO frames (filename, source_video, width, height, is_practice, is_core, content_sha256)
           VALUES (?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(filename, operation, width, height, hash).lastInsertRowid,
    );
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    const raced = db
      .prepare('SELECT id, filename FROM frames WHERE filename = ? OR content_sha256 = ?')
      .get(filename, hash) as { id: number; filename: string } | undefined;
    if (raced) return { kind: 'duplicate', reason: raced.filename === filename ? 'same_name' : 'same_image', ...raced };
    throw error;
  }
  try {
    fs.renameSync(temporary, framePath(filename));
  } catch (error) {
    db.prepare('DELETE FROM frames WHERE id = ?').run(id);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return { kind: 'added', id, filename, operation };
}
