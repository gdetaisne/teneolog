import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@teneolog/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@teneolog/topology': fileURLToPath(new URL('../topology/src/index.ts', import.meta.url)),
      '@teneolog/constraints': fileURLToPath(new URL('../constraints/src/index.ts', import.meta.url)),
      '@teneolog/road-width': fileURLToPath(new URL('../road-width/src/index.ts', import.meta.url)),
      // Sans cet alias, le verdict de DESTINATION se jugeait contre le dist de
      // la projection : un test pouvait rester vert sur un correctif non rebuildé
      // (réserve R8).
      '@teneolog/projection': fileURLToPath(new URL('../projection/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
