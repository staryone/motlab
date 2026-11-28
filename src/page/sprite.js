// Sprites for scene pages: a sprite sheet or an Aseprite export played at the frame worked out from t, and sprite
// stacks, an object drawn as horizontal slices one above another so a flat picture reads as solid when it turns.
// Served by the render server and the viewer at /__motlab/sprite.js:
//
//   const { loadSprite, loadStack } = await import('/__motlab/sprite.js');
//   const hero = await loadSprite('../sprites/hero.json');                         // Aseprite's sprite sheet JSON
//   const coin = await loadSprite('../sprites/coin.png', { frames: 8, fps: 12 });   // equal frames in a row or grid
//   hero.draw(ctx, t, 960, 900, { tag: 'run', scale: 6 });                          // feet (anchor) at 960, 900
//   const car = await loadStack('../assets/car.stack.json');                        // from motlab-assets' slices.py
//   car.draw(ctx, 960, 600, { angle: 40 * t, scale: 8 });
//
// Paths are relative to the page, like an <img src>. Pixel art stays sharp: drawing is not smoothed unless
// { smooth: true }. Everything drawn is a function of t, so frames can be drawn in any order.

// ---- sprite sheets --------------------------------------------------------------------------------------------------

// The frames a tag plays, in order, and how often: Aseprite's rules (src/doc/playback.cpp). pingpong shows each end
// once a round (from..to, then to-1..from+1). repeat (Aseprite writes it as a string, and only when above 0) is the
// number of passes, a pingpong pass being one way; after them the last frame holds. Without it the tag loops.
export function tagFrames({ from, to, direction = 'forward', repeat }) {
  const up = [], down = [];
  for (let i = from; i <= to; i++) up.push(i);
  for (let i = to; i >= from; i--) down.push(i);
  const passes = Number(repeat) > 0 ? Number(repeat) : 0;
  if (direction === 'forward' || direction === 'reverse') {
    const one = direction === 'forward' ? up : down;
    return { loop: passes ? null : one, once: passes ? Array.from({ length: passes }, () => one).flat() : null };
  }
  if (direction !== 'pingpong' && direction !== 'pingpong_reverse') throw new Error(`sprite: unknown tag direction "${direction}"`);
  const [a, b] = direction === 'pingpong' ? [up, down] : [down, up];
  if (!passes) return { loop: up.length < 2 ? a : [...a, ...b.slice(1, -1)], once: null };
  const once = [...a];
  for (let p = 1; p < passes; p++) once.push(...(p % 2 ? b : a).slice(1));
  return { loop: null, once };
}

// The frame shown at t seconds into a tag: list is frame indices, ms their durations in milliseconds.
export function frameAt(t, { loop, once }, ms) {
  const list = loop || once, total = list.reduce((s, f) => s + ms[f], 0);
  let at = Math.max(0, t * 1000);
  if (loop) at %= total;
  else if (at >= total) return list.at(-1);
  for (const f of list) { if (at < ms[f]) return f; at -= ms[f]; }
  return list.at(-1);
}

// The frames of an Aseprite JSON export (hash or array form) as { x, y, w, h, ox, oy, sw, sh, ms }: where the frame is
// in the sheet, where its trimmed box sits in the full frame, the full frame's size and its duration.
export function asepriteFrames(data) {
  const list = Array.isArray(data.frames) ? data.frames : Object.values(data.frames || {});
  if (!list.length) throw new Error('sprite: the JSON has no frames (export it from Aseprite with JSON data)');
  return list.map(f => ({ x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, ox: f.spriteSourceSize?.x ?? 0, oy: f.spriteSourceSize?.y ?? 0,
    sw: f.sourceSize?.w ?? f.frame.w, sh: f.sourceSize?.h ?? f.frame.h, ms: f.duration ?? 100 }));
}

const loadImage = async url => {
  const img = new Image(); img.src = url;
  try { await img.decode(); } catch { throw new Error(`sprite: could not load the image ${decodeURIComponent(url)}`); }
  return img;
};

// path: an Aseprite sprite sheet JSON (its "image" next to it), or an image of equal frames. For an image, give
// frames (how many), and cols (frames a row, default all of them in one row) or the frame's width and height; fps sets
// how long each shows (12 by default).
export async function loadSprite(path, { frames, cols, width, height, fps = 12 } = {}) {
  const url = new URL(path, document.baseURI);
  let img, list, tags = {};
  if (/\.json$/i.test(url.pathname)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sprite: ${path} answered ${res.status}`);
    const data = await res.json();
    list = asepriteFrames(data);
    img = await loadImage(new URL(data.meta?.image || url.pathname.replace(/\.json$/i, '.png'), url));
    for (const tag of data.meta?.frameTags || []) tags[tag.name] = tagFrames(tag);
  } else {
    img = await loadImage(url);
    const n = frames || 1, c = cols || n, w = width || img.naturalWidth / c, h = height || img.naturalHeight / Math.ceil(n / c);
    list = Array.from({ length: n }, (_, i) => ({ x: (i % c) * w, y: Math.floor(i / c) * h, w, h, ox: 0, oy: 0, sw: w, sh: h, ms: 1000 / fps }));
  }
  const all = tagFrames({ from: 0, to: list.length - 1 }), ms = list.map(f => f.ms);
  const at = (t, tag) => {
    if (tag !== undefined && !tags[tag]) throw new Error(`sprite: no tag "${tag}" (tags: ${Object.keys(tags).join(', ') || 'none'})`);
    return frameAt(t, tag === undefined ? all : tags[tag], ms);
  };
  return {
    image: img, frames: list, tags: Object.keys(tags),
    width: list[0].sw, height: list[0].sh,
    duration: ms.reduce((s, v) => s + v, 0) / 1000,
    // The index of the frame shown at t, in a tag or across all frames, looping.
    frameAt: at,
    // Draws the frame at t with its anchor (fractions of the full frame, [0.5, 1] being the middle of the bottom) at
    // x, y. scale is page units a sprite pixel; flip mirrors it left to right.
    draw(ctx, t, x, y, { tag, frame, scale = 1, anchor = [0.5, 1], flip = false, smooth = false, alpha = 1 } = {}) {
      const f = list[frame ?? at(t, tag)];
      ctx.save();
      ctx.imageSmoothingEnabled = smooth; ctx.globalAlpha *= alpha;
      ctx.translate(x, y); ctx.scale(flip ? -scale : scale, scale);
      ctx.drawImage(img, f.x, f.y, f.w, f.h, f.ox - anchor[0] * f.sw, f.oy - anchor[1] * f.sh, f.w, f.h);
      ctx.restore();
    },
  };
}

// ---- sprite stacks --------------------------------------------------------------------------------------------------

// path: a .stack.json from motlab-assets' slices.py, or an image of slices of equal size (give slices, the number; they
// sit in a row unless vertical: true, bottom slice first unless topFirst: true, as some exporters write them; check a
// still). shade darkens the bottom slice by that fraction and the ones above less, so the height reads.
export async function loadStack(path, { slices, vertical = false, topFirst = false, shade = 0 } = {}) {
  const url = new URL(path, document.baseURI);
  let img, n = slices, info = { vertical, topFirst };
  if (/\.json$/i.test(url.pathname)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stack: ${path} answered ${res.status}`);
    const data = await res.json();
    img = await loadImage(new URL(data.image, url));
    n = data.slices; info = { vertical: data.layout === 'column', topFirst: data.order === 'top-first' };
  } else img = await loadImage(url);
  if (!(n >= 1)) throw new Error('stack: say how many slices the image holds ({ slices: n })');
  const w = info.vertical ? img.naturalWidth : img.naturalWidth / n, d = info.vertical ? img.naturalHeight / n : img.naturalHeight;
  // Each slice on its own small canvas, bottom first, shaded once here rather than every frame.
  const cut = Array.from({ length: n }, (_, i) => {
    const k = info.topFirst ? n - 1 - i : i, c = document.createElement('canvas');
    c.width = w; c.height = d;
    const g = c.getContext('2d');
    g.drawImage(img, info.vertical ? 0 : k * w, info.vertical ? k * d : 0, w, d, 0, 0, w, d);
    const dark = shade * (1 - i / Math.max(1, n - 1));
    if (dark > 0) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = `rgba(0,0,0,${dark})`; g.fillRect(0, 0, w, d); }
    return c;
  });
  return {
    slices: n, width: w, depth: d,
    // Draws the stack with the middle of its bottom slice at x, y. angle turns it (degrees, clockwise seen from above),
    // scale is page units a voxel, spacing the slices' step up the screen in voxels (1 is the usual look), squash
    // flattens the slices up and down (1 keeps them as drawn; 0.7 looks more from the side). With a camera that rolls,
    // pass its turn (cam.at(t).turn) so the slices still step straight up the screen.
    draw(ctx, x, y, { angle = 0, scale = 1, spacing = 1, squash = 1, turn = 0, smooth = false, alpha = 1 } = {}) {
      const m = ctx.getTransform(), px = Math.hypot(m.a, m.b) * scale * spacing;   // device pixels a slice step
      const fill = Math.max(1, Math.min(16, Math.ceil(px)));   // draw each slice this often so no gap shows between them
      ctx.save();
      ctx.imageSmoothingEnabled = smooth; ctx.globalAlpha *= alpha;
      ctx.translate(x, y); ctx.rotate(turn * Math.PI / 180);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < fill; k++) {
          ctx.save();
          ctx.translate(0, -(i + k / fill) * spacing * scale); ctx.scale(1, squash);
          ctx.rotate((angle - turn) * Math.PI / 180); ctx.scale(scale, scale);
          ctx.drawImage(cut[i], -w / 2, -d / 2);
          ctx.restore();
        }
      }
      ctx.restore();
    },
  };
}
