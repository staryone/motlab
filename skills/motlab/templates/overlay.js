// An overlay: motion drawn over the video from one time to another, over every scene and transition it spans, such as
// a lower third, a logo, a progress bar or captions. It has no look of its own: the look comes from the user's
// references, another skill, or a style from motlab-styles. Copy it next to the scenes, rename it, replace draw(), and
// list it in project.json:
//   "overlays": [{ "layer": "overlays/name.js", "from": 2, "to": 6.5, "params": { "name": "Ana Putri", "title": "Founder" } }]
// or with "scene": 3 to count "from" and "to" from that scene's start.
//
// draw(ctx, t, W, H, o) is called for each frame the overlay shows, after the scenes and transitions are drawn:
//   t  seconds since the overlay began, o.duration its whole length, so it can leave before it ends
//   W, H  the page's own pixels (1920 x 1080 for a 16:9 page), whatever the render's scale
//   o.params  from project.json; o.time  seconds of the whole video
// Like a scene, everything must be a function of t: no timers and no unseeded randomness. A module may await its
// fonts at the top (document.fonts.load), which the renderer and the viewer wait for before the first frame.

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const outCubic = k => 1 - (1 - clamp(k)) ** 3;
const inCubic = k => clamp(k) ** 3;

// Example: a name and a role in the lower left, sliding in for 0.5 s and out over the last 0.4 s.
export function draw(ctx, t, W, H, o) {
  const { name = 'Name', title = '' } = o.params;
  const enter = outCubic(t / 0.5), leave = inCubic((t - (o.duration - 0.4)) / 0.4), k = enter * (1 - leave);
  if (k <= 0) return;
  const S = H / 1080, x = 96 * S, y = H - 230 * S;   // inside the title-safe area of a 16:9 frame
  ctx.globalAlpha = k;
  ctx.translate((k - 1) * 60 * S, 0);
  ctx.font = `600 ${52 * S}px system-ui, sans-serif`;
  const nameW = ctx.measureText(name).width;
  ctx.font = `400 ${32 * S}px system-ui, sans-serif`;
  const w = Math.max(nameW, ctx.measureText(title).width) + 64 * S;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath(); ctx.roundRect(x, y, w, title ? 132 * S : 92 * S, 14 * S); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${52 * S}px system-ui, sans-serif`; ctx.fillText(name, x + 32 * S, y + 66 * S);
  if (title) { ctx.font = `400 ${32 * S}px system-ui, sans-serif`; ctx.fillText(title, x + 32 * S, y + 110 * S); }
}
