/**
 * Tests for static/sw.js — the service-worker precache + fetch strategies.
 *
 * sw.js registers install/activate/fetch listeners on `self` at import time and
 * uses the global `caches`, `fetch` and `AbortController`. We install a fake
 * `self` (recorded addEventListener, location.origin, skipWaiting, clients.claim)
 * plus caches/fetch stubs BEFORE importing the module, then drive each handler
 * directly through its recorded listener with absolute URLs. AbortController is
 * left as the real global (happy-dom uses it internally; a fake breaks the env)
 * and only observed via a spy on its prototype abort.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGIN = 'https://busradar.example';

// Recorded event listeners keyed by type (install/activate/fetch).
const listeners = {};
// We keep the REAL AbortController — happy-dom's own fetch/timer machinery
// uses it internally, and replacing it with a fake breaks the environment
// (its signal must be a real EventTarget). We observe .abort via a
// per-instance spy installed from the fetch stub.

const fakeSelf = {
  location: { origin: ORIGIN },
  skipWaiting: vi.fn(() => Promise.resolve()),
  clients: { claim: vi.fn(() => Promise.resolve()) },
  addEventListener(type, cb) {
    (listeners[type] = listeners[type] || []).push(cb);
  },
};

// A single cache object so put() calls are trackable across open() calls.
let theCache;
let cachesStub;

const _orig = {
  self: globalThis.self,
  caches: globalThis.caches,
  fetch: globalThis.fetch,
};

// Stubs must be live before sw.js runs its top-level addEventListener calls.
// AbortController is intentionally left as the real global.
globalThis.self = fakeSelf;
globalThis.caches = { open: () => Promise.resolve({}), keys: () => Promise.resolve([]) };
globalThis.fetch = () => Promise.resolve({ ok: true });

await import('../../static/sw.js');

const installHandler = listeners.install[0];
const activateHandler = listeners.activate[0];
const fetchHandler = listeners.fetch[0];

function makeCache() {
  return {
    addAll: vi.fn(() => Promise.resolve()),
    put: vi.fn(() => Promise.resolve()),
  };
}

function makeEvent(url, opts = {}) {
  const request = { url, method: opts.method || 'GET', mode: opts.mode || 'cors' };
  const e = {
    request,
    responded: undefined,
    waited: undefined,
    respondWith: vi.fn((p) => {
      e.responded = p;
    }),
    waitUntil: vi.fn((p) => {
      e.waited = p;
    }),
  };
  return e;
}

beforeEach(() => {
  globalThis.self = fakeSelf;
  theCache = makeCache();
  cachesStub = {
    open: vi.fn(() => Promise.resolve(theCache)),
    keys: vi.fn(() => Promise.resolve([])),
    match: vi.fn(() => Promise.resolve(undefined)),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  globalThis.caches = cachesStub;
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true }));
  // Observe every AbortController.abort() the SW makes, without replacing the
  // real global. The spy wraps the real abort so the signal still fires its
  // abort event (which a rejecting fetch stub can listen for).
  vi.spyOn(AbortController.prototype, 'abort');
  fakeSelf.skipWaiting.mockClear();
  fakeSelf.clients.claim.mockClear();
});

afterEach(() => {
  globalThis.self = _orig.self;
  globalThis.caches = _orig.caches;
  globalThis.fetch = _orig.fetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('listener registration', () => {
  it('registered exactly one install, activate and fetch listener', () => {
    expect(typeof installHandler).toBe('function');
    expect(typeof activateHandler).toBe('function');
    expect(typeof fetchHandler).toBe('function');
    expect(listeners.install).toHaveLength(1);
    expect(listeners.activate).toHaveLength(1);
    expect(listeners.fetch).toHaveLength(1);
  });
});

describe('install', () => {
  it('opens the versioned cache, precaches the URL list and calls skipWaiting', async () => {
    const e = makeEvent(ORIGIN + '/');
    installHandler(e);
    await e.waited;
    expect(cachesStub.open).toHaveBeenCalledTimes(1);
    expect(cachesStub.open.mock.calls[0][0]).toMatch(/^busradar-/);
    expect(theCache.addAll).toHaveBeenCalledTimes(1);
    const urls = theCache.addAll.mock.calls[0][0];
    expect(urls).toContain('/');
    expect(urls).toContain('/index.html');
    expect(urls).toContain('/init.js');
    expect(fakeSelf.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('activate', () => {
  it('deletes only stale busradar- caches, keeps the current one and foreign caches, then claims clients', async () => {
    cachesStub.keys.mockResolvedValue(['busradar-old', 'busradar-__APP_VERSION__', 'other-cache']);
    const e = makeEvent(ORIGIN + '/');
    activateHandler(e);
    await e.waited;
    // 'busradar-old' passes both filter clauses → deleted.
    expect(cachesStub.delete).toHaveBeenCalledTimes(1);
    expect(cachesStub.delete).toHaveBeenCalledWith('busradar-old');
    // Current cache (k === CACHE) and 'other-cache' (wrong prefix) are kept.
    expect(cachesStub.delete).not.toHaveBeenCalledWith('busradar-__APP_VERSION__');
    expect(cachesStub.delete).not.toHaveBeenCalledWith('other-cache');
    expect(fakeSelf.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('with no stale caches deletes nothing but still claims clients', async () => {
    cachesStub.keys.mockResolvedValue(['busradar-__APP_VERSION__']);
    const e = makeEvent(ORIGIN + '/');
    activateHandler(e);
    await e.waited;
    expect(cachesStub.delete).not.toHaveBeenCalled();
    expect(fakeSelf.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe('fetch — early returns (no respondWith)', () => {
  it('ignores non-GET requests', () => {
    const e = makeEvent(ORIGIN + '/index.html', { method: 'POST' });
    fetchHandler(e);
    expect(e.respondWith).not.toHaveBeenCalled();
  });

  it('SECURITY: ignores cross-origin requests (never intercepts them)', () => {
    const e = makeEvent('https://evil.example/steal.js');
    fetchHandler(e);
    expect(e.respondWith).not.toHaveBeenCalled();
    expect(cachesStub.open).not.toHaveBeenCalled();
    expect(cachesStub.match).not.toHaveBeenCalled();
  });

  it('SECURITY: never intercepts /api/ requests and never caches an API response', () => {
    const e = makeEvent(ORIGIN + '/api/stream/viewport');
    fetchHandler(e);
    expect(e.respondWith).not.toHaveBeenCalled();
    // Tripwire: no cache was opened, matched or written for an /api/ URL.
    expect(cachesStub.open).not.toHaveBeenCalled();
    expect(cachesStub.match).not.toHaveBeenCalled();
    expect(theCache.put).not.toHaveBeenCalled();
  });
});

describe('fetch — navigate (network-first with 3s timeout, offline fallback to /index.html)', () => {
  it('success: returns the network response, clears the timeout so abort never fires', async () => {
    vi.useFakeTimers();
    const netResp = { ok: true, body: 'live' };
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/some/route', { mode: 'navigate' });
    fetchHandler(e);
    expect(e.respondWith).toHaveBeenCalledTimes(1);
    // fetch was called with an AbortSignal (the timeout controller's signal).
    expect(globalThis.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    // Flush the resolved fetch + .then so clearTimeout(timeout) runs BEFORE we
    // advance the clock, proving the success path cancels the abort timer.
    await e.responded;
    expect(e.responded).resolves.toBe(netResp);
    vi.advanceTimersByTime(3000);
    expect(AbortController.prototype.abort).not.toHaveBeenCalled();
    expect(cachesStub.match).not.toHaveBeenCalled();
  });

  it('offline (fetch rejects): falls back to the cached /index.html and clears the timeout', async () => {
    vi.useFakeTimers();
    const indexResp = { ok: true, body: 'cached-index' };
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    cachesStub.match.mockResolvedValue(indexResp);
    const e = makeEvent(ORIGIN + '/deep/link', { mode: 'navigate' });
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(indexResp);
    expect(cachesStub.match).toHaveBeenCalledWith('/index.html');
    // The .catch cleared the timer, so a later tick must not abort.
    vi.advanceTimersByTime(3000);
    expect(AbortController.prototype.abort).not.toHaveBeenCalled();
  });

  it('timeout: after 3s the controller aborts, the fetch rejects on the signal and it falls back to /index.html', async () => {
    vi.useFakeTimers();
    const indexResp = { ok: true, body: 'cached-index' };
    // Reject only when the passed AbortSignal fires its abort event — this is
    // exactly the browser fetch(signal) contract the SW relies on.
    globalThis.fetch = vi.fn(
      (req, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    cachesStub.match.mockResolvedValue(indexResp);
    const e = makeEvent(ORIGIN + '/slow', { mode: 'navigate' });
    fetchHandler(e);
    expect(AbortController.prototype.abort).not.toHaveBeenCalled();
    // The 3s timer fires controller.abort() itself (the covered line).
    vi.advanceTimersByTime(3000);
    expect(AbortController.prototype.abort).toHaveBeenCalledTimes(1);
    await expect(e.responded).resolves.toBe(indexResp);
    expect(cachesStub.match).toHaveBeenCalledWith('/index.html');
  });
});

describe('fetch — app code (.js/.css/.webmanifest, network-first, cache the fresh copy)', () => {
  it('ok response: forces a conditional request, returns it and caches the clone', async () => {
    const clone = { tag: 'clone' };
    const netResp = { ok: true, clone: vi.fn(() => clone) };
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/init.js');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(netResp);
    // {cache: 'no-cache'} conditional-request flag is passed through.
    expect(globalThis.fetch.mock.calls[0][1]).toEqual({ cache: 'no-cache' });
    // Fire-and-forget cache write — wait for the detached promise chain.
    await vi.waitFor(() => expect(theCache.put).toHaveBeenCalled());
    expect(theCache.put).toHaveBeenCalledWith(e.request, clone);
  });

  it('.css is treated as app code too', async () => {
    const netResp = { ok: true, clone: vi.fn(() => ({})) };
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/style.css');
    fetchHandler(e);
    await e.responded;
    expect(globalThis.fetch.mock.calls[0][1]).toEqual({ cache: 'no-cache' });
    await vi.waitFor(() => expect(theCache.put).toHaveBeenCalled());
  });

  it('.webmanifest is treated as app code too', async () => {
    const netResp = { ok: true, clone: vi.fn(() => ({})) };
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/manifest.webmanifest');
    fetchHandler(e);
    await e.responded;
    expect(globalThis.fetch.mock.calls[0][1]).toEqual({ cache: 'no-cache' });
    await vi.waitFor(() => expect(theCache.put).toHaveBeenCalled());
  });

  it('non-ok response: returns it but does NOT cache it', async () => {
    const netResp = { ok: false, clone: vi.fn() };
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/init.js');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(netResp);
    expect(netResp.clone).not.toHaveBeenCalled();
    expect(cachesStub.open).not.toHaveBeenCalled();
  });

  it('falsy response: the `resp && resp.ok` guard short-circuits, nothing is cached', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(null));
    const e = makeEvent(ORIGIN + '/init.js');
    fetchHandler(e);
    await expect(e.responded).resolves.toBeNull();
    expect(cachesStub.open).not.toHaveBeenCalled();
  });

  it('fetch rejects (offline): falls back to the cached request', async () => {
    const cached = { ok: true, body: 'cached-js' };
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    cachesStub.match.mockResolvedValue(cached);
    const e = makeEvent(ORIGIN + '/init.js');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(cached);
    expect(cachesStub.match).toHaveBeenCalledWith(e.request);
  });
});

describe('fetch — immutable assets (fonts/icons/vendor, cache-first)', () => {
  it('cache hit: returns the cached response without hitting the network', async () => {
    const cached = { ok: true, body: 'cached-font' };
    cachesStub.match.mockResolvedValue(cached);
    const e = makeEvent(ORIGIN + '/fonts/dm-sans-latin.woff2');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(cached);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('vendor .js is cache-first (isVendor short-circuits app-code), cache hit returns cached', async () => {
    const cached = { ok: true, body: 'cached-leaflet' };
    cachesStub.match.mockResolvedValue(cached);
    const e = makeEvent(ORIGIN + '/vendor/leaflet.js');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(cached);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('cache miss + ok network: returns the response and caches the clone', async () => {
    const clone = { tag: 'clone' };
    const netResp = { ok: true, clone: vi.fn(() => clone) };
    cachesStub.match.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/icons/icon-192.png');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(netResp);
    await vi.waitFor(() => expect(theCache.put).toHaveBeenCalled());
    expect(theCache.put).toHaveBeenCalledWith(e.request, clone);
  });

  it('cache miss + non-ok network: returns the response but does NOT cache it', async () => {
    const netResp = { ok: false, clone: vi.fn() };
    cachesStub.match.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn(() => Promise.resolve(netResp));
    const e = makeEvent(ORIGIN + '/favicon.svg');
    fetchHandler(e);
    await expect(e.responded).resolves.toBe(netResp);
    expect(netResp.clone).not.toHaveBeenCalled();
    expect(theCache.put).not.toHaveBeenCalled();
  });
});
