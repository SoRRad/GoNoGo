import fs from 'fs';
import path from 'path';

/**
 * All runtime state lives under one directory so a single Docker volume mount
 * carries the whole study: the database, the frames, and every mask PNG.
 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const FRAMES_DIR = path.join(DATA_DIR, 'frames');
export const MASKS_DIR = path.join(DATA_DIR, 'masks');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const DB_PATH = path.join(DATA_DIR, 'app.db');

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, FRAMES_DIR, MASKS_DIR, EXPORTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Absolute path of a frame file, guarded against traversal via the filename. */
export function framePath(filename: string): string {
  const safe = path.basename(filename);
  return path.join(FRAMES_DIR, safe);
}

/**
 * Masks are addressed by frame + surgeon + layer, so a re-save overwrites in
 * place and there is never more than one current mask per (frame, surgeon).
 */
export function maskPath(frameId: number, surgeonId: number, layer: 'go' | 'nogo'): string {
  return path.join(MASKS_DIR, `${frameId}__${surgeonId}__${layer}.png`);
}

/** Path stored in the DB, relative to DATA_DIR, so the volume can move hosts. */
export function toRelative(absolutePath: string): string {
  return path.relative(DATA_DIR, absolutePath).split(path.sep).join('/');
}

export function fromRelative(relativePath: string): string {
  return path.join(DATA_DIR, relativePath);
}
