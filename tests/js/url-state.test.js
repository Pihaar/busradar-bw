import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { urlState } from '../../static/api.js';

describe('urlState.parse', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('returns empty for no hash', () => {
    window.location.hash = '';
    var result = urlState.parse();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns empty for hash > 2048 chars', () => {
    window.location.hash = '#jid=' + 'A'.repeat(2048);
    var result = urlState.parse();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('drops unknown keys', () => {
    window.location.hash = '#jid=123&unknown=foo&evil=bar';
    var result = urlState.parse();
    expect(result.jid).toBe('123');
    expect(result.unknown).toBeUndefined();
    expect(result.evil).toBeUndefined();
  });

  it('first key wins on duplicates', () => {
    window.location.hash = '#jid=first&jid=second';
    var result = urlState.parse();
    expect(result.jid).toBe('first');
  });

  it('accepts tab=dep and tab=arr', () => {
    window.location.hash = '#tab=dep';
    expect(urlState.parse().tab).toBe('dep');
    window.location.hash = '#tab=arr';
    expect(urlState.parse().tab).toBe('arr');
  });

  it('drops invalid tab values', () => {
    window.location.hash = '#tab=invalid';
    expect(urlState.parse().tab).toBeUndefined();
    window.location.hash = '#tab=DEP';
    expect(urlState.parse().tab).toBeUndefined();
  });

  it('handles malformed decodeURIComponent without throw', () => {
    window.location.hash = '#jid=%E0%A4%A';
    var result = urlState.parse();
    expect(result.jid).toBeUndefined();
  });

  it('drops values > 300 chars', () => {
    window.location.hash = '#jid=' + 'X'.repeat(301);
    var result = urlState.parse();
    expect(result.jid).toBeUndefined();
  });

  it('keeps values <= 300 chars', () => {
    window.location.hash = '#jid=' + 'X'.repeat(300);
    var result = urlState.parse();
    expect(result.jid).toBe('X'.repeat(300));
  });

  it('skips pairs without = or with = at position 0', () => {
    window.location.hash = '#noequals&=nokey&jid=valid';
    var result = urlState.parse();
    expect(result.jid).toBe('valid');
    expect(Object.keys(result)).toHaveLength(1);
  });
});

describe('urlState.buildShareHash', () => {
  it('builds jid-only hash', () => {
    var result = urlState.buildShareHash({ jid: '1|123|0|80|20260523' });
    expect(result).toBe('#jid=1%7C123%7C0%7C80%7C20260523');
  });

  it('builds stop+tab hash', () => {
    var result = urlState.buildShareHash({ stop: '6003411', tab: 'dep' });
    expect(result).toBe('#stop=6003411&tab=dep');
  });

  it('builds stop+tab=arr hash', () => {
    var result = urlState.buildShareHash({ stop: '6003411', tab: 'arr' });
    expect(result).toBe('#stop=6003411&tab=arr');
  });

  it('ignores invalid tab values', () => {
    var result = urlState.buildShareHash({ stop: '6003411', tab: 'invalid' });
    expect(result).toBe('#stop=6003411');
  });

  it('jid wins over stop (else branch)', () => {
    var result = urlState.buildShareHash({ jid: 'J1', stop: 'S1', tab: 'dep' });
    expect(result).toBe('#jid=J1');
    expect(result).not.toContain('stop');
    expect(result).not.toContain('tab');
  });

  it('empty opts returns bare #', () => {
    var result = urlState.buildShareHash({});
    expect(result).toBe('#');
  });
});

describe('urlState.push', () => {
  beforeEach(() => {
    urlState._pushCount = 0;
  });

  it('calls history.pushState and increments _pushCount', () => {
    var spy = vi.spyOn(window.history, 'pushState');
    urlState.push({ jid: 'test123' });
    expect(spy).toHaveBeenCalledOnce();
    expect(urlState._pushCount).toBe(1);
    spy.mockRestore();
  });

  it('only includes URL_SCHEMA keys in hash', () => {
    var spy = vi.spyOn(window.history, 'pushState');
    urlState.push({ jid: 'J', evil: 'hack', lat: '49.3' });
    var call = spy.mock.calls[0];
    expect(call[2]).toContain('jid=J');
    expect(call[2]).toContain('lat=49.3');
    expect(call[2]).not.toContain('evil');
    spy.mockRestore();
  });
});

describe('urlState.replace', () => {
  it('calls history.replaceState', () => {
    var spy = vi.spyOn(window.history, 'replaceState');
    urlState.replace({ lat: '49.3', lon: '8.6', z: '14' });
    expect(spy).toHaveBeenCalledOnce();
    var call = spy.mock.calls[0];
    expect(call[2]).toContain('lat=49.3');
    expect(call[2]).toContain('lon=8.6');
    expect(call[2]).toContain('z=14');
    spy.mockRestore();
  });
});
