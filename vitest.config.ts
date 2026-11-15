import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'jsdom',
    poolOptions: {
      forks: {
        // Node 25+ Web Storage masks jsdom's browser Storage globals.
        execArgv: ['--no-experimental-webstorage'],
      },
    },
    clearMocks: true,
  },
});
