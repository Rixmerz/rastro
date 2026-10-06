import { defineConfig } from 'vitest/config';

// Evals drive real `rastro mcp` processes, a daemon and Chromium per scenario:
// slow, so they stay out of `pnpm test` and run with `pnpm evals`.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 90000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
