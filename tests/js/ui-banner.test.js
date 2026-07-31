/**
 * Tests for the terminal-banner show/hide helpers in static/ui.js.
 *
 * hideTerminalBanner is called from refresh._setSseState's 'open' branch to
 * dismiss a stale banner after any (re)connect; showTerminalBanner is now
 * re-showable, so its reload-button wiring must not stack handlers.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Leaflet is imported transitively via ui.js → map.js; a minimal stub keeps
// the module graph loadable under happy-dom.
globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
};

const { ui } = await import('../../static/ui.js');

describe('ui.hideTerminalBanner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets hidden=true on an existing #terminal-banner', () => {
    const banner = document.createElement('div');
    banner.id = 'terminal-banner';
    banner.hidden = false;
    document.body.appendChild(banner);
    ui.hideTerminalBanner();
    expect(banner.hidden).toBe(true);
  });

  it('is a no-op (no throw) when the banner element is absent', () => {
    expect(() => ui.hideTerminalBanner()).not.toThrow();
  });
});

describe('ui.showTerminalBanner — idempotent reload wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('wires the reload button via onclick (single handler, not stacked) across re-shows', () => {
    const banner = document.createElement('div');
    banner.id = 'terminal-banner';
    banner.hidden = true;
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'version-banner__reload';
    banner.appendChild(reloadBtn);
    document.body.appendChild(banner);

    ui.showTerminalBanner();
    expect(banner.hidden).toBe(false);
    const firstHandler = reloadBtn.onclick;
    expect(typeof firstHandler).toBe('function');

    // Hide, then show again — a stacking addEventListener would accumulate a
    // second handler; the onclick assignment replaces it, so it stays a single
    // function reference.
    ui.hideTerminalBanner();
    ui.showTerminalBanner();
    expect(banner.hidden).toBe(false);
    expect(typeof reloadBtn.onclick).toBe('function');
  });
});
