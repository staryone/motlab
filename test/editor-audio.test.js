import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('viewer: audio requests preserve filename characters and folder separators', async () => {
  const html = readFileSync(new URL('../src/editor.html', import.meta.url), 'utf8');
  const start = html.indexOf('const tracks = await Promise.all(files.map');
  const src = html.slice(start, html.indexOf('\n\n  const view =', start));
  for (const file of ['voice.wav', 'voice #1.wav', 'takes #1/voice %23.wav', 'takes #1\\voice %23.wav', 'voice ?2.wav']) {
    let url;
    const tracks = await runInNewContext(`(async () => { ${src}; return tracks; })()`, {
      files: [{ file }],
      fetch: async path => {
        url = new URL(path, 'http://localhost/p/project/');
        return { arrayBuffer: async () => new ArrayBuffer(0) };
      },
      ac: { decodeAudioData: async () => ({ duration: 1, getChannelData: () => [] }) },
      PEAKS: 1,
    });
    assert.equal(decodeURIComponent(url.pathname), `/p/project/${file.replaceAll('\\', '/')}`);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(tracks[0].file, file);
  }
});
