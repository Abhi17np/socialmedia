const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

// A hand-rolled config, not eslint-config-next — that package's
// @next/eslint-plugin-next pulls in a vulnerable transitive fast-glob →
// micromatch → braces chain (5 high-severity npm audit findings,
// discovered while adding this very lint step), and the project's actual
// needs here (catch real JS/React mistakes, not full Next-specific
// conventions) don't need the full plugin for that.
module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      // react/jsx-uses-vars is what teaches no-unused-vars that
      // `<Icon />` counts as using the `Icon` import — without it, every
      // lucide-react icon and every component used only in JSX (not
      // called as a plain function) is a false-positive "unused var".
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // Next.js's automatic JSX runtime — no `import React` needed
      'react/prop-types': 'off', // not a PropTypes codebase
      'react/no-unescaped-entities': 'off', // a literal apostrophe in JSX text renders fine everywhere; this rule just mangles readable prose into HTML entities for no functional benefit
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }]
    }
  },
  {
    ignores: ['node_modules/**', '.next/**']
  }
];
