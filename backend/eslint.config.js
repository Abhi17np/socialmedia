const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node }
    },
    rules: {
      // Real bugs this project has actually hit (an unused destructured
      // var masking a typo) stay errors; a caught-but-unused error
      // variable (very common in this codebase's "log and move on"
      // catch blocks) is intentional, not a bug.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    ignores: ['node_modules/**', 'test/**/*.output']
  }
];
