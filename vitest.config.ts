import { defineConfig } from 'vitest/config';

/**
 * Everything below the barrier runs in node, against the blocking build
 * of the same DuckDB the browser runs. The screen's specs mount the real
 * components with `gesso-testing`, with no browser either.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
    testTimeout: 30_000
  }
});
