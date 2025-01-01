import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Glob patterns or regular expressions to ignore test files.
  testIgnore: '*test-assets',

  // Glob patterns or regular expressions that match test files.
  testMatch: 'app-tests/*.test.mjs',

  reporter: process.env.CI ? 'github' : 'list'
});