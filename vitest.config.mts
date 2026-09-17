import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Same @/ alias as tsconfig.json, so tests import exactly what the app does.
    alias: { '@': path.resolve(rootDir, './src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Each database test opens its own in-memory SQLite instance.
    pool: 'forks',
  },
});
