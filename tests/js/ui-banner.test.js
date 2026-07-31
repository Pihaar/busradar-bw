/**
 * Tests for the terminal-banner show/hide helpers in static/ui.js.
 *
 * hideTerminalBanner is called from refresh._setSseState's 'open' branch to
 * dismiss a stale banner after any (re)connect; showTerminalBanner is now
 * re-showable, so its reload-button wiring must not stack handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  let realLocation;

  beforeEach(() => {
    document.body.innerHTML = '';
    realLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('reload button fires exactly once per click after re-shows (no stacked handlers)', () => {
    const banner = document.createElement('div');
    banner.id = 'terminal-banner';
    banner.hidden = true;
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'version-banner__reload';
    banner.appendChild(reloadBtn);
    document.body.appendChild(banner);

    // Stub reload so a click is observable without navigating.
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });

    // Two show cycles re-run the wiring. A stacking addEventListener would leave
    // two live handlers → one click fires reload twice; the onclick assignment
    // replaces, so one click fires it exactly once.
    ui.showTerminalBanner();
    ui.hideTerminalBanner();
    ui.showTerminalBanner();
    expect(banner.hidden).toBe(false);

    reloadBtn.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('ui.showVersionUpdateBanner — idempotent button wiring', () => {
  let realLocation;

  beforeEach(() => {
    document.body.innerHTML = '';
    realLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('reload fires once per click after a dismiss + re-show (no stacked handlers)', () => {
    const banner = document.createElement('div');
    banner.id = 'version-banner';
    banner.hidden = true;
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'version-banner__reload';
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'version-banner__dismiss';
    banner.append(reloadBtn, dismissBtn);
    document.body.appendChild(banner);

    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });

    ui.showVersionUpdateBanner();
    dismissBtn.click(); // onclick sets hidden=true again
    expect(banner.hidden).toBe(true);
    ui.showVersionUpdateBanner(); // second wiring
    expect(banner.hidden).toBe(false);

    reloadBtn.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
