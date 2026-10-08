import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@teneolog/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@teneolog/topology': fileURLToPath(new URL('../topology/src/index.ts', import.meta.url)),
      '@teneolog/constraints': fileURLToPath(new URL('../constraints/src/index.ts', import.meta.url)),
      '@teneolog/routes': fileURLToPath(new URL('../routes/src/index.ts', import.meta.url)),
      '@teneolog/pipeline': fileURLToPath(new URL('../pipeline/src/index.ts', import.meta.url)),
      '@teneolog/road-width': fileURLToPath(new URL('../road-width/src/index.ts', import.meta.url)),
      '@teneolog/points': fileURLToPath(new URL('../points/src/index.ts', import.meta.url)),
      '@teneolog/projection': fileURLToPath(new URL('../projection/src/index.ts', import.meta.url)),
      '@teneolog/report': fileURLToPath(new URL('../report/src/index.ts', import.meta.url)),
      '@teneolog/swept-path': fileURLToPath(new URL('../swept-path/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
