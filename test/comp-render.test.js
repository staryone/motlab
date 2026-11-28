// End to end: needs Chrome and ffmpeg. A page draws a clip through /__motlab/comp.js with a warp and lays a canvas on
// it at four corners, and the stills show both in their places.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { renderStills } from '../src/render.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-comp-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');
after(() => rmSync(dir, { recursive: true, force: true }));

function meanRgb(file, crop) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${crop},scale=1:1:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  return [...r.stdout.subarray(0, 3)];
}

test('footage is pushed by a warp and a layer lands on its corners', async () => {
  // red on the left half, blue on the right, 320 x 180
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x180:r=30:d=1',
    '-filter_complex', 'hstack', '-pix_fmt', 'yuv420p', '-y', join(dir, 'halves.mp4')]);
  assert.equal(made.status, 0, String(made.stderr));
  writeFileSync(join(dir, 'page.html'), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script type="module">
    const ctx = document.getElementById('c').getContext('2d');
    window.TOTAL = 1;
    let clip, comp;
    const green = Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    green.getContext('2d').fillStyle = '#00ff00'; green.getContext('2d').fillRect(0, 0, 16, 16);
    window.ready = (async () => {
      const { openFootage } = await import('/__motlab/footage.js');
      const { compositor } = await import('/__motlab/comp.js');
      clip = await openFootage('halves.mp4');
      comp = compositor({ width: 320, height: 180 });
      return true;
    })();
    window.renderAt = async t => {
      await window.ready;
      // everything moves 40 to the right after 0.5 s; the layer is a tilted green quad on the left
      comp.footage(await clip.frame(t), { warps: t > 0.5 ? [{ type: 'push', dx: 40, dy: 0 }] : [] });
      comp.layer(green, { at: [[20, 20], [100, 30], [100, 80], [20, 70]] });
      ctx.drawImage(comp.canvas, 0, 0);
    };
  </script>`);
  const [before, pushed] = await renderStills({ page: join(dir, 'page.html'), outDir: join(dir, 'stills'), times: [0.25, 0.75], log: () => {} });
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 24);   // pure colours come back a little off through yuv420p
  assert.ok(near(meanRgb(before, '20:20:170:120'), [0, 0, 255]), `right of the middle is blue: ${meanRgb(before, '20:20:170:120')}`);
  assert.ok(near(meanRgb(pushed, '20:20:170:120'), [255, 0, 0]), `pushed 40 to the right it is red: ${meanRgb(pushed, '20:20:170:120')}`);
  assert.ok(near(meanRgb(pushed, '30:20:50:45'), [0, 255, 0]), `the layer: ${meanRgb(pushed, '30:20:50:45')}`);
  assert.ok(near(meanRgb(pushed, '10:10:40:150'), [255, 0, 0]), `below the layer, the footage: ${meanRgb(pushed, '10:10:40:150')}`);
});
