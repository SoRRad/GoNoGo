import path from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: ['.next/**', 'dist/**', 'node_modules/**', 'next-env.d.ts', 'public/**'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Config files are legitimately anonymous default exports.
    files: ['*.config.mjs', '*.config.mts', 'eslint.config.mjs'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
  {
    // Runs under plain node before anything is built, so it must stay CommonJS.
    files: ['scripts/ensure-built.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Smoke-test helpers. They are copied into the running container and run by
    // its node against the image's own node_modules, so they are CommonJS and
    // never part of the build.
    files: ['scripts/smoke/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];

export default config;
