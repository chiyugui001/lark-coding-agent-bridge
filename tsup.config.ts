import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts', 'graphify-router': 'src/agent/graphify-router.ts', 'git-version-router': 'src/agent/git-version-router.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
]);
