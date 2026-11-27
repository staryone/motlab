// Overlays: modules drawn over the video from one time to another, over scenes and transitions alike, such as a lower
// third, a logo or a progress bar. The renderer (Node and the in-page runtime) and the viewer use this file. In
// project.json:
//   "overlays": [{ "layer": "overlays/lower-third.js", "from": 2, "to": 6.5, "params": { "name": "Ana" } },
//                { "layer": "overlays/progress.js" },
//                { "layer": "overlays/tag.js", "scene": 3, "from": 0.5, "to": 4 }]
// Times are seconds of the video, or with "scene" (from 1) seconds from that scene's start, so the overlay moves with
// the scene. Without "from" it starts at 0, without "to" it lasts to the end of the video, or of its scene. Later
// overlays are drawn over earlier ones.
// The module exports draw(ctx, t, W, H, o): t is seconds since the overlay began, W x H the page's own pixels (before
// ?scale=), and o is { duration, params, time }, time being seconds of the video. Everything it draws must be a
// function of t, as in a scene page.

export function parseOverlays(list, sceneCount) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('"overlays" in the project file must be a list');
  return list.map((o, i) => {
    const where = `overlay ${i + 1}`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${where} must be an object with "layer"`);
    if (!/\.m?js$/i.test(String(o.layer ?? ''))) throw new Error(`${where}: "layer" must be a .js module that exports draw(ctx, t, W, H, o)`);
    for (const k of ['from', 'to']) if (o[k] !== undefined && !Number.isFinite(o[k])) throw new Error(`${where}: "${k}" must be a number of seconds`);
    if (o.scene !== undefined && !(Number.isInteger(o.scene) && o.scene >= 1 && o.scene <= sceneCount))
      throw new Error(`${where}: "scene" must be a scene number from 1 to ${sceneCount}`);
    if ((o.from ?? 0) < 0 || (o.to !== undefined && o.to <= (o.from ?? 0))) throw new Error(`${where}: "from" must be 0 or more and "to" after it`);
    return { layer: String(o.layer), scene: o.scene, from: o.from, to: o.to, params: o.params ?? {} };
  });
}

// Each overlay with its span in seconds of the video (start, end), from the scenes' starts and lengths in seconds.
export function placeOverlays(list, starts, lengths) {
  const total = starts.at(-1) + lengths.at(-1);
  return list.map(o => {
    const base = o.scene ? starts[o.scene - 1] : 0;
    const end = o.to !== undefined ? base + o.to : o.scene ? base + lengths[o.scene - 1] : total;
    return { ...o, start: base + (o.from ?? 0), end };
  });
}

// Whether a placed overlay shows at a time of the video. Frame times are sums of frames / fps, so they are compared
// with a margin well under a frame.
export const overlayAt = (o, time) => time >= o.start - 1e-6 && time < o.end - 1e-6;

export async function loadOverlay(url, name = url) {
  const m = await import(url);
  if (typeof m.draw !== 'function') throw new Error(`overlay ${name} has no draw(ctx, t, W, H, o) export`);
  return m;
}

// Draws the overlays (each with its module as `mod`) that show at `time` onto ctx, whose canvas holds the frame at
// any size: they draw in the page's own W x H pixels, scaled to the canvas.
export async function drawOverlays(ctx, list, time, W, H) {
  for (const o of list) {
    if (!overlayAt(o, time)) continue;
    ctx.save();
    ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
    try { await o.mod.draw(ctx, time - o.start, W, H, { duration: o.end - o.start, params: o.params, time }); }
    finally { ctx.restore(); }
  }
}
