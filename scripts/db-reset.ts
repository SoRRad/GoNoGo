/**
 * Wipes every annotation, mask and queue, keeping frames and surgeons.
 *
 *   npm run db:reset -- --yes
 *
 * For clearing out test data before the study starts. It refuses to run without
 * the flag, and prints exactly what it is about to destroy.
 */
import fs from 'fs';
import { getDb } from '../src/lib/db';
import { MASKS_DIR, ensureDataDirs } from '../src/lib/paths';

function main() {
  ensureDataDirs();
  const db = getDb();

  const annotations = (db.prepare('SELECT COUNT(*) AS n FROM annotations').get() as { n: number }).n;
  const submitted = (
    db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE submitted_at IS NOT NULL').get() as { n: number }
  ).n;
  const assignments = (db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n;
  const maskFiles = fs.existsSync(MASKS_DIR)
    ? fs.readdirSync(MASKS_DIR).filter((name) => name.endsWith('.png'))
    : [];

  console.log('This will permanently delete:');
  console.log(`  ${annotations} annotations (${submitted} of them submitted)`);
  console.log(`  ${assignments} queue assignments`);
  console.log(`  ${maskFiles.length} mask files`);
  console.log('Frames and surgeons (including their access links) are kept.');

  if (!process.argv.includes('--yes')) {
    console.log('');
    console.log('Nothing was deleted. Re-run with --yes to confirm:');
    console.log('  npm run db:reset -- --yes');
    process.exit(1);
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM annotations').run();
    db.prepare('DELETE FROM assignments').run();
  });
  run();
  for (const name of maskFiles) fs.rmSync(`${MASKS_DIR}/${name}`, { force: true });

  console.log('');
  console.log('Done. Run `npm run assign` to rebuild the queues.');
}

main();
