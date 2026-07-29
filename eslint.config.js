import js from '@eslint/js';
import globals from 'globals';

// Flat config for the Vanilla-ES-module browser frontend (no build step,
// no TypeScript). We enable js.configs.recommended for genuine-bug rules
// (no-undef, no-unreachable, no-dupe-keys, ...) but deliberately keep every
// stylistic rule off so the existing var/function code isn't mass-flagged.
export default [
  // Non-source artifacts that must never be linted.
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'static/vendor/**',
      '.playwright-mcp/**',
    ],
  },

  js.configs.recommended,

  // Browser app modules.
  {
    files: ['static/**/*.js'],
    ignores: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Leaflet is loaded as a classic <script> before the modules run,
        // so `L` is a read-only ambient global here.
        L: 'readonly',
        // App-level window handles some modules touch by bare name.
        I18N: 'readonly',
      },
    },
    rules: {
      // The frontend is full of intentional `try { ... } catch (e) {}`
      // defensive guards; an empty catch is a valid pattern here.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Caught errors are frequently swallowed on purpose (see above).
      // Unused function args are also intentional here: self-documenting
      // callback params (e.g. _forceReconnect(reason) named at the call
      // site) and parallel method signatures (renderJourneyStops(data,
      // vehicle) mirrors drawRoute(data, vehicle)). vars/imports are still
      // checked, so genuine dead locals and dead imports are caught.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Service worker: its own global scope (self, caches, clients, ...).
  {
    files: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Vitest tests run under happy-dom: Node + browser + vitest globals.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.vitest,
        // Tests stub Leaflet via `globalThis.L = {...}`, so `L` is a
        // writable ambient global in the test scope.
        L: 'writable',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
