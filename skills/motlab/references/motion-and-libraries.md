# Motion helpers and animation libraries

Every frame must come from `t` alone, because the renderer asks for frames in any order and the viewer jumps around.
That rules out anything that runs on its own clock. The tools below all work by being told the time.

## motion.js: easing, springs, keyframes, motion blur

Served by the renderer and the viewer, so a scene imports it the same way in both:

```js
const { ease, cubicBezier, spring, tween, stagger, prog, lerp, clamp, motionBlur } = await import('/__motlab/motion.js');
```

| Helper | What it does |
|---|---|
| `ease.outCubic(k)` and the rest | the usual curves: `linear`, `in/out/inOut` + `Sine`, `Quad`, `Cubic`, `Quart`, `Expo`, `Back`, plus `outBounce` and the CSS presets `css`, `cssIn`, `cssOut`, `cssInOut` |
| `cubicBezier(x1, y1, x2, y2)` | a CSS `cubic-bezier()` as an easing, e.g. one copied from a design tool or an After Effects graph |
| `spring({ stiffness, damping, mass, velocity })` | a spring from 0 to 1 solved exactly, so frame order does not matter. `spring(...).duration` is when it has settled within 0.1%. `damping` 10 at `stiffness` 100 overshoots by 16%; 20 is critically damped (no overshoot) |
| `tween(t, [[0, 0], [0.4, 120, ease.outBack], [1.2, [10, 20]]])` | keyframes of numbers or arrays, each with the easing into it |
| `stagger(i, 0.06, 0.3, { n, from: 'center' })` | the start time of item `i` in a staggered group |
| `prog(t, a, b)` | 0 to 1 between seconds `a` and `b` |
| `await motionBlur(canvas, t, async time => drawFrame(time), { samples: 8, shutter: 0.5 / fps })` | draws the frame across the shutter and averages it on `canvas`. Use it only on fast moves; it costs `samples` times the drawing |

A spring for an element that pops in after a beat: `const s = spring({ stiffness: 180, damping: 12 }); scale = s(t - beat)`.

## camera.js: a camera, shake and parallax

A camera over a 2D canvas page: keys for where it looks, how far it zooms and how it rolls, long jumps between far
places, following something that moves, shake from seeded noise, and parallax for layers at different depths. Every
value comes from `t`, like the rest of the page. Use it when the look calls for camera moves; a scene without one
needs none of it.

```js
const { camera, shake, noise } = await import('/__motlab/camera.js');
const cam = camera({ width: W, height: H,
  keys: [[0, { x: 960, y: 540, zoom: 1 }], [1.6, { x: 1240, y: 470, zoom: 1.8, turn: 3 }, 'inOutCubic']],
  shake: [{ from: 2.1, to: 2.6, amount: 18, turn: 1, speed: 14 }] });
cam.apply(ctx, t, { scale: SCALE });   // then draw in the page's own units
```

| Part | What it does |
|---|---|
| `keys: [[time, { x, y, zoom, turn }, easing], ...]` | `x`, `y` is the point of the page in the centre of the frame, `zoom` 2 shows half the width, and `turn` rolls the camera clockwise in degrees, so the picture turns the other way. A key leaves out what does not change. The easing is a name from `motion.js` or a function (default `inOutCubic`). Two keys at the same time cut the camera |
| `fly: true` in a key | the move into that key is a long jump: the camera pulls out while it travels and pushes in at the end, so the way between two far places stays readable. A number instead of `true` says how far it pulls out (1.41 by default, 2 further) |
| `follow: [{ from, to, target, blend, lag }]` | between `from` and `to` the camera looks at a moving thing instead of its keys: `target` is a function of `t` that returns the thing's `[x, y]`, from the same code that draws it. It eases in and out over `blend` seconds (0.3); `lag` looks at where the thing was on average over that many seconds, like an operator who reacts a little late. Zoom and turn still come from the keys |
| `shake: [{ from, to, amount, turn, speed, seed, decay }]` | `amount` is the largest offset in page units and `turn` the largest roll in degrees; `speed` is wobbles a second, 12 to 20 for a hit and 1 to 3 for a hand-held camera. With a `to` it dies away by then, like a hit, and `decay: false` holds it instead. Without `from` and `to` it runs through the whole scene |
| `cam.apply(ctx, t, { scale, depth })` | sets the canvas transform; draw everything after it in page units |
| `cam.at(t)`, `cam.matrix(t, depth)`, `cam.point(t, x, y, depth)` | where the camera looks; its 2D matrix (as in `setTransform`, or a WebGL page's 3x3); where a point of the page lands in the frame, to draw a label at its own size beside something the camera zooms in on |
| `cam.speed(t)` | how fast the picture moves, in page units a second |
| `shake(t, list)`, `noise(x, seed)` | the shake and the noise on their own, for a three.js or gl3d camera |

- Zoom eases in log space, so a push feels even from far to near. The end that is zoomed in further keeps its point
  moving in a straight line across the frame, so a push in on a point off centre goes straight to it instead of
  swinging out first. Put the key on the point the shot is about.
- A long jump (`fly: true`) suits places far apart on one big canvas: a map, a timeline, a board of cards. Halfway
  through a jump of three frame widths at zoom 1 the camera is at zoom 0.32, so the way between shows; give it the
  time to read that, and check stills in the middle of it.
- To follow something along a drawn path, give `target` a point on the path: with an SVG path element,
  `t => { const p = path.getPointAtLength(len * prog(t, 2, 5)); return [p.x, p.y]; }`. Draw the thing with the same
  function, so camera and thing never drift apart. To keep it off centre, add an offset in `target`.
- Draw what stays put on screen (captions, a logo, a lower third) after `ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)`,
  or as an overlay.
- Keep the edges out of sight. A layer under a pan, a shake or a roll needs picture past the frame: with zoom 1 and a
  shake of 20, draw the background at least 20 units larger on every side, or zoom in to 1.05.
- A whip pan is a fast key (`inOutExpo` over 0.3 to 0.5 s) with motion blur only while it is fast, since every sample
  draws the frame again:

```js
const shutter = 0.5 / fps, samples = Math.min(32, Math.ceil(cam.speed(t) * shutter / 4));
await motionBlur(canvas, t, time => draw(time), { samples, shutter });   // draw(time) calls cam.apply(ctx, time) first
```

  With at most 12 samples, the fastest frames of a 2400-unit whip over 0.4 s showed stripes; 32 hid them, and that
  3.5 s scene took 1.5 s to render at 1080p instead of 1.3 s (the test laptop, RTX 3060 Laptop). For a whip across a
  cut, the outgoing scene speeds up (`inExpo`) towards a point out of frame and the next one starts at full speed and
  slows down (`outExpo`), with the cut on the fastest frame.

### Parallax from layers

`depth` in `cam.apply` says how far a layer is: 1 moves with the camera, 0 stays put (a sky), 0.6 moves 0.6 as far and
zooms less, and 1.3 moves more (a foreground). Draw the layers from far to near, each at its own depth:

```js
for (const l of layers) { cam.apply(ctx, t, { scale: SCALE, depth: l.depth }); ctx.drawImage(l.img, 0, 0, W, H); }
```

The layers come from the assets: an illustration drawn in layers, cut-outs from `key.py`, parts from `split.py`, or a
photo cut along its depth:

```bash
motlab depth photo.jpg                                 # photo.depth.png next to it, nearer is lighter
python3 scripts/depth_layers.py photo.jpg --layers 3 --out img/layers
```

`depth_layers.py` writes `photo-1.png` (far, opaque) up to `photo-3.png` (near), and `photo-layers.json` with each
layer's `depth` for `cam.apply`: `--far` (0.6) for the far one and 1 for the nearest. Under each layer's nearer
neighbours, the hidden part is smeared in from its own edges, so a small move shows picture behind an object instead of
a hole, and a large move shows the smear. It suits a subject in front of a background. A floor or a road that runs from
near to far is cut into bands, and the seam shows where two bands move apart, so keep that move small or use two
layers. Check stills at both ends of the move.

`motlab depth` runs Depth Anything V2 Small, a model that measures depth and makes no picture. The first run downloads
about 70 MB; later runs work offline. On the test laptop it took 0.2 to 0.4 s a photo on the GPU, and 3.9 s for an
800x800 photo with `--cpu`.

## sprite.js: sprite sheets and sprite stacks

Frame-by-frame sprites and pixel art, and sprite stacks: an object drawn as horizontal slices one above another, so a
flat picture reads as solid when it turns. Use them when the references call for that look.

```js
const { loadSprite, loadStack } = await import('/__motlab/sprite.js');
const hero = await loadSprite('../assets/hero.json');                         // Aseprite's sprite sheet JSON
const coin = await loadSprite('../assets/coin.png', { frames: 8, fps: 12 });   // equal frames in a row
hero.draw(ctx, t, 960, 900, { tag: 'run', scale: 6 });                         // its feet at 960, 900
const car = await loadStack('../assets/kits/toys/stacks/car/car.stack.json', { shade: 0.3 });
car.draw(ctx, 960, 600, { angle: 40 * t, scale: 8 });
```

| Part | What it does |
|---|---|
| `loadSprite('x.json')` | an Aseprite export (File > Export Sprite Sheet with JSON data, hash or array): each frame's own duration, trimmed frames in their place, and the tags with their direction (`forward`, `reverse`, `pingpong`, `pingpong_reverse`) and repeat, played as Aseprite plays them |
| `loadSprite('x.png', { frames, cols, width, height, fps })` | equal frames in a row, or in a grid with `cols` frames a row |
| `sprite.draw(ctx, t, x, y, { tag, frame, scale, anchor, flip, alpha })` | the frame at `t`, its `anchor` (`[0.5, 1]`, the middle of its feet) at x, y; `scale` is page units a sprite pixel. `sprite.frameAt(t, tag)` gives the frame's number, to time a sound to a footstep |
| `loadStack('x.stack.json' or 'x.png', { slices, vertical, topFirst, shade })` | a stack from the motlab-assets skill's `slices.py`, or an image of equal slices (bottom first in a row, unless `vertical` or `topFirst` says otherwise). `shade` darkens the lower slices so the height reads |
| `stack.draw(ctx, x, y, { angle, scale, spacing, squash, turn })` | the stack with the middle of its bottom slice at x, y, turned by `angle` (degrees, clockwise seen from above); `scale` is page units a voxel, `spacing` the step between slices (1), and a `squash` below 1 looks more from the side |

- Pixel art stays sharp: nothing is smoothed. Use a whole-number `scale` and whole-number positions so every sprite
  pixel is the same size. The viewer's 1080p and 4K exports keep the pixels even; 1440p and 720p draw a 1080p page at
  4/3 and 2/3, where they come out uneven.
- A stack goes under the camera like anything else (`cam.apply`) and zooms with it. With a camera that rolls, pass
  `turn: cam.at(t).turn`, so the slices still step straight up the screen. Draw sprites that should stay upright after
  `ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)`.
- Draw several stacks from the back of the screen to the front (the smallest screen y first; `cam.point` gives it
  under a camera), so the nearer one covers the further.
- A stack suits a view from above or at an angle; from the side its slices show as lines. Each slice is drawn as often
  as its step covers device pixels, so no gap opens between slices at 4K.
- Objects for stacks come from the motlab-assets skill (`slices.py`): carved from pixel-art views, from distance
  functions, or voxelized from a 3D model in Blender. A MagicaVoxel slice export loads as an image with `slices`;
  check a still for which end is the bottom.

## Transitions between scenes

Set in `project.json` on the scene a transition leads into. The viewer and the render draw it with the same shader:

```json
{ "file": "scenes/02.html", "transition": { "type": "crosswarp", "duration": 0.5, "ease": "inOutCubic", "params": {} } }
```

The two scenes overlap for `duration`, so the video gets that much shorter and every later scene starts that much
earlier. Audio `start` times are times in the finished video, so move them when you add a transition before them.
Both scenes need content for the whole overlap: the outgoing scene keeps playing under it and the incoming one has
already started, so do not end a scene on its last frame of motion. The types, from gl-transitions (MIT):

| Type | Look | Params (default) |
|---|---|---|
| `fade` | crossfade | |
| `fadecolor` | dip through a colour | `color` ([0, 0, 0]), `colorPhase` (0.4) |
| `Directional` | push: the new scene slides in and pushes the old one out | `direction` ([0, 1]) |
| `directionalwipe` | soft-edged wipe | `direction` ([1, -1]), `smoothness` (0.5) |
| `directionalwarp` | wipe that stretches both scenes | `direction` ([-1, 1]) |
| `circleopen` | iris | `smoothness` (0.3), `opening` (true) |
| `CrossZoom` | zoom blur through the cut | `strength` (0.4) |
| `crosswarp` | warp from one side | |
| `SimpleZoom` | zoom into the old scene, then fade | `zoom_quickness` (0.8) |
| `LinearBlur` | blur dissolve | `intensity` (0.1) |
| `cube` | 3D cube turn | `persp` (0.7), `unzoom` (0.3), `reflection` (0.4), `floating` (3) |

Names are not case sensitive. `ease` is any name from `motion.js` (default `inOutCubic`). Which cuts get a shader
transition comes from the video's look. A shader between two scenes that already morph into each other inside their
pages only blurs the morph, so use one or the other at a cut.

### A layer over the cut

A layer is a ready-made sweep or wipe drawn over a hard cut, such as a kit's transition used the same way at many
cuts. The other ways to change shot are a hard cut, a shader transition, or a change drawn frame by frame inside the
scene pages; the look decides which (`technique.md` §3). A layer goes in `project.json` like this:
`"transition": { "layer": "assets/kits/<kit>/transitions/swish/transition.js", "duration": 0.6 }`. The module exports
`draw(ctx, p, W, H)` in page pixels, `p` runs 0 to 1 and the frame must be fully covered at 0.5, where the cut is.
The scenes keep their full length (nothing overlaps), so audio times do not move. The module comes from the asset
skill (`templates/transition.js`); motlab then draws it over the cut, so neither scene page draws it.

### A transition of your own, or one from a reference

When none of the 11 fits, write the shader into the project, for example `transitions/swipe.glsl`, and set
`"type": "transitions/swipe.glsl"`. It is a gl-transitions shader: define `vec4 transition(vec2 uv)`, read the scenes
with `getFromColor(uv)` and `getToColor(uv)`, use `progress` (0 to 1, eased) and `ratio` (width / height), and give
each uniform its default in a comment so `params` can change it:

```glsl
uniform float softness; // = 0.05
vec4 transition(vec2 uv) {
  float edge = progress * (1.0 + softness);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(edge - softness, edge, uv.x));
}
```

Uniforms can be float, int, bool, vec2 to vec4 or ivec2 to ivec4, not textures; do not declare `progress` or
`ratio`. A shader from gl-transitions (github.com/gl-transitions/gl-transitions, all MIT) that uses no texture can be
copied in unchanged: keep its author and licence lines. The viewer shows a compile error with the line in the file when the project opens.

When the user shows a transition they like in another video, do not guess it from a description. Take frames across
it, about ten over the transition, named by their time so `contact_sheet.py` can lay them out:

```bash
for t in 3.20 3.25 3.30 3.35 3.40 3.45 3.50 3.55 3.60 3.65; do ffmpeg -v error -y -ss $t -i reference.mp4 -frames:v 1 ref/$t.png; done
python3 scripts/contact_sheet.py ref ref-sheet.jpg
```

Look at the sheet and write down what happens frame by frame: where the new scene first appears, the shape and
softness of the edge, its direction and speed (constant, or fast in the middle, which is the `ease`), and anything on
top such as blur, zoom, a colour flash or light. Build the shader from that, render the project, take frames from the
same stretch of your MP4 the same way, and compare the two sheets side by side. Change the shader or `ease` until the
moments match, then tell the user what still differs. Copy the movement, not the other video's pictures.

## Animation libraries

These were each checked with a box moving from x 100 to 1700 over 2 s: stills at 0.5, 1 and 1.5 s were identical
in forward and reverse order, the box was at 500, 900 and 1300, and the viewer showed it at 900 at 1 s. Pin the exact
version, as below. They load from jsDelivr, so a render needs the network.

**GSAP 3.15.0** (free, its own licence from Webflow, not MIT: it may not be used in a no-code visual animation
builder that competes with Webflow, and Webflow can change the terms). A paused timeline only moves when sought:

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
<script>
const state = { x: 100 };
const tl = gsap.timeline({ paused: true }).to(state, { x: 1700, duration: 2, ease: 'power3.out' });
window.renderAt = t => { tl.seek(t, false); draw(state); };
</script>
```

**Anime.js 4.5.0** (MIT). Times are in milliseconds:

```js
const { createTimeline } = await import('https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js');
const tl = createTimeline({ autoplay: false }).add(state, { x: 1700, duration: 2000, ease: 'outExpo' });
window.renderAt = t => { tl.seek(t * 1000); draw(state); };
```

**Lottie (lottie-web 5.13.0, MIT)** plays After Effects animations exported with Bodymovin as JSON. Use the canvas
build. It draws into a canvas it makes inside the container (it ignores `rendererSettings.context`), so size the
container to the frame and copy that canvas:

```html
<div id="lot" style="position:fixed;left:-99999px;top:0"></div>
<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.13.0/build/player/lottie_canvas.min.js"></script>
<script>
Object.assign(lot.style, { width: c.width / devicePixelRatio + 'px', height: c.height / devicePixelRatio + 'px' });
let anim;
window.ready = fetch('anim.json').then(r => r.json()).then(data => new Promise(ok => {
  anim = lottie.loadAnimation({ container: lot, renderer: 'canvas', loop: false, autoplay: false, animationData: data });
  anim.addEventListener('DOMLoaded', () => ok(true));
}));
window.renderAt = async t => {
  await window.ready; anim.goToAndStop(t * anim.frameRate, true);   // in frames; fractions draw in-between frames
  ctx.drawImage(anim.renderer.canvasContext.canvas, 0, 0, c.width, c.height);
};
</script>
```

**Theatre.js core 0.7.2** (Apache-2.0) plays keyframes made in Theatre's visual editor (the studio, AGPL-3.0, used only
while editing and not shipped in the page). Export the project state from the studio as JSON and load it:

```js
const { getProject } = await import('https://cdn.jsdelivr.net/npm/@theatre/core@0.7.2/+esm');
const project = getProject('motlab', { state: await (await fetch('theatre-state.json')).json() });
await project.ready;
const sheet = project.sheet('Scene'), box = sheet.object('Box', { x: 0 });
window.renderAt = t => { sheet.sequence.position = t; draw(box.value); };   // seconds
```

The test used a state file written by hand, not one exported from the studio. Running the studio inside the motlab
viewer has not been tried.

Lottie files with image layers work, also with the image inside the JSON as a data URL. **Text layers need their
glyphs**: lottie-web's canvas build throws on a text layer exported without them (Bodymovin's "Glyphs" option), and it
swallows the error, so the whole animation stays on its first frame. Export with glyphs, or play the file with dotLottie.

**GSAP plugins** (SplitText, MorphSVGPlugin and DrawSVGPlugin ship in `gsap@3.15.0/dist/`). They change DOM and SVG
elements, so keep those elements hidden in the page and draw what they hold onto the canvas:

```js
gsap.registerPlugin(SplitText, MorphSVGPlugin, DrawSVGPlugin);
const split = SplitText.create('#title', { type: 'chars' });          // #title: visibility:hidden, same font as the canvas
const tl = gsap.timeline({ paused: true })
  .to('#shape', { morphSVG: '#target', duration: 2 }, 0)              // read back: new Path2D(shape.getAttribute('d'))
  .fromTo('#line', { drawSVG: '0%' }, { drawSVG: '100%', duration: 2 }, 0)   // read back: line.style.strokeDasharray and strokeDashoffset
  .from(split.chars, { y: 160, opacity: 0, stagger: 0.1, duration: 0.5 }, 0);
window.renderAt = t => { tl.seek(t, false);
  for (const ch of split.chars) { ctx.globalAlpha = +gsap.getProperty(ch, 'opacity'); ctx.fillText(ch.textContent, x0 + ch.offsetLeft, y0 + gsap.getProperty(ch, 'y')); } };
```

Wait for `document.fonts.ready` before `SplitText.create`, or the letters are measured in the fallback font. All three
gave the same stills forward and in reverse order.

**dotLottie (`@lottiefiles/dotlottie-web` 0.82.0, MIT)** plays `.lottie` and Lottie JSON with its own renderer (ThorVG,
WebAssembly) and handles text layers without glyphs, in its own font when the file has none:

```js
const { DotLottie } = await import('https://cdn.jsdelivr.net/npm/@lottiefiles/dotlottie-web@0.82.0/+esm');
const player = new DotLottie({ canvas: off, src: 'anim.lottie', autoplay: false, loop: false, renderConfig: { autoResize: false, devicePixelRatio: 1 } });
window.ready = new Promise((ok, no) => { player.addEventListener('load', () => ok(true)); player.addEventListener('loadError', no); });
window.renderAt = async t => { await window.ready; player.setFrame(Math.min(t * FPS, player.totalFrames - 1)); ctx.drawImage(off, 0, 0, c.width, c.height); };
```

`off` is a second canvas the size of `#c`, kept off screen. A `.lottie` file it cannot read fires neither `load` nor
`loadError`, so the page never becomes ready; the render then says it is still waiting after 30 s. Stills were the
same forward and in reverse.

Not tested: Rive.
