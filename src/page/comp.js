// Animation that touches real footage, for scene pages: tracks made by skills/motlab/scripts/track.py, and a WebGL
// compositor that draws the footage with warps (ripple, shockwave, bulge, swirl, push, crack) and lays canvases on it
// at tracked places, matched to the shot (levels, tint, grain, motion blur, light wrap, a contact shadow).
// Served at /__motlab/comp.js by the renderer and the viewer.
//
//   const { loadTrack, compositor, quad } = await import('/__motlab/comp.js');
//   const track = await loadTrack('../footage/phone.track.json');
//   const comp = compositor({ width: W, height: H, scale: S });
//   // in renderAt, with ct the time in the clip and fit where the clip is drawn on the page ([x, y, w, h]):
//   comp.footage(await clip.frame(ct), { fit, warps: [{ type: 'ripple', x: 960, y: 540, age: t - 1 }] });
//   comp.layer(ui, { at: track.plane('screen', ct, fit), match: { levels: 0.5, grain: 'auto', wrap: 0.3 } });
//   ctx.drawImage(comp.canvas, 0, 0);
//
// Everything the compositor takes is in page units, like the rest of the page; track values are in the clip's pixels
// until a fit is given.

// ------------------------------------------------------------------ tracks
const ident = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a, b) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const applyH = (H, [x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}
// the homography from the unit square (0,0) (1,0) (1,1) (0,1) to four corners (Heckbert)
export function squareTo(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
// the homography taking four corners a to four corners b
export const homography = (a, b) => mul(squareTo(b), inv(squareTo(a)));

// corners of a w x h box at x, y (its anchor point, 0.5 0.5 = the middle), turned by angle (radians) and scaled
export function quad(x, y, w, h, { angle = 0, scale = 1, anchor = [0.5, 0.5] } = {}) {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
    const dx = (u - anchor[0]) * w, dy = (v - anchor[1]) * h;
    return [x + dx * c - dy * s, y + dx * s + dy * c];
  });
}

// the same four corners with each edge moved outward by d page units (inward when d < 0): a layer that covers a
// screen reaches a little under its bezel, so no sliver of the old screen shows at the edge
export function grow(q, d) {
  const n = q.length, area = q.reduce((a, p, i) => a + p[0] * q[(i + 1) % n][1] - q[(i + 1) % n][0] * p[1], 0), side = Math.sign(area) || 1;
  const lines = q.map((p, i) => {   // each edge, pushed out along its normal
    const r = q[(i + 1) % n], dx = r[0] - p[0], dy = r[1] - p[1], l = Math.hypot(dx, dy) || 1, nx = dy / l * side, ny = -dx / l * side;
    return [[p[0] + nx * d, p[1] + ny * d], [dx, dy]];
  });
  return q.map((_, i) => {   // a corner is where its two edges meet
    const [[ax, ay], [adx, ady]] = lines[(i + n - 1) % n], [[bx, by], [bdx, bdy]] = lines[i], den = adx * bdy - ady * bdx;
    if (Math.abs(den) < 1e-9) return [bx, by];
    const k = ((bx - ax) * bdy - (by - ay) * bdx) / den;
    return [ax + adx * k, ay + ady * k];
  });
}

// A track file from track.py. Times are seconds into the clip (the same time given to clip.frame). Each value is the
// one of the frame shown at that time, so it stays on the picture; a frame where the track was lost takes the
// nearest frame that was not, and outside the tracked part the nearest end. fit = [x, y, w, h], where the clip is
// drawn on the page, turns clip pixels into page units.
export async function loadTrack(path) {
  const r = await fetch(new URL(path, document.baseURI));
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const d = await r.json(), times = d.times;
  const frame = t => { let lo = 0, hi = times.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t + 1e-6) lo = m; else hi = m - 1; } return lo; };
  const KEY = { plane: 'corners', points: 'points', camera: 'matrix' };
  function raw(name, t) {
    const tr = d.tracks[name];
    if (!tr) throw new Error(`${path} has no track "${name}" (it has ${Object.keys(d.tracks).join(', ')})`);
    const v = tr[KEY[tr.kind]], k = Math.min(Math.max(frame(t) - tr.first, 0), v.length - 1);
    for (let i = 0; i < v.length; i++) for (const j of [k - i, k + i]) if (v[j]) return { tr, v: v[j], i: j };
    throw new Error(`${path}: track "${name}" was lost in every frame`);
  }
  const toPage = (fit, p) => fit ? [fit[0] + p[0] * fit[2] / d.width, fit[1] + p[1] * fit[3] / d.height] : p;
  const pairs = v => v.reduce((a, x, i) => (i % 2 ? a[a.length - 1].push(x) : a.push([x]), a), []);
  // the homography from the track's first frame to time t, in clip pixels
  function moved(name, t) {
    const { tr, v } = raw(name, t);
    if (tr.kind === 'camera') return v;
    const first = tr[KEY[tr.kind]].find(Boolean);
    if (tr.kind === 'plane') return homography(pairs(first), pairs(v));
    const [a, b] = [pairs(first), pairs(v)];   // points: a move, and with two a scale and a turn
    if (a.length < 2) return [1, 0, b[0][0] - a[0][0], 0, 1, b[0][1] - a[0][1], 0, 0, 1];
    const ax = a[1][0] - a[0][0], ay = a[1][1] - a[0][1], bx = b[1][0] - b[0][0], by = b[1][1] - b[0][1];
    const k = Math.hypot(bx, by) / Math.hypot(ax, ay), th = Math.atan2(by, bx) - Math.atan2(ay, ax), c = k * Math.cos(th), s = k * Math.sin(th);
    return [c, -s, b[0][0] - c * a[0][0] + s * a[0][1], s, c, b[0][1] - s * a[0][0] - c * a[0][1], 0, 0, 1];
  }
  return {
    width: d.width, height: d.height, fps: d.fps, times, tracks: d.tracks, frame,
    plane: (name, t, fit) => pairs(raw(name, t).v).map(p => toPage(fit, p)),
    points: (name, t, fit) => pairs(raw(name, t).v).map(p => toPage(fit, p)),
    // 0 to 1 at the frame shown at t, and 0 where the track was lost or did not reach
    confidence: (name, t) => { const tr = raw(name, t).tr; return tr.confidence[frame(t) - tr.first] ?? 0; },
    // corners at the shutter's opening and closing, for a layer's motion blur: fn(time) gives the corners at a time
    // in the clip (track.plane, carry or quad around points), taken from the frames before and after the one shown.
    // open: how much of a frame the shutter is open (0.5, a 180 degree shutter, is the usual).
    shutter(fn, t, open = 0.5) {
      const k = frame(t), a = fn(times[k]), b = fn(times[Math.max(0, k - 1)]), c = fn(times[Math.min(times.length - 1, k + 1)]);
      const lerp = (p, q, f) => p.map((v, i) => [v[0] + (q[i][0] - v[0]) * f, v[1] + (q[i][1] - v[1]) * f]);
      return { from: lerp(a, b, open / 2), to: lerp(a, c, open / 2) };
    },
    // points given in the track's first frame (clip pixels), where the track has carried them by time t: a label
    // beside a tracked screen, a mark on a wall that the camera track moves
    carry: (name, t, pts, fit) => { const H = moved(name, t); return pts.map(p => toPage(fit, applyH(H, p))); },
    // position, scale and turn of a points track (one or two points) or a plane, against its first frame: for a
    // Canvas 2D page (ctx.translate, rotate, scale). x, y is the first point (a plane's middle), in page units with fit.
    pose(name, t, fit) {
      const { tr, v } = raw(name, t), H = moved(name, t);
      const at = tr.kind === 'plane' ? pairs(v).reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]) : pairs(v)[0];
      const sx = fit ? fit[2] / d.width : 1, sy = fit ? fit[3] / d.height : 1;
      return { x: toPage(fit, at)[0], y: toPage(fit, at)[1], scale: Math.sqrt(Math.abs(H[0] * H[4] - H[1] * H[3])) / H[8], angle: Math.atan2(H[3] * sy, H[0] * sx) };
    },
  };
}

// ------------------------------------------------------------------ the compositor
const VERT = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
uniform vec2 uSize; uniform float uScale;
out vec4 o;
const float TAU = 6.28318531;
vec2 pagePos() { return vec2(gl_FragCoord.x, uSize.y * uScale - gl_FragCoord.y) / uScale; }
float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }
`;

const WARPS = { ripple: 1, shockwave: 2, bulge: 3, swirl: 4, push: 5, crack: 6 };
const MAX_WARPS = 8;

const FOOTAGE = COMMON + `
uniform sampler2D uTex; uniform vec4 uRect; uniform int uN; uniform vec4 uW[${MAX_WARPS * 3}];
vec2 warp(vec2 p, out float shade, out float split) {
  vec2 off = vec2(0.0); shade = 0.0; split = 0.0;
  for (int i = 0; i < ${MAX_WARPS}; i++) {
    if (i >= uN) break;
    vec4 a = uW[i * 3], b = uW[i * 3 + 1], c = uW[i * 3 + 2];
    int type = int(a.x); vec2 d = p - a.yz; float age = a.w, r = length(d);
    vec2 dir = r > 1e-4 ? d / r : vec2(0.0);
    if (type == 1) {            // ripple: amp, wavelength, speed, decay | rings, shine
      float x = (b.z * age - r) / b.y;                       // wavelengths behind the front
      if (age > 0.0 && x > 0.0 && x < c.x) {
        float env = sin(3.14159265 * x / c.x) * exp(-b.w * age) * inversesqrt(1.0 + r / b.y) * smoothstep(0.0, b.y, r);
        off -= dir * b.x * env * cos(TAU * x);
        shade += c.y * env * sin(TAU * x);
      }
    } else if (type == 2) {     // shockwave: amp, width, speed, decay | split
      float x = (r - b.z * age) / b.y, g = x * exp(-x * x) * exp(-b.w * max(age, 0.0));
      if (age > 0.0) { off -= dir * b.x * g * 1.65; split += abs(g) * c.x; shade += 0.15 * g; }
    } else if (type == 3) {     // bulge: amount (+ magnify, - pinch), radius
      float s = r / b.y;
      if (s < 1.0) off -= d * b.x * (1.0 - s) * (1.0 - s);
    } else if (type == 4) {     // swirl: angle in radians, radius
      float s = r / b.y;
      if (s < 1.0) { float th = b.x * (1.0 - s) * (1.0 - s), cs = cos(th), sn = sin(th); off += vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y) - d; }
    } else if (type == 5) {     // push: dx, dy, radius (0 = everywhere)
      float s = b.z > 0.0 ? r / b.z : 0.0;
      if (s < 1.0) { float f = (1.0 - s * s); off -= b.xy * f * f; }
    } else if (type == 6) {     // crack: radius, shift, cracks, darkness | seed
      float R = b.x;
      if (R > 0.0 && r < R) {
        float n = max(floor(b.z), 3.0), th = atan(d.y, d.x) + 3.14159265, sec = TAU / n;
        // straight cracks out from the middle, each at its own angle and bending a little as it goes
        float s0 = floor(th / sec), best = 1e9, side = 0.0;
        for (int k = -1; k <= 2; k++) {
          float sk = mod(s0 + float(k), n), a = (sk + 0.2 + 0.6 * hash(vec2(sk, c.x))) * sec;
          a += 0.05 * sin(r / R * (6.0 + 6.0 * hash(vec2(sk, c.x + 1.0))) + sk);
          float da = mod(th - a + 3.14159265, TAU) - 3.14159265;
          if (abs(da) < abs(best)) best = da;
          if (da > 0.0) side = sk;          // the crack just below this angle: the shard is between it and the next
        }
        float id = mod(s0 + (best > 0.0 ? 0.0 : -1.0), n);
        // broken rings across each shard, at radii that differ from shard to shard
        float ring = 0.0, rl = 1e9;
        for (int k = 1; k <= 3; k++) {
          float rr = R * (0.18 + 0.27 * float(k - 1)) * (0.8 + 0.4 * hash(vec2(id, float(k) + c.x)));
          if (hash(vec2(id * 3.0 + float(k), c.x)) < 0.75) { rl = min(rl, abs(r - rr)); if (r > rr) ring = float(k); }
        }
        float w = 0.9 + 1.3 * (1.0 - r / R), fade = 1.0 - smoothstep(0.7, 1.0, r / R);
        float line = max(1.0 - smoothstep(0.0, w, r * abs(best)), 1.0 - smoothstep(0.0, w, rl)) * fade;
        vec2 h = hash2(vec2(id, ring) + c.x) - 0.5;
        off -= (dir * (0.5 + hash(vec2(id + 9.0, ring))) + h) * b.y * fade * smoothstep(0.0, 0.12 * R, r);
        shade -= b.w * line;
        shade += 0.35 * b.w * (1.0 - smoothstep(0.0, w * 2.5, r * abs(best - 0.004))) * fade * step(0.0, best);   // a bright glint along one side
      }
    }
  }
  return off;
}
vec4 foot(vec2 q) {
  vec2 uv = (q - uRect.xy) / uRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(uTex, uv);
}
void main() {
  vec2 p = pagePos(); float shade, split;
  vec2 off = warp(p, shade, split);
  vec4 c = foot(p + off);
  if (split > 0.001) { c.r = foot(p + off * (1.0 + split)).r; c.b = foot(p + off * (1.0 - split)).b; }
  c.rgb = clamp(c.rgb * (1.0 + shade), 0.0, 1.0) * c.a;
  o = c;
}`;

const LAYER = COMMON + `
uniform sampler2D uTex, uFoot; uniform mat3 uInv0, uInv1; uniform int uSamples, uMode;
uniform float uOpacity, uLevels, uTintAmt, uGrain, uGrainPx, uSeed, uWrap, uWrapLod, uFootLod, uShadowLod;
uniform vec3 uBlack, uWhite, uTint; uniform vec4 uFootRect;
vec2 uvAt(mat3 m, vec2 p) { vec3 h = m * vec3(p, 1.0); return h.xy / h.z; }
bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
float cover(vec2 uv) {            // how much of this pixel the layer covers at its edges
  vec2 fw = max(fwidth(uv), vec2(1e-6)), e = min(uv, 1.0 - uv) / fw + 0.5;
  return clamp(e.x, 0.0, 1.0) * clamp(e.y, 0.0, 1.0);
}
void main() {
  vec2 p = pagePos();
  if (uMode == 1) {             // contact shadow: the layer's alpha, blurred, as black
    vec2 uv = uvAt(uInv0, p);
    float a = inside(uv) ? textureLod(uTex, uv, uShadowLod).a : 0.0;
    o = vec4(0.0, 0.0, 0.0, a * uOpacity); return;
  }
  vec4 c = vec4(0.0);
  for (int k = 0; k < 32; k++) {   // motion blur: the layer where it was across the shutter
    if (k >= uSamples) break;
    float f = (float(k) + 0.5) / float(uSamples);
    vec3 h = mix(uInv0 * vec3(p, 1.0), uInv1 * vec3(p, 1.0), f);
    vec2 uv = h.xy / h.z;
    if (h.z > 0.0) c += texture(uTex, clamp(uv, 0.0, 1.0)) * cover(uv);
  }
  c /= float(uSamples);
  if (c.a < 1e-4) discard;
  vec3 rgb = c.rgb / c.a;
  rgb = mix(rgb, uBlack + rgb * (uWhite - uBlack), uLevels);
  rgb = mix(rgb, rgb * uTint, uTintAmt);
  if (uWrap > 0.0) {             // light wrap: the footage's light over the layer's edges
    vec2 uv = uvAt(uInv0, p);
    float edge = 1.0 - textureLod(uTex, clamp(uv, 0.0, 1.0), uWrapLod).a;
    vec3 bg = textureLod(uFoot, (p - uFootRect.xy) / uFootRect.zw, uFootLod).rgb;
    rgb = mix(rgb, 1.0 - (1.0 - rgb) * (1.0 - bg), clamp(uWrap * edge * 2.0, 0.0, 1.0));
  }
  if (uGrain > 0.0) {            // grain on the footage's own pixel grid, new every frame
    vec2 cell = floor(gl_FragCoord.xy / uGrainPx);
    float n = (hash(cell + uSeed) + hash(cell + uSeed + 71.3) + hash(cell + uSeed + 143.9) - 1.5) * 2.0;
    rgb += n * uGrain;
  }
  o = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a) * uOpacity;
}`;

// The footage's light: its darkest and brightest colours (2nd and 98th percentile of brightness), its mean colour,
// and its noise (Immerkaer 1996, on a crop at the clip's own size), measured on the CPU from small copies.
function measure(src, sw, sh, noise, [rx, ry, rw, rh] = [0, 0, sw, sh]) {
  const s = measure.c ||= new OffscreenCanvas(64, 36), g = s.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, 64, 36);
  g.drawImage(src, rx, ry, rw, rh, 0, 0, 64, 36);
  const px = g.getImageData(0, 0, 64, 36).data, n = 64 * 36, lum = new Float32Array(n);
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) mean[k] += px[i * 4 + k] / 255 / n;
    lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  }
  const order = [...lum.keys()].sort((a, b) => lum[a] - lum[b]);
  const avg = ids => [0, 1, 2].map(k => ids.reduce((sum, i) => sum + px[i * 4 + k], 0) / ids.length / 255);
  const tail = Math.max(1, Math.round(n * 0.02));
  const out = { black: avg(order.slice(0, tail)), white: avg(order.slice(-tail)), mean };
  if (noise) {
    const W = Math.round(Math.min(256, rw)), H = Math.round(Math.min(256, rh)), c = measure.n ||= new OffscreenCanvas(256, 256), q = c.getContext('2d', { willReadFrequently: true });
    q.drawImage(src, rx + (rw - W) / 2, ry + (rh - H) / 2, W, H, 0, 0, W, H);
    const a = q.getImageData(0, 0, W, H).data, L = (x, y) => (a[(y * W + x) * 4] * 0.2126 + a[(y * W + x) * 4 + 1] * 0.7152 + a[(y * W + x) * 4 + 2] * 0.0722) / 255;
    let sum = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++)
      sum += Math.abs(L(x - 1, y - 1) - 2 * L(x, y - 1) + L(x + 1, y - 1) - 2 * L(x - 1, y) + 4 * L(x, y) - 2 * L(x + 1, y) + L(x - 1, y + 1) - 2 * L(x, y + 1) + L(x + 1, y + 1));
    out.noise = Math.sqrt(Math.PI / 2) * sum / (6 * (W - 2) * (H - 2));
  }
  return out;
}

// A WebGL2 canvas of the page's size that draws footage and layers in the order they are given, every frame:
// footage() first, then layer() for each canvas laid on it, then copy comp.canvas onto the page's canvas.
export function compositor({ width, height, scale = 1 }) {
  let cv, gl, prog, texFoot, pool, used, foot, light;
  function init() {
    cv = document.createElement('canvas'); cv.width = Math.round(width * scale); cv.height = Math.round(height * scale);
    gl = cv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('comp.js needs WebGL2');
    const build = frag => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`comp.js shader: ${gl.getShaderInfoLog(s)}`);
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`comp.js: ${gl.getProgramInfoLog(p)}`);
      const loc = new Map(), u = n => loc.has(n) ? loc.get(n) : (loc.set(n, gl.getUniformLocation(p, n)), loc.get(n));
      return { p, u };
    };
    prog = { foot: build(FOOTAGE), layer: build(LAYER) };
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    texFoot = texture(); pool = []; used = 0;
  }
  function texture() {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  function upload(t, src) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  function common(P) {
    gl.useProgram(P.p); gl.viewport(0, 0, cv.width, cv.height);
    gl.uniform2f(P.u('uSize'), width, height); gl.uniform1f(P.u('uScale'), scale);
  }
  // a frame from clip.frame() (rotation and flip applied as f.draw does), or any canvas or image
  function source(f) {
    const w = f.displayWidth ?? f.width, h = f.displayHeight ?? f.height;
    if (typeof f.toCanvasImageSource !== 'function') return { src: f, w, h };
    if (!f.rotation && !f.flip && w === f.codedWidth && h === f.codedHeight) return { src: f.toCanvasImageSource(), w, h };
    const c = source.c ||= new OffscreenCanvas(w, h);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    f.draw(c.getContext('2d'), 0, 0, w, h);
    return { src: c, w, h };
  }
  init();
  let seed = 0;
  return {
    get canvas() { return cv; },
    // Draws footage under everything else and starts a frame. fit: [x, y, w, h] in page units (default the whole
    // page). warps: [{ type, x, y, age, ... }] in page units, age in seconds since the warp began (see WARP_DEFAULTS).
    // noise: measure the footage's noise too, for layers with grain: 'auto'. region: [x, y, w, h] in page units, the
    // part of the footage whose light the layers match (default all of it); leave out a green screen or a sky.
    // frame: a number that changes every frame (track.frame(t)), so the grain changes with the footage's.
    footage(f, { fit = [0, 0, width, height], warps = [], noise = false, region, frame = 0 } = {}) {
      if (gl.isContextLost()) init();
      used = 0; seed = frame;
      const { src, w, h } = source(f);
      const r = region && [(region[0] - fit[0]) * w / fit[2], (region[1] - fit[1]) * h / fit[3], region[2] * w / fit[2], region[3] * h / fit[3]];
      light = measure(src, w, h, noise, r);
      upload(texFoot, src);
      foot = { fit, w, h };
      gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const P = prog.foot; common(P);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFoot); gl.uniform1i(P.u('uTex'), 0);
      gl.uniform4f(P.u('uRect'), ...fit);
      if (warps.length > MAX_WARPS) throw new Error(`comp.js draws at most ${MAX_WARPS} warps at once`);
      const W = new Float32Array(MAX_WARPS * 12);
      warps.forEach((w, i) => W.set(packWarp(w), i * 12));
      gl.uniform1i(P.u('uN'), warps.length); gl.uniform4fv(P.u('uW'), W);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return light;
    },
    // Lays a canvas (or image) on the frame at corners `at` (four [x, y] in page units, top left first, clockwise).
    // from / to: the corners at the shutter's opening and closing, for motion blur (samples, default 8).
    // match: { levels, tint, grain, wrap } from 0 to 1 (grain 'auto' takes the footage's measured noise, which
    // footage() measures with noise: true). shadow: { opacity, blur } draws the layer's shape as a soft dark shadow
    // instead of the layer. blend: 'normal' or 'add'.
    layer(img, { at, from, to, samples = from && to ? 8 : 1, opacity = 1, match = {}, shadow, blend = 'normal' } = {}) {
      if (!foot) throw new Error('comp.js: call footage() first in each frame');
      if (!at) throw new Error('comp.js: layer() needs at: four corners');
      const t = pool[used] ||= texture(); used++;
      upload(t, img);
      const P = prog.layer; common(P);
      gl.enable(gl.BLEND);
      if (blend === 'add') gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(P.u('uTex'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texFoot); gl.uniform1i(P.u('uFoot'), 1);
      const m3 = q => { const m = inv(squareTo(q)); return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; };   // column-major
      gl.uniformMatrix3fv(P.u('uInv0'), false, m3(from || at)); gl.uniformMatrix3fv(P.u('uInv1'), false, m3(to || at));
      gl.uniform1i(P.u('uSamples'), Math.max(1, Math.min(32, samples)));
      gl.uniform1i(P.u('uMode'), shadow ? 1 : 0);
      gl.uniform1f(P.u('uOpacity'), shadow ? (shadow.opacity ?? 0.5) * opacity : opacity);
      const iw = img.width, side = Math.hypot(at[1][0] - at[0][0], at[1][1] - at[0][1]) * scale;   // layer pixels per device pixel
      const lod = px => Math.max(0, Math.log2(Math.max(1e-3, px * scale * iw / Math.max(side, 1))));
      gl.uniform1f(P.u('uShadowLod'), lod(shadow?.blur ?? 6));
      const tint = light.mean, l = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2] || 1;
      gl.uniform1f(P.u('uLevels'), match.levels || 0); gl.uniform3fv(P.u('uBlack'), light.black); gl.uniform3fv(P.u('uWhite'), light.white);
      gl.uniform1f(P.u('uTintAmt'), match.tint || 0); gl.uniform3fv(P.u('uTint'), tint.map(v => Math.min(1.5, Math.max(0.5, v / l))));
      const grain = match.grain === 'auto' ? (light.noise ?? (() => { throw new Error("comp.js: grain 'auto' needs footage(f, { noise: true })"); })()) : (match.grain || 0);
      gl.uniform1f(P.u('uGrain'), grain); gl.uniform1f(P.u('uGrainPx'), Math.max(1, foot.fit[2] * scale / foot.w)); gl.uniform1f(P.u('uSeed'), (seed * 7.31) % 1000);
      const wrapPx = match.wrapSize ?? 12;   // page units
      gl.uniform1f(P.u('uWrap'), match.wrap || 0); gl.uniform1f(P.u('uWrapLod'), lod(wrapPx));
      gl.uniform1f(P.u('uFootLod'), Math.max(0, Math.log2(wrapPx * foot.w / foot.fit[2]))); gl.uniform4f(P.u('uFootRect'), ...foot.fit);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    },
  };
}

// Defaults for each warp, in page units and seconds; any can be given in the warp's object.
export const WARP_DEFAULTS = {
  ripple: { amp: 6, wavelength: 40, speed: 260, decay: 1.2, rings: 4, shine: 0.15 },
  shockwave: { amp: 30, width: 40, speed: 900, decay: 2.5, split: 0.15 },
  bulge: { amount: 0.4, radius: 200 },
  swirl: { angle: 2, radius: 220 },
  push: { dx: 0, dy: 0, radius: 0 },
  crack: { radius: 300, shift: 4, cracks: 11, darkness: 0.6, seed: 1 },
};
function packWarp(w) {
  const type = WARPS[w.type];
  if (!type) throw new Error(`comp.js: unknown warp "${w.type}" (${Object.keys(WARPS).join(', ')})`);
  const o = { ...WARP_DEFAULTS[w.type], ...w }, age = w.age ?? 0;
  const p = {
    ripple: [[o.amp, o.wavelength, o.speed, o.decay], [o.rings, o.shine, 0, 0]],
    shockwave: [[o.amp, o.width, o.speed, o.decay], [o.split, 0, 0, 0]],
    bulge: [[o.amount, o.radius, 0, 0], [0, 0, 0, 0]],
    swirl: [[o.angle, o.radius, 0, 0], [0, 0, 0, 0]],
    push: [[o.dx, o.dy, o.radius, 0], [0, 0, 0, 0]],
    crack: [[o.radius, o.shift, o.cracks, o.darkness], [o.seed, 0, 0, 0]],
  }[w.type];
  return [type, w.x ?? 0, w.y ?? 0, age, ...p[0], ...p[1]];
}
