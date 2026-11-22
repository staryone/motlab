import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/compose_into_clip.py', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'motlab-compose-end-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const python = process.platform === 'win32' ? 'python' : 'python3';

function run(command, args) {
  const result = spawnSync(command, args, { maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, result.error?.message || String(result.stderr));
  return result.stdout;
}

test('compose into clip: the animation lasts --end, whatever the number of PNGs', t => {
  if (spawnSync(python, ['-c', 'import numpy, PIL']).status !== 0) return t.skip('requires numpy and Pillow');
  const frames = join(dir, 'frames'), clip = join(dir, 'clip.mp4'), out = join(dir, 'out.mp4');
  mkdirSync(frames);
  for (const [name, color] of [['000', 'red'], ['001', 'lime']]) {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x64`, '-frames:v', '1',
      '-pix_fmt', 'rgba', join(frames, `${name}.png`)]);
  }
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=25:d=1', '-c:v', 'mpeg4', clip]);
  run(python, [script, frames, clip, out, '--end', '2', '--fade', '3', '4', '--melt', '3', '4',
    '--fps', '25', '--w', '64', '--h', '64']);

  const rgb = run('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const pixel = n => [...rgb.subarray(n * 3, n * 3 + 3)];
  const strongest = n => ['red', 'green', 'blue'][pixel(n).indexOf(Math.max(...pixel(n)))];
  assert.equal(rgb.length / 3, 75, '2 s of animation and 1 s of clip at 25 fps');
  assert.equal(strongest(0), 'red');
  assert.equal(strongest(49), 'green', 'the last PNG is still on screen just before 2 s');
  assert.equal(strongest(50), 'blue', 'the clip starts at 2 s');
});
