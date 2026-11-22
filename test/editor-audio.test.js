import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { attachPage, findChrome, launchChrome } from '../src/chrome.js';

test('viewer loads audio files with hashes and preserves folder separators', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-editor-audio-'));
  let child, chrome;
  try {
    const files = ['voice.wav', 'voice #1.wav', 'takes #1/voice %23.wav', 'takes #1\\voice %23.wav'];
    mkdirSync(join(dir, 'takes #1'));
    const wav = new URL('../example/audio/tik.wav', import.meta.url);
    for (const file of files.slice(0, 3)) copyFileSync(wav, join(dir, file));
    writeFileSync(join(dir, 'project.json'), JSON.stringify({
      fps: 24, scenes: ['scene.html'], audio: files.map(file => ({ file })),
    }));
    writeFileSync(join(dir, 'scene.html'), `<canvas id="c" width="64" height="64"></canvas><script>
      window.TOTAL = 1; window.ready = Promise.resolve(); window.renderAt = () => {};
    </script>`);

    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const editor = new URL('../src/editor.js', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { startEditor } from ${JSON.stringify(editor)}; await startEditor('.', ${port});`],
    { cwd: dir, env: { ...process.env, HOME: dir, USERPROFILE: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const url = output.toString().match(/Editor: (http:\/\/\S+)/)?.[1];
    assert.ok(url, 'viewer did not print a URL');

    chrome = await launchChrome({ chromePath: findChrome(), extraArgs: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND'] });
    const page = await attachPage(chrome);
    await page.navigate(url);
    let state;
    const deadline = Date.now() + 15000;
    do {
      state = await page.evaluate(`({
        tracks: document.querySelectorAll('#audio .row').length,
        visible: document.getElementById('view')?.hidden === false,
        message: document.getElementById('msg')?.textContent
      })`);
      if (state.tracks || page.errors.length) break;
      await setTimeout(50);
    } while (Date.now() < deadline);
    assert.equal(state.tracks, files.length, page.errors.join('\n') || state.message);
    assert.equal(state.visible, true);
    assert.deepEqual(page.errors, []);
  } finally {
    await chrome?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
