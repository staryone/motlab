// End to end: needs Chrome and ffmpeg. A page plays an Aseprite-style sprite sheet and draws a sprite stack through
// /__motlab/sprite.js, and the stills show the right frame and the slices in their places.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { renderStills } from '../src/render.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-sprite-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');
after(() => rmSync(dir, { recursive: true, force: true }));

function meanRgb(file, crop) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${crop},scale=1:1:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  return [...r.stdout.subarray(0, 3)];
}

test('a sprite sheet shows the frame its tag plays at t, and a stack draws its slices one above another', async () => {
  // sheet.png: a red frame and a blue one, 16 x 16 each, side by side; sheet.json as Aseprite writes it (hash form).
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16',
    '-filter_complex', 'hstack', '-frames:v', '1', '-y', join(dir, 'sheet.png')]);
  assert.equal(made.status, 0, String(made.stderr));
  const frame = x => ({ frame: { x, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 }, duration: 500 });
  writeFileSync(join(dir, 'sheet.json'), JSON.stringify({ frames: { 'a 0.aseprite': frame(0), 'a 1.aseprite': frame(16) },
    meta: { image: 'sheet.png', size: { w: 32, h: 16 }, frameTags: [{ name: 'blue', from: 1, to: 1, direction: 'forward' }] } }));
  writeFileSync(join(dir, 'page.html'), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script type="module">
    const ctx = document.getElementById('c').getContext('2d');
    window.TOTAL = 1;
    let sheet, stack;
    window.ready = (async () => {
      const { loadSprite, loadStack } = await import('/__motlab/sprite.js');
      sheet = await loadSprite('sheet.json');
      const s = document.createElement('canvas'); s.width = 8; s.height = 4;   // two 4 x 4 slices: green below, white above
      const g = s.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 4, 4); g.fillStyle = '#ffffff'; g.fillRect(4, 0, 4, 4);
      stack = await loadStack(s.toDataURL(), { slices: 2 });
      return true;
    })();
    window.renderAt = async t => {
      await window.ready;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 180);
      sheet.draw(ctx, t, 80, 170, { scale: 8 });              // 128 x 128, its feet at 80, 170
      sheet.draw(ctx, t, 160, 30, { tag: 'blue', scale: 1, anchor: [0, 0] });
      stack.draw(ctx, 240, 100, { scale: 16 });               // bottom slice over 208..272 x 68..132, the top one 16 higher
    };
  </script>`);
  const [early, late] = await renderStills({ page: join(dir, 'page.html'), outDir: join(dir, 'stills'), times: [0.25, 0.75], log: () => {} });
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 6);
  assert.ok(near(meanRgb(early, '60:60:50:80'), [255, 0, 0]), `the first frame shows until 0.5 s: ${meanRgb(early, '60:60:50:80')}`);
  assert.ok(near(meanRgb(late, '60:60:50:80'), [0, 0, 255]), `then the second: ${meanRgb(late, '60:60:50:80')}`);
  assert.ok(near(meanRgb(early, '8:8:164:34'), [0, 0, 255]), 'a tag plays only its own frames');
  assert.ok(near(meanRgb(early, '30:30:225:60'), [255, 255, 255]), `the top slice: ${meanRgb(early, '30:30:225:60')}`);
  assert.ok(near(meanRgb(early, '30:10:225:120'), [0, 255, 0]), `the bottom slice shows below it: ${meanRgb(early, '30:10:225:120')}`);
  assert.ok(near(meanRgb(early, '20:10:150:120'), [0, 0, 0]), 'nothing beside the stack');
});
