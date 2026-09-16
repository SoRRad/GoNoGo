/**
 * Writes the full study export to data/exports/.
 *
 *   npm run export [-- <output.zip>]
 */
import fs from 'fs';
import path from 'path';
import { createExportArchive } from '../src/lib/export';
import { EXPORTS_DIR, ensureDataDirs } from '../src/lib/paths';

async function main() {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.resolve(process.argv[2] || path.join(EXPORTS_DIR, `sadi-export-${stamp}.zip`));
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const { archive, stats } = createExportArchive();
  const output = fs.createWriteStream(target);

  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (error) => console.warn('  warning:', error.message));
    archive.on('error', reject);
    archive.pipe(output);
  });

  const size = fs.statSync(target).size;
  console.log(`Wrote ${target}`);
  console.log(
    `  ${stats.annotations} annotations · ${stats.frames} frames · ${stats.masks} masks · ` +
      `${stats.consensusFrames} consensus frames · ${(size / 1024 / 1024).toFixed(2)} MB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
