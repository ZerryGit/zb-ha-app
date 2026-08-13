import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared/graph': resolve(__dirname, '../src/data/graph'),
      '@shared/textLayout': resolve(__dirname, '../src/data/textLayout.ts'),
      '@zb/expressions': resolve(__dirname, '../packages/zb-expressions/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.{js,jsx}'],
    globals: true,
  },
});
