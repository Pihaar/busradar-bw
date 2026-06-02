import { describe, it, expect } from 'vitest';
import {
  formatTime,
  getDayOffset,
  parseHafasTimeToMin,
  calcDelay,
  parseCoord,
  parseZoom,
} from './utils.js';

describe('formatTime', () => {
  it('formats normal HHMMSS', () => {
    expect(formatTime('134500')).toBe('13:45');
    expect(formatTime('083000')).toBe('8:30');
    expect(formatTime('000000')).toBe('0:00');
  });

  it('formats HHMM (4 chars)', () => {
    expect(formatTime('1345')).toBe('13:45');
  });

  it('handles next-day offset prefix', () => {
    expect(formatTime('01000200')).toBe('0:02');
    expect(formatTime('01234500')).toBe('23:45');
  });

  it('handles multi-day offset prefix', () => {
    expect(formatTime('02010000')).toBe('1:00');
    expect(formatTime('02250000')).toBe('1:00');
  });

  it('handles h=25 (bare, no prefix)', () => {
    expect(formatTime('250000')).toBe('1:00');
  });

  it('handles h=48 (bare)', () => {
    expect(formatTime('480000')).toBe('0:00');
  });

  it('rejects short strings', () => {
    expect(formatTime('')).toBe('');
    expect(formatTime('12')).toBe('');
    expect(formatTime('123')).toBe('');
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
  });

  it('rejects non-numeric', () => {
    expect(formatTime('ABCDEF')).toBe('');
    expect(formatTime('XX0000')).toBe('');
  });
});

describe('getDayOffset', () => {
  it('returns 0 for normal times', () => {
    expect(getDayOffset('134500')).toBe(0);
    expect(getDayOffset('230000')).toBe(0);
  });

  it('detects offset prefix', () => {
    expect(getDayOffset('01134500')).toBe(1);
    expect(getDayOffset('02134500')).toBe(2);
  });

  it('detects bare h>=24', () => {
    expect(getDayOffset('250000')).toBe(1);
    expect(getDayOffset('480000')).toBe(2);
  });

  it('returns 0 for null/empty', () => {
    expect(getDayOffset(null)).toBe(0);
    expect(getDayOffset('')).toBe(0);
    expect(getDayOffset(undefined)).toBe(0);
  });

  it('returns 0 for non-numeric prefix', () => {
    expect(getDayOffset('XX134500')).toBe(0);
  });
});

describe('parseHafasTimeToMin', () => {
  it('parses normal HHMMSS', () => {
    expect(parseHafasTimeToMin('134500')).toBe(13 * 60 + 45);
    expect(parseHafasTimeToMin('000000')).toBe(0);
    expect(parseHafasTimeToMin('235900')).toBe(23 * 60 + 59);
  });

  it('parses HHMM (4 chars)', () => {
    expect(parseHafasTimeToMin('1345')).toBe(13 * 60 + 45);
  });

  it('parses offset prefix', () => {
    expect(parseHafasTimeToMin('01000200')).toBe(24 * 60 + 2);
    expect(parseHafasTimeToMin('01234500')).toBe((23 + 24) * 60 + 45);
    expect(parseHafasTimeToMin('02010000')).toBe((1 + 48) * 60 + 0);
  });

  it('returns null for short strings', () => {
    expect(parseHafasTimeToMin('')).toBeNull();
    expect(parseHafasTimeToMin('12')).toBeNull();
    expect(parseHafasTimeToMin('123')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseHafasTimeToMin(null)).toBeNull();
    expect(parseHafasTimeToMin(undefined)).toBeNull();
  });

  it('returns null for non-numeric', () => {
    expect(parseHafasTimeToMin('ABCDEF')).toBeNull();
    expect(parseHafasTimeToMin('1X3000')).toBeNull();
    expect(parseHafasTimeToMin('XX134500')).toBeNull();
  });
});

describe('calcDelay', () => {
  it('computes positive delay', () => {
    expect(calcDelay('134500', '134800')).toBe(3);
  });

  it('computes negative delay (early)', () => {
    expect(calcDelay('134500', '134200')).toBe(-3);
  });

  it('computes zero delay', () => {
    expect(calcDelay('134500', '134500')).toBe(0);
  });

  it('handles midnight wraparound (delay)', () => {
    expect(calcDelay('235900', '000100')).toBe(2);
  });

  it('handles midnight wraparound (early)', () => {
    expect(calcDelay('000100', '235900')).toBe(-2);
  });

  it('returns null for missing input', () => {
    expect(calcDelay(null, '134500')).toBeNull();
    expect(calcDelay('134500', null)).toBeNull();
    expect(calcDelay(null, null)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(calcDelay('XX0000', '134500')).toBeNull();
  });
});

describe('parseCoord', () => {
  it('parses valid coordinates', () => {
    expect(parseCoord('49.342', -90, 90)).toBe(49.342);
    expect(parseCoord('-8.66', -180, 180)).toBe(-8.66);
    expect(parseCoord('0', -90, 90)).toBe(0);
  });

  it('rejects out-of-range', () => {
    expect(parseCoord('91', -90, 90)).toBeNull();
    expect(parseCoord('-91', -90, 90)).toBeNull();
    expect(parseCoord('181', -180, 180)).toBeNull();
  });

  it('rejects Infinity/NaN', () => {
    expect(parseCoord('Infinity', -90, 90)).toBeNull();
    expect(parseCoord('NaN', -90, 90)).toBeNull();
    expect(parseCoord('-Infinity', -90, 90)).toBeNull();
  });

  it('rejects empty/whitespace', () => {
    expect(parseCoord('', -90, 90)).toBeNull();
    expect(parseCoord('  ', -90, 90)).toBeNull();
    expect(parseCoord(null, -90, 90)).toBeNull();
  });

  it('rejects trailing garbage', () => {
    expect(parseCoord('49.3abc', -90, 90)).toBeNull();
    expect(parseCoord('1e999', -90, 90)).toBeNull();
  });

  it('accepts zero (equator)', () => {
    expect(parseCoord('0', -90, 90)).toBe(0);
    expect(parseCoord('0.0', -180, 180)).toBe(0);
  });
});

describe('parseZoom', () => {
  it('parses valid zoom levels', () => {
    expect(parseZoom('1')).toBe(1);
    expect(parseZoom('14')).toBe(14);
    expect(parseZoom('19')).toBe(19);
  });

  it('rejects out-of-range', () => {
    expect(parseZoom('0')).toBeNull();
    expect(parseZoom('20')).toBeNull();
    expect(parseZoom('-1')).toBeNull();
  });

  it('rejects fractional', () => {
    expect(parseZoom('14.5')).toBeNull();
  });

  it('accepts 14.0 (isInteger)', () => {
    expect(parseZoom('14.0')).toBe(14);
  });

  it('rejects empty/null', () => {
    expect(parseZoom('')).toBeNull();
    expect(parseZoom(null)).toBeNull();
    expect(parseZoom('  ')).toBeNull();
  });

  it('rejects hex', () => {
    expect(parseZoom('0x10')).toBeNull();
  });

  it('rejects scientific notation out of range', () => {
    expect(parseZoom('2e1')).toBeNull();
  });
});
