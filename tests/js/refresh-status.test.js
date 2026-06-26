import { describe, it } from 'vitest';

// The polling-to-SSE switch replaced the polling loop with EventSource.
// The 49 polling-loop tests in the previous version of this file targeted
// API surface that no longer exists (scheduleRefresh, state._nextFreshDataIn,
// state.consecutiveErrors as a polling driver). A future cleanup commit will
// delete the file outright. Until then the suite is parked with a stable
// reason string so it stays visible in test output.
describe.skip('refresh.js polling loop — deprecated since the polling-to-SSE switch', () => {
  it('placeholder so vitest still discovers the suite', () => {});
});
