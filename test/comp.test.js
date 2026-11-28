// /__motlab/comp.js without a browser: the homographies, the corner helpers and how a track file is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grow, homography, loadTrack, quad, squareTo } from '../src/page/comp.js';

const apply = (H, [x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
const close = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('squareTo and homography take corners to corners, in perspective too', () => {
  const q = [[100, 50], [400, 80], [380, 300], [90, 260]];
  const H = squareTo(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((p, i) => assert.ok(close(apply(H, p), q[i]), `${p} -> ${apply(H, p)}`));
  const r = [[0, 0], [200, 0], [200, 100], [0, 100]];   // a plain rectangle takes the affine path
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((p, i) => assert.ok(close(apply(squareTo(r), p), r[i])));
  const G = homography(r, q);
  r.forEach((p, i) => assert.ok(close(apply(G, p), q[i], 1e-6)));
});

test('quad turns and scales a box around its anchor; grow moves every edge out by the same distance', () => {
  assert.deepEqual(quad(100, 100, 40, 20), [[80, 90], [120, 90], [120, 110], [80, 110]]);
  const t = quad(0, 0, 10, 10, { angle: Math.PI / 2, anchor: [0, 0] });
  assert.ok(close(t[1], [0, 10]) && close(t[3], [-10, 0]), JSON.stringify(t));
  const q = [[100, 50], [400, 80], [380, 300], [90, 260]], g = grow(q, 5);
  // each grown edge is parallel to the old one, 5 units further out
  for (let i = 0; i < 4; i++) {
    const [a, b] = [q[i], q[(i + 1) % 4]], [c] = [g[i]];
    const nx = b[1] - a[1], ny = a[0] - b[0], l = Math.hypot(nx, ny);
    const d = ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny) / l;
    assert.ok(Math.abs(Math.abs(d) - 5) < 1e-6, `edge ${i}: ${d}`);
  }
  // the same for corners given the other way round
  const back = grow([...q].reverse(), 5).reverse();
  back.forEach((p, i) => assert.ok(close(p, g[i]), `${p} vs ${g[i]}`));
});

test('a track gives the frame shown at a time, holds lost frames and the ends, and carries points', async () => {
  // 5 frames at 10 fps; the plane moves 10 px right per frame and is lost in frame 3; two points turn by 90 degrees
  const corners = k => [0, 0, 100, 0, 100, 50, 0, 50].map((v, i) => i % 2 ? v : v + 10 * k);
  const file = {
    width: 1000, height: 500, fps: 10, times: [0, 0.1, 0.2, 0.3, 0.4],
    tracks: {
      card: { kind: 'plane', first: 1, corners: [corners(1), corners(2), null, corners(4)], confidence: [1, 1, 0, 1] },
      pair: { kind: 'points', first: 0, points: [[0, 0, 10, 0], [5, 5, 5, 15]], confidence: [1, 1] },
    },
  };
  globalThis.document = { baseURI: 'http://x/scenes/a.html' };
  globalThis.fetch = async url => ({ ok: String(url) === 'http://x/footage/c.track.json', status: 404, json: async () => file });
  const t = await loadTrack('../footage/c.track.json');
  assert.equal(t.frame(0.1999), 1);
  assert.equal(t.frame(0.2), 2);
  assert.deepEqual(t.plane('card', 0)[0], [10, 0], 'before the track starts: its first frame');
  assert.deepEqual(t.plane('card', 0.25)[0], [20, 0], 'a lost frame takes the nearest earlier one that was found');
  assert.deepEqual(t.plane('card', 9)[0], [40, 0], 'after the end: the last frame');
  assert.deepEqual(t.plane('card', 0.15, [0, 0, 500, 250])[1], [55, 0], 'fit halves clip pixels here');
  assert.equal(t.confidence('card', 0.3), 0);
  // a point beside the plane in its first frame moves with it
  assert.ok(close(t.carry('card', 0.4, [[150, 25]])[0], [180, 25]));
  const p = t.pose('pair', 0.1);
  assert.ok(close([p.x, p.y, p.scale, p.angle], [5, 5, 1, Math.PI / 2]), JSON.stringify(p));
  const s = t.shutter(x => t.plane('card', x), 0.4);   // frame 3 was lost, so the frame before is frame 2's
  assert.ok(close(s.from[0], [35, 0]) && close(s.to[0], [40, 0]), JSON.stringify(s));
  assert.throws(() => t.plane('nope', 0), /has no track "nope" \(it has card, pair\)/);
  await assert.rejects(loadTrack('missing.json'), /missing\.json: 404/);
});
