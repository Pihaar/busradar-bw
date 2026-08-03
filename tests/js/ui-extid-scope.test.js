/**
 * Unit coverage for the platform-scoping helpers extracted from the stationboard
 * render path: computeScopeActive (locL-geometry scope decision), scopedBoard
 * (extId filter with Number.isInteger bounds), and ui._scopedStationBoard (the
 * single derivation reading state). These absorb the extId-scoping coverage that
 * used to live inline in renderDepartures/renderArrivals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: {
    subscribeBoard: vi.fn(),
    getStationBoard: vi.fn(),
    getJourney: vi.fn(),
    selectStream: vi.fn(),
  },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const { ui, computeScopeActive, scopedBoard, annotatePlatforms, platformScopedBoard } =
  await import('../../static/ui.js');
const { state } = await import('../../static/state.js');

// crd.x/y are ×1e6. Distance: dlat=|Δy|/1e6*111000, dlon=|Δx|/1e6*111000*0.65.
// Δy=1000 → ~111 m (>1m); Δy=5 → ~0.56 m (<1m).
const SELF = { extId: 'S', name: 'Stop', crd: { x: 8600000, y: 49000000 } };
const FAR_SAME = { extId: 'O', name: 'Stop', crd: { x: 8600000, y: 49001000 } };
const NEAR_SAME = { extId: 'N', name: 'Stop', crd: { x: 8600000, y: 49000005 } };
const FAR_DIFF = { extId: 'F', name: 'Other', crd: { x: 8600000, y: 49002000 } };
const NO_CRD = { extId: 'C', name: 'Stop' };
const board = (locL) => ({ common: { locL } });

describe('computeScopeActive', () => {
  it('returns false when filterExtId is empty', () => {
    expect(computeScopeActive(board([SELF, FAR_SAME]), false, '')).toBe(false);
  });
  it('returns false for empty filterExtId even when hasPlatform is truthy (precedence)', () => {
    expect(computeScopeActive(board([SELF, FAR_SAME]), true, '')).toBe(false);
  });
  it('returns true for a platform stop regardless of geometry', () => {
    expect(computeScopeActive(board([SELF]), true, 'S')).toBe(true);
  });
  it('returns false when self extId is not in locL', () => {
    expect(computeScopeActive(board([FAR_SAME, FAR_DIFF]), false, 'X')).toBe(false);
  });
  it('returns false when self loc has no crd', () => {
    expect(computeScopeActive(board([NO_CRD, FAR_SAME]), false, 'C')).toBe(false);
  });
  it('returns true for a same-named sibling platform > 1 m away', () => {
    expect(computeScopeActive(board([SELF, FAR_SAME]), false, 'S')).toBe(true);
  });
  it('returns false for a same-named loc within 1 m (HAFAS duplicate)', () => {
    expect(computeScopeActive(board([SELF, NEAR_SAME]), false, 'S')).toBe(false);
  });
  it('skips a differently-named far loc (unrelated stop in locL)', () => {
    expect(computeScopeActive(board([SELF, FAR_DIFF]), false, 'S')).toBe(false);
  });
  it('skips a same-named other loc without crd', () => {
    const otherNoCrd = { extId: 'C2', name: 'Stop' };
    expect(computeScopeActive(board([SELF, otherNoCrd]), false, 'S')).toBe(false);
  });
  it('scans past a near sibling to a far one (both loop iterations)', () => {
    expect(computeScopeActive(board([SELF, NEAR_SAME, FAR_SAME]), false, 'S')).toBe(true);
  });
  it('returns false for an empty locL', () => {
    expect(computeScopeActive(board([]), false, 'S')).toBe(false);
  });
  it('handles zero/missing coordinates via the || 0 fallback (same-named, within 1 m)', () => {
    // self and sibling both at {x:0,y:0}: exercises the `crd.x || 0` / `crd.y || 0`
    // fallback arms; distance 0 → within 1 m → not scoped.
    var selfZero = { extId: 'S', name: 'Stop', crd: { x: 0, y: 0 } };
    var sibZero = { extId: 'O', name: 'Stop', crd: { x: 0, y: 0 } };
    expect(computeScopeActive(board([selfZero, sibZero]), false, 'S')).toBe(false);
  });
  it('returns false when board is null-ish', () => {
    expect(computeScopeActive(null, false, 'S')).toBe(false);
  });
});

describe('scopedBoard', () => {
  const locL = [{ extId: 'S' }, { extId: 'O' }];
  const full = {
    common: { locL },
    jnyL: [
      { stbStop: { locX: 0 } }, // → S (kept)
      { stbStop: { locX: 1 } }, // → O (dropped)
      { stbStop: { locX: 1.5 } }, // non-integer (dropped)
      { stbStop: { locX: NaN } }, // NaN (dropped)
      { stbStop: { locX: -1 } }, // negative (dropped)
      { stbStop: { locX: 5 } }, // out of range (dropped)
      { stbStop: { locX: null } }, // null → -1 (dropped)
      {}, // no stbStop → {} arm → -1 (dropped)
    ],
  };
  it('returns the original board (identity) when not scoping', () => {
    expect(scopedBoard(full, false, 'S')).toBe(full);
  });
  it('returns the original board (identity) when filterExtId is empty', () => {
    expect(scopedBoard(full, true, '')).toBe(full);
  });
  it('keeps only entries whose locX resolves to the chosen extId', () => {
    const out = scopedBoard(full, true, 'S');
    expect(out).not.toBe(full);
    expect(out.jnyL).toHaveLength(1);
    expect(out.jnyL[0].stbStop.locX).toBe(0);
  });
  it('does not crash on null / empty boards', () => {
    expect(scopedBoard(null, false, 'S')).toBe(null);
    expect(scopedBoard({}, true, 'S')).toEqual({ jnyL: [] });
    expect(scopedBoard({ jnyL: [], common: {} }, true, 'S')).toEqual({ jnyL: [], common: {} });
  });
});

describe('ui._scopedStationBoard', () => {
  beforeEach(() => {
    state._stationDepData = null;
    state._stationArrData = null;
    state._stationLoc = null;
    state._stationExtId = '';
  });
  const locL = [{ extId: 'S', name: 'Stop', crd: { x: 8600000, y: 49000000 } }, FAR_SAME];
  const bd = { common: { locL }, jnyL: [{ stbStop: { locX: 0 } }, { stbStop: { locX: 1 } }] };

  it('reads the DEP board and scopes it', () => {
    state._stationDepData = bd;
    state._stationLoc = { platform: '' };
    state._stationExtId = 'S';
    expect(ui._scopedStationBoard('DEP').jnyL).toHaveLength(1);
  });
  it('reads the ARR board separately', () => {
    state._stationArrData = bd;
    state._stationLoc = { platform: '' };
    state._stationExtId = 'S';
    expect(ui._scopedStationBoard('ARR').jnyL).toHaveLength(1);
  });
  it('passes through a null board (ARR not yet loaded) without crashing', () => {
    state._stationExtId = 'S';
    expect(ui._scopedStationBoard('ARR')).toBe(null);
  });
  it('scopes unconditionally for a platform stop (hasPlatform from state._stationLoc)', () => {
    state._stationDepData = bd;
    state._stationLoc = { platform: '2' };
    state._stationExtId = 'S';
    expect(ui._scopedStationBoard('DEP').jnyL).toHaveLength(1);
  });
  it('returns the full board when not scoping', () => {
    state._stationDepData = bd;
    state._stationLoc = { platform: '' };
    state._stationExtId = ''; // no extId → scopedBoard returns original
    expect(ui._scopedStationBoard('DEP')).toBe(bd);
  });
});

describe('annotatePlatforms', () => {
  it('tags each jny with _platformExtId and marks the board', () => {
    const b = { jnyL: [{ jid: 'a' }, { jid: 'b' }, { jid: 'c' }], platforms: ['S1', null, 'S2'] };
    annotatePlatforms(b);
    expect(b._platformTagged).toBe(true);
    expect(b.jnyL[0]._platformExtId).toBe('S1');
    expect(b.jnyL[1]._platformExtId).toBeNull();
    expect(b.jnyL[2]._platformExtId).toBe('S2');
  });
  it('is a no-op without a platforms array (ordinary stop)', () => {
    const b = { jnyL: [{ jid: 'a' }] };
    annotatePlatforms(b);
    expect(b._platformTagged).toBeUndefined();
    expect(b.jnyL[0]._platformExtId).toBeUndefined();
  });
  it('null-safe on a null board', () => {
    expect(annotatePlatforms(null)).toBeNull();
  });
  it('tolerates a platforms array with no jnyL', () => {
    const b = { platforms: ['S1'] };
    annotatePlatforms(b);
    expect(b._platformTagged).toBe(true);
  });
});

describe('platformScopedBoard', () => {
  const tagged = () => ({
    _platformTagged: true,
    jnyL: [
      { jid: 'a', _platformExtId: 'S1' },
      { jid: 'b', _platformExtId: 'S2' },
      { jid: 'c', _platformExtId: null },
    ],
  });
  it('keeps only the opened Steig plus fail-open null rows', () => {
    const out = platformScopedBoard(tagged(), 'S1');
    expect(out.jnyL.map((j) => j.jid)).toEqual(['a', 'c']); // S1 + null (both)
  });
  it('inverse Steig keeps the other tagged row plus null', () => {
    const out = platformScopedBoard(tagged(), 'S2');
    expect(out.jnyL.map((j) => j.jid)).toEqual(['b', 'c']);
  });
  it('is a no-op for an untagged board (ordinary stop, byte-identical)', () => {
    const b = { jnyL: [{ jid: 'a' }] };
    expect(platformScopedBoard(b, 'S1')).toBe(b);
  });
  it('is a no-op without a filter extId', () => {
    const b = tagged();
    expect(platformScopedBoard(b, '')).toBe(b);
  });
  it('null-safe on a null board', () => {
    expect(platformScopedBoard(null, 'S1')).toBeNull();
  });
  it('tolerates a tagged board with no jnyL', () => {
    const out = platformScopedBoard({ _platformTagged: true }, 'S1');
    expect(out.jnyL).toEqual([]);
  });
});

describe('ui._scopedStationBoard with platform tags', () => {
  it('applies the Steig filter after geometric scope', () => {
    state._stationDepData = {
      _platformTagged: true,
      common: { locL: [] },
      jnyL: [
        { jid: 'a', _platformExtId: '4466864' },
        { jid: 'b', _platformExtId: '4407123' },
        { jid: 'c', _platformExtId: null },
      ],
    };
    state._stationLoc = { platform: '' };
    state._stationExtId = '4466864';
    const view = ui._scopedStationBoard('DEP');
    expect(view.jnyL.map((j) => j.jid)).toEqual(['a', 'c']);
  });
});
