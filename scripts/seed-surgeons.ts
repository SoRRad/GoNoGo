/**
 * Creates surgeon records and their access links.
 *
 *   npm run seed:surgeons -- <csv>
 *
 * CSV columns: name,email  (a header row is detected and skipped)
 *
 * Re-running is safe. An email that already exists keeps its existing token, so
 * links already emailed out never stop working.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../src/lib/db';
import type { Surgeon } from '../src/lib/db';
import { generateAccessToken, nowIso } from '../src/lib/ids';
import { ensureDataDirs } from '../src/lib/paths';

function parseCsv(text: string): { name: string; email: string }[] {
  const rows: { name: string; email: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) continue;
    const [name, email] = cells;
    if (/^name$/i.test(name) && /^e-?mail$/i.test(email)) continue;
    if (!email.includes('@')) {
      console.warn(`  ! skipping row without a usable email: ${line}`);
      continue;
    }
    rows.push({ name, email: email.toLowerCase() });
  }
  return rows;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run seed:surgeons -- <csv>');
    process.exit(1);
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`No such file: ${resolved}`);
    process.exit(1);
  }

  ensureDataDirs();
  const db = getDb();
  const rows = parseCsv(fs.readFileSync(resolved, 'utf8'));
  if (rows.length === 0) {
    console.error('No usable rows found. Expected: name,email');
    process.exit(1);
  }

  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const results: { surgeon: Surgeon; created: boolean }[] = [];

  const run = db.transaction(() => {
    for (const row of rows) {
      const existing = db.prepare('SELECT * FROM surgeons WHERE email = ?').get(row.email) as Surgeon | undefined;
      if (existing) {
        if (existing.name !== row.name) {
          db.prepare('UPDATE surgeons SET name = ? WHERE id = ?').run(row.name, existing.id);
        }
        results.push({ surgeon: { ...existing, name: row.name }, created: false });
        continue;
      }
      let token = generateAccessToken();
      while (db.prepare('SELECT 1 FROM surgeons WHERE access_token = ?').get(token)) {
        token = generateAccessToken();
      }
      const info = db
        .prepare('INSERT INTO surgeons (name, email, access_token, created_at) VALUES (?, ?, ?, ?)')
        .run(row.name, row.email, token, nowIso());
      const surgeon = db.prepare('SELECT * FROM surgeons WHERE id = ?').get(info.lastInsertRowid) as Surgeon;
      results.push({ surgeon, created: true });
    }
  });
  run();

  console.log('');
  console.log('Access links — email these to each surgeon individually.');
  console.log('A link is the only credential: treat it like a password.');
  console.log('');
  for (const { surgeon, created } of results) {
    console.log(`  ${created ? 'new    ' : 'exists '} ${surgeon.name} <${surgeon.email}>`);
    console.log(`           ${baseUrl}/a/${surgeon.access_token}`);
  }
  console.log('');
  console.log(`${results.filter((r) => r.created).length} created, ${results.filter((r) => !r.created).length} already present.`);
  console.log('Next step: npm run assign');
}

main();
