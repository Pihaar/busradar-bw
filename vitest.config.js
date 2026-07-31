import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['tests/js/setup.js'],
    include: ['tests/js/**/*.test.js'],
    coverage: {
      provider: 'v8',
      // include is the anti-phantom-100% mechanism (v4 semantics): without it
      // only modules loaded at runtime are counted, so a never-imported file
      // would silently pass. With it, such a file drops to 0% and fails the
      // gate. NOT `all: true` — that key was removed in vitest 4.0.
      include: ['static/**/*.js'],
      exclude: ['static/vendor/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
