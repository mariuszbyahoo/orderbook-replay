import { defineConfig } from 'vitest/config';

// base './' so the static bundle works under any sub-path (e.g. /p/<slug>/) without rebuilding.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
