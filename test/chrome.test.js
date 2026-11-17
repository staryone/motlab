// Chrome's launch flags: --no-sandbox is added when, and only when, motlab
// runs as root, because Chrome refuses to start as root without it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SANDBOX_FLAGS } from '../src/chrome.js';

test('--no-sandbox is passed exactly when running as root', () => {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  assert.deepEqual(SANDBOX_FLAGS, root ? ['--no-sandbox'] : []);
});
