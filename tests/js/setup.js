import { Window } from 'happy-dom';

// Load real i18n translations so t() returns actual strings, not key fallbacks
import '../../static/i18n.js';

// Node 26 defines a global localStorage accessor that yields undefined without
// --localstorage-file. Vitest's happy-dom environment only overrides globals it
// knows about, so the unusable Node accessor would shadow happy-dom's Storage.
// Inspect the descriptor instead of reading it: the read logs an
// ExperimentalWarning once per worker.
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
if (storageDescriptor?.get && !storageDescriptor.value) {
  globalThis.localStorage = new Window().localStorage;
}
