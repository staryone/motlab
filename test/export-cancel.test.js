import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { renderVideo } from '../src/render.js';

test('viewer cancellation releases a scene waiting for ready before accepting another export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-cancel-'));
  let reached;
  const ready = new Promise(r => { reached = r; });
  const marker = createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.end(); reached(); });
  await new Promise(r => marker.listen(0, '127.0.0.1', r));
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ fps: 1, scenes: ['scene.html'] }));
  writeFileSync(join(dir, 'scene.html'), `<canvas id="c" width="64" height="64"></canvas><script>
    window.TOTAL = 1; window.renderAt = () => {};
    window.ready = fetch('http://127.0.0.1:${marker.address().port}/ready').then(() => new Promise(r => setTimeout(r, 8000)));
  </script>`);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { startEditor } from ${JSON.stringify(new URL('../src/editor.js', import.meta.url).href)}; startEditor(${JSON.stringify(dir)}, ${port});`],
  { env: { ...process.env, MOTLAB_CACHE_DIR: join(dir, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', d => { logs += d; });
  try {
    await new Promise((ok, no) => {
      const timeout = setTimeout(() => no(new Error(logs || 'viewer did not start')), 10000);
      child.stdout.on('data', d => { logs += d; if (logs.includes('Editor:')) { clearTimeout(timeout); ok(); } });
    });
    const viewer = await fetch(`${base}/p/${basename(dir).toLowerCase()}/`);
    assert.equal(viewer.status, 200);
    const post = path => fetch(base + path, { method: 'POST', body: JSON.stringify({ scale: 1, tag: 'cancel', parallel: 1 }) });
    const path = `/p/${basename(dir).toLowerCase()}/export`;
    const first = await post(path), finished = first.text();
    await Promise.race([ready, new Promise((_, no) => { const t = setTimeout(() => no(new Error('scene did not reach ready')), 15000); t.unref(); })]);
    const start = performance.now();
    const cancelled = await post('/export/cancel');
    const cancelMs = performance.now() - start;
    const next = await post(path);
    const nextMs = performance.now() - start;
    const text = await finished, releaseMs = performance.now() - start;
    if (next.status === 200) { await post('/export/cancel'); await next.text(); }
    else await next.text();
    assert.match(text, /CANCELLED/);
    assert.ok(releaseMs < 2000, `cancel took ${releaseMs.toFixed(0)} ms to release`);
    assert.equal(next.status, 200, 'follow-up export must not be busy after cancel responds');
    assert.equal((await post('/export/cancel')).status, 204, 'cancel without a job is harmless');
  } finally {
    child.kill();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    await new Promise(r => marker.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup cancellation handles multiple workers, missing contract and an already aborted signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-cancel-workers-'));
  const page = join(dir, 'scene.html'), out = join(dir, 'out.mp4');
  const controller = new AbortController();
  let arrivals = 0;
  const marker = createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.end(); if (++arrivals === 2) controller.abort(); });
  await new Promise(r => marker.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(page, `<script>fetch('http://127.0.0.1:${marker.address().port}/');</script>`);
    const start = performance.now();
    await assert.rejects(renderVideo({ page, out, workers: 2, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(performance.now() - start < 5000, 'both workers must stop without waiting for the contract timeout');
    await assert.rejects(renderVideo({ page, out, signal: controller.signal }), { name: 'AbortError' });
    writeFileSync(page, '<script>window.renderAt = () => {}; window.ready = Promise.reject(new Error("ready failed"));</script>');
    await assert.rejects(renderVideo({ page, out }), /ready failed/);
  } finally { await new Promise(r => marker.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
