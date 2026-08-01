/**
 * Coverage for the detail-panel structure of static/ui.js: init wiring, panel
 * state machine, tab switching, tab-mode, line filter, load-more button, the
 * follow-button helpers, and the two pointer-gesture initialisers
 * (initBottomSheet drag, initSwipeTabs swipe). Behaviour-level assertions
 * (state, mock calls, hidden/class flags), not markup structure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs, firePointer, stubPointerCapture } from './ui-dom.js';

const realL = globalThis.L;
globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (coords) => ({ _coords: coords }),
};

const selectStream = vi.fn(() => Promise.resolve({}));
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    getStationBoard: vi.fn(() => new Promise(() => {})),
    getJourney: vi.fn(() => new Promise(() => {})),
    selectStream: (...a) => selectStream(...a),
  },
  urlState: {
    push: vi.fn(),
    replace: vi.fn(),
    parse: vi.fn(() => ({})),
    saveMapPosition: vi.fn(),
    _pushCount: 0,
  },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { urlState } = await import('../../static/api.js');
const { state } = await import('../../static/state.js');
const { announce } = await import('../../static/status.js');

function mapStub(extra) {
  return Object.assign(
    {
      getCenter: () => ({ lat: 49.3, lng: 8.6, distanceTo: () => 0 }),
      getZoom: () => 14,
      setView: vi.fn(),
      panTo: vi.fn(),
      fitBounds: vi.fn(),
      once: vi.fn(),
    },
    extra || {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  state.map = mapStub();
  state.selectedJid = null;
  state.selectedStop = null;
  state.followBus = false;
  state.panelState = 'hidden';
  state._activeTab = null;
  state._tabMode = null;
  state.routeCoords = null;
  state.routeLayer = null;
  state.routeStopMarkers = [];
  state._selectedStopMarker = null;
  urlState._pushCount = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ui.setPanelState', () => {
  it('open: sets aria-expanded true, removes inert, adds --open class', () => {
    ui.setPanelState('open');
    expect(state.panelState).toBe('open');
    expect(ui.panel.getAttribute('aria-expanded')).toBe('true');
    expect(ui.panel.inert).toBe(false);
    expect(ui.panel.classList.contains('detail-panel--open')).toBe(true);
  });

  it('collapsed: aria-expanded false and --collapsed class', () => {
    ui.setPanelState('collapsed');
    expect(ui.panel.getAttribute('aria-expanded')).toBe('false');
    expect(ui.panel.classList.contains('detail-panel--collapsed')).toBe(true);
  });

  it('half: adds --half class', () => {
    ui.setPanelState('half');
    expect(ui.panel.classList.contains('detail-panel--half')).toBe(true);
  });

  it('hidden: sets inert and disables an active follow', () => {
    state.followBus = true;
    const spy = vi.spyOn(ui, '_disableFollow');
    ui.setPanelState('hidden');
    expect(ui.panel.inert).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('hidden without active follow does not call _disableFollow', () => {
    state.followBus = false;
    const spy = vi.spyOn(ui, '_disableFollow');
    ui.setPanelState('hidden');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ui.clearRoute', () => {
  it('removes route layer + stop markers and nulls coords', () => {
    const layerRemove = vi.fn();
    const m1 = { remove: vi.fn() };
    state.routeLayer = { remove: layerRemove };
    state.routeStopMarkers = [m1];
    state.routeCoords = [[1, 2]];
    ui.clearRoute();
    expect(layerRemove).toHaveBeenCalledOnce();
    expect(m1.remove).toHaveBeenCalledOnce();
    expect(state.routeStopMarkers).toEqual([]);
    expect(state.routeCoords).toBeNull();
  });

  it('is a no-op when there is no route layer', () => {
    state.routeLayer = null;
    expect(() => ui.clearRoute()).not.toThrow();
  });
});

describe('ui.closePanel', () => {
  it('resets selection state, unsubscribes SSE, clears route and hides actions', () => {
    state.selectedJid = 'J';
    state.selectedJourneyData = { x: 1 };
    const markerRemove = vi.fn();
    state._selectedStopMarker = { remove: markerRemove };
    const clearSpy = vi.spyOn(ui, 'clearRoute');
    ui.closePanel();
    expect(state.selectedJid).toBeNull();
    expect(state.selectedJourneyData).toBeNull();
    expect(markerRemove).toHaveBeenCalledOnce();
    expect(state._selectedStopMarker).toBeNull();
    expect(selectStream).toHaveBeenCalledWith('none');
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(document.getElementById('journey-actions').hidden).toBe(true);
    expect(urlState.saveMapPosition).toHaveBeenCalledOnce();
  });
});

describe('ui._disableFollow / _updateFollowUrl / _updateFollowButton', () => {
  it('_disableFollow clears state and button pressed attr', () => {
    state.followBus = true;
    const btn = document.getElementById('btn-follow');
    btn.classList.add('action-btn--active');
    ui._disableFollow();
    expect(state.followBus).toBe(false);
    expect(btn.classList.contains('action-btn--active')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('_updateFollowUrl adds follow=1 when following', () => {
    urlState.parse.mockReturnValue({});
    state.followBus = true;
    ui._updateFollowUrl();
    expect(urlState.replace).toHaveBeenCalledWith({ follow: '1' });
  });

  it('_updateFollowUrl deletes follow when not following', () => {
    urlState.parse.mockReturnValue({ follow: '1' });
    state.followBus = false;
    ui._updateFollowUrl();
    expect(urlState.replace).toHaveBeenCalledWith({});
  });

  it('_updateFollowButton toggles active class + pressed to match state', () => {
    state.followBus = true;
    ui._updateFollowButton();
    const btn = document.getElementById('btn-follow');
    expect(btn.classList.contains('action-btn--active')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ui.setTabMode', () => {
  it('journey: shows stops tab, hides dep/arr, hides line filter', () => {
    ui.setTabMode('journey');
    expect(document.getElementById('tab-stops').style.display).toBe('');
    expect(document.getElementById('tab-departures').style.display).toBe('none');
    expect(state._tabMode).toBe('journey');
  });

  it('station: hides stops, shows dep/arr, hides journey-actions and disables follow', () => {
    const spy = vi.spyOn(ui, '_disableFollow');
    ui.setTabMode('station');
    expect(document.getElementById('tab-stops').style.display).toBe('none');
    expect(document.getElementById('tab-departures').style.display).toBe('');
    expect(document.getElementById('journey-actions').hidden).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(state._tabMode).toBe('station');
  });
});

describe('ui.switchTab', () => {
  it('stops: marks stops tab active, shows its panel, hides filter', () => {
    const hideSpy = vi.spyOn(ui, 'hideLineFilter');
    ui.switchTab('stops');
    expect(document.getElementById('tab-stops').classList.contains('detail-tab--active')).toBe(
      true,
    );
    expect(document.getElementById('tabpanel-stops').hidden).toBe(false);
    expect(state._activeTab).toBe('stops');
    expect(hideSpy).toHaveBeenCalled();
  });

  it('departures with cached data rebuilds the line filter', () => {
    state._stationDepData = { common: {}, jnyL: [] };
    const spy = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    ui.switchTab('departures');
    expect(document.getElementById('tabpanel-departures').hidden).toBe(false);
    expect(spy).toHaveBeenCalledWith(state._stationDepData, null);
  });

  it('arrivals with cached data rebuilds the line filter', () => {
    state._stationArrData = { common: {}, jnyL: [] };
    const spy = vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    ui.switchTab('arrivals');
    expect(document.getElementById('tabpanel-arrivals').hidden).toBe(false);
    expect(spy).toHaveBeenCalledWith(state._stationArrData, null);
  });

  it('switching DEP↔ARR of a selected stop re-subscribes the board SSE', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._activeStationBoardType = 'DEP';
    state._stationArrDur = 120;
    ui.switchTab('arrivals');
    expect(state._activeStationBoardType).toBe('ARR');
    expect(selectStream).toHaveBeenCalledWith('stationboard', 'A=1@L=1@', 'ARR', 120);
  });

  it('does not re-subscribe when the board type is unchanged', () => {
    state.selectedStop = { lid: 'A=1@L=1@' };
    state._activeStationBoardType = 'DEP';
    ui.switchTab('departures');
    expect(selectStream).not.toHaveBeenCalled();
  });
});

describe('ui.hideLineFilter / buildLineFilter / applyLineFilter', () => {
  it('hideLineFilter hides and empties the element', () => {
    const el = document.getElementById('line-filter');
    el.appendChild(document.createElement('button'));
    el.hidden = false;
    ui.hideLineFilter();
    expect(el.hidden).toBe(true);
    expect(el.children.length).toBe(0);
  });

  it('buildLineFilter hides the filter when <= 1 distinct line', () => {
    const data = { common: { prodL: [{ nameS: '721' }] }, jnyL: [{ prodX: 0 }] };
    ui.buildLineFilter(data);
    expect(document.getElementById('line-filter').hidden).toBe(true);
  });

  it('buildLineFilter renders an All chip plus one chip per line, sorted', () => {
    state._activeTab = 'departures';
    state._depFilter = null;
    const data = {
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    };
    ui.buildLineFilter(data);
    const el = document.getElementById('line-filter');
    expect(el.hidden).toBe(false);
    const chips = el.querySelectorAll('.filter-chip');
    expect(chips.length).toBe(3); // All + 705 + 721
    expect(chips[0].classList.contains('filter-chip--active')).toBe(true); // All active
    // numeric sort: 705 before 721
    expect(chips[1].textContent).toBe('705');
    expect(chips[2].textContent).toBe('721');
  });

  it('buildLineFilter marks the active line chip when a filter is set', () => {
    state._activeTab = 'departures';
    state._depFilter = '721';
    const data = {
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    };
    ui.buildLineFilter(data);
    const active = document.getElementById('line-filter').querySelector('.filter-chip--active');
    expect(active.dataset.line).toBe('721');
  });

  it('All chip click calls applyLineFilter(null); line chip click passes the line', () => {
    state._activeTab = 'departures';
    state._depFilter = null;
    const data = {
      common: { prodL: [{ nameS: '721' }, { nameS: '705' }] },
      jnyL: [{ prodX: 0 }, { prodX: 1 }],
    };
    ui.buildLineFilter(data);
    const spy = vi.spyOn(ui, 'applyLineFilter').mockImplementation(() => {});
    const chips = document.getElementById('line-filter').querySelectorAll('.filter-chip');
    chips[0].click();
    expect(spy).toHaveBeenCalledWith(null);
    chips[2].click();
    expect(spy).toHaveBeenCalledWith('721');
  });

  it('applyLineFilter(dep) sets _depFilter and re-renders departures + load-more', () => {
    state._activeTab = 'departures';
    state._stationDepData = { jnyL: [] };
    state._stationLoc = { lid: 'A' };
    state._stationExtId = '1';
    state._stationDepDur = 60;
    const renderSpy = vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {});
    const lmSpy = vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    // one chip present so the active toggle path runs
    const chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.line = '721';
    document.getElementById('line-filter').appendChild(chip);
    ui.applyLineFilter('721');
    expect(state._depFilter).toBe('721');
    expect(chip.classList.contains('filter-chip--active')).toBe(true);
    expect(renderSpy).toHaveBeenCalled();
    expect(lmSpy).toHaveBeenCalledWith('departure-list', { lid: 'A' }, '1', 60, 'DEP');
  });

  it('applyLineFilter(arr) sets _arrFilter and re-renders arrivals', () => {
    state._activeTab = 'arrivals';
    state._stationArrData = { jnyL: [] };
    state._stationLoc = { lid: 'A' };
    state._stationExtId = '1';
    state._stationArrDur = 60;
    const renderSpy = vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    ui.applyLineFilter(null);
    expect(state._arrFilter).toBeNull();
    expect(renderSpy).toHaveBeenCalledWith(state._stationArrData, { lid: 'A' }, '1', null);
  });
});

describe('ui.addLoadMoreButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="dl"></ul>';
  });

  it('removes an existing load-more item before re-adding', () => {
    const list = document.getElementById('dl');
    const old = document.createElement('li');
    old.className = 'load-more-item';
    list.appendChild(old);
    ui.addLoadMoreButton('dl', { lid: 'A' }, '1', 120, 'DEP');
    expect(list.querySelectorAll('.load-more-item').length).toBe(1);
    expect(list.querySelector('.load-more-btn')).not.toBeNull();
  });

  it('does nothing when a hafas-hint is present', () => {
    const list = document.getElementById('dl');
    const hint = document.createElement('li');
    hint.className = 'hafas-hint';
    list.appendChild(hint);
    ui.addLoadMoreButton('dl', { lid: 'A' }, '1', 120, 'DEP');
    expect(list.querySelector('.load-more-btn')).toBeNull();
  });

  it('does nothing when an empty-state is present', () => {
    const list = document.getElementById('dl');
    const es = document.createElement('li');
    es.className = 'empty-state';
    list.appendChild(es);
    ui.addLoadMoreButton('dl', { lid: 'A' }, '1', 120, 'DEP');
    expect(list.querySelector('.load-more-btn')).toBeNull();
  });

  it('renders the max-timeframe hint at dur >= 1440 instead of a button', () => {
    ui.addLoadMoreButton('dl', { lid: 'A' }, '1', 1440, 'DEP');
    const list = document.getElementById('dl');
    expect(list.querySelector('.load-more-btn')).toBeNull();
    expect(list.querySelector('.load-more-item.empty-state')).not.toBeNull();
  });

  it('ARR button uses the arrivals label', () => {
    ui.addLoadMoreButton('dl', { lid: 'A' }, '1', 120, 'ARR');
    const btn = document.getElementById('dl').querySelector('.load-more-btn');
    expect(btn.textContent.length).toBeGreaterThan(0);
  });
});

describe('ui.init — event wiring', () => {
  beforeEach(() => {
    buildPanelDom();
    ui.init();
  });

  it('detail-back with no push history calls closePanel', () => {
    urlState._pushCount = 0;
    const spy = vi.spyOn(ui, 'closePanel').mockImplementation(() => {});
    document.getElementById('detail-back').click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('detail-back with push history calls history.back', () => {
    urlState._pushCount = 2;
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    document.getElementById('detail-back').click();
    expect(backSpy).toHaveBeenCalledOnce();
    backSpy.mockRestore();
  });

  it('Escape closes an open panel', () => {
    state.panelState = 'half';
    const spy = vi.spyOn(ui, 'closePanel').mockImplementation(() => {});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // init() attaches a document-level listener each call; across this describe's
    // beforeEach they accumulate, so assert it fired (behaviour), not an exact count.
    expect(spy).toHaveBeenCalled();
  });

  it('Escape is ignored while the about-dialog is open', () => {
    const dlg = document.getElementById('about-dialog');
    dlg.open = true;
    state.panelState = 'half';
    const spy = vi.spyOn(ui, 'closePanel').mockImplementation(() => {});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('Escape is a no-op when the panel is already hidden', () => {
    state.panelState = 'hidden';
    const spy = vi.spyOn(ui, 'closePanel').mockImplementation(() => {});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('tab buttons switch tabs', () => {
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    document.getElementById('tab-stops').click();
    document.getElementById('tab-departures').click();
    document.getElementById('tab-arrivals').click();
    expect(spy).toHaveBeenCalledWith('stops');
    expect(spy).toHaveBeenCalledWith('departures');
    expect(spy).toHaveBeenCalledWith('arrivals');
  });

  it('detail-share triggers ui.share and cancels a pending map click', () => {
    const cancel = vi.fn();
    state._cancelMapClick = cancel;
    const spy = vi.spyOn(ui, 'share').mockImplementation(() => {});
    document.getElementById('detail-share').click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();
    state._cancelMapClick = null;
  });
});

describe('ui.initJourneyActions — follow button', () => {
  beforeEach(() => {
    buildPanelDom();
    ui.init();
    state.selectedJid = null;
    state.followBus = false;
    state._notStartedJid = null;
  });

  it('toggles follow on and announces', () => {
    ui._updateFollowButton = vi.fn();
    ui._updateFollowUrl = vi.fn();
    document.getElementById('btn-follow').click();
    expect(state.followBus).toBe(true);
    expect(announce).toHaveBeenCalled();
  });

  it('follow-on for a not-started journey pans to the first stop coord', () => {
    state.followBus = false;
    state.selectedJid = 'J';
    state._notStartedJid = 'J';
    state.selectedJourneyData = {
      journey: { stopL: [{ locX: 0 }] },
      common: { locL: [{ crd: { x: 8600000, y: 49300000 } }] },
    };
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).toHaveBeenCalledWith([49.3, 8.6], { duration: 1 });
  });

  it('follow-on for a live bus far away jumps the view (dist > 3000)', () => {
    state.selectedJid = 'J';
    state.vehicles = new Map([['J', { data: { lat: 49.5, lon: 8.8 } }]]);
    state.map = mapStub({ getCenter: () => ({ distanceTo: () => 5000 }) });
    document.getElementById('btn-follow').click();
    expect(state.map.setView).toHaveBeenCalled();
    expect(state._followPanning).toBe(false);
  });

  it('follow-on for a nearby live bus pans smoothly and arms a timeout', () => {
    vi.useFakeTimers();
    state.selectedJid = 'J';
    state.vehicles = new Map([['J', { data: { lat: 49.5, lon: 8.8 } }]]);
    state.map = mapStub({ getCenter: () => ({ distanceTo: () => 1000 }) });
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).toHaveBeenCalled();
    expect(state.map.once).toHaveBeenCalledWith('moveend', expect.any(Function));
  });

  it('follow-on for a live bus already centred (dist <= 5) does not pan', () => {
    state.selectedJid = 'J';
    state.vehicles = new Map([['J', { data: { lat: 49.5, lon: 8.8 } }]]);
    state.map = mapStub({ getCenter: () => ({ distanceTo: () => 2 }) });
    document.getElementById('btn-follow').click();
    expect(state.map.panTo).not.toHaveBeenCalled();
    expect(state.map.setView).not.toHaveBeenCalled();
  });

  it('fitroute is a no-op without a route', () => {
    state.routeCoords = null;
    document.getElementById('btn-fitroute').click();
    expect(state.map.fitBounds).not.toHaveBeenCalled();
  });

  it('fitroute (desktop) fits bounds with right-padding for the panel', () => {
    vi.useFakeTimers();
    state.routeCoords = [
      [1, 2],
      [3, 4],
    ];
    window.innerWidth = 1400;
    document.getElementById('detail-panel').getBoundingClientRect = () => ({
      width: 360,
      top: 100,
    });
    document.getElementById('btn-fitroute').click();
    expect(state.map.fitBounds).toHaveBeenCalled();
    const opts = state.map.fitBounds.mock.calls[0][1];
    expect(opts.paddingBottomRight[0]).toBe(390); // width + 30
  });

  it('fitroute (mobile) fits bounds with bottom-padding', () => {
    vi.useFakeTimers();
    state.routeCoords = [
      [1, 2],
      [3, 4],
    ];
    window.innerWidth = 500;
    window.innerHeight = 800;
    document.getElementById('detail-panel').getBoundingClientRect = () => ({
      width: 360,
      top: 300,
    });
    document.getElementById('btn-fitroute').click();
    const opts = state.map.fitBounds.mock.calls[0][1];
    expect(opts.paddingTopLeft).toEqual([30, 80]);
  });
});

describe('ui.initBottomSheet — drag gestures', () => {
  let handle;
  beforeEach(() => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initBottomSheet();
    handle = ui.panel.querySelector('.detail-handle');
    stubPointerCapture(handle);
    window.innerHeight = 1000;
    state._cancelMapClick = null;
  });

  it('a vertical drag past threshold resizes the panel then snaps to a state on release', () => {
    const setSpy = vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    // panel offsetHeight read at down; then at up currentHeight decides ratio
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 }); // dy=-100 up, drag starts
    // release at a height that maps to "half" (ratio 0.5)
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerup', { clientX: 100, clientY: 700 });
    expect(setSpy).toHaveBeenCalledWith('half');
  });

  it('release ratio < 0.25 snaps to collapsed', () => {
    const setSpy = vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 100 }); // 0.1
    firePointer(handle, 'pointerup', { clientX: 100, clientY: 700 });
    expect(setSpy).toHaveBeenCalledWith('collapsed');
  });

  it('release ratio >= 0.75 snaps to open', () => {
    const setSpy = vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 900 }); // 0.9
    firePointer(handle, 'pointerup', { clientX: 100, clientY: 700 });
    expect(setSpy).toHaveBeenCalledWith('open');
  });

  it('pointerup without an active drag just clears the down flag (no snap)', () => {
    const setSpy = vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointerup', { clientX: 100, clientY: 800 }); // never dragged
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('pointerdown on a button inside the handle is ignored', () => {
    const btn = document.createElement('button');
    handle.appendChild(btn);
    stubPointerCapture(handle);
    firePointer(btn, 'pointerdown', { clientX: 1, clientY: 1 });
    // no drag armed → a move does not change transition
    firePointer(handle, 'pointermove', { clientX: 1, clientY: 200 });
    expect(ui.panel.style.transition).toBe('');
  });

  it('a mostly-horizontal move does not start a drag', () => {
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 300, clientY: 790 }); // absDx>absDy
    expect(ui.panel.style.transition).toBe('');
  });

  it('a small move below threshold does not start a drag', () => {
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 795 }); // absDy<10
    expect(ui.panel.style.transition).toBe('');
  });

  it('a downward drag inside scrolled content is suppressed', () => {
    const content = document.getElementById('detail-content');
    Object.defineProperty(content, 'scrollTop', { configurable: true, value: 50 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    // dispatch a move whose target is inside content, downward (dy>0)
    firePointer(content, 'pointermove', { clientX: 100, clientY: 900 });
    expect(ui.panel.style.transition).toBe('');
  });

  it('pointercancel resets transition', () => {
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 });
    firePointer(handle, 'pointercancel', {});
    expect(ui.panel.style.transition).toBe('');
  });

  it('pointerdown cancels a pending map click', () => {
    const cancel = vi.fn();
    state._cancelMapClick = cancel;
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    expect(cancel).toHaveBeenCalledOnce();
    state._cancelMapClick = null;
  });

  it('a non-primary pointerdown is ignored', () => {
    firePointer(handle, 'pointerdown', { clientX: 1, clientY: 1, isPrimary: false });
    firePointer(handle, 'pointermove', { clientX: 1, clientY: 200 });
    expect(ui.panel.style.transition).toBe('');
  });
});

describe('ui.initSwipeTabs — horizontal swipe between DEP/ARR', () => {
  let content;
  beforeEach(() => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initSwipeTabs();
    content = document.getElementById('detail-content');
    stubPointerCapture(content);
    state._tabMode = 'station';
  });

  it('is a no-op initialiser when detail-content is missing', () => {
    document.body.innerHTML = '';
    expect(() => ui.initSwipeTabs()).not.toThrow();
  });

  it('left swipe on the departures tab switches to arrivals', () => {
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 260, clientY: 102 }); // horizontal, captures
    firePointer(content, 'pointerup', { clientX: 200, clientY: 100 }); // dx=-100
    expect(spy).toHaveBeenCalledWith('arrivals');
  });

  it('right swipe on the arrivals tab switches to departures', () => {
    state._activeTab = 'arrivals';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 160, clientY: 102 });
    firePointer(content, 'pointerup', { clientX: 240, clientY: 100 }); // dx=+140
    expect(spy).toHaveBeenCalledWith('departures');
  });

  it('a small swipe (< 30px) does not switch', () => {
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 285, clientY: 101 });
    firePointer(content, 'pointerup', { clientX: 285, clientY: 100 }); // |dx|=15
    expect(spy).not.toHaveBeenCalled();
  });

  it('pointerdown outside station mode disarms the gesture', () => {
    state._tabMode = 'journey';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointerup', { clientX: 200, clientY: 100 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a mostly-vertical move abandons the swipe (not captured)', () => {
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 305, clientY: 200 }); // vertical dominates
    firePointer(content, 'pointerup', { clientX: 200, clientY: 200 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a move under the 10px deadzone stays uncaptured', () => {
    state._activeTab = 'departures';
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    const ev = firePointer(content, 'pointermove', { clientX: 305, clientY: 103 });
    expect(ev.defaultPrevented).toBe(false);
  });

  it('pointerup while station mode ended between move and up bails out', () => {
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 260, clientY: 101 });
    state._tabMode = 'journey'; // e.g. selection changed mid-gesture
    firePointer(content, 'pointerup', { clientX: 200, clientY: 100 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('pointercancel resets the gesture', () => {
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    expect(() => firePointer(content, 'pointercancel', {})).not.toThrow();
  });

  it('lostpointercapture resets the gesture', () => {
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    expect(() => firePointer(content, 'lostpointercapture', {})).not.toThrow();
  });

  it('a non-primary pointerup is ignored', () => {
    state._activeTab = 'departures';
    const spy = vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    firePointer(content, 'pointerdown', { clientX: 300, clientY: 100 });
    firePointer(content, 'pointermove', { clientX: 260, clientY: 101 });
    firePointer(content, 'pointerup', { clientX: 200, clientY: 100, isPrimary: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a pointermove with no active gesture is ignored', () => {
    // no pointerdown first
    const ev = firePointer(content, 'pointermove', { clientX: 260, clientY: 101 });
    expect(ev.defaultPrevented).toBe(false);
  });
});

// Restore the pre-existing global L stub for any later suites in the run.
afterEach(() => {
  if (realL !== undefined) globalThis.L = realL;
});
