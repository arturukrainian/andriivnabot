/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { 'import/resolver': { typescript: {} } },
  ignorePatterns: ['dist', 'node_modules'],
};
