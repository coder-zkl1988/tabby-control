import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTaskRequestTimeoutMs } from '../scripts/release-gate-timeouts.mjs';

test('uses a transport deadline beyond the default inactivity timeout', () => {
  assert.equal(resolveTaskRequestTimeoutMs({ task: {} }), 330_000);
});

test('keeps the transport deadline above a longer inactivity timeout', () => {
  assert.equal(
    resolveTaskRequestTimeoutMs({ task: { timeoutMs: 600_000 } }),
    630_000,
  );
});

test('keeps the legacy floor for short task timeouts', () => {
  assert.equal(
    resolveTaskRequestTimeoutMs({ task: { timeoutMs: 120_000 } }),
    300_000,
  );
});

test('honors an explicit scenario wall-clock timeout', () => {
  assert.equal(
    resolveTaskRequestTimeoutMs({
      requestTimeoutMs: 1_200_000,
      task: { timeoutMs: 600_000 },
    }),
    1_200_000,
  );
});
