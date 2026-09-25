/**
 * Ingests still frames into the study.
 *
 *   npm run seed:frames -- <dir> [--source-video=NAME]
 *
 * Layout inside <dir>:
 *   practice/*.png        -> the shared practice frames, always shown first
 *   <video-name>/*.png    -> real frames, source_video taken from the folder
 *   *.png                 -> real frames, source_video from --source-video
 *
 * Files are copied into data/frames and recorded with their native dimensions.
 * Re-running is safe: a filename already in the database is updated, not duplicated.
 */
import fs from 'fs';
import path from 'path';
import { imageSize } from 'image-size';
import { getDb } from '../src/lib/db';
import { FRAMES_DIR, ensureDataDirs, framePath } from '../src/lib/paths';
import { sha256 } from '../src/lib/upload';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

interface Candidate {
  sourcePath: string;
  storedName: string;
  sourceVideo: string | null;
  isPractice: boolean;
}

function listImages(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function collect(root: string, explicitVideo: string | null): Candidate[] {
  const out: Candidate[] = [];

  for (const file of listImages(path.join(root, 'practice'))) {
    out.push({ sourcePath: file, storedName: path.basename(file), sourceVideo: null, isPractice: true });
  }

  for (const file of listImages(root)) {
    out.push({
      sourcePath: file,
      storedName: path.basename(file),
      sourceVideo: explicitVideo,
      isPractice: false,
    });
  }

  const subdirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'practice')
    .map((entry) => entry.name)
    .sort();

  for (const video of subdirs) {
    for (const file of listImages(path.join(root, video))) {
      // Namespaced so two videos can both contain frame_0001.png.
      out.push({
        sourcePath: file,
        storedName: `${video}__${path.basename(file)}`,
        sourceVideo: explicitVideo || video,
        isPractice: false,
      });
    }
  }

  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  const videoFlag = args.find((arg) => arg.startsWith('--source-video='));
  const explicitVideo = videoFlag ? videoFlag.split('=').slice(1).join('=') : null;

  if (!dir) {
    console.error('Usage: npm run seed:frames -- <dir> [--source-video=NAME]');
    process.exit(1);
  }
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    console.error(`No such directory: ${root}`);
    process.exit(1);
  }

  ensureDataDirs();
  const db = getDb();
  const candidates = collect(root, explicitVideo);
  if (candidates.length === 0) {
    console.error(`No .png/.jpg/.jpeg files found under ${root}`);
    process.exit(1);
  }

  const insert = db.prepare(
    `INSERT INTO frames (filename, source_video, width, height, is_practice, content_sha256)
     VALUES (@filename, @sourceVideo, @width, @height, @isPractice, @contentSha256)
     ON CONFLICT (filename) DO UPDATE SET
        source_video   = excluded.source_video,
        width          = excluded.width,
        height         = excluded.height,
        is_practice    = excluded.is_practice,
        content_sha256 = excluded.content_sha256`,
  );

  let added = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const candidate of candidates) {
      const destination = framePath(candidate.storedName);
      const buffer = fs.readFileSync(candidate.sourcePath);
      let dimensions;
      try {
        dimensions = imageSize(buffer);
      } catch {
        console.warn(`  ! unreadable image, skipped: ${candidate.sourcePath}`);
        skipped++;
        continue;
      }
      if (!dimensions.width || !dimensions.height) {
        console.warn(`  ! no dimensions, skipped: ${candidate.sourcePath}`);
        skipped++;
        continue;
      }

      if (path.resolve(candidate.sourcePath) !== path.resolve(destination)) {
        fs.writeFileSync(destination, buffer);
      }

      const existed = db.prepare('SELECT id FROM frames WHERE filename = ?').get(candidate.storedName);
      insert.run({
        filename: candidate.storedName,
        sourceVideo: candidate.sourceVideo,
        width: dimensions.width,
        height: dimensions.height,
        isPractice: candidate.isPractice ? 1 : 0,
        contentSha256: sha256(buffer),
      });
      if (existed) updated++;
      else added++;
    }
  });
  run();

  const practice = (db.prepare('SELECT COUNT(*) AS n FROM frames WHERE is_practice = 1').get() as { n: number }).n;
  const real = (db.prepare('SELECT COUNT(*) AS n FROM frames WHERE is_practice = 0').get() as { n: number }).n;

  console.log(`Frames directory: ${FRAMES_DIR}`);
  console.log(`  added   ${added}`);
  console.log(`  updated ${updated}`);
  if (skipped) console.log(`  skipped ${skipped}`);
  console.log(`Database now holds ${practice} practice frames and ${real} study frames.`);
  if (practice !== 5) {
    console.log(`  note: the protocol calls for 5 practice frames; ${practice} are marked practice.`);
  }
}

main();
