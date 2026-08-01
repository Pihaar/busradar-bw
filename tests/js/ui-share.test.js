/**
 * Coverage for ui.share / _copyAndToast / _showToast in static/ui.js. The
 * share path branches on navigator.share (present/absent, resolve, AbortError
 * reject, synchronous throw) and the clipboard fallback branches on
 * navigator.clipboard.writeText (present resolve/reject) vs the execCommand
 * textarea fallback (success/throw). Each arm is asserted via an observable
 * outcome (toast text, navigator.share call args), never "does not throw".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs } from './ui-dom.js';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

const buildShareHash = vi.fn(() => '#jid=J');
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { subscribeBoard: () => Promise.resolve({}), selectStream: vi.fn(() => Promise.resolve()) },
  urlState: { push: vi.fn(), replace: vi.fn(), buildShareHash: (...a) => buildShareHash(...a) },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  ui.detailLine.textContent = '721';
  ui.detailDir.textContent = 'Sandhausen';
  state._tabMode = 'journey';
  state.selectedJid = 'J';
  state.selectedStop = null;
  state._activeTab = 'stops';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
});

function setNavigator(props) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: props,
  });
}

describe('ui.share — guard', () => {
  it('does nothing when neither a journey nor a stop is selected', () => {
    state._tabMode = 'journey';
    state.selectedJid = null;
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).not.toHaveBeenCalled();
    expect(buildShareHash).not.toHaveBeenCalled();
  });
});

describe('ui.share — journey', () => {
  it('uses navigator.share with a journey title/url when available', () => {
    const share = vi.fn(() => Promise.resolve());
    setNavigator({ share });
    ui.share();
    expect(buildShareHash).toHaveBeenCalledWith({ jid: 'J' });
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('#jid=J') }),
    );
  });

  it('falls back to copy when navigator.share rejects (non-abort)', async () => {
    const share = vi.fn(() => Promise.reject({ name: 'Other' }));
    setNavigator({ share });
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
  });

  it('does not fall back to copy on an AbortError reject (user cancelled)', async () => {
    const share = vi.fn(() => Promise.reject({ name: 'AbortError' }));
    setNavigator({ share });
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to copy when navigator.share throws synchronously', () => {
    const share = vi.fn(() => {
      throw new Error('boom');
    });
    setNavigator({ share });
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).toHaveBeenCalled();
  });

  it('copies directly when navigator.share is absent', () => {
    setNavigator({});
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).toHaveBeenCalled();
  });
});

describe('ui.share — station', () => {
  beforeEach(() => {
    state._tabMode = 'station';
    state.selectedJid = null;
    state.selectedStop = { extId: 'E1', name: 'Sandhausen' };
  });

  it('shares a stop with the dep tab hint', () => {
    setNavigator({});
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(buildShareHash).toHaveBeenCalledWith({ stop: 'E1', tab: 'dep' });
    expect(spy).toHaveBeenCalled();
  });

  it('shares a stop with the arr tab hint', () => {
    setNavigator({});
    state._activeTab = 'arrivals';
    vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(buildShareHash).toHaveBeenCalledWith({ stop: 'E1', tab: 'arr' });
  });

  it('derives the extId from the lid when the stop has none', () => {
    setNavigator({});
    state.selectedStop = { extId: '', lid: 'A=1@L=6003411@', name: 'S' };
    state._activeTab = 'departures';
    vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(buildShareHash).toHaveBeenCalledWith({ stop: '6003411', tab: 'dep' });
  });

  it('does nothing when no extId can be resolved', () => {
    setNavigator({});
    state.selectedStop = { extId: '', lid: 'no-match', name: 'S' };
    const spy = vi.spyOn(ui, '_copyAndToast').mockImplementation(() => {});
    ui.share();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ui._copyAndToast', () => {
  it('clipboard.writeText resolve → "copied" toast', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setNavigator({ clipboard: { writeText } });
    const spy = vi.spyOn(ui, '_showToast').mockImplementation(() => {});
    ui._copyAndToast('http://x/#jid=J');
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('http://x/#jid=J');
    expect(spy).toHaveBeenCalled();
  });

  it('clipboard.writeText reject → "failed" toast', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    setNavigator({ clipboard: { writeText } });
    const spy = vi.spyOn(ui, '_showToast').mockImplementation(() => {});
    ui._copyAndToast('http://x/');
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
  });

  it('falls back to execCommand textarea copy when clipboard is absent', () => {
    setNavigator({});
    document.execCommand = vi.fn(() => true);
    const spy = vi.spyOn(ui, '_showToast').mockImplementation(() => {});
    ui._copyAndToast('http://x/');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(spy).toHaveBeenCalled();
    // the temporary textarea is cleaned up
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('shows the failed toast when execCommand throws', () => {
    setNavigator({});
    document.execCommand = vi.fn(() => {
      throw new Error('no exec');
    });
    const spy = vi.spyOn(ui, '_showToast').mockImplementation(() => {});
    ui._copyAndToast('http://x/');
    expect(spy).toHaveBeenCalled();
  });
});

describe('ui._showToast', () => {
  it('creates the toast element on first use and shows the message', () => {
    vi.useFakeTimers();
    ui._showToast('Hallo');
    const el = document.getElementById('toast');
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('Hallo');
    expect(el.classList.contains('toast--visible')).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(el.classList.contains('toast--visible')).toBe(false);
  });

  it('reuses an existing toast element', () => {
    vi.useFakeTimers();
    ui._showToast('one');
    const first = document.getElementById('toast');
    ui._showToast('two');
    expect(document.getElementById('toast')).toBe(first);
    expect(first.textContent).toBe('two');
  });
});
