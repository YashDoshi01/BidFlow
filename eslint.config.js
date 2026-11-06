import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'apps/web/dist/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money and ids are never compared with == ; keep equality strict.
      eqeqeq: ['error', 'always'],
      // A swallowed promise is a silent failure (plan section 4.1, rule 11).
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // The browser app: browser globals and the rules of hooks (a wrong dependency
    // array in an effect is how duplicate subscriptions are born).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The API/test files use Node globals; the browser code must not. (vite.config.ts
      // runs in Node and is outside src/.)
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname'],
    },
  },
  {
    // Browser test files import node:test.
    files: ['apps/web/src/**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // node:test's describe()/it() return promises that the runner collects;
    // awaiting them is not needed.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Integration tests assert on parsed JSON from the server (typed `any` on
    // purpose in helpers.ts); the unsafe-any rules add noise, not safety, there.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // node:assert's assert.equal(x?.y, ...) narrows x afterwards, so later x?.z is reported as
      // "unnecessary" although it reads exactly as the assertion intends. Source code keeps the rule.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    // Module boundaries (plan section 3.6): inside apps/api/src/modules/<m>/,
    // code may import another module only through that module's index.ts.
    // "../<other>/<file>" is a deep import into another module's internals.
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // ../<module>/<anything but index.ts>; "../../x" (shared code) is not matched.
              regex: '^\\.\\./(?!\\.)[^/]+/(?!index\\.ts$).+',
              message: 'Import another module only through its index.ts (ADR-011).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
