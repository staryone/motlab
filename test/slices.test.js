// skills/motlab-assets/scripts/slices.py: sprite stacks from flat views, from distance functions and, when Blender is
// installed (on PATH, or BLENDER), from a 3D model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../skills/motlab-assets/scripts/', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };   // it is imported from its folder; leave no __pycache__ there
const py = (code, ...args) => spawnSync(python, ['-c', code, ...args], { encoding: 'utf8', cwd: scripts, env });
const dir = mkdtempSync(join(tmpdir(), 'motlab-slices-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const slicesPy = join(scripts, 'slices.py');

// The colour of voxel (x, z) in slice y of a stack strip, as "r,g,b,a".
const voxel = (name, y, z, x) => py(`
import json, sys
from PIL import Image
info = json.load(open(sys.argv[1] + '.stack.json'))
print(','.join(map(str, Image.open(sys.argv[1] + '.stack.png').getpixel((int(sys.argv[2]) * info['width'] + int(sys.argv[4]), int(sys.argv[3]))))))`,
  join(dir, name), String(y), String(z), String(x)).stdout.trim();

test('views: a house carved from its top, front and side, each face coloured by the view that sees it', () => {
  // 6 wide, 4 deep, 5 high: walls 3 high (yellow, the side a darker yellow, a brown door), a red roof 2 high.
  const made = py(`
import sys, numpy as np
from PIL import Image
d = sys.argv[1]
top = np.zeros((4, 6, 4), np.uint8); top[:] = (200, 40, 40, 255)
front = np.zeros((5, 6, 4), np.uint8); front[:2] = (200, 40, 40, 255); front[2:] = (240, 210, 90, 255); front[3:, 2:4] = (90, 50, 20, 255)
side = np.zeros((5, 4, 4), np.uint8); side[2:] = (220, 190, 80, 255); side[1] = (200, 40, 40, 255); side[0, 1:3] = (200, 40, 40, 255)
for n, a in (('top', top), ('front', front), ('side', side)): Image.fromarray(a, 'RGBA').save(f'{d}/{n}.png')
Image.fromarray(np.zeros((5, 5, 4), np.uint8), 'RGBA').save(f'{d}/narrow.png')`, dir);
  assert.equal(made.status, 0, made.stderr);
  const r = spawnSync(python, [slicesPy, 'views', join(dir, 'top.png'), join(dir, 'front.png'), join(dir, 'side.png'), '--out', join(dir, 'out', 'house')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(readFileSync(join(dir, 'out', 'house.stack.json'), 'utf8'));
  assert.deepEqual(info, { image: 'house.stack.png', slices: 5, width: 6, depth: 4, layout: 'row', order: 'bottom-first' });
  assert.ok(existsSync(join(dir, 'out', 'house.stack-preview.png')));
  assert.equal(voxel('out/house', 0, 3, 2), '90,50,20,255', 'the door, on the front of the bottom slice');
  assert.equal(voxel('out/house', 2, 3, 0), '240,210,90,255', 'the front wall');
  assert.equal(voxel('out/house', 1, 1, 5), '220,190,80,255', 'the right wall, from the side view');
  assert.equal(voxel('out/house', 1, 1, 0), '220,190,80,255', 'the left wall takes the side view too');
  assert.equal(voxel('out/house', 4, 1, 2), '200,40,40,255', 'the ridge of the roof, from the top view');
  assert.equal(voxel('out/house', 4, 0, 2), '0,0,0,0', 'the gable leaves the roof narrower at the top');
  const bad = spawnSync(python, [slicesPy, 'views', join(dir, 'top.png'), join(dir, 'front.png'), join(dir, 'narrow.png'), '--out', join(dir, 'x')], { encoding: 'utf8', env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /side\.png is 5 x 5; it must be 4 wide \(top\.png's height\) and 5 high/);
});

test('from_sdf: a ball sampled at the middle of each voxel, in one colour', () => {
  const r = py(`
import sys, numpy as np, slices
info = slices.from_sdf(lambda x, y, z: np.sqrt(x**2 + y**2 + z**2) - 1, (30, 120, 220), lo=(-1, -1, -1), hi=(1, 1, 1), size=10, out=sys.argv[1])
print(info['slices'], info['width'], info['depth'], info['voxel'])`, join(dir, 'ball'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').at(-1), '10 10 10 0.2');
  assert.equal(voxel('ball', 5, 5, 5), '30,120,220,255');
  assert.equal(voxel('ball', 0, 0, 0), '0,0,0,0', 'a corner of the box is outside the ball');
});

const blender = process.env.BLENDER || (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0] || '').trim();
test('glb: a model voxelized in Blender takes its texture and its material colour', { skip: !blender && 'Blender is not installed' }, () => {
  // A 2 x 1 x 0.5 m base textured green on the left and blue on the right, and a red cube on it towards the front.
  writeFileSync(join(dir, 'make.py'), `
import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.25)); base = bpy.context.object; base.scale = (2, 1, 0.5)
bpy.ops.object.transform_apply(scale=True)
img = bpy.data.images.new('tex', 2, 1); img.pixels[:] = [0.2, 0.8, 0.2, 1, 0.2, 0.2, 0.9, 1]
img.filepath_raw = out + '.png'; img.file_format = 'PNG'; img.save()
mat = bpy.data.materials.new('tex'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img; tex.interpolation = 'Closest'
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
base.data.materials.append(mat)
uv = base.data.uv_layers.active.data
for poly in base.data.polygons:
    for li in poly.loop_indices: uv[li].uv = (0.25 if base.data.vertices[base.data.loops[li].vertex_index].co.x < 0 else 0.75, 0.5)
bpy.ops.mesh.primitive_cube_add(size=0.5, location=(0.5, -0.2, 0.75)); top = bpy.context.object
red = bpy.data.materials.new('red'); red.use_nodes = True
red.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.02, 0.02, 1)
top.data.materials.append(red)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')`);
  const made = spawnSync(blender, ['-b', '--factory-startup', '-P', join(dir, 'make.py'), '--', join(dir, 'model.glb')], { encoding: 'utf8' });
  assert.ok(existsSync(join(dir, 'model.glb')), made.stderr);
  const r = spawnSync(python, [slicesPy, 'glb', join(dir, 'model.glb'), '--size', '24', '--out', join(dir, 'model'), '--blender', blender], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(readFileSync(join(dir, 'model.stack.json'), 'utf8'));
  assert.deepEqual([info.slices, info.width, info.depth], [12, 24, 12]);   // 2 m across in 24 voxels of 1/12 m; 1 m high
  assert.equal(voxel('model', 2, 6, 3), '51,204,51,255', 'the left of the base, from the texture');
  assert.equal(voxel('model', 2, 6, 20), '51,51,230,255', 'the right of the base');
  assert.equal(voxel('model', 9, 8, 17), '231,39,39,255', 'the cube, its linear red 0.8 written as sRGB');
  assert.equal(voxel('model', 9, 8, 5), '0,0,0,0', 'nothing above the left of the base');
});
