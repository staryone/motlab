import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('motlab depth checks its images before it starts Chrome', () => {
  const none = run('depth');
  assert.equal(none.status, 1);
  assert.match(none.stderr + none.stdout, /depth needs one or more images/);
  const text = run('depth', 'README.md');
  assert.equal(text.status, 1);
  assert.match(text.stderr + text.stdout, /README\.md: a depth map needs a JPEG, PNG, WebP, AVIF or BMP image/);
});

test('motlab working checks its note and scene numbers before it looks for a viewer', () => {
  const r = run('working', 'example', '--note', '3,x');
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--note: "x" is not a note number/);
  assert.match(run('working').stderr + run('working').stdout, /working needs the project folder or project file/);
});

test('motlab restart leaves the domain viewer running when the password is invalid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'motlab-viewer-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const password = 'sample-test-password', domain = 'viewer.example.com';
  delete env.MOTLAB_VIEWER_PASSWORD;
  const control = (args, vars = env) => spawnSync(process.execPath, [bin, ...args], { cwd: home, env: vars, encoding: 'utf8' });
  let url;
  try {
    const started = control(['start', '--domain', domain], { ...env, MOTLAB_VIEWER_PASSWORD: password });
    assert.equal(started.status, 0, started.stderr);
    url = started.stdout.match(/^Viewer: (http:\/\/127\.0\.0\.1:\d+) and https:/)?.[1];
    assert.ok(url, started.stdout);
    const tokenFile = join(home, '.motlab', 'viewer-token');
    const viewer = async () => (await fetch(`${url}/__motlab/editor`, {
      headers: { Connection: 'close', 'x-motlab-token': readFileSync(tokenFile, 'utf8') },
      signal: AbortSignal.timeout(3000),
    })).json();
    const before = await viewer();
    assert.equal(before.domain, domain);
    assert.ok(before.pid);
    for (const vars of [env, { ...env, MOTLAB_VIEWER_PASSWORD: 'too short' }]) {
      const restarted = control(['restart'], vars);
      assert.equal(restarted.status, 1, restarted.stderr);
      assert.match(restarted.stderr, /MOTLAB_VIEWER_PASSWORD.*at least 12 characters/);
      assert.doesNotMatch(restarted.stdout, /Stopped the viewer/);
      assert.deepEqual(await viewer(), before);
    }
    const restarted = control(['restart'], { ...env, MOTLAB_VIEWER_PASSWORD: password });
    assert.equal(restarted.status, 0, restarted.stderr);
    const after = await viewer();
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.domain, before.domain);
    assert.equal(after.workspace, before.workspace);
  } finally {
    if (url) control(['stop']);
    rmSync(home, { recursive: true, force: true });
  }
});
