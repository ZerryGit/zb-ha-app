import react from '@vitejs/plugin-react';
import { cpSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';

// Copies Monaco's pre-built AMD bundle to dist/monaco-editor/min/vs after the
// Rollup bundle is written. This avoids importing Monaco through Rollup (which
// would OOM-kill the build due to 1500+ ESM modules) and instead serves the
// already-compiled AMD files as static assets.
const copyMonacoAMD = () => ({
  name: 'copy-monaco-amd',
  closeBundle() {
    cpSync(
      resolve('node_modules/monaco-editor/min/vs'),
      resolve('dist/monaco-editor/min/vs'),
      { recursive: true },
    );
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), copyMonacoAMD()],
  base: './',                          // Relative paths for HA Ingress
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // vite 8 bundles with rolldown, which requires the function form of
        // manualChunks (the object form is rollup-only). Group vendor libs into
        // stable chunks for long-term caching — same intent as the old object.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/](konva|react-konva)[\\/]/.test(id)) return 'vendor-konva';
          if (/[\\/]node_modules[\\/](zustand|immer)[\\/]/.test(id)) return 'vendor-zustand';
        },
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // Shared graph math — single source of truth for both server and builder.
      // The server imports these as TypeScript; Vite transpiles them for the builder.
      '@shared/graph': resolve(__dirname, '../src/data/graph'),
      // Shared text measurement + word wrapping, same arrangement as the graph
      // math above. Both trees must break lines identically or the preview
      // stops matching the panel.
      '@shared/textLayout': resolve(__dirname, '../src/data/textLayout.ts'),
      // Shared expression engine — single source of truth for bindings,
      // math, logic, pipe-syntax. Aliased to the package's TypeScript
      // source so the builder build does not depend on the package
      // having been pre-compiled. Vite/esbuild handles the .ts files.
      '@zb/expressions': resolve(__dirname, '../packages/zb-expressions/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8099',
      '/render': 'http://localhost:8099',
      '/payload': 'http://localhost:8099',
      '/image.png': 'http://localhost:8099',
      '/entities': 'http://localhost:8099',
      '/history': 'http://localhost:8099',
      '/export': 'http://localhost:8099',
    },
  },
});
