/**
 * Final branch mop-up for static/ui.js: the last uncovered guard-true arms
 * (_cancelMapClick), midnight-wrap arities, gesture onMove content-scroll and
 * onCancel guards, the cascade deselect-mid-expand bails, the load-more ARR
 * click, renderArrivals dedup/out-of-range/nodata-colour rows, and the
 * focusJourneyById selected-stop-marker / history-push / delay-from-arrival
 * arms. Every case asserts an observable effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPanelDom, wireUiRefs, firePointer, stubPointerCapture } from './ui-dom.js';

globalThis.L = {
  latLng: (lat, lon) => ({ lat, lng: lon }),
  latLngBounds: (c) => ({ _c: c }),
  layerGroup: vi.fn(() => ({ addTo: vi.fn() })),
  polyline: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => {
    const m = { addTo: vi.fn(() => m), bindTooltip: vi.fn(() => m), on: vi.fn(), remove: vi.fn() };
    return m;
  }),
};

const getJourney = vi.fn(() => new Promise(() => {}));
const getStationBoard = vi.fn(() => new Promise(() => {}));
vi.mock('../../static/api.js', () => ({
  api: {
    getStationBoard: (...a) => getStationBoard(...a),
    getJourney: (...a) => getJourney(...a),
    selectStream: vi.fn(() => Promise.resolve()),
  },
  urlState: { push: vi.fn(), replace: vi.fn(), parse: vi.fn(() => ({})), saveMapPosition: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui } = await import('../../static/ui.js');
const { state } = await import('../../static/state.js');
const { urlState } = await import('../../static/api.js');

function settle() {
  return new Promise((r) => setTimeout(r, 0));
}
function mapStub(extra) {
  return Object.assign(
    {
      setView: vi.fn(),
      panTo: vi.fn(),
      fitBounds: vi.fn(),
      once: vi.fn(),
      getCenter: () => ({ lat: 49.3, lng: 8.6 }),
      getZoom: () => 14,
    },
    extra || {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDom();
  wireUiRefs(ui);
  state.serverTimeMin = 600;
  state.serverTimeStamp = null;
  state.map = mapStub();
  state.selectedStop = null;
  state._selectedStopMarker = null;
  state._cancelMapClick = null;
  state.vehicles = new Map();
  state.allStops = new Map();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('_cancelMapClick guard-true arms', () => {
  it('selectJourney cancels a pending map click', () => {
    const cancel = vi.fn();
    state._cancelMapClick = cancel;
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    ui.selectJourney({ jid: 'J', line: '1', direction: 'X', delay: null }, true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('showStationBoard cancels a pending map click', () => {
    const cancel = vi.fn();
    state._cancelMapClick = cancel;
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'clearRoute').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'hideLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'loadDepartures').mockReturnValue({ finally: () => {} });
    ui.showStationBoard({ lid: 'A=1@L=1@', name: 'S', lat: 49.3, lon: 8.6 }, true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('focusJourneyById cancels a pending map click', () => {
    const cancel = vi.fn();
    state._cancelMapClick = cancel;
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    ui.focusJourneyById('J', {}, true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('_populateStopTimes — dwell wrap in the other direction', () => {
  it('normalises an inverted arrival/departure across midnight (diff > 720)', () => {
    const el = document.createElement('div');
    // arrival 00:05, departure 23:50 (same visual day) → diff ~ -735 → +1440 wrap,
    // but this branch is diff > 720; use arrival 00:10 dep 23:00 → diff -730 <-720 → +1440.
    // To hit the `> 720` arm: arrival 23:00, departure 00:10 with values that yield +1390.
    ui._populateStopTimes(el, {
      aTimeS: '000500',
      aTimeR: '000500',
      dTimeS: '235000',
      dTimeR: '235000',
    });
    // dR - aR = 1430 - 5 = 1425 > 720 → -1440 → -15 → dwell stays null (no split)
    expect(el.classList.contains('stop-times--split')).toBe(false);
  });
});

describe('midnight-wrap: updateJourneyStopDelays early-morning arm', () => {
  it('applies the (now<360, stop>1080) wrap when patching dots', () => {
    state.serverTimeMin = 120; // 02:00
    const list = document.createElement('ol');
    const li = document.createElement('li');
    li.className = 'stop-item';
    const dot = document.createElement('div');
    dot.className = 'stop-dot';
    const times = document.createElement('div');
    times.className = 'stop-times';
    li.append(dot, times);
    list.appendChild(li);
    document.body.appendChild(list);
    ui.stopList = list;
    const stopL = [{ locX: 0, dTimeS: '233000', dTimeR: '233000' }]; // 23:30 → -1440 → past
    state._renderedStopSig = ui._stopSig(stopL);
    ui.updateJourneyStopDelays({ journey: { stopL } });
    expect(dot.classList.contains('stop-dot--passed')).toBe(true);
  });
});

describe('updateStopProgress — early-morning wrap arm', () => {
  it('applies the (now<360, min>1080) wrap to a stop time', () => {
    document.body.innerHTML = ''; // avoid a duplicate #stop-progress from the panel fixture
    state.serverTimeMin = 120; // 02:00
    const list = document.createElement('ol');
    list.getBoundingClientRect = () => ({ top: 0, left: 0, height: 500, width: 300 });
    [10, 100].forEach((cy) => {
      const li = document.createElement('li');
      li.className = 'stop-item';
      const dot = document.createElement('span');
      dot.className = 'stop-dot';
      dot.getBoundingClientRect = () => ({ top: cy - 4, height: 8, left: 9, width: 8 });
      li.appendChild(dot);
      list.appendChild(li);
    });
    const prog = document.createElement('div');
    prog.id = 'stop-progress';
    list.appendChild(prog);
    document.body.appendChild(list);
    ui.stopList = list;
    // 23:00 (>1080) → -1440 → -60 (past), and 01:00 future; both <= now → bar full
    ui.updateStopProgress([{ dTimeS: '230000' }, { dTimeS: '010000' }]);
    expect(prog.style.height).toBe('90px'); // lastY 100 − firstY 10
  });
});

describe('bottom-sheet onMove content-scroll + onCancel guards', () => {
  let handle, content;
  beforeEach(() => {
    buildPanelDom();
    wireUiRefs(ui);
    ui.initBottomSheet();
    handle = ui.panel.querySelector('.detail-handle');
    content = document.getElementById('detail-content');
    stubPointerCapture(handle);
    window.innerHeight = 1000;
  });

  // Dispatch a pointermove on the handle but with the event target set to a
  // node inside #detail-content, so the content-scroll guard is reached.
  function moveWithTarget(target, props) {
    const ev = new Event('pointermove', { bubbles: true });
    Object.assign(ev, Object.assign({ isPrimary: true, pointerId: 1 }, props));
    Object.defineProperty(ev, 'target', { value: target, configurable: true });
    handle.dispatchEvent(ev);
    return ev;
  }

  it('a downward move over scrolled content (scrollTop>0) does not start a drag', () => {
    Object.defineProperty(content, 'scrollTop', { configurable: true, value: 50 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    moveWithTarget(content, { clientX: 100, clientY: 900 }); // dy>0, scrollTop>0 → return
    expect(ui.panel.style.transition).toBe('');
  });

  it('an upward move inside content at scrollTop 0 (dy<0) does not start a drag', () => {
    const inner = document.createElement('div');
    content.appendChild(inner);
    Object.defineProperty(content, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    moveWithTarget(inner, { clientX: 100, clientY: 700 }); // dy<0 → return
    expect(ui.panel.style.transition).toBe('');
  });

  it('a downward drag from the header (not over content) starts and resizes', () => {
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 500 });
    // target is the handle (outside content) → skips the content guard, drags
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 600 }); // dy>0 downward
    expect(ui.panel.style.transition).toBe('none');
  });

  it('a non-primary pointercancel is ignored', () => {
    Object.defineProperty(ui.panel, 'offsetHeight', { configurable: true, value: 500 });
    firePointer(handle, 'pointerdown', { clientX: 100, clientY: 800 });
    firePointer(handle, 'pointermove', { clientX: 100, clientY: 700 });
    ui.panel.style.transition = 'none';
    firePointer(handle, 'pointercancel', { isPrimary: false }); // guard returns early
    expect(ui.panel.style.transition).toBe('none'); // unchanged
  });
});

describe('load-more ARR button click', () => {
  it('resets the arr expand counter and cascades loadArrivals', () => {
    document.body.innerHTML = '<ul id="al"></ul>';
    state._arrExpandCount = 5;
    const spy = vi.spyOn(ui, 'loadArrivals').mockImplementation(() => {});
    ui.addLoadMoreButton('al', { lid: 'A' }, '1', 480, 'ARR');
    document.querySelector('.load-more-btn').click();
    expect(state._arrExpandCount).toBe(0);
    expect(spy).toHaveBeenCalledWith({ lid: 'A' }, '1', 540, true);
  });
});

describe('cascade deselect mid-expand', () => {
  const loc = { lid: 'A=1@L=1@', name: 'S' };
  beforeEach(() => {
    vi.spyOn(ui, 'discoverPlatforms').mockImplementation(() => {});
    vi.spyOn(ui, 'buildLineFilter').mockImplementation(() => {});
    vi.spyOn(ui, 'addLoadMoreButton').mockImplementation(() => {});
    state._activeStationBoardType = 'DEP';
  });

  it('loadDepartures bails inside the expand branch when the stop is deselected during render', async () => {
    state.selectedStop = loc;
    state._stationDepCount = 0;
    state._depExpandCount = 0;
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    // renderDepartures flips the selection so the expand-branch re-check bails
    vi.spyOn(ui, 'renderDepartures').mockImplementation(() => {
      state.selectedStop = { lid: 'OTHER' };
      return [];
    });
    await ui.loadDepartures(loc, '', 60, true);
    await settle();
    expect(state._autoExpandingDep).toBe(false);
    // exactly one fetch: the cascade did not recurse
    expect(getStationBoard).toHaveBeenCalledTimes(1);
  });

  it('loadArrivals bails inside the expand branch when the stop is deselected during render', async () => {
    state.selectedStop = loc;
    state._activeStationBoardType = 'ARR';
    state._stationArrCount = 0;
    state._arrExpandCount = 0;
    getStationBoard.mockResolvedValue({ jnyL: [], common: {} });
    vi.spyOn(ui, 'renderArrivals').mockImplementation(() => {
      state.selectedStop = { lid: 'OTHER' };
      return [];
    });
    await ui.loadArrivals(loc, '', 60, true);
    await settle();
    expect(state._autoExpandingArr).toBe(false);
    expect(getStationBoard).toHaveBeenCalledTimes(1);
  });
});

describe('renderArrivals — dedup + out-of-range + nodata colour', () => {
  const arrList = () => document.getElementById('arrival-list');
  beforeEach(() => {
    state._stationArrDur = 60;
    state._autoExpandingArr = false;
  });

  it('dedups identical arrival rows and drops out-of-range under platform filter', () => {
    const data = {
      jnyL: [
        { jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } },
        { jid: 'B', prodX: 0, dirTxt: 'X', stbStop: { locX: 0, aTimeS: '120000' } }, // dup key
        { jid: 'C', prodX: 0, dirTxt: 'Z', stbStop: { locX: 9, aTimeS: '121000' } }, // out of range
      ],
      common: { prodL: [{ nameS: '721' }], locL: [{ extId: 'E1' }] },
    };
    ui.renderArrivals(data, { name: 'S', platform: '2' }, 'E1', null);
    // only the deduped in-range row survives
    expect(arrList().querySelectorAll('.departure-item').length).toBe(1);
  });

  it('renders the nodata colour when an arrival has no realtime', () => {
    const data = {
      jnyL: [{ jid: 'A', prodX: 0, dirTxt: 'X', stbStop: { aTimeS: '' } }],
      common: { prodL: [{ nameS: '721' }], locL: [] },
    };
    ui.renderArrivals(data, { name: 'S' }, '', null);
    const el = arrList().querySelector('.departure-delay');
    expect(el.style.color).toContain('secondary');
  });
});

describe('focusJourneyById — marker/history/delay arms', () => {
  beforeEach(() => {
    vi.spyOn(ui, '_disableFollow').mockImplementation(() => {});
    vi.spyOn(ui, 'setTabMode').mockImplementation(() => {});
    vi.spyOn(ui, 'switchTab').mockImplementation(() => {});
    vi.spyOn(ui, 'setPanelState').mockImplementation(() => {});
    vi.spyOn(ui, 'renderJourneyStops').mockImplementation(() => {});
    vi.spyOn(ui, 'drawRoute').mockImplementation(() => {});
    state.panelState = 'half';
  });

  it('removes an existing selected-stop marker up front', () => {
    const remove = vi.fn();
    state._selectedStopMarker = { remove };
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.focusJourneyById('J', {}, true);
    expect(remove).toHaveBeenCalledOnce();
    expect(state._selectedStopMarker).toBeNull();
  });

  it('pushes history when skipHistory is falsy', () => {
    getJourney.mockReturnValueOnce(new Promise(() => {}));
    ui.focusJourneyById('J', {});
    expect(urlState.push).toHaveBeenCalledWith(expect.objectContaining({ jid: 'J' }));
  });

  it('derives the delay from a stop arrival pair when there is a live position', async () => {
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          pos: { x: 8610000, y: 49310000 },
          stopL: [{ locX: 0, aTimeS: '100000', aTimeR: '100300' }], // +3 via arrival pair
          dirTxt: 'Ziel',
          prodX: 0,
        },
        common: { prodL: [{ nameS: '721', name: 'Bus 721' }], locL: [{ name: 'A' }] },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await settle();
    expect(ui.detailDelay.textContent).toContain('+3');
  });

  it('not-started desktop path uses the panel-width fit padding', async () => {
    vi.useFakeTimers();
    window.innerWidth = 1400;
    document.getElementById('detail-panel').getBoundingClientRect = () => ({ width: 360, top: 50 });
    ui.drawRoute.mockImplementation(() => {
      state.routeCoords = [
        [1, 2],
        [3, 4],
      ];
    });
    getJourney.mockReturnValueOnce(
      Promise.resolve({
        journey: {
          stopL: [
            { locX: 0, dTimeS: '120000' },
            { locX: 1, dTimeS: '123000' },
          ],
          dirTxt: 'Z',
          prodX: 0,
        },
        common: {
          prodL: [{ nameS: '721', name: 'Bus 721' }],
          locL: [{ name: 'A' }, { name: 'B' }],
        },
      }),
    );
    ui.focusJourneyById('J', {}, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.map.fitBounds).toHaveBeenCalled();
    const opts = state.map.fitBounds.mock.calls[0][1];
    expect(opts.paddingBottomRight[0]).toBe(390); // width + 30 (desktop)
    // the 1500ms navigating reset callback runs
    state._navigating = true;
    vi.advanceTimersByTime(1500);
    expect(state._navigating).toBe(false);
  });
});
