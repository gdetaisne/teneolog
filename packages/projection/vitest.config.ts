import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@teneolog/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@teneolog/points': fileURLToPath(new URL('../points/src/index.ts', import.meta.url)),
      '@teneolog/swept-path': fileURLToPath(new URL('../swept-path/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
