import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../skills/motlab/scripts/', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const py = (code, ...args) => spawnSync(python, ['-c', code, ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'motlab-depth-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('depth_layers.py cuts a photo into layers that stack back into it, with the hidden part filled', () => {
  // A red wall far away with a blue box in front of it; its depth map is dark for the wall and light for the box.
  const made = py(`
import sys
from PIL import Image, ImageDraw
img = Image.new('RGB', (200, 120), (200, 40, 40)); ImageDraw.Draw(img).rectangle([70, 30, 129, 89], fill=(30, 60, 220))
dep = Image.new('L', (200, 120), 40); ImageDraw.Draw(dep).rectangle([70, 30, 129, 89], fill=220)
img.save(sys.argv[1] + '/box.png'); dep.save(sys.argv[1] + '/box.depth.png')`, dir);
  assert.equal(made.status, 0, made.stderr);
  const r = spawnSync(python, [join(scripts, 'depth_layers.py'), join(dir, 'box.png'), '--layers', '2', '--out', join(dir, 'layers')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(readFileSync(join(dir, 'layers', 'box-layers.json'), 'utf8'));
  assert.deepEqual(info.layers.map(l => [l.file, l.depth]), [['box-1.png', 0.6], ['box-2.png', 1]]);
  assert.deepEqual(info.size, [200, 120]);
  const check = py(`
import sys, numpy as np
from PIL import Image
d = sys.argv[1] + '/layers/'
far, near = (np.asarray(Image.open(d + f'box-{i}.png'), float) for i in (1, 2))
assert far[..., 3].min() == 255, 'the far layer is opaque'
assert near[60, 100, 3] == 255 and near[5, 5, 3] == 0, 'the near layer is the box only'
r, g, b = far[60, 100, :3]
assert r > 150 and b < 100, f'behind the box the far layer is filled with the wall, not the box: {far[60, 100, :3]}'
a = near[..., 3:] / 255
stack = near[..., :3] * a + far[..., :3] * (1 - a)
diff = abs(stack - np.asarray(Image.open(sys.argv[1] + '/box.png').convert('RGB'), float))
assert diff.mean() < 1, f'the stack differs from the photo by {diff.mean()} on average'
print('ok')`, dir);
  assert.equal(check.status, 0, check.stderr);
  const bad = spawnSync(python, [join(scripts, 'depth_layers.py'), join(dir, 'box.png'), '--layers', '9'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--layers is 2 to 8/);
  const none = spawnSync(python, [join(scripts, 'depth_layers.py'), join(dir, 'nothing.jpg')], { encoding: 'utf8' });
  assert.match(none.stderr, /nothing\.depth\.png not found: make it with {2}motlab depth/);
});
