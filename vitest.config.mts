import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      // Obsidian SDK has no valid Node entry point; redirect to a stub for tests.
      obsidian: new URL('src/__mocks__/obsidian.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [new URL('src/__mocks__/window-shim.ts', import.meta.url).pathname],
    globals: true,
  },
});
