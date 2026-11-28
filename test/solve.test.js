// skills/motlab/scripts/blender/solve.py on a clip rendered in Blender with a known camera: the solved camera and
// lens match it. Needs Blender (on PATH, or BLENDER) and ffmpeg, so it is skipped where Blender is not installed (CI).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/blender/solve.py', import.meta.url));
const found = (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0] || '').trim();
const windows = 'C:\\Program Files\\Blender Foundation';
const installed = process.platform === 'win32' && existsSync(windows)
  ? spawnSync('cmd', ['/c', 'dir', '/b', '/s', `${windows}\\blender.exe`], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(Boolean) : '';
const blender = process.env.BLENDER || found || installed;
const dir = mkdtempSync(join(tmpdir(), 'motlab-solve-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('solve.py finds a moving camera and its lens, and puts the floor at y = 0', { skip: !blender && 'Blender is not installed', timeout: 600000 }, () => {
  // a floor and a wall with noise on them and three boxes, the camera sliding past at 28 mm, 640 x 360, 48 frames
  writeFileSync(join(dir, 'scene.py'), `
import bpy, json, math, random, sys
out = sys.argv[sys.argv.index('--') + 1]
random.seed(3)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 640, 360, 100
sc.frame_start, sc.frame_end = 1, 48
def noise(name, a, b):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    img = bpy.data.images.new(name, 128, 128)
    img.pixels = [v for _ in range(128 * 128) for r in [random.random()] for v in [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r, a[2] + (b[2] - a[2]) * r, 1]]
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; tex.interpolation = 'Closest'
    nt.links.new(tex.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color']); return m
bpy.ops.mesh.primitive_plane_add(size=20); bpy.context.object.data.materials.append(noise('floor', (0.1, 0.1, 0.1), (0.9, 0.9, 0.8)))
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 6, 5), rotation=(math.pi / 2, 0, 0)); bpy.context.object.data.materials.append(noise('wall', (0.2, 0.3, 0.5), (1, 1, 1)))
for i, (x, y, s) in enumerate([(-2, 1, 0.8), (1.5, 2.5, 1.2), (0.2, -1, 0.5)]):
    bpy.ops.mesh.primitive_cube_add(size=s, location=(x, y, s / 2)); bpy.context.object.data.materials.append(noise(f'b{i}', (0.5, 0.1, 0), (1, 0.8, 0.3)))
bpy.ops.object.camera_add(); cam = bpy.context.object; sc.camera = cam; cam.data.lens = 28
truth = []
for f in range(1, 49):
    k = (f - 1) / 47
    cam.location = (-3 + 4 * k, -8 + 1.2 * k, 2.2)
    d = [0.5 * k - cam.location[0], 1 - cam.location[1], 0.6 - cam.location[2]]
    cam.rotation_euler = (math.pi / 2 + math.atan2(d[2], math.hypot(d[0], d[1])), 0, math.atan2(d[1], d[0]) - math.pi / 2)
    cam.keyframe_insert('location', frame=f); cam.keyframe_insert('rotation_euler', frame=f)
    truth.append(list(cam.location))
json.dump(truth, open(out + '/truth.json', 'w'))
sc.render.image_settings.file_format = 'PNG'; sc.render.filepath = out + '/f'
bpy.ops.render.render(animation=True)`);
  const made = spawnSync(blender, ['-b', '--factory-startup', '-P', join(dir, 'scene.py'), '--', dir], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const enc = spawnSync('ffmpeg', ['-v', 'error', '-framerate', '24', '-i', join(dir, 'f%04d.png'), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', join(dir, 'room.mp4')]);
  assert.equal(enc.status, 0, String(enc.stderr));
  // three points on the floor in the first frame
  const r = spawnSync(blender, ['-b', '--factory-startup', '-P', script, '--', join(dir, 'room.mp4'), '--floor', '100,320', '520,320', '330,345'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
  const d = JSON.parse(readFileSync(join(dir, 'room.track.json'), 'utf8')), cam = d.tracks.camera3d;
  assert.equal(cam.kind, 'camera3d');
  assert.equal(cam.matrix.length, 48);
  assert.ok(cam.matrix.every(Boolean), 'every frame solved');
  assert.ok(Math.abs(cam.focal - 28) < 1.5, `focal ${cam.focal} mm for 28\n${r.stdout.slice(-1500)}`);
  assert.ok(cam.error < 1, `re-projection error ${cam.error} px`);
  const fov = 2 * Math.atan(36 * 360 / 640 / 2 / 28) * 180 / Math.PI;
  assert.ok(Math.abs(cam.fov - fov) < 2, `field of view ${cam.fov} for ${fov.toFixed(1)}`);
  // the floor: the camera is above it, and the solved floor details lie on it
  const y = cam.matrix[0][13];
  assert.ok(y > 0, `the camera is above the floor: ${y}`);
  const flat = cam.points.filter(p => Math.abs(p[1]) < 0.05 * y).length / cam.points.length, low = Math.min(...cam.points.map(p => p[1]));
  assert.ok(flat > 0.25, `${(flat * 100).toFixed(0)}% of the details lie on the floor`);
  assert.ok(low > -0.05 * y, `no detail far below the floor: the lowest is at ${low.toFixed(3)}, the camera at ${y.toFixed(3)}`);
  // the path: the camera moved 4.2 units in a straight line; the solved one is straight too, up to its own scale
  const pos = cam.matrix.map(m => [m[12], m[13], m[14]]), [a, b] = [pos[0], pos[47]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const off = Math.max(...pos.map((p, i) => { const k = i / 47, q = a.map((v, j) => v + (b[j] - v) * k); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / len; }));
  assert.ok(off < 0.01, `the solved path leaves the straight line by ${(off * 100).toFixed(2)}% of its length`);
});
