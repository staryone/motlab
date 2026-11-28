// A camera for scene pages: keyframed position, zoom and turn, shake from seeded noise, and parallax across layers.
// Served by the render server and the viewer at /__motlab/camera.js:
//
//   const { camera, shake, noise } = await import('/__motlab/camera.js');
//   const cam = camera({ width: W, height: H,
//     keys: [[0, { x: 960, y: 540, zoom: 1 }], [1.6, { x: 1240, y: 470, zoom: 1.8, turn: 3 }, 'inOutCubic']],
//     shake: [{ from: 2.1, to: 2.6, amount: 18, turn: 1, speed: 14 }] });
//   cam.apply(ctx, t, { scale: SCALE });               // then draw in the page's own W x H units
//   cam.apply(ctx, t, { scale: SCALE, depth: 0.6 });   // a layer further back moves and zooms less
//
// A key is [time, { x, y, zoom, turn }, easing into it]. x, y is the point of the page the camera looks at (the centre
// of the frame), zoom 2 shows half the width, and turn is the camera's roll in degrees, clockwise, so the picture
// turns the other way. A key leaves out what does not change; the first key starts from the whole page, unturned.
// Two keys at the same time cut the camera. Zoom eases in log space, so a push feels even from far to near, and the
// end that is closer in keeps its point moving in a straight line across the frame: a push in on a point off centre
// goes straight to it instead of swinging out first.
//
// fly: true in a key makes the move into it a long jump: the camera pulls out while it travels and pushes in at the end,
// on the path of van Wijk and Nuij's "Smooth and efficient zooming and panning" (2003; d3.interpolateZoom and Mapbox's
// flyTo use it). A number instead of true says how far it pulls out (1.41 by default; 2 pulls out further).
//
// follow keeps a moving thing in frame: [{ from, to, target: t => [x, y], blend, lag }]. target gives the thing's place
// in page units at t, from the same code that draws it. Between from and to the camera looks at it instead of at its
// keys, easing over blend seconds at each end (0.3 by default); zoom and turn still come from the keys. lag (seconds)
// looks at where it was on average over that time, like an operator who reacts a little late: 24 samples weighted
// towards the middle of it (a Hann window), so the camera eases into a move instead of speeding up in steps.
//
// depth is a layer's parallax: 1 moves with the camera, 0 stays put (a sky), 0.5 moves half as far and zooms by the
// square root, 1.5 moves more (a foreground). Turn and shake are the same for every layer, as when a camera turns.
// Every value is a function of t, so frames can be drawn in any order.
import { ease as EASE, lerp } from './motion.js';

const RAD = Math.PI / 180;
// The weights of a follow's lag: a Hann window over 24 samples, summing to 1.
const LAG = (() => { const w = Array.from({ length: 24 }, (_, j) => Math.sin(Math.PI * (j + 0.5) / 24) ** 2), s = w.reduce((a, b) => a + b); return w.map(v => v / s); })();
const rot = (a, x, y) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

// Smooth noise of x, about -1 to 1, the same for the same x and seed in every render: gradient noise in one dimension
// with a second octave. One unit of x is about one wobble.
const hash = (i, seed) => {
  let h = Math.imul(i ^ Math.imul(seed + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
};
const grad = (x, seed) => {
  const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * lerp(hash(i, seed) * f, hash(i + 1, seed) * (f - 1), u);
};
export const noise = (x, seed = 0) => (grad(x, seed) + 0.5 * grad(x * 2.03 + 17.1, seed + 101)) / 1.2;

// The offset of one or more shakes at t: { x, y } in page units and turn in degrees. A shake is { from, to, amount,
// turn, speed, seed, decay }: amount is the size in page units, turn in degrees, speed the wobbles a second (12 to 20
// for a hit, 1 to 3 for a hand-held camera). With decay (the default when it has a "to") it starts at full size and
// dies away by "to", like a hit; decay: false holds it, fading over 0.2 s at an end that was given.
export function shake(t, list) {
  const out = { x: 0, y: 0, turn: 0 };
  for (const [i, o] of (Array.isArray(list) ? list : [list]).entries()) {
    const { from = 0, to = Infinity, amount = 10, turn = 0, speed = 10, seed = i } = o;
    if (t < from || t >= to) continue;
    const decay = o.decay ?? o.to !== undefined;
    const env = decay ? (1 - (t - from) / (to - from)) ** 2
      : Math.min(1, o.from !== undefined ? (t - from) / 0.2 : 1, o.to !== undefined ? (to - t) / 0.2 : 1);
    const s = (t - from) * speed;
    out.x += noise(s, seed * 3) * amount * env; out.y += noise(s, seed * 3 + 1) * amount * env;
    out.turn += noise(s, seed * 3 + 2) * turn * env;
  }
  return out;
}

export function camera({ width = 1920, height = 1080, keys = [[0, {}]], shake: shakes = [], follow = [] } = {}) {
  const W = width, H = height;
  if (!Array.isArray(keys) || !keys.length) throw new Error('camera: keys must be a list of [time, { x, y, zoom, turn }, easing]');
  let prev = { x: W / 2, y: H / 2, zoom: 1, turn: 0 };
  const K = keys.map(([t, v = {}, e], i) => {
    const easing = typeof e === 'function' ? e : EASE[e ?? 'inOutCubic'];
    if (!easing) throw new Error(`camera: key ${i + 1} has an unknown easing "${e}"`);
    if (!Number.isFinite(t) || (i && t < keys[i - 1][0])) throw new Error(`camera: key ${i + 1} must have a time at or after the key before`);
    const { fly, ...values } = v;
    if (fly !== undefined && fly !== true && !(fly > 0)) throw new Error(`camera: key ${i + 1} has fly ${fly}; it is true or a number above 0`);
    prev = { ...prev, ...values };
    if (!(prev.zoom > 0)) throw new Error(`camera: key ${i + 1} needs a zoom above 0`);
    return { t, ...prev, ease: easing, fly: fly === true ? Math.SQRT2 : fly };
  });
  for (let i = 1; i < K.length; i++) if (K[i].fly) K[i].path = flight(K[i - 1], K[i], K[i].fly);
  const follows = (Array.isArray(follow) ? follow : [follow]).map((f, i) => {
    if (typeof f?.target !== 'function') throw new Error(`camera: follow ${i + 1} needs target, a function of t that returns [x, y]`);
    return { from: -Infinity, to: Infinity, blend: 0.3, lag: 0, ...f };
  });
  const ang = turn => -turn * RAD;   // the camera rolls clockwise, so the picture turns anticlockwise

  // The long jump from key a to key b, as a function of the eased progress k: [x, y, zoom]. Views are a centre and a
  // width (W / zoom); rho is how far it pulls out. The same sums as d3.interpolateZoom.
  function flight(a, b, rho) {
    const w0 = W / a.zoom, w1 = W / b.zoom, dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, r2 = rho * rho;
    if (d2 < 1e-9) return k => [a.x, a.y, a.zoom * (b.zoom / a.zoom) ** k];
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d2) / (2 * w0 * r2 * d1), b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d2) / (2 * w1 * r2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1), S = (r1 - r0) / rho;
    return k => {
      const r = rho * k * S + r0, u = w0 / (r2 * d1) * (Math.cosh(r0) * Math.tanh(r) - Math.sinh(r0));
      return [a.x + u * dx, a.y + u * dy, W * Math.cosh(r) / (w0 * Math.cosh(r0))];
    };
  }

  // The camera's own move at t, without shake.
  function keyed(t) {
    if (t < K[0].t) return K[0];
    let i = 1; while (i < K.length && K[i].t <= t) i++;
    if (i === K.length) return K.at(-1);
    const a = K[i - 1], b = K[i], k = b.ease((t - a.t) / (b.t - a.t));
    if (b.path) { const [x, y, zoom] = b.path(k); return { x, y, zoom, turn: lerp(a.turn, b.turn, k) }; }
    const zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), k)), turn = lerp(a.turn, b.turn, k);
    // P is the point the closer end looks at; its place on screen goes from where it is at the other end, Q, to the
    // centre (or back) in a straight line.
    const [P, Q, w] = b.zoom >= a.zoom ? [b, a, 1 - k] : [a, b, k];
    const [sx, sy] = rot(ang(Q.turn), (P.x - Q.x) * Q.zoom, (P.y - Q.y) * Q.zoom);
    const [dx, dy] = rot(-ang(turn), sx * w / zoom, sy * w / zoom);
    return { x: P.x - dx, y: P.y - dy, zoom, turn };
  }

  // The keyed move with the follows on it, without shake.
  function view(t) {
    let v = keyed(t);
    for (const f of follows) {
      if (t <= f.from || t >= f.to) continue;
      const e = f.blend > 0 ? Math.min(1, (t - f.from) / f.blend, (f.to - t) / f.blend) : 1, w = e * e * (3 - 2 * e);
      let tx = 0, ty = 0;
      if (f.lag > 0) {
        for (let j = 0; j < LAG.length; j++) { const [x, y] = f.target(t - f.lag * (j + 0.5) / LAG.length); tx += x * LAG[j]; ty += y * LAG[j]; }
      } else [tx, ty] = f.target(t);
      v = { ...v, x: lerp(v.x, tx, w), y: lerp(v.y, ty, w) };
    }
    return v;
  }

  // The 2D matrix [a, b, c, d, e, f] from the page's units to the frame's, for a layer at this depth (as in
  // ctx.setTransform; for a WebGL page, the same as a 3x3 matrix).
  function matrix(t, depth = 1) {
    const v = view(t), s = shake(t, shakes);
    const z = v.zoom ** depth, a = ang(v.turn + s.turn), cos = Math.cos(a) * z, sin = Math.sin(a) * z;
    const cx = W / 2 + (v.x - W / 2) * depth, cy = H / 2 + (v.y - H / 2) * depth;
    return [cos, sin, -sin, cos, W / 2 + s.x - (cos * cx - sin * cy), H / 2 + s.y - (sin * cx + cos * cy)];
  }
  const map = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const unmap = (m, X, Y) => {
    const det = m[0] * m[3] - m[1] * m[2], x = X - m[4], y = Y - m[5];
    return [(m[3] * x - m[2] * y) / det, (m[0] * y - m[1] * x) / det];
  };

  return {
    // Where the camera looks at t, shake included: { x, y, zoom, turn }.
    at(t) {
      const v = view(t), s = shake(t, shakes), turn = v.turn + s.turn, [dx, dy] = rot(-ang(turn), s.x / v.zoom, s.y / v.zoom);
      return { x: v.x - dx, y: v.y - dy, zoom: v.zoom, turn };
    },
    matrix,
    // Sets ctx to draw in the page's units through the camera. scale is the page's ?scale=.
    apply(ctx, t, { scale = 1, depth = 1 } = {}) {
      const m = matrix(t, depth);
      ctx.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale);
    },
    // Where a point of the page lands in the frame at t, in page units: for a label drawn at its own size next to
    // something the camera zooms in on.
    point: (t, x, y, depth = 1) => map(matrix(t, depth), x, y),
    // How fast the picture moves at t, in page units a second: the fastest of the frame's corners. For motion blur on
    // fast moves only: samples = Math.min(32, Math.ceil(cam.speed(t) * shutter / 4)), a sample every 4 units or less.
    speed(t, depth = 1) {
      const h = 1 / 480, m = matrix(t, depth), m0 = matrix(t - h, depth), m1 = matrix(t + h, depth);
      let top = 0;
      for (const [X, Y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const [x, y] = unmap(m, X, Y), [x0, y0] = map(m0, x, y), [x1, y1] = map(m1, x, y);
        top = Math.max(top, Math.hypot(x1 - x0, y1 - y0) / (2 * h));
      }
      return top;
    },
  };
}
