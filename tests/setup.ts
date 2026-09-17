import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Every test worker gets its own DATA_DIR, set before any module reads it.
 * src/lib/paths.ts resolves DATA_DIR at import time, so this has to run first —
 * vitest.config.mts registers it as a setup file.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sadi-test-'));
process.env.DATA_DIR = dir;
for (const sub of ['frames', 'masks', 'exports']) {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
}
