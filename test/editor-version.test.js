import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachPage, findChrome, launchChrome } from '../src/chrome.js';

// The time limit covers starting Chrome and the viewer and loading the page. On CI's Windows runner the whole test took
// 9 to 22 s on ten runs on 2026-11-27 and passed 30 s twice, with no change to what it checks, so it has room to 90 s.
test('the viewer loads an existing version with an apostrophe in its filename', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-editor-')), name = 'demo &amp; team', root = join(dir, name);
  const file = "project-client's.json";
  let child, chrome;
  try {
    mkdirSync(root);
    copyFileSync(new URL('./fixtures/basic.html', import.meta.url), join(root, 'scene.html'));
    writeFileSync(join(root, 'project.json'), JSON.stringify({ fps: 30, scenes: [] }));
    writeFileSync(join(root, file), JSON.stringify({ fps: 30, scenes: ['scene.html'] }));
    const editor = new URL('../src/editor.js', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      import { startEditor } from ${JSON.stringify(editor)};
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => startEditor(process.argv[1], port));
      });
    `, join(root, file)], { cwd: root, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', d => { output += d; const m = /Editor: (http:\/\/\S+)  \(/.exec(output); if (m) resolve(m[1]); });
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`editor exited: ${code}`)));
    });
    chrome = await launchChrome({ chromePath: findChrome() });
    const page = await attachPage(chrome);
    // The viewer's Google Fonts stylesheet holds back the load event; on CI that host took up to the whole timeout.
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] });
    const loaded = new Promise(resolve => chrome.on('Page.loadEventFired', resolve));
    await page.navigate(url);
    await loaded;
    assert.deepEqual(page.errors, []);
    const length = await page.evaluate(`(async () => {
      const len = document.querySelector('#len'), deadline = performance.now() + 10000;
      while (len.textContent === '00:00.00' && performance.now() < deadline)
        await new Promise(resolve => requestAnimationFrame(resolve));
      return len.textContent;
    })()`);
    assert.deepEqual(page.errors, []);
    assert.equal(length, '00:01.00');
    assert.equal(await page.evaluate('document.title'), `${name} / client's · motlab`);
  } finally {
    if (chrome) await chrome.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
