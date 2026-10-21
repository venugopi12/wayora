import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one test database; run files one at a time.
    fileParallelism: false,
  },
});
