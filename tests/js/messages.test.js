import { describe, it, expect } from 'vitest';
import { extractHafasMessages } from './utils.js';

describe('extractHafasMessages', () => {
  function makeCommon(remL, himL) {
    return { remL: remL || [], himL: himL || [] };
  }

  function makeMsg(type, opts) {
    return Object.assign({ type: type }, opts);
  }

  it('returns empty for null/undefined inputs', () => {
    expect(extractHafasMessages(null, null, null)).toEqual({ journeyLevel: [], perStopByLocX: {} });
    expect(extractHafasMessages(undefined, undefined, undefined)).toEqual({ journeyLevel: [], perStopByLocX: {} });
    expect(extractHafasMessages({}, [], [])).toEqual({ journeyLevel: [], perStopByLocX: {} });
  });

  it('filters IGNORE_CODES (ae, au, az, ai, ac, ib, ic) case-insensitive', () => {
    var codes = ['ae', 'au', 'az', 'ai', 'ac', 'ib', 'ic', 'AE', 'Au', 'IB'];
    var remL = codes.map(function(c) { return { code: c, txtN: 'text for ' + c }; });
    var msgL = codes.map(function(_, i) { return makeMsg('REM', { remX: i }); });
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('keeps visible codes (BE, BR, text, KB, s)', () => {
    var remL = [
      { code: 'BE', txtN: 'Behindertengerecht' },
      { code: 'BR', txtN: 'Rollstuhlplatz' },
      { code: 'text.journeystop.product.or.direction.changes.journey.message', txtN: 'Linienänderung' },
      { code: 'KB', txtN: 'Klimaanlage' },
    ];
    var msgL = remL.map(function(_, i) { return makeMsg('REM', { remX: i }); });
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(4);
    expect(result.journeyLevel[0].text).toBe('Behindertengerecht');
  });

  it('truncates txtN > 500 chars (trim before slice)', () => {
    var longText = '  ' + 'A'.repeat(600) + '  ';
    var remL = [{ code: 'BE', txtN: longText }];
    var msgL = [makeMsg('REM', { remX: 0 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel[0].text.length).toBe(500);
    expect(result.journeyLevel[0].text).toBe('A'.repeat(500));
  });

  it('treats fLocX < 0 as journeyLevel', () => {
    var remL = [{ code: 'BE', txtN: 'test' }];
    var msgL = [makeMsg('REM', { remX: 0, fLocX: -1, tLocX: 5 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, [{locX: 0}, {locX: 5}]);
    expect(result.journeyLevel).toHaveLength(1);
    expect(Object.keys(result.perStopByLocX)).toHaveLength(0);
  });

  it('treats fLocX > tLocX as journeyLevel', () => {
    var remL = [{ code: 'BE', txtN: 'test' }];
    var msgL = [makeMsg('REM', { remX: 0, fLocX: 5, tLocX: 2 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, [{locX: 0}, {locX: 10}]);
    expect(result.journeyLevel).toHaveLength(1);
  });

  it('Rundkurs: firstLocX === lastLocX → journeyLevel', () => {
    var remL = [{ code: 'BE', txtN: 'test' }];
    var stopL = [{locX: 3}, {locX: 5}, {locX: 3}];
    var msgL = [makeMsg('REM', { remX: 0, fLocX: 3, tLocX: 3 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, stopL);
    expect(result.journeyLevel).toHaveLength(1);
  });

  it('per-stop: scoped message placed at fLocX only', () => {
    var remL = [{ code: 'BE', txtN: 'platform change' }];
    var stopL = [{locX: 0}, {locX: 1}, {locX: 2}, {locX: 3}];
    var msgL = [makeMsg('REM', { remX: 0, fLocX: 1, tLocX: 2 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, stopL);
    expect(result.journeyLevel).toHaveLength(0);
    expect(result.perStopByLocX[1]).toHaveLength(1);
    expect(result.perStopByLocX[1][0].text).toBe('platform change');
  });

  it('dedup by code+text for journey-level', () => {
    var remL = [{ code: 'BE', txtN: 'same text' }];
    var msgL = [
      makeMsg('REM', { remX: 0 }),
      makeMsg('REM', { remX: 0 }),
    ];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(1);
  });

  it('dedup by code+text for per-stop', () => {
    var remL = [{ code: 'BE', txtN: 'same text' }];
    var stopL = [{locX: 0}, {locX: 5}];
    var msgL = [
      makeMsg('REM', { remX: 0, fLocX: 2, tLocX: 3 }),
      makeMsg('REM', { remX: 0, fLocX: 2, tLocX: 3 }),
    ];
    var result = extractHafasMessages(makeCommon(remL), msgL, stopL);
    expect(result.perStopByLocX[2]).toHaveLength(1);
  });

  it('HIM: extracts head text', () => {
    var himL = [{ head: 'Bauarbeiten Hauptstraße' }];
    var msgL = [makeMsg('HIM', { himX: 0 })];
    var result = extractHafasMessages(makeCommon([], himL), msgL, []);
    expect(result.journeyLevel).toHaveLength(1);
    expect(result.journeyLevel[0].text).toBe('Bauarbeiten Hauptstraße');
  });

  it('HIM: himX out of bounds → graceful skip', () => {
    var himL = [{ head: 'only one' }];
    var msgL = [makeMsg('HIM', { himX: 99 })];
    var result = extractHafasMessages(makeCommon([], himL), msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('HIM: common.himL missing → graceful skip', () => {
    var msgL = [makeMsg('HIM', { himX: 0 })];
    var result = extractHafasMessages({}, msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('REM: remX out of bounds → graceful skip', () => {
    var remL = [{ code: 'BE', txtN: 'only one' }];
    var msgL = [makeMsg('REM', { remX: 99 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('strips control characters (0x00-0x1F, 0x7F)', () => {
    var remL = [{ code: 'BE', txtN: 'Hello\x00World\x1F!\x7F' }];
    var msgL = [makeMsg('REM', { remX: 0 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel[0].text).toBe('Hello World !');
  });

  it('skips whitespace-only text', () => {
    var remL = [{ code: 'BE', txtN: '   \t  ' }];
    var msgL = [makeMsg('REM', { remX: 0 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('handles code: null and code: 0 without TypeError', () => {
    var remL = [
      { code: null, txtN: 'null code' },
      { code: 0, txtN: 'zero code' },
    ];
    var msgL = [makeMsg('REM', { remX: 0 }), makeMsg('REM', { remX: 1 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(2);
  });

  it('skips REM with no txtN', () => {
    var remL = [{ code: 'BE' }];
    var msgL = [makeMsg('REM', { remX: 0 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, []);
    expect(result.journeyLevel).toHaveLength(0);
  });

  it('journey-wide when fLocX <= firstLocX and tLocX >= lastLocX', () => {
    var remL = [{ code: 'BE', txtN: 'covers all' }];
    var stopL = [{locX: 2}, {locX: 3}, {locX: 4}, {locX: 8}];
    var msgL = [makeMsg('REM', { remX: 0, fLocX: 0, tLocX: 10 })];
    var result = extractHafasMessages(makeCommon(remL), msgL, stopL);
    expect(result.journeyLevel).toHaveLength(1);
    expect(Object.keys(result.perStopByLocX)).toHaveLength(0);
  });
});
