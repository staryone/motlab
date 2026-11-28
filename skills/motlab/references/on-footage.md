# Animation on real footage: tracks, mattes, warps and matching

For animation that has to sit in a real shot: an app on a phone someone holds, a poster on a wall the camera moves
past, a sign that rises from behind a chair, a hit that cracks the picture, a drop that ripples a puddle. Each of
these is put together from the same few parts instead of being built as one effect:

- a track says where something is in every frame of the clip (`scripts/track.py`, made once)
- a matte says which pixels are one object in every frame (`motlab matte`, made once)
- the compositor in `/__motlab/comp.js` draws the footage, bends it with warps, and lays canvases on it at
  tracked places, matched to the shot, behind or inside real objects, and patches real objects away

Models that make pictures or video stay out; `motlab matte` runs SAM 2.1, which only finds an object's pixels. The
clip is the user's own, or one they have the rights to.

## Which parts an interaction needs

| The shot | Track | On the page |
|---|---|---|
| An app on a phone held in a hand | `--plane` on the screen's corners, `--grow 0.15` when the screen is plain | `layer()` at `grow(plane, 3)` so it reaches under the bezel; `match` levels, grain, a little wrap; `shutter()` for motion blur. On a green screen, `keyed` so fingers stay in front, with `marks` over its tracking marks |
| A poster, sign or screen on a wall | `--plane` on a patch of the wall around it | `carry()` the poster's corners from the first frame; a `shadow` layer a few pixels below; `match` levels and tint 0.5 or more |
| A label that stays on a far or flat background while the camera moves | `--camera` | `carry('camera', ...)` its corners from the first frame |
| Text or a mark that follows a thing | `--points` on a sharp detail of it (two for its turn and size) | `pose()` on a Canvas 2D page, or `quad()` around the point on a layer |
| A hit: the picture cracks, a shockwave runs out | `--camera` or `--plane`, so the hit stays on its spot | `crack` and `shockwave` warps at the carried point, and a short `push` with radius 0 as shake |
| A drop or a stone in water | `--camera` if the shot moves | `ripple` warps, one per drop |
| A lens or a magnifier | the thing under it | `bulge` |
| A twist into the next shot | none | `swirl`, its angle eased up to the cut |
| Something comes out from behind a real object, or a person walks in front of the poster | `--plane` or `--camera` for where the animation sits; `motlab matte` on the object or person | the layer with `behind: matte`; a thin thing in front of it (a rod, a cable) drawn back on top as a layer of the footage itself with `inside: its matte` |
| A glow or a colour change on a real object | `motlab matte` on it | a layer `inside` its matte, `blend: 'add'` for light |
| A real object is gone (a logo, a mark, a thing on the table) | `--plane` on the surface under it | `patch()` at its carried corners, with pixels from beside it (`offset`) or, when the camera moves past it, from another frame (`source` and `track.map`) |

| A 3D object standing on a real table or floor while the camera moves | `scripts/blender/solve.py --floor` (the 3D camera) | a three.js scene drawn with `track.setCamera()`, a `ShadowMaterial` floor for its shadow, laid on the footage with `comp.layer` and `match` |

## 1. Find the positions

Export a frame where nothing covers the surface and read the coordinates off a grid:

```bash
ffmpeg -ss 2.6 -i footage/phone.mp4 -frames:v 1 frame.png
python3 scripts/grid.py frame.png grid.jpg --step 50
```

Positions are in the clip's pixels as it plays (a phone's rotation applied). For a plane, take the corners in the
order top left, top right, bottom right, bottom left of what will be drawn on it, on the surface's own edges. On a
green or blue screen, the corners of the keyed colour inside the bezel are exact.

## 2. Track

```bash
python3 scripts/track.py footage/phone.mp4 --plane screen=766,169,1015,169,1015,677,770,678 --grow 0.15 --at 2.6 --sheet check.jpg
python3 scripts/track.py footage/stairs.mp4 --plane wall=1170,110,1500,110,1500,720,1170,720 --points button=1172,822 --sheet check.jpg
python3 scripts/track.py footage/clock.mp4 --camera --range 4 9
```

- `--at` is the time in the clip where the positions are true; tracking runs from there to both ends. `--range`
  tracks only the part a scene uses, which saves time on a long clip.
- Every run adds its tracks to `<clip>.track.json` next to the clip, replacing tracks of the same name.
- `--sheet check.jpg` draws the tracks on 8 frames. Look at it before building on a track: the outline should stay
  on the surface's edges, the points on their details, and the camera's grid fixed to the wall.
- A point needs a small, sharp detail (a corner, a screw, a mark); on a plain area it cannot be followed. Its window
  is `--window` pixels from its centre (15 by default; smaller for a small detail near other moving things).
- A plane follows the texture inside it. A plain screen has almost none, so `--grow` takes in the bezel. Fingers and
  other things that move their own way are left out by themselves, as long as the surface's own details are most of
  what is in the region at `--at`. Start on a frame where the surface is clear.
- `--camera` fits one flat move to the whole frame. It is right for a pan or a shake over a wall or a distant view.
  In a deep scene (railings in front of a wall) the near and far parts move differently: track the surface the
  animation sits on with `--plane` instead.
- Each frame has a confidence from 0 to 1, the share of details that agreed. Frames where it was lost are `null`
  and the page holds the nearest frame that was found. The script prints how many frames were weak or lost.

Measured on the test laptop (Windows, numpy and scipy on the CPU), on 1920 x 1080 clips from Mixkit:

| Clip | Track | Time | How close |
|---|---|---|---|
| A hand holding a green-screen phone, a finger crossing it, 787 frames at 60 fps | plane, `--grow 0.15` | 39 s | screen edges 1.85 px from the visible edge on average (1.6 px on the start frame itself, the limit of that measure); started again in the middle and tracked both ways, the two runs agreed within 0.53 px on average, 4.4 px at most while a finger covered a corner |
| A stairwell, the camera drifting, 288 frames at 24 fps | plane on the wall, and two points | 29 s and 13 s | tracked to the end and back to the start, the corners came back within 0.17 px and the points within 0.15 px |
| A white wall with a clock, a pan, 307 frames at 24 fps | camera | 20 s | a grid fixed to the wall stayed on the same numbers of the clock |

On a made clip with known motion (a card turning, growing and tilting, 960 x 540, 90 frames), the corners were
0.33 px from the truth on average and 0.55 px at most. The method: pyramidal Lucas-Kanade on details spread over the
region; each frame is warped by the predicted homography into a keyframe and matched there, so the error does not
add up from frame to frame; the homography is fitted with RANSAC.

## 2b. Matte an object

```bash
motlab matte footage/room.mp4 --click 910,540 --click 960,470 --name chair
motlab matte footage/street.mp4 --at 2.5 --click 640,400 --exclude 700,380 --range 2,8 --name person
```

- Click on the object at `--at`, on two or three of its parts for something that is not one colour; `--exclude`
  on what is next to it and must stay out. `--box x1,y1,x2,y2` around it works too. `--name` lets one clip have
  several mattes (`chair`, `lamp`).
- It writes `<clip>.<name>.matte.webm` and an entry in `<clip>.track.json`, with a score per frame. The command
  prints how many frames were weak or empty; check them.
- About 0.3 s a frame on the test laptop's GPU: 288 frames of 1080p in 90 s. The first run downloads the model
  (about 80 MB).
- Look at it before building on it: draw the matte over a few frames as a tinted layer (`inside`, a red canvas,
  opacity 0.5) and render stills.
- The object is carried from frame to frame by the last frame's mask. If it turns into something else (it slid
  onto the wall behind), give it a points track: `track.py --points nail=...` on sharp details of the object, then
  `motlab matte <clip> --points nail`, which asks with those points in every frame.
- A matte is 256 pixels across the frame, about 7.5 pixels at 1080p. Edges are soft and thin things are rough: a
  lamp's 3-pixel rod in the test left a gap of about 10 pixels around it in a sign behind it. Keep animation from
  crossing close behind thin things, or let the sign pass while the rod is drawn back on top.

## 3. Draw it

```js
let clip, track, comp, C;
window.ready = (async () => {
  const { openFootage } = await import('/__motlab/footage.js');
  C = await import('/__motlab/comp.js');
  clip = await openFootage('../footage/phone.mp4');
  track = await C.loadTrack('../footage/phone.track.json');
  comp = C.compositor({ width: W, height: H, scale: S });
})();
window.renderAt = async t => {
  await window.ready;
  const ct = IN + t, fit = [0, 0, W, H];                   // the time in the clip, and where the clip is drawn
  comp.footage(await clip.frame(ct), { fit, noise: true, frame: track.frame(ct), region: [600, 600, 500, 480] });
  drawApp(t);                                              // the animation, on its own canvas `app`
  const screen = x => C.grow(track.plane('screen', x, fit), 3);
  comp.layer(app, { at: screen(ct), ...track.shutter(screen, ct), match: { levels: 0.35, tint: 0.2, grain: 'auto', wrap: 0.25 } });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(comp.canvas, 0, 0);
};
```

Everything the compositor takes is in page units. Track values are in the clip's pixels until a `fit` is given:
`[x, y, w, h]`, where the clip is drawn on the page, the same rectangle passed to `footage()`.

The track (`loadTrack`), with `t` the time in the clip:

| Call | Gives |
|---|---|
| `track.plane(name, t, fit)` | a plane's four corners |
| `track.points(name, t, fit)` | a points track's points |
| `track.carry(name, t, pts, fit)` | points given in the track's first frame, moved with the plane, the points or the camera to time `t`: a poster beside a tracked patch of wall, a label on a wall the camera pans over |
| `track.pose(name, t, fit)` | `{ x, y, scale, angle }` against the first frame, for `ctx.translate`, `rotate`, `scale` on a Canvas 2D page |
| `track.shutter(fn, t, open)` | `{ from, to }` corners for motion blur, from the frames before and after; `fn(time)` gives corners. `open` 0.5 is a 180 degree shutter |
| `track.confidence(name, t)`, `track.frame(t)` | the confidence at that frame (0 where lost), and the frame's number |
| `await track.matte(name)` | a matte from `motlab matte`, in `window.ready`: `await m.frame(t)` is its picture at time `t` in the clip |
| `track.map(name, t, t2, fit)` | page positions at `t` to where the same points are at `t2`, for a patch from another frame |

The compositor, called in this order every frame:

| Call | Does |
|---|---|
| `comp.footage(frame, { fit, warps, noise, region, frame })` | draws the clip and measures its light. `region` is the part whose light the layers match (leave out a green screen or a bright sky); `noise: true` measures its grain; `frame: track.frame(ct)` changes the grain with the footage's |
| `comp.layer(canvas, { at, from, to, samples, opacity, match, shadow, blend })` | lays a canvas on four corners, in perspective. `from` and `to` blur it along its move. `shadow: { opacity, blur }` draws its shape as a soft dark shadow instead (lay it first, a few pixels down on the same surface). `blend: 'add'` for light |
| `comp.patch({ at, matte, offset, source, map, feather })` | covers part of the frame (four corners with a soft edge `feather` page units wide, or a matte; grow the matte so the object's edge goes too) with pixels from `offset` page units beside it, or from `source`, another frame (`await clip2.frame(t2)` from a second `openFootage` of the clip) through `map`. Call it before the layers that go over it |
| `comp.canvas` | the result, to copy onto `#c` |

A layer also takes:

- `behind: matte` hides it where the real object is; `inside: matte` shows it only there. A matte is a frame from
  `m.frame(t)`, or `{ frame, soft, grow }`: `soft` is the edge's width (1.5 by default), and `grow` takes in more
  around the object (2 or 3 closes the gaps where a thin thing crossed it).
- `keyed: { color, tolerance, soft, despill, marks }` shows it only where the footage is near `color`: a green or
  blue screen. Fingers in front stay in front, and `despill` (1 by default) takes the screen's colour off their
  edges. `marks` is up to four sets of corners where it shows whatever the colour, over a screen's tracking marks
  (carried with the screen's plane). Pick `color` from a frame (the screen's green was `#65dc08` in the test).
- The layer can be a frame of footage instead of a canvas. Laid on the whole page `inside` an object's matte, it
  draws that real object back on top of the animation.

`match`, each from 0 to 1:

- `levels` moves the layer's black and white to the footage's darkest and brightest colours. 0.3 to 0.7; a flat
  graphic on a dim wall needs more.
- `tint` takes on the footage's colour of light. Keep it low for brand colours that must stay true.
- `grain` adds noise on the footage's pixel grid; `'auto'` uses the footage's measured noise. Without it a clean
  graphic floats above the shot.
- `wrap` lets the footage's light spill over the layer's edges (`wrapSize`, 12 page units by default).

Helpers: `C.quad(x, y, w, h, { angle, scale, anchor })` gives corners of a box; `C.grow(corners, d)` moves every
edge out by `d` page units; `C.homography(a, b)` and `C.squareTo(q)` for anything else.

## 4. A 3D camera

For three.js in a shot whose camera moves through space (a dolly, a walk, a handheld move with depth), Blender's
tracker and solver work out the real camera, frame by frame, with no window:

```bash
blender -b --factory-startup -P scripts/blender/solve.py -- footage/room.mp4 --floor 560,880 1420,850 1000,760
```

- `--floor` takes three points, in the clip's pixels at `--at` seconds, on the surface the object stands on (a
  floor, a table top). The solved details nearest to them become y = 0, with y up; the script prints how far each
  detail was from its point. Pick spots with texture (a grain, a mark, a corner), well apart.
- `--focal` is a first guess of the lens in mm on a `--sensor` mm wide sensor (35 on 36 by default); the solver
  refines it. `--fixed-focal` keeps a known lens. `--range from to` solves part of the clip.
- It writes a `camera3d` entry into `<clip>.track.json`: the camera's matrix per frame for three.js, its field of
  view, the error in pixels, and the solved details as 3D `points` (`track.tracks.camera3d.points`). The units are
  the solver's own: size objects from what they should look like at a spot (below), or from the points.
- It needs parallax: the camera has to move through space, not only turn. A pan or tilt on a tripod has none; use
  `track.py --camera` for those. An error under 1 pixel is good.
- Lens distortion is taken as none. A wide lens with strong distortion lets things drift at the frame's edges.
- More details make the solve much slower, not much better. A 1080p clip of 288 frames with 761 details had not
  finished its first solve after 30 minutes; with the defaults (at most 30 new details every 24 frames), 157 frames
  of it solved in 137 s with an error of 0.18 px. Solve only the part a scene uses (`--range`).

On a clip rendered in Blender with a known camera (960 x 540, 90 frames, a 28 mm lens), it found the lens at 27.9 mm
and an error of 0.36 px in 66 s, and the camera path was within 0.8 cm of the true one over 6.6 m on average (3.9 cm
at most), turned at most 0.8 degrees off. The solver gives a slightly different answer on each run, so the script
solves again until the lens and the error settle. On a real Mixkit clip of a room (a slow dolly, 157 frames at
1080p), a box placed on the table through the 3D camera stayed within 0.43 px on average (1.01 px at most) of the
same spot followed by `track.py --plane` on the table top.

```js
import * as THREE from 'three';                       // the three.js template's import map
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setSize(W * S, H * S, false); gl.setClearColor(0x000000, 0); gl.shadowMap.enabled = true;
const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 100);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
// in window.ready: the spot on the floor under a pixel of the clip, and a size that looks right there
track.setCamera('camera3d', IN, camera);
const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / track.width * 2 - 1, 1 - y / track.height * 2), camera);
const at = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
const size = 2 * at.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 170 / track.height;   // 170 px tall
// in renderAt
comp.footage(await clip.frame(ct), { fit, noise: true, frame: track.frame(ct) });
track.setCamera('camera3d', ct, camera);
gl.render(scene, camera);
comp.layer(gl.domElement, { at: C.quad(0, 0, W, H, { anchor: [0, 0] }), match: { levels: 0.4, tint: 0.4, grain: 'auto', wrap: 0.2 } });
```

Light the object like the shot: a directional light from where the light in the clip comes from, and the
`ShadowMaterial` floor so its shadow falls on the real surface. A real object in front of it still needs a matte
(`behind`).

## Warps

Warps bend the footage itself. They are given to `footage()` as a list, up to 8 at once, in page units, with `age`
the seconds since the warp began (`t - HIT`). Any value left out takes its default:

| Warp | Values (defaults) | For |
|---|---|---|
| `ripple` | `amp` 6, `wavelength` 40, `speed` 260, `decay` 1.2, `rings` 4, `shine` 0.15 | a drop in water, a tap on a surface |
| `shockwave` | `amp` 30, `width` 40, `speed` 900, `decay` 2.5, `split` 0.15 (colour fringe) | an impact, a bass hit, a reveal |
| `bulge` | `amount` 0.4 (below 0 pinches), `radius` 200 | a lens, a magnifier, a breath |
| `swirl` | `angle` 2 radians, `radius` 220 | a twist out of a shot |
| `push` | `dx`, `dy`, `radius` (0: the whole frame) | a nudge, or shake with radius 0 and an offset from `shake()` in `camera.js` |
| `crack` | `radius` 300, `shift` 4, `cracks` 11, `darkness` 0.6, `seed` 1 | glass or a screen breaking; grow `radius` from 0 over about 0.1 s |

A hit reads when its parts land on the same frame: the crack, the shockwave, a shake and the sound. Keep it on a
tracked spot (`carry`) so it does not slide when the camera moves.

## Checking it

- Look at `--sheet` before building, then at stills where the surface moves fastest and where something passes
  close to it.
- Step through a move frame by frame in the viewer. A layer that swims against the footage by a pixel or two is a
  track that slipped: start it on another frame, give the plane more texture (`--grow`), or shorten `--range`.
- A layer that looks pasted on usually lacks grain, has blacks deeper than the footage's, or is sharper than the
  footage while it moves. Raise `levels`, use `grain: 'auto'`, and give it `shutter()` blur.
- The footage drawn by `comp.js` matches `f.draw` within 1 of 255 per channel, so a scene can switch between them.
- Measured on the test laptop: a sign rising from behind a matted chair, the lamp in front of it drawn back on top,
  a book patched off the table (5 s), and an app scrolling under a finger on a green-screen phone (3 s), rendered
  at 1080p at 30 and 39 fps.
- `comp.js` needs WebGL2. On a machine without a GPU, Chrome draws it with SwiftShader, which is slower.
