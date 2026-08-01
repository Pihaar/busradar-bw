/**
 * Coverage for the `search` object in static/ui.js: init (input/focus/keydown/
 * outside-click wiring + debounce), doSearch (local line/stop matching, dedup,
 * disambiguation, remote line + stop fetches with search-id staleness guard),
 * _renderCombined, and renderResults (line rows, stop rows, delay colours,
 * empty state, result clicks → selectJourney/focusJourneyById/showStationBoard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };

vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { subscribeBoard: () => Promise.resolve({}), selectStream: vi.fn(() => Promise.resolve()) },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui, search } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// Flush all pending microtasks (fetch → .json() → .then chains, two deep).
function settle() {
  return new Promise((r) => setTimeout(r, 0));
}

function searchDom() {
  document.body.innerHTML = `
    <input id="search-input" />
    <div id="search-results" hidden></div>
  `;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchDom();
  search.init();
  state.vehicles = new Map();
  state.allStops = new Map();
  state.map = { setView: vi.fn(), getCenter: () => ({ lat: 49.3, lng: 8.6 }) };
  search._asyncLines = [];
  search._asyncStops = [];
  search._localLines = [];
  search._localStops = [];
  search._searchSeq = 0;
  // default: both fetches never resolve so async branches don't fire unasked
  window.fetch = vi.fn(() => new Promise(() => {}));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('search.init — wiring', () => {
  it('debounces input and calls doSearch with the trimmed value', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(search, 'doSearch').mockImplementation(() => {});
    search.input.value = '  Sand  ';
    search.input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledWith('Sand');
  });

  it('focus reveals results when the query is long enough', () => {
    search.input.value = 'Sa';
    search.results.hidden = true;
    search.input.dispatchEvent(new Event('focus'));
    expect(search.results.hidden).toBe(false);
  });

  it('focus with a too-short query keeps results hidden', () => {
    search.input.value = 'S';
    search.results.hidden = true;
    search.input.dispatchEvent(new Event('focus'));
    expect(search.results.hidden).toBe(true);
  });

  it('an outside click hides the results', () => {
    search.results.hidden = false;
    document.body.click();
    expect(search.results.hidden).toBe(true);
  });

  it('a click inside the input keeps results visible', () => {
    search.results.hidden = false;
    search.input.click();
    expect(search.results.hidden).toBe(false);
  });

  it('Escape hides the results and blurs the input', () => {
    search.results.hidden = false;
    const blur = vi.spyOn(search.input, 'blur');
    search.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(search.results.hidden).toBe(true);
    expect(blur).toHaveBeenCalled();
  });
});

describe('search.doSearch', () => {
  it('hides results and returns early for a query shorter than 2 chars', () => {
    search.results.hidden = false;
    search.doSearch('a');
    expect(search.results.hidden).toBe(true);
  });

  it('matches a local line by exact line and by lineFull substring', () => {
    state.vehicles = new Map([
      ['J1', { data: { line: '721', lineFull: 'Bus 721', direction: 'X', delay: 0, stops: [] } }],
    ]);
    const spy = vi.spyOn(search, '_renderCombined');
    search.doSearch('721');
    expect(search._localLines.length).toBe(1);
    expect(spy).toHaveBeenCalled();
  });

  it('matches, scores and de-duplicates local stops', () => {
    state.allStops = new Map([
      [
        'a',
        { data: { name: 'Sandhausen Rathaus', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } },
      ],
      [
        'b',
        { data: { name: 'Sandhausen Rathaus', lat: 49.34, lon: 8.66, extId: 'E2', platform: '' } },
      ],
      [
        'c',
        { data: { name: 'Sandhausen Kirche', lat: 49.35, lon: 8.67, extId: 'E3', platform: '' } },
      ],
    ]);
    search.doSearch('sandhausen rathaus');
    // duplicate name+coords collapsed to one; disambig flagged (>1 same name)
    const names = search._localStops.map((r) => r.stop.name);
    expect(names.filter((n) => n === 'Sandhausen Rathaus').length).toBe(1);
    expect(search._localStops.some((r) => r.stop._disambig)).toBe(true);
  });

  it('fires the remote line_search for a short line-like query with no local hit', async () => {
    state.vehicles = new Map();
    window.fetch = vi.fn((url) => {
      if (url.includes('/line_search')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              vehicles: [{ jid: 'R', line: '9', direction: 'Z', lat: 49, lon: 8, stops: [] }],
            }),
        });
      }
      return new Promise(() => {});
    });
    const spy = vi.spyOn(search, '_renderCombined');
    search.doSearch('99');
    await settle();
    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/line_search'));
    expect(search._asyncLines.length).toBe(1);
    expect(spy).toHaveBeenCalled();
  });

  it('ignores a stale remote line_search response (search id moved on)', async () => {
    state.vehicles = new Map();
    let resolveJson;
    window.fetch = vi.fn((url) => {
      if (url.includes('/line_search')) {
        return Promise.resolve({ ok: true, json: () => new Promise((r) => (resolveJson = r)) });
      }
      return new Promise(() => {});
    });
    search.doSearch('99');
    await settle(); // let the fetch resolve so json() is invoked and resolveJson set
    search._searchSeq++; // a newer search started
    resolveJson({
      vehicles: [{ jid: 'R', line: '9', direction: 'Z', lat: 49, lon: 8, stops: [] }],
    });
    await settle();
    expect(search._asyncLines.length).toBe(0);
  });

  it('a non-ok line_search response yields null and does not add async lines', async () => {
    state.vehicles = new Map();
    window.fetch = vi.fn((url) => {
      if (url.includes('/line_search')) return Promise.resolve({ ok: false });
      return new Promise(() => {});
    });
    search.doSearch('99');
    await settle();
    expect(search._asyncLines.length).toBe(0);
  });

  it('merges remote stop results, skipping already-seen extIds and coords', async () => {
    state.allStops = new Map([
      ['a', { data: { name: 'Sandhausen', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } }],
    ]);
    window.fetch = vi.fn((url) => {
      if (url.includes('/search?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: [
                { name: 'Sandhausen', lat: 49.34, lon: 8.66, extId: 'E1' }, // dup extId → skipped
                { name: 'Walldorf', lat: 49.3, lon: 8.64, extId: 'E5' }, // new
                { name: 'Sandhausen', lat: 49.34, lon: 8.66, extId: 'E9' }, // dup coords → skipped
              ],
            }),
        });
      }
      return new Promise(() => {});
    });
    search.doSearch('sand');
    await settle();
    expect(search._asyncStops.map((r) => r.stop.extId)).toEqual(['E5']);
  });

  it('flags remote stop disambiguation when a local stop shares its name', async () => {
    state.allStops = new Map([
      ['a', { data: { name: 'Bahnhof', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } }],
    ]);
    window.fetch = vi.fn((url) => {
      if (url.includes('/search?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ results: [{ name: 'Bahnhof', lat: 49.9, lon: 8.9, extId: 'E7' }] }),
        });
      }
      return new Promise(() => {});
    });
    search.doSearch('bahnhof');
    await settle();
    expect(search._asyncStops[0].stop._disambig).toBe(true);
  });

  it('ignores a stale remote stop response', async () => {
    let resolveJson;
    window.fetch = vi.fn((url) => {
      if (url.includes('/search?')) {
        return Promise.resolve({ ok: true, json: () => new Promise((r) => (resolveJson = r)) });
      }
      return new Promise(() => {});
    });
    search.doSearch('walldorf');
    await settle(); // fetch resolves → json() called → resolveJson set
    search._searchSeq++;
    resolveJson({ results: [{ name: 'Walldorf', lat: 49, lon: 8, extId: 'E5' }] });
    await settle();
    expect(search._asyncStops.length).toBe(0);
  });
});

describe('search._renderCombined', () => {
  it('prefers async lines over local and sorts stops by score', () => {
    search._asyncLines = [
      { type: 'line', vehicle: { line: '9', direction: 'Z', delay: null, stops: [] } },
    ];
    search._localLines = [
      { type: 'line', vehicle: { line: '1', direction: 'A', delay: null, stops: [] } },
    ];
    search._localStops = [
      { type: 'stop', stop: { name: 'AB', lat: 1, lon: 2, extId: 'x', platform: '' }, score: 1 },
    ];
    search._asyncStops = [
      { type: 'stop', stop: { name: 'AB CD', lat: 1, lon: 2, extId: 'y', platform: '' } },
    ];
    search._queryWords = ['ab', 'cd'];
    const spy = vi.spyOn(search, 'renderResults').mockImplementation(() => {});
    search._renderCombined();
    const combined = spy.mock.calls[0][0];
    expect(combined[0].vehicle.line).toBe('9'); // async line first
    // async stop 'AB CD' scores 2 (both words) → sorts before local 'AB' (1)
    const stopResults = combined.filter((r) => r.type === 'stop');
    expect(stopResults[0].stop.name).toBe('AB CD');
  });
});

describe('search.renderResults', () => {
  it('renders a no-results item when empty', () => {
    search.renderResults([]);
    expect(search.results.querySelector('.search-result-name').textContent.length).toBeGreaterThan(
      0,
    );
    expect(search.results.hidden).toBe(false);
  });

  it('renders a line row with next-stop detail and a delay badge', () => {
    search.renderResults([
      {
        type: 'line',
        vehicle: {
          line: '721',
          direction: 'Ziel',
          delay: 3,
          stops: [{ name: 'Halt A' }],
          jid: 'J',
          lat: 49,
          lon: 8,
        },
      },
    ]);
    expect(search.results.querySelector('.search-result-icon--line').textContent).toBe('721');
    expect(search.results.querySelector('.search-result-detail').textContent).toContain('Halt A');
    expect(search.results.querySelector('.search-result-delay')).not.toBeNull();
  });

  it('a line row without a delay omits the delay badge', () => {
    search.renderResults([
      {
        type: 'line',
        vehicle: { line: '721', direction: 'Z', delay: null, stops: [], jid: 'J', lat: 49, lon: 8 },
      },
    ]);
    expect(search.results.querySelector('.search-result-delay')).toBeNull();
  });

  it('line click on a local vehicle selects the journey', () => {
    state.vehicles = new Map([['J', { data: { jid: 'J', lat: 49, lon: 8 } }]]);
    const sel = vi.spyOn(ui, 'selectJourney').mockImplementation(() => {});
    search.renderResults([
      {
        type: 'line',
        vehicle: { line: '721', direction: 'Z', delay: 0, stops: [], jid: 'J', lat: 49, lon: 8 },
      },
    ]);
    search.results.querySelector('.search-result-item').click();
    expect(state.map.setView).toHaveBeenCalledWith([49, 8], 16);
    expect(sel).toHaveBeenCalled();
    expect(search.results.hidden).toBe(true);
  });

  it('line click on a remote vehicle focuses by id', () => {
    state.vehicles = new Map();
    const foc = vi.spyOn(ui, 'focusJourneyById').mockImplementation(() => {});
    search.renderResults([
      {
        type: 'line',
        vehicle: {
          line: '9',
          lineFull: 'Bus 9',
          direction: 'Z',
          delay: 5,
          stops: [],
          jid: 'R',
          lat: 49,
          lon: 8,
        },
      },
    ]);
    search.results.querySelector('.search-result-item').click();
    expect(foc).toHaveBeenCalledWith('R', { nameS: '9', name: 'Bus 9' });
  });

  it('renders the delay colours for delayed and major-delay lines', () => {
    search.renderResults([
      {
        type: 'line',
        vehicle: { line: '1', direction: 'A', delay: 4, stops: [], jid: 'A', lat: 1, lon: 1 },
      },
      {
        type: 'line',
        vehicle: { line: '2', direction: 'B', delay: 9, stops: [], jid: 'B', lat: 1, lon: 1 },
      },
    ]);
    const badges = search.results.querySelectorAll('.search-result-delay');
    expect(badges[0].style.color).toContain('delayed');
    expect(badges[1].style.color).toContain('major-delay');
  });

  it('renders a stop row and opens its station board on click', () => {
    const sb = vi.spyOn(ui, 'showStationBoard').mockImplementation(() => {});
    search.renderResults([
      { type: 'stop', stop: { name: 'Rathaus', lat: 49.34, lon: 8.66, extId: 'E1', platform: '' } },
    ]);
    expect(search.results.querySelector('.search-result-icon--stop').textContent).toBe('H');
    search.results.querySelector('.search-result-item').click();
    expect(state.map.setView).toHaveBeenCalledWith([49.34, 8.66], 17);
    expect(sb).toHaveBeenCalled();
  });

  it('a disambiguated stop row shows the coord/id detail line', () => {
    search.renderResults([
      {
        type: 'stop',
        stop: {
          name: 'Rathaus',
          lat: 49.34,
          lon: 8.66,
          extId: 'E1',
          platform: '2',
          _disambig: true,
        },
      },
    ]);
    const detail = search.results.querySelector('.search-result-detail');
    expect(detail.textContent).toContain('E1');
    expect(search.results.querySelector('.search-result-name').textContent).toContain('2');
  });
});
