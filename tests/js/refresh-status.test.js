import { describe, it } from 'vitest';

// Iter 2a of the SSE migration replaced the polling loop with EventSource.
// The 49 polling-loop tests in the previous version of this file targeted
// API surface that no longer exists (scheduleRefresh, state._nextFreshDataIn,
// state.consecutiveErrors as a polling driver). Iter 2b will delete the file
// outright. Until then the suite is parked with a stable reason string so
// PIV can spot it.
describe.skip('refresh.js polling loop — deprecated in iter 2a (SSE migration)', () => {
  it('placeholder so vitest still discovers the suite', () => {});
});
