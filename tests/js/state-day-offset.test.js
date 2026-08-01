/**
 * Unit coverage for the day-offset helpers added to static/state.js:
 * dateDiffDays (validated YYYYMMDD difference), serverNowMinRel (now lifted into
 * the board's service-date frame) and the bounded _pushHorizonLog ring.
 *
 * derivedServerNowMin is pinned deterministically by setting serverTimeStamp = 0
 * (falsy → the elapsed-ms term is 0), so serverNowMinRel is exact, no fake timers.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const { state, dateDiffDays, serverNowMinRel, _pushHorizonLog } =
  await import('../../static/state.js');

describe('dateDiffDays', () => {
  it('is zero for identical dates', () => {
    expect(dateDiffDays('20260801', '20260801')).toBe(0);
  });
  it('counts whole days forward (to - from), incl. month/year rollover', () => {
    expect(dateDiffDays('20260801', '20260802')).toBe(1);
    expect(dateDiffDays('20260801', '20260803')).toBe(2);
    expect(dateDiffDays('20260131', '20260201')).toBe(1); // month rollover
    expect(dateDiffDays('20261231', '20270101')).toBe(1); // year rollover
  });
  it('is negative when to precedes from', () => {
    expect(dateDiffDays('20260802', '20260801')).toBe(-1);
  });
  it('returns 0 when the FROM argument is malformed (validation arm)', () => {
    expect(dateDiffDays('99999999', '20260801')).toBe(0);
    expect(dateDiffDays('2026080', '20260801')).toBe(0); // 7 digits
    expect(dateDiffDays('abcdefgh', '20260801')).toBe(0);
    expect(dateDiffDays(null, '20260801')).toBe(0);
  });
  it('returns 0 when the TO argument is malformed (second validation arm)', () => {
    expect(dateDiffDays('20260801', '99999999')).toBe(0);
    expect(dateDiffDays('20260801', '00000000')).toBe(0);
    expect(dateDiffDays('20260801', '20261302')).toBe(0); // month 13
    expect(dateDiffDays('20260801', '20260800')).toBe(0); // day 0
    expect(dateDiffDays('20260801', undefined)).toBe(0);
  });
  it('returns 0 when BOTH are malformed', () => {
    expect(dateDiffDays('xx', 'yy')).toBe(0);
  });
  it('rejects years outside 2000-2100 (structural range)', () => {
    expect(dateDiffDays('20260801', '19991231')).toBe(0);
    expect(dateDiffDays('20260801', '21010101')).toBe(0);
  });
});

describe('serverNowMinRel', () => {
  beforeEach(() => {
    state.serverTimeMin = null;
    state.serverTimeStamp = 0; // falsy → derivedServerNowMin adds no elapsed ms
    state.serverDate = null;
  });
  it('is null when there is no server clock yet', () => {
    expect(serverNowMinRel('20260801')).toBeNull();
  });
  it('falls back to plain minute-of-day when serverDate is unknown', () => {
    state.serverTimeMin = 720;
    expect(serverNowMinRel('20260801')).toBe(720);
  });
  it('falls back to plain minute-of-day when baseDate is missing', () => {
    state.serverTimeMin = 720;
    state.serverDate = '20260801';
    expect(serverNowMinRel(null)).toBe(720);
  });
  it('equals minute-of-day when the board date is today', () => {
    state.serverTimeMin = 720;
    state.serverDate = '20260801';
    expect(serverNowMinRel('20260801')).toBe(720);
  });
  it('lifts now by +1440 when the board date is yesterday (post-midnight)', () => {
    // sD = yesterday, serverDate = today → now is one day ahead in the sD-frame.
    state.serverTimeMin = 1;
    state.serverDate = '20260802';
    expect(serverNowMinRel('20260801')).toBe(1 + 1440);
  });
  it('clamps the day gap to 2 for an implausibly stale/corrupt board date', () => {
    // serverDate 9 days after sD → clamped to 2 so a corrupt sD cannot throw the
    // anchor astronomically off (mirrors entryDateShiftDays [0,2]).
    state.serverTimeMin = 720;
    state.serverDate = '20260810';
    expect(serverNowMinRel('20260801')).toBe(720 + 2 * 1440);
  });
  it('pins the upper clamp edge: 2 days is NOT clamped, 3 days IS', () => {
    state.serverTimeMin = 720;
    state.serverDate = '20260803'; // exactly +2 → unchanged
    expect(serverNowMinRel('20260801')).toBe(720 + 2 * 1440);
    state.serverDate = '20260804'; // +3 → first clamped value (still 2)
    expect(serverNowMinRel('20260801')).toBe(720 + 2 * 1440);
  });
  it('clamps a negative gap (board date after server date) to 0', () => {
    state.serverTimeMin = 720;
    state.serverDate = '20260731'; // serverDate before sD → dateDiffDays -1 → max(0,-1)=0
    expect(serverNowMinRel('20260801')).toBe(720);
  });
});

describe('_pushHorizonLog', () => {
  beforeEach(() => {
    state._boardHorizonLog = [];
  });
  it('appends entries in order', () => {
    _pushHorizonLog({ cause: 'a' });
    _pushHorizonLog({ cause: 'b' });
    expect(state._boardHorizonLog.map((e) => e.cause)).toEqual(['a', 'b']);
  });
  it('drops the oldest once past the ring cap (FIFO, stable length)', () => {
    for (let i = 0; i < 35; i++) _pushHorizonLog({ n: i });
    expect(state._boardHorizonLog.length).toBe(30);
    expect(state._boardHorizonLog[0].n).toBe(5); // 0..4 dropped
    expect(state._boardHorizonLog[29].n).toBe(34);
  });
});
