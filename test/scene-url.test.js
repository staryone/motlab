import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('viewer: scene iframe URLs preserve path segments and the scale query', async () => {
  const html = readFileSync(new URL('../src/editor.html', import.meta.url), 'utf8');
  const start = html.indexOf('async function openPage(file, limit)');
  const src = html.slice(start, html.indexOf('\n  const trim =', start));
  for (const file of ['scene.html', 'scenes #1/scene #2.html', 'scene ?2.html', 'scene %23.html', 'scene space.html']) {
    const canvas = {}, frame = { contentWindow: { document: { getElementById: () => canvas }, renderAt() {}, TOTAL: 1, ready: Promise.resolve() } };
    const open = runInNewContext(`(${src})`, {
      document: { createElement: () => frame },
      $: () => ({ append: () => queueMicrotask(() => frame.onload()) }),
    });
    assert.equal((await open(file)).canvas, canvas);
    const url = new URL(frame.src, 'http://localhost/p/project/');
    assert.equal(decodeURIComponent(url.pathname), `/p/project/${file}`);
    assert.equal(url.search, '?scale=1');
    assert.equal(url.hash, '');
  }
});
