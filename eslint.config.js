import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { withReferenceApp } from './scripts/uikit.mjs';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.scrap/**',
      '.vitest/**',
      // The generated API reference and the release folders.
      'api-reference/**',
      'release/**',
      // The program lungo generates from models/: never edited by hand.
      'packages/models/program/**',
      // Lake's build of the models and the sources of their dependencies.
      'models/.lake/**',
      // The pinned checkout of wsb, for its UI kit, and the dev-server test's copy of the app.
      'wsb/**',
      'apps/reference/.dev-test-*/**',
      // The reference application needs the wsb UI kit to be checked; without it, it is left out.
      ...(withReferenceApp() ? [] : ['apps/reference/**']),
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
