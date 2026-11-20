import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/motlab.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('motlab help, --help and -h print the commands and succeed; no command prints them and fails', () => {
  for (const args of [['help'], ['--help'], ['-h']]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /motlab render <project>/);
    assert.match(r.stdout, /Engine folder: /);
  }
  assert.equal(run().status, 1);
  assert.match(run('nope').stderr + run('nope').stdout, /unknown mode "nope" .* or help/);
});
