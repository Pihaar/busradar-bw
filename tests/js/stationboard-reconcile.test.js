/**
 * Unit coverage for the pure stationboard reconcile + pagination helpers in
 * static/ui.js. These are DOM-free and side-effect-free, so they exercise every
 * branch directly: the Soll-based reconcile window, the index-space remap of an
 * adopted push entry, the effective-time sort, and the horizon math.
 */
import { describe, it, expect, vi } from 'vitest';

globalThis.L = { latLng: (lat, lon) => ({ lat, lng: lon }) };
vi.mock('../../static/api.js', () => ({
  trackedFetch: (...a) => window.fetch(...a),
  api: { subscribeBoard: vi.fn(), getStationBoard: vi.fn(), selectStream: vi.fn() },
  urlState: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('../../static/map.js', () => ({
  markers: { updateAll: vi.fn(), highlightSelected: vi.fn() },
  stopsLayer: { update: vi.fn(), addStopMarker: vi.fn(), saveToCache: vi.fn() },
}));
vi.mock('../../static/status.js', () => ({ announce: vi.fn() }));

const {
  boardEntryEff,
  boardEntryKey,
  reconcileBoard,
  computeInitialHorizon,
  extendHorizon,
  hasBeyondHorizon,
  sliceToHorizon,
} = await import('../../static/ui.js');

// HAFAS HHMMSS from minutes-of-day.
function hhmm(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return h + m + '00';
}
function dep(jid, sollMin, opts) {
  const stb = { dTimeS: hhmm(sollMin) };
  if (opts && opts.istMin != null) stb.dTimeR = hhmm(opts.istMin);
  if (opts && 'locX' in opts) stb.locX = opts.locX;
  return {
    jid,
    prodX: (opts && opts.prodX) != null ? opts.prodX : 0,
    dirTxt: (opts && opts.dir) || 'D',
    stbStop: stb,
  };
}

describe('boardEntryEff', () => {
  it('prefers the real (Ist) time over the scheduled time', () => {
    expect(boardEntryEff(dep('A', 720, { istMin: 725 }))).toBe(725);
  });
  it('falls back to the scheduled time when no Ist is present', () => {
    expect(boardEntryEff(dep('A', 720))).toBe(720);
  });
  it('returns null when neither time is present', () => {
    expect(boardEntryEff({ stbStop: {} })).toBeNull();
    expect(boardEntryEff(null)).toBeNull();
  });
  it('reads the arrival Ist/Soll fields too', () => {
    expect(boardEntryEff({ stbStop: { aTimeR: hhmm(500) } })).toBe(500);
    expect(boardEntryEff({ stbStop: { aTimeS: hhmm(480) } })).toBe(480);
  });
});

describe('boardEntryKey', () => {
  it('is day- and line-distinct', () => {
    const k = boardEntryKey({
      jid: 'J',
      prodX: 3,
      dirTxt: 'X',
      date: '20260201',
      stbStop: { dTimeS: '120000' },
    });
    expect(k).toBe('J|3|X|20260201|120000');
  });
  it('uses empty defaults for a bare entry', () => {
    expect(boardEntryKey({ stbStop: {} })).toBe('||||');
  });
});

describe('reconcileBoard — guards', () => {
  it('returns the cache unchanged when cache is null', () => {
    expect(reconcileBoard(null, { jnyL: [] }, 720)).toBeNull();
  });
  it('returns the cache unchanged when nowMin is null (no server clock)', () => {
    const cache = { jnyL: [dep('A', 720)], common: {} };
    expect(reconcileBoard(cache, { jnyL: [] }, null)).toBe(cache);
  });
  it('tolerates a cache with no jnyL (cache.jnyL || [] arm)', () => {
    const merged = reconcileBoard(
      { common: { locL: [], prodL: [] } },
      { jnyL: [dep('A', 730)], common: { locL: [], prodL: [] } },
      720,
    );
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['A']);
  });
});

describe('reconcileBoard — window + set-difference', () => {
  function cache(jnyL) {
    return { jnyL, common: { locL: [{ extId: 'E1' }], prodL: [{ nameS: '721' }] } };
  }
  function push(jnyL, locL, prodL) {
    return {
      jnyL,
      common: { locL: locL || [{ extId: 'E1' }], prodL: prodL || [{ nameS: '721' }] },
    };
  }

  it('drops an in-window cache entry that the push no longer carries', () => {
    // now=720, winTop=min(840, maxPushSoll). Push carries only B (730); A (725)
    // is in-window (<=winTop) and absent from the push → removed.
    const merged = reconcileBoard(
      cache([dep('A', 725), dep('B', 730)]),
      push([dep('B', 730)]),
      720,
    );
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['B']);
  });

  it('keeps the tail (Soll > winTop) untouched and ignores far push entries', () => {
    // now=720 → now+120=840. Push maxSoll=800 → winTop=800. Cache C at 900 is tail.
    const merged = reconcileBoard(
      cache([dep('A', 730), dep('C', 900)]),
      push([dep('A', 730), dep('B', 800)]),
      720,
    );
    // A adopted, B adopted (<=800), C kept as tail → sorted by eff.
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['A', 'B', 'C']);
  });

  it('winTop stays now+120 when the push extends beyond it (maxPushSoll >= winTop)', () => {
    // Push has an entry at 900 (> now+120=840): winTop=840, that entry is NOT
    // adopted (soll>winTop) and a cache tail entry at 900 survives.
    const merged = reconcileBoard(
      cache([dep('A', 730), dep('T', 900)]),
      push([dep('A', 730), dep('FAR', 900)]),
      720,
    );
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['A', 'T']);
  });

  it('skips push/cache entries with no scheduled time', () => {
    const merged = reconcileBoard(
      cache([dep('A', 730), { jid: 'NOTIME', prodX: 0, dirTxt: 'x', stbStop: {} }]),
      push([dep('A', 730), { jid: 'PN', prodX: 0, dirTxt: 'y', stbStop: {} }]),
      720,
    );
    // The no-Soll cache entry has cs==null → kept; the no-Soll push entry skipped.
    expect(merged.jnyL.map((j) => j.jid).sort()).toEqual(['A', 'NOTIME']);
  });

  it('remaps an adopted push entry into the cache index space (find + append)', () => {
    // Push locL/prodL differ in order from cache; adopted entry must point at the
    // cache indices. E1 exists in cache (find), E2 is new (append).
    const merged = reconcileBoard(
      cache([]),
      push(
        [dep('A', 730, { locX: 0, prodX: 0 }), dep('B', 735, { locX: 1, prodX: 1 })],
        [{ extId: 'E1' }, { extId: 'E2' }],
        [{ nameS: '721' }, { nameS: '705' }],
      ),
      720,
    );
    expect(merged.common.locL.map((l) => l.extId)).toEqual(['E1', 'E2']); // E2 appended
    expect(merged.common.prodL.map((p) => p.nameS)).toEqual(['721', '705']);
    const b = merged.jnyL.find((j) => j.jid === 'B');
    expect(b.stbStop.locX).toBe(1); // remapped into cache locL space
    expect(b.prodX).toBe(1);
  });

  it('leaves locX/prodX untouched when out of range or absent', () => {
    const merged = reconcileBoard(
      cache([]),
      push(
        [{ jid: 'A', prodX: 9, dirTxt: 'x', stbStop: { dTimeS: hhmm(730), locX: 9 } }],
        [{ extId: 'E1' }],
        [{ nameS: '721' }],
      ),
      720,
    );
    const a = merged.jnyL[0];
    expect(a.stbStop.locX).toBe(9); // out of range → not remapped
    expect(a.prodX).toBe(9);
  });

  it('sorts merged entries by effective time, nulls last', () => {
    const merged = reconcileBoard(
      { jnyL: [{ jid: 'N', prodX: 0, dirTxt: 'x', stbStop: {} }], common: {} },
      { jnyL: [dep('A', 730), dep('B', 725)], common: { locL: [], prodL: [] } },
      720,
    );
    // 725 (B), 730 (A), then the null-time N last.
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['B', 'A', 'N']);
  });

  it('orders two null-time entries stably (comparator 0 arm)', () => {
    const bare = (jid) => ({ jid, prodX: 0, dirTxt: 'x', stbStop: {} });
    const merged = reconcileBoard(
      { jnyL: [bare('N1'), bare('N2')], common: {} },
      { jnyL: [], common: { locL: [], prodL: [] } },
      720,
    );
    expect(merged.jnyL.length).toBe(2);
  });

  it('exercises every comparator arm with mixed null/timed entries', () => {
    const bare = (jid) => ({ jid, prodX: 0, dirTxt: 'x', stbStop: {} });
    // Timed entries are tail (Soll > now+120=840) so an empty push keeps them;
    // the null-eff entries are kept too (cs == null). The merge then sorts a
    // mix of null and timed effs, hitting every comparator arm.
    const merged = reconcileBoard(
      { jnyL: [bare('N1'), dep('A', 900), bare('N2'), dep('B', 880)], common: {} },
      { jnyL: [], common: { locL: [], prodL: [] } },
      720,
    );
    expect(merged.jnyL.slice(0, 2).map((j) => j.jid)).toEqual(['B', 'A']);
    expect(
      merged.jnyL
        .slice(2)
        .map((j) => j.jid)
        .sort(),
    ).toEqual(['N1', 'N2']);
  });

  it('remaps via every _entityKey arm (name fallback, lid fallback, null slot, negative locX)', () => {
    const merged = reconcileBoard(
      { jnyL: [], common: { locL: [], prodL: [] } },
      {
        jnyL: [
          dep('A', 726, { locX: 0, prodX: 0 }), // loc {extId:'', name:'S'} → e.name fallback
          dep('B', 727, { locX: 1, prodX: 0 }), // loc {lid:'X'} → e.lid fallback
          dep('C', 728, { locX: 2, prodX: 0 }), // undefined slot → _entityKey(undefined) === ''
          dep('D', 729, { locX: -1, prodX: 0 }), // locX < 0 → not remapped (90 >=0 arm)
        ],
        common: {
          locL: [{ extId: '', name: 'S' }, { lid: 'X' }, undefined],
          prodL: [{ nameS: '721' }],
        },
      },
      720,
    );
    expect(merged.jnyL.map((j) => j.jid)).toEqual(['A', 'B', 'C', 'D']);
    // D kept its negative locX (skipped remap).
    expect(merged.jnyL.find((j) => j.jid === 'D').stbStop.locX).toBe(-1);
  });

  it('remaps via the terminal _entityKey arms (all-falsy L key, P key with cls, out-of-range locX)', () => {
    const merged = reconcileBoard(
      { jnyL: [], common: { locL: [], prodL: [] } },
      {
        jnyL: [
          dep('A', 726, { locX: 0, prodX: 0 }), // loc {extId:''} → 'L:'+'' (|| '' arm); prod {cls:1} → cond-true
          dep('B', 727, { locX: 1, prodX: 1 }), // loc {name:'x'} → neither extId/lid in → 'P:'; prod {} → all-falsy
          dep('E', 728, { locX: 5, prodX: 0 }), // locX 5 >= length → not remapped (90 <length arm)
        ],
        common: {
          locL: [{ extId: '' }, { name: 'x' }],
          prodL: [{ cls: 1 }, {}],
        },
      },
      720,
    );
    expect(merged.jnyL.find((j) => j.jid === 'E').stbStop.locX).toBe(5); // out of range → untouched
  });
});

describe('computeInitialHorizon', () => {
  it('returns now+60 when the next departure is within the hour', () => {
    expect(computeInitialHorizon([dep('A', 740)], 720)).toBe(780); // 740 < 780 → now+60
  });
  it('stretches to the next departure when it lies beyond now+60', () => {
    expect(computeInitialHorizon([dep('A', 900)], 720)).toBe(900);
  });
  it('returns now+60 for an empty board', () => {
    expect(computeInitialHorizon([], 720)).toBe(780);
    expect(computeInitialHorizon(null, 720)).toBe(780);
  });
  it('ignores departures already in the past (e < now)', () => {
    expect(computeInitialHorizon([dep('A', 700)], 720)).toBe(780);
  });
  it('picks the earliest upcoming departure across several (e < next arm)', () => {
    expect(computeInitialHorizon([dep('A', 900), dep('B', 850)], 720)).toBe(850);
    expect(computeInitialHorizon([dep('A', 850), dep('B', 900)], 720)).toBe(850);
  });
});

describe('extendHorizon', () => {
  it('adds 60 min when a departure lies within the +60 step', () => {
    expect(extendHorizon([dep('A', 745)], 720)).toBe(780); // 745 <= 780 → +60
  });
  it('jumps to the next departure when +60 would reveal nothing', () => {
    expect(extendHorizon([dep('A', 900)], 720)).toBe(900);
  });
  it('adds 60 for an empty board', () => {
    expect(extendHorizon([], 720)).toBe(780);
  });
  it('ignores departures at or before the current horizon', () => {
    expect(extendHorizon([dep('A', 700)], 720)).toBe(780);
  });
  it('picks the earliest departure beyond the horizon across several (e < next arm)', () => {
    expect(extendHorizon([dep('A', 950), dep('B', 900)], 720)).toBe(900);
    expect(extendHorizon([dep('A', 900), dep('B', 950)], 720)).toBe(900);
  });
  it('tolerates a null jnyL (|| [] fallback)', () => {
    expect(extendHorizon(null, 720)).toBe(780);
  });
});

describe('hasBeyondHorizon', () => {
  it('is true when a departure lies past the horizon', () => {
    expect(hasBeyondHorizon([dep('A', 800)], 720)).toBe(true);
  });
  it('is false when every departure is at or before the horizon', () => {
    expect(hasBeyondHorizon([dep('A', 700)], 720)).toBe(false);
    expect(hasBeyondHorizon([{ stbStop: {} }], 720)).toBe(false); // null eff
  });
  it('tolerates a null jnyL (|| [] fallback)', () => {
    expect(hasBeyondHorizon(null, 720)).toBe(false);
  });
});

describe('sliceToHorizon', () => {
  it('keeps only entries with eff <= horizon (null eff excluded)', () => {
    const board = { jnyL: [dep('A', 700), dep('B', 800), { jid: 'N', stbStop: {} }], common: {} };
    const sliced = sliceToHorizon(board, 720);
    expect(sliced.jnyL.map((j) => j.jid)).toEqual(['A']);
  });
  it('tolerates a board with no jnyL', () => {
    expect(sliceToHorizon({}, 720).jnyL).toEqual([]);
  });
});
