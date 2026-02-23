/** Jest config for the basic-app example (run from repo root: npm run example:test). */
const path = require('path');
const repoRoot = path.resolve(__dirname, '..', '..');
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: repoRoot,
  roots: ['<rootDir>/examples/basic-app'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
