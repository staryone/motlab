import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { renderVideo } from '../src/render.js';

function within(promise, ms, message) {
  const { promise: deadline, reject } = Promise.withResolvers();
  const timer = setTimeout(reject, ms, new Error(message));
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const closeMarker = marker => new Promise(r => { marker.close(r); marker.closeAllConnections(); });

test('viewer cancellation releases a scene waiting for ready before accepting another export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-cancel-'));
  const { promise: waiting, resolve: reached } = Promise.withResolvers();
  // Leave the response pending so window.ready cannot finish on its own.
  const marker = createServer(() => reached());
  await new Promise(r => marker.listen(0, '127.0.0.1', r));
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ fps: 1, scenes: ['scene.html'] }));
  writeFileSync(join(dir, 'scene.html'), `<canvas id="c" width="64" height="64"></canvas><script>
    window.TOTAL = 1; window.renderAt = () => {};
    window.ready = { then(resolve, reject) { fetch('http://127.0.0.1:${marker.address().port}/ready').then(resolve, reject); } };
  </script>`);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { startEditor } from ${JSON.stringify(new URL('../src/editor.js', import.meta.url).href)}; startEditor(${JSON.stringify(dir)}, ${port}); process.on('disconnect', () => process.exit());`],
  { env: { ...process.env, MOTLAB_CACHE_DIR: join(dir, 'cache') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  child.stderr.on('data', d => { logs += d; });
  try {
    await new Promise((ok, no) => {
      const timeout = setTimeout(() => no(new Error(logs || 'viewer did not start')), 10000);
      child.stdout.on('data', d => { logs += d; if (logs.includes('Editor:')) { clearTimeout(timeout); ok(); } });
    });
    const viewer = await fetch(`${base}/p/${basename(dir).toLowerCase()}/`);
    assert.equal(viewer.status, 200);
    const post = (path, ms = 15000) => fetch(base + path, {
      method: 'POST', body: JSON.stringify({ scale: 1, tag: 'cancel', parallel: 1 }), signal: AbortSignal.timeout(ms),
    });
    const path = `/p/${basename(dir).toLowerCase()}/export`;
    const first = await post(path, 45000);
    assert.equal(first.status, 200);
    await within(waiting, 15000, 'scene did not reach ready');
    assert.equal((await post('/export/cancel')).status, 204);
    const next = await post(path);
    assert.equal(next.status, 200, 'follow-up export must not be busy after cancel responds');
    assert.match(await first.text(), /CANCELLED/);
    assert.equal((await post('/export/cancel')).status, 204);
    assert.match(await next.text(), /CANCELLED/);
    assert.equal((await post('/export/cancel')).status, 204, 'cancel without a job is harmless');
  } finally {
    if (child.connected) child.disconnect();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    await closeMarker(marker);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup cancellation handles multiple workers, missing contract and an already aborted signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-cancel-workers-'));
  const page = join(dir, 'scene.html'), out = join(dir, 'out.mp4');
  const controller = new AbortController();
  let arrivals = 0;
  // A blocked script keeps the document loading while both workers are cancelled.
  const marker = createServer(() => { if (++arrivals === 2) controller.abort(); });
  await new Promise(r => marker.listen(0, '127.0.0.1', r));
  let rendering;
  try {
    writeFileSync(page, `<script src="http://127.0.0.1:${marker.address().port}/waiting.js"></script>`);
    rendering = renderVideo({ page, out, workers: 2, signal: controller.signal });
    await assert.rejects(within(rendering, 30000, 'both workers must stop without waiting for the contract timeout'), { name: 'AbortError' });
    await assert.rejects(renderVideo({ page, out, signal: controller.signal }), { name: 'AbortError' });
    writeFileSync(page, '<script>window.renderAt = () => {}; window.ready = Promise.reject(new Error("ready failed"));</script>');
    await assert.rejects(renderVideo({ page, out }), /ready failed/);
  } finally {
    await closeMarker(marker);
    await rendering?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
