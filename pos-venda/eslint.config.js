const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['node_modules/**', 'eslint.config.js', 'prettier.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
