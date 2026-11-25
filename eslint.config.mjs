import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.test-build/**', 'coverage/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // an empty block must say why it is empty (a comment counts) - no silently swallowed errors
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-control-regex': 'off', // terminal code handles escape sequences on purpose
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // node:test collects describe()/it() itself; their returned promises are not meant to be awaited
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'] }] },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
