// skills/motlab/scripts/track.py on clips made here with known motion: a textured card moved by homographies over a
// background that drifts, so every true corner and point is known. Needs python3 with numpy, scipy and Pillow, and
// ffmpeg.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { squareTo } from '../src/page/comp.js';

const script = fileURLToPath(new URL('../skills/motlab/scripts/track.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const dir = mkdtempSync(join(tmpdir(), 'motlab-track-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => spawnSync(python, [script, ...args], { encoding: 'utf8' });

// card.mp4: 480 x 270, 36 frames at 30 fps. The card turns, grows, tilts and moves; the background drifts.
// truth.json: the card's corners in every frame.
before(() => {
  const r = spawnSync(python, ['-c', `
import sys, json, subprocess, numpy as np
from scipy import ndimage
out = sys.argv[1]; rng = np.random.default_rng(1); W, H, N = 480, 270, 36
tex = lambda h, w, s: (lambda t: (t - t.min()) / (t.max() - t.min()))(ndimage.gaussian_filter(rng.random((h, w, 3)), (s, s, 0)))
bg = tex(H + 80, W + 80, 2) * 0.6; card = tex(200, 150, 1.5)
def homog(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y, -u], [0, 0, 0, x, y, 1, -v * x, -v * y, -v]]
    return np.linalg.svd(np.array(A))[2][-1].reshape(3, 3)
src = np.array([[0, 0], [150, 0], [150, 200], [0, 200]], float)
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '30', '-i', '-',
                      '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out + '/card.mp4'], stdin=subprocess.PIPE)
yy, xx = np.mgrid[0:H, 0:W].astype(float); truth = []
for f in range(N):
    k = f / (N - 1); a = 0.35 * k; s = 0.45 + 0.15 * k; tilt = 20 * k
    base = np.array([[-75, -100], [75, -100], [75, 100], [-75, 100]]) * s
    base[:2, 0] += [tilt, -tilt]
    dst = base @ np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]).T + [170 + 140 * k, 135 + 20 * np.sin(k * 4)]
    Hi = np.linalg.inv(homog(src, dst)); q = Hi @ np.stack([xx.ravel(), yy.ravel(), np.ones(W * H)]); u, v = (q[:2] / q[2]).reshape(2, H, W)
    inside = (u >= 0) & (u < 149) & (v >= 0) & (v < 199)
    img = np.stack([ndimage.map_coordinates(bg[..., c], [yy + 40 + 3 * np.sin(f / 3), xx + 40 + 20 * k], order=1) for c in range(3)], -1)
    img = np.where(inside[..., None], np.stack([ndimage.map_coordinates(card[..., c], [v, u], order=1) for c in range(3)], -1), img)
    p.stdin.write((np.clip(img + rng.normal(0, 0.01, img.shape), 0, 1) * 255).astype(np.uint8).tobytes()); truth.append(dst.tolist())
p.stdin.close(); p.wait()
json.dump(truth, open(out + '/truth.json', 'w'))`, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

const pairs = v => v.reduce((a, x, i) => (i % 2 ? a[a.length - 1].push(x) : a.push([x]), a), []);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const flat = q => q.flat().map(v => v.toFixed(2)).join(',');

test('a plane is followed from its start frame to both ends, its corners within a pixel of the truth', () => {
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  const mid = 18;   // start in the middle: frames 18 to 35 forwards, 18 to 0 backwards
  const r = run(join(dir, 'card.mp4'), '--plane', `card=${flat(truth[mid])}`, '--at', String(mid / 30), '--out', join(dir, 'card.track.json'));
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(readFileSync(join(dir, 'card.track.json'), 'utf8'));
  assert.equal(d.times.length, 36);
  assert.deepEqual([d.width, d.height, d.fps], [480, 270, 30]);
  const tr = d.tracks.card;
  assert.equal(tr.kind, 'plane');
  assert.equal(tr.first, 0);
  const errs = tr.corners.map((c, i) => Math.max(...pairs(c).map((p, j) => dist(p, truth[i][j]))));
  const mean = errs.reduce((a, b) => a + b) / errs.length;
  assert.ok(mean < 0.6 && Math.max(...errs) < 1.2, `corner error: mean ${mean.toFixed(2)}, max ${Math.max(...errs).toFixed(2)} px`);
  assert.ok(Math.min(...tr.confidence) > 0.5, `confidence ${Math.min(...tr.confidence)}`);
});

test('two points and the camera go into the same file, next to the plane', () => {
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  // two details inside the card, as points; the camera follows the background, which only drifts
  const on = (q, u, v) => { const H = squareTo(q), w = H[6] * u + H[7] * v + H[8]; return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]; };
  const at = i => [on(truth[i], 0.3, 0.3), on(truth[i], 0.7, 0.75)];
  const r = run(join(dir, 'card.mp4'), '--points', `pair=${flat(at(0))}`, '--window', '9', '--camera', '--out', join(dir, 'card.track.json'), '--sheet', join(dir, 'sheet.jpg'));
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(readFileSync(join(dir, 'card.track.json'), 'utf8'));
  assert.deepEqual(Object.keys(d.tracks).sort(), ['camera', 'card', 'pair']);
  assert.ok(existsSync(join(dir, 'sheet.jpg')), 'the check sheet was written');
  const errs = d.tracks.pair.points.map((v, i) => Math.max(...pairs(v).map((p, j) => dist(p, at(i)[j]))));
  assert.ok(Math.max(...errs) < 1, `point error up to ${Math.max(...errs).toFixed(2)} px`);
  // the background moved by (-20 k, -3 sin(f / 3)): a point of the first frame lands there
  const last = d.tracks.camera.matrix[35], [x, y] = [200, 40], w = last[6] * x + last[7] * y + last[8];
  const want = [x - 20, y - 3 * Math.sin(35 / 3)];
  const got = [(last[0] * x + last[1] * y + last[2]) / w, (last[3] * x + last[4] * y + last[5]) / w];
  assert.ok(dist(got, want) < 1, `camera: ${got.map(v => v.toFixed(2))} for ${want.map(v => v.toFixed(2))}`);
});

test('a plane without texture is refused, and a clip of another size starts the file again', () => {
  const r = run(join(dir, 'card.mp4'), '--plane', 'flat=0,0,1,0,1,1,0,1', '--out', join(dir, 'flat.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /too little texture/);
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=0.5', '-pix_fmt', 'yuv420p', '-y', join(dir, 'other.mp4')]);
  assert.equal(made.status, 0, String(made.stderr));
  const again = run(join(dir, 'other.mp4'), '--camera', '--out', join(dir, 'card.track.json'));
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /made from a different clip/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'card.track.json'), 'utf8')).tracks), ['camera']);
  const none = run(join(dir, 'card.mp4'));
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /give --points, --plane or --camera/);
});
