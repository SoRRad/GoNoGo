/**
 * Writes a consistent snapshot of the database to a file.
 *
 *   node dist/scripts/db-snapshot.js <output-path>
 *
 * Uses SQLite's online backup API, which is safe against a live writer. A plain
 * file copy is NOT: the database runs in WAL mode, so at any instant the
 * committed state is split between app.db and app.db-wal, and copying them
 * separately while a surgeon is autosaving can produce a file that opens
 * perfectly and is missing the most recent annotations.
 *
 * The snapshot is verified before this exits, so a backup that cannot be opened
 * fails here rather than on the day it is needed.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/lib/paths';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node dist/scripts/db-snapshot.js <output-path>');
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}. Is DATA_DIR correct?`);
    process.exit(1);
  }

  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.rmSync(resolved, { force: true });

  const source = new Database(DB_PATH, { readonly: true });
  await source.backup(resolved);
  source.close();

  // Open the snapshot itself and prove it is sound.
  const snapshot = new Database(resolved, { readonly: true });
  const integrity = snapshot.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    snapshot.close();
    console.error(`Snapshot failed integrity check: ${String(integrity)}`);
    process.exit(1);
  }
  const counts = {
    surgeons: (snapshot.prepare('SELECT COUNT(*) AS n FROM surgeons').get() as { n: number }).n,
    frames: (snapshot.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }).n,
    annotations: (snapshot.prepare('SELECT COUNT(*) AS n FROM annotations').get() as { n: number }).n,
    submitted: (
      snapshot.prepare('SELECT COUNT(*) AS n FROM annotations WHERE submitted_at IS NOT NULL').get() as {
        n: number;
      }
    ).n,
  };
  snapshot.close();

  console.log(
    `snapshot ok: ${counts.surgeons} surgeons, ${counts.frames} frames, ` +
      `${counts.annotations} annotations (${counts.submitted} submitted)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
