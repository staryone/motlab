import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  assert.match(run('nope').stderr + run('nope').stdout, /unknown mode "nope" .* help or version/);
});

test('motlab version, --version and -v print the version from package.json and succeed', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const args of [['version'], ['--version'], ['-v']]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout.trim(), version, args.join(' '));
  }
});

test('motlab working checks its note and scene numbers before it looks for a viewer', () => {
  const r = run('working', 'example', '--note', '3,x');
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--note: "x" is not a note number/);
  assert.match(run('working').stderr + run('working').stdout, /working needs the project folder or project file/);
});
