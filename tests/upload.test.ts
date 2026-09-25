import fs from 'fs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { encodeBinaryMaskPng } from '@/lib/masks';
import { framePath } from '@/lib/paths';
import {
  MAX_IMAGE_BYTES,
  addUploadedImage,
  backfillContentHashes,
  normaliseOperation,
  safeNamePart,
  sha256,
  storedNameFor,
} from '@/lib/upload';
import { addFrame, testDb } from './helpers';

let seed = 0;
/** A small PNG whose content differs on every call. */
function png(width = 8, height = 6): Buffer {
  const occupancy = new Uint8Array(width * height);
  occupancy[seed++ % occupancy.length] = 1;
  occupancy[(seed * 7) % occupancy.length] = 1;
  return encodeBinaryMaskPng(width, height, occupancy);
}

function jpg(width = 10, height = 4): Buffer {
  const data = Buffer.alloc(width * height * 4, 200);
  data[0] = seed++ % 255;
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}

const plenty = { freeBytes: () => 10 * 1024 ** 3 };

describe('names', () => {
  it('keeps the operation as the folder was called, tidied', () => {
    expect(normaliseOperation('  Case\t 12 \n')).toBe('Case 12');
    expect(normaliseOperation('Case\u000712')).toBe('Case12');
  });

  it('stores files under safe names, with the extension the bytes call for', () => {
    expect(safeNamePart('Case 12 (left)')).toBe('Case_12_left');
    expect(safeNamePart('../../etc/passwd')).toBe('etc_passwd');
    expect(safeNamePart('Zoë')).toBe('Zoe');
    expect(safeNamePart('???')).toBe('image');
    expect(storedNameFor('Case 12', 'frame 0001.JPG', 'png')).toBe('Case_12__frame_0001.png');
    expect(storedNameFor('Case 12', 'frame.tar.gz', 'jpg')).toBe('Case_12__frame.tar.jpg');
  });
});

describe('adding an uploaded image', () => {
  it('adds it to the spare pool with its size, operation and hash, and stores the file', () => {
    const db = testDb();
    const bytes = png(12, 9);
    const outcome = addUploadedImage(db, { operation: 'Case 26', originalName: 'frame_01.png', bytes }, plenty);
    expect(outcome).toMatchObject({ kind: 'added', filename: 'Case_26__frame_01.png', operation: 'Case 26' });
    if (outcome.kind !== 'added') throw new Error('not added');

    const row = db.prepare('SELECT * FROM frames WHERE id = ?').get(outcome.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      source_video: 'Case 26',
      width: 12,
      height: 9,
      is_practice: 0,
      is_core: 0,
      content_sha256: sha256(bytes),
    });
    expect(fs.readFileSync(framePath('Case_26__frame_01.png')).equals(bytes)).toBe(true);
    // Nobody's list is touched.
    expect((db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n).toBe(0);
  });

  it('accepts JPEG, judged by its bytes rather than its name', () => {
    const db = testDb();
    const outcome = addUploadedImage(db, { operation: 'Case 3', originalName: 'still.png', bytes: jpg() }, plenty);
    expect(outcome).toMatchObject({ kind: 'added', filename: 'Case_3__still.jpg' });
  });

  it('skips an image already in the study, even under another name', () => {
    const db = testDb();
    const bytes = png();
    addUploadedImage(db, { operation: 'Case 1', originalName: 'a.png', bytes }, plenty);
    const again = addUploadedImage(db, { operation: 'Renamed', originalName: 'b.png', bytes }, plenty);
    expect(again).toMatchObject({ kind: 'duplicate', reason: 'same_image', filename: 'Case_1__a.png' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }).n).toBe(1);
  });

  it('recognises images loaded before hashes were kept', () => {
    const db = testDb();
    const bytes = png();
    const id = addFrame(db);
    const { filename } = db.prepare('SELECT filename FROM frames WHERE id = ?').get(id) as { filename: string };
    fs.mkdirSync(framePath('x').replace(/x$/, ''), { recursive: true });
    fs.writeFileSync(framePath(filename), bytes);

    const outcome = addUploadedImage(db, { operation: 'Case 9', originalName: 'copy.png', bytes }, plenty);
    expect(outcome).toMatchObject({ kind: 'duplicate', reason: 'same_image', id });
    // And the backfill is done once, not on every upload.
    expect(backfillContentHashes(db)).toBe(0);
  });

  it('will not replace a different image that has the same operation and name', () => {
    const db = testDb();
    const first = png();
    addUploadedImage(db, { operation: 'Case 2', originalName: 'f.png', bytes: first }, plenty);
    const outcome = addUploadedImage(db, { operation: 'Case 2', originalName: 'f.png', bytes: png() }, plenty);
    expect(outcome).toMatchObject({ kind: 'duplicate', reason: 'same_name' });
    expect(fs.readFileSync(framePath('Case_2__f.png')).equals(first)).toBe(true);
  });

  it('refuses what cannot be a study image', () => {
    const db = testDb();
    const add = (operation: string, bytes: Buffer, name = 'x.png') =>
      addUploadedImage(db, { operation, originalName: name, bytes }, plenty);
    expect(add('Case 1', Buffer.alloc(0))).toEqual({ kind: 'refused', reason: 'empty' });
    expect(add('Case 1', Buffer.from('not an image at all'))).toEqual({ kind: 'refused', reason: 'not_an_image' });
    // A GIF is an image, but not one the study serves.
    expect(add('Case 1', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))).toEqual({
      kind: 'refused',
      reason: 'not_an_image',
    });
    expect(add('   ', png())).toEqual({ kind: 'refused', reason: 'no_operation' });
    expect(add('Practice', png())).toEqual({ kind: 'refused', reason: 'practice' });
    expect(add('Case 1', Buffer.alloc(MAX_IMAGE_BYTES + 1))).toEqual({ kind: 'refused', reason: 'too_large' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }).n).toBe(0);
  });

  it('stops before the disk fills, and leaves nothing behind', () => {
    const db = testDb();
    const outcome = addUploadedImage(
      db,
      { operation: 'Case 5', originalName: 'full.png', bytes: png() },
      { freeBytes: () => 100 * 1024 * 1024 },
    );
    expect(outcome).toEqual({ kind: 'refused', reason: 'disk_full' });
    expect(fs.existsSync(framePath('Case_5__full.png'))).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }).n).toBe(0);
  });

  it('leaves no temporary files', () => {
    const db = testDb();
    addUploadedImage(db, { operation: 'Case 7', originalName: 'a.png', bytes: png() }, plenty);
    const directory = framePath('a').replace(/a$/, '');
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('.upload-'))).toEqual([]);
  });
});
