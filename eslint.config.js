import js from '@eslint/js';
import globals from 'globals';
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
    // node:test's describe()/it() return promises that the runner collects;
    // awaiting them is not needed.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Module boundaries (plan section 3.6): a module may import another
    // module only through its index.ts. Rules are added when modules exist.
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
