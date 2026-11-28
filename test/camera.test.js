import assert from 'node:assert/strict';
import { test } from 'node:test';
import { camera, noise, shake } from '../src/page/camera.js';

const near = (a, b, d = 1e-6) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);
const W = 1920, H = 1080;

test('noise is the same for the same x and seed, smooth, and stays within -1 to 1', () => {
  let lo = 0, hi = 0, step = 0;
  for (let x = -20; x < 200; x += 0.01) {
    const v = noise(x, 4);
    lo = Math.min(lo, v); hi = Math.max(hi, v); step = Math.max(step, Math.abs(noise(x + 0.01, 4) - v));
  }
  assert.ok(lo >= -1 && hi <= 1 && lo < -0.6 && hi > 0.6, `range ${lo} to ${hi}`);
  assert.ok(step < 0.05, `a step of 0.01 changed it by ${step}`);
  assert.equal(noise(3.7, 2), noise(3.7, 2));
  assert.notEqual(noise(3.7, 2), noise(3.7, 3));
});

test('a shake is still outside its span, dies away by its end, and a held one fades in and out over 0.2 s', () => {
  const hit = { from: 1, to: 1.5, amount: 20, turn: 2, speed: 15 };
  assert.deepEqual(shake(0.99, hit), { x: 0, y: 0, turn: 0 });
  assert.deepEqual(shake(1.5, hit), { x: 0, y: 0, turn: 0 });
  const size = t => Math.hypot(shake(t, hit).x, shake(t, hit).y);
  assert.ok(Math.max(...[1.05, 1.1, 1.15, 1.2].map(size)) > 2, 'it moves near its start');
  assert.ok(size(1.49) < 0.01, 'it has died away at its end');
  const held = { from: 2, to: 6, amount: 10, speed: 2, decay: false }, h = t => shake(t, held);
  assert.deepEqual(h(3), h(3));
  for (const t of [2.05, 5.95]) assert.ok(Math.abs(h(t).x) <= 10 * 0.25 + 1e-9, `${t}: within a quarter of the amount`);
  const always = { amount: 10, speed: 2 };   // no "from" or "to": no fade and no decay
  near(shake(0.3, always).x, noise(0.6, 0) * 10, 1e-9);
});

test('keys carry what they leave out, hold before the first and after the last, and zoom in log space', () => {
  const cam = camera({ width: W, height: H, keys: [[1, { x: 500 }], [3, { zoom: 4 }, 'linear'], [5, { turn: 10 }]] });
  assert.deepEqual(cam.at(0), { x: 500, y: 540, zoom: 1, turn: 0 });
  assert.deepEqual(cam.at(9), { x: 500, y: 540, zoom: 4, turn: 10 });
  near(cam.at(2).zoom, 2, 1e-9);   // halfway between 1 and 4 in log space
  near(cam.at(2).x, 500, 1e-9);
  const cut = camera({ keys: [[0, { x: 100 }], [1, { x: 100 }], [1, { x: 900 }]] });
  assert.equal(cut.at(0.999).x, 100);
  assert.equal(cut.at(1).x, 900);
});

test('a push in on a point off centre moves that point in a straight line to the centre, at the eased pace', () => {
  const cam = camera({ width: W, height: H, keys: [[0, { zoom: 1 }], [2, { x: 1700, y: 300, zoom: 8, turn: 20 }, 'outCubic']] });
  const [x0, y0] = cam.point(0, 1700, 300);
  near(x0, 1700, 1e-6); near(y0, 300, 1e-6);
  for (const t of [0.3, 0.8, 1.4, 2]) {
    const [x, y] = cam.point(t, 1700, 300), k = 1 - (1 - t / 2) ** 3;
    near(x, 1700 + (W / 2 - 1700) * k, 1e-6); near(y, 300 + (H / 2 - 300) * k, 1e-6);
  }
  const out = camera({ width: W, height: H, keys: [[0, { x: 400, y: 800, zoom: 6 }], [1, { zoom: 1, x: 960, y: 540 }, 'linear']] });
  for (const t of [0.25, 0.5, 0.75]) {   // pulling out, the point it started on leaves the centre in a straight line
    const [x, y] = out.point(t, 400, 800);
    near(x, W / 2 + (400 - 960) * t, 1e-6); near(y, H / 2 + (800 - 540) * t, 1e-6);
  }
});

test('depth 0 stays put, depth 1 puts the look-at point in the centre, and turn rolls the camera clockwise', () => {
  const cam = camera({ width: W, height: H, keys: [[0, { x: 1300, y: 200, zoom: 3 }]] });
  assert.deepEqual(cam.matrix(0, 0).map(v => +v.toFixed(9)), [1, 0, 0, 1, 0, 0]);
  const [x, y] = cam.point(0, 1300, 200);
  near(x, W / 2); near(y, H / 2);
  const half = cam.point(0, 1300, 200, 0.5), [cx, cy] = [W / 2 + 340 * 0.5, H / 2 - 340 * 0.5];   // looks at the halfway point, zoom sqrt(3)
  near(half[0], W / 2 + (1300 - cx) * Math.sqrt(3), 1e-6); near(half[1], H / 2 + (200 - cy) * Math.sqrt(3), 1e-6);
  const rolled = camera({ width: W, height: H, keys: [[0, { turn: 90 }]] });
  const [rx, ry] = rolled.point(0, W / 2 + 100, H / 2);   // the camera rolls clockwise, so a point to the right goes up
  near(rx, W / 2, 1e-9); near(ry, H / 2 - 100, 1e-9);
});

test('at() and the matrix agree with a shake on, and apply() scales the matrix for ?scale=', () => {
  const cam = camera({ width: W, height: H, keys: [[0, { x: 700, zoom: 1.5, turn: 5 }]], shake: [{ amount: 30, turn: 3, speed: 4 }] });
  for (const t of [0.2, 1.1, 2.7]) {
    const v = cam.at(t), [x, y] = cam.point(t, v.x, v.y);
    near(x, W / 2, 1e-6); near(y, H / 2, 1e-6);
    assert.ok(Math.abs(v.turn - 5) <= 3);
  }
  let set;
  cam.apply({ setTransform: (...m) => { set = m; } }, 1.1, { scale: 2 });
  assert.deepEqual(set, cam.matrix(1.1).map(v => v * 2));
});

test('speed is 0 for a still camera and the pan speed for a steady pan', () => {
  assert.equal(camera({ keys: [[0, { zoom: 2 }]] }).speed(1), 0);
  const pan = camera({ width: W, height: H, keys: [[0, { x: 0 }], [2, { x: 1000 }, 'linear']] });
  near(pan.speed(1), 500, 1e-3);
  near(pan.speed(1, 0.5), 250, 1e-3);
});

test('fly: a long jump pulls out on the way and lands exactly on its key', () => {
  const cam = camera({ width: W, height: H, keys: [[0, { x: 960, y: 540, zoom: 1.5 }], [2, { x: 960 + 3 * W, y: 900, zoom: 2, turn: 10, fly: true }, 'linear']] });
  assert.deepEqual(cam.at(0), { x: 960, y: 540, zoom: 1.5, turn: 0 });
  const end = cam.at(2);
  near(end.x, 960 + 3 * W, 1e-6); near(end.y, 900, 1e-6); near(end.zoom, 2, 1e-9); near(end.turn, 10, 1e-9);
  const mid = cam.at(1);
  assert.ok(mid.zoom < 0.5, `it pulls out to see the way: zoom ${mid.zoom} halfway`);
  let last = -Infinity;
  for (let t = 0; t <= 2; t += 0.05) { const x = cam.at(t).x; assert.ok(x >= last - 1e-9, 'it travels one way'); last = x; }
  const further = camera({ width: W, height: H, keys: [[0, { zoom: 1.5 }], [2, { x: 960 + 3 * W, zoom: 2, fly: 2 }, 'linear']] });
  assert.ok(further.at(1).zoom < mid.zoom, 'a larger fly pulls out further');
  const still = camera({ width: W, height: H, keys: [[0, { zoom: 1 }], [1, { zoom: 4, fly: true }, 'linear']] });
  near(still.at(0.5).zoom, 2, 1e-9);   // no travel: the zoom alone, in log space
});

test('follow looks at a moving thing between its times, easing in and out, and lag trails it', () => {
  const ball = t => [200 + 400 * t, 300 + 50 * t];
  const cam = camera({ width: W, height: H, keys: [[0, { x: 960, y: 540, zoom: 1.5 }], [4, { zoom: 2 }, 'linear']],
    follow: [{ from: 1, to: 3, target: ball, blend: 0.4 }] });
  near(cam.at(0.9).x, 960, 1e-9);
  near(cam.at(3.1).y, 540, 1e-9);
  for (const t of [1.5, 2, 2.5]) { const v = cam.at(t); near(v.x, ball(t)[0], 1e-9); near(v.y, ball(t)[1], 1e-9); }
  near(cam.at(1.2).x, (960 + ball(1.2)[0]) / 2, 1e-9);   // halfway through the blend, halfway there
  near(cam.at(2).zoom, Math.exp(Math.log(1.5) + (Math.log(2) - Math.log(1.5)) / 2), 1e-9);   // zoom still from the keys
  const late = camera({ width: W, height: H, follow: { target: ball, lag: 0.5 } });
  near(late.at(2).x, ball(1.75)[0], 1e-9);   // a straight move, so the average is where it was lag / 2 ago
  // a target that starts to move all at once: the lag eases the camera into it, with no step in its speed
  const go = camera({ width: W, height: H, follow: { target: t => [Math.max(0, t - 1) * 600, 0], lag: 0.4 } });
  const speed = Array.from({ length: 60 }, (_, i) => go.at(0.9 + (i + 1) / 60).x - go.at(0.9 + i / 60).x);
  const jumps = speed.slice(1).map((v, i) => Math.abs(v - speed[i]));
  assert.ok(Math.max(...jumps) < 0.9, `the speed changed by ${Math.max(...jumps).toFixed(2)} px between two frames`);
});

test('camera() refuses keys it cannot follow', () => {
  assert.throws(() => camera({ keys: [] }), /keys must be a list/);
  assert.throws(() => camera({ keys: [[0, {}], [1, {}, 'wobbly']] }), /key 2 has an unknown easing "wobbly"/);
  assert.throws(() => camera({ keys: [[1, {}], [0.5, {}]] }), /key 2 must have a time at or after/);
  assert.throws(() => camera({ keys: [[0, { zoom: 0 }]] }), /key 1 needs a zoom above 0/);
  assert.throws(() => camera({ keys: [[0, {}], [1, { x: 5000, fly: 'far' }]] }), /key 2 has fly far; it is true or a number above 0/);
  assert.throws(() => camera({ follow: [{ from: 1 }] }), /follow 1 needs target, a function of t/);
});
