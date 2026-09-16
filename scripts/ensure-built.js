/**
 * Compiles the CLI scripts only when they are stale.
 *
 * In a container the compiled output is already baked in and TypeScript is not
 * installed, so this is a no-op. In development it rebuilds whenever a source
 * file is newer than its output.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputProbe = path.join(root, 'dist', 'scripts', 'assign.js');

function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(path.join(root, 'scripts'));
  walk(path.join(root, 'src', 'lib'));
  return newest;
}

const builtAt = fs.existsSync(outputProbe) ? fs.statSync(outputProbe).mtimeMs : 0;
if (builtAt >= newestSourceMtime() && builtAt > 0) process.exit(0);

const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(tsc)) {
  if (builtAt > 0) process.exit(0);
  console.error('TypeScript is not installed and dist/ is missing. Run `npm install` first.');
  process.exit(1);
}

execFileSync(tsc, ['-p', path.join(root, 'tsconfig.scripts.json')], { stdio: 'inherit', cwd: root });
