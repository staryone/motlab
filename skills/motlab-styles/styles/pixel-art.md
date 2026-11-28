# Pixel art

A look for videos drawn as pixel art: a small world on a coarse grid of square pixels, a few hue-shifted colour ramps,
soft light added on top, poses that hold on steps, and objects that turn as sprite stacks. Use it when the user asks
for pixel art, or names this style. The user's references come first: where they show their own palette, pixel size
or motion, follow them and keep the rest of this.

`templates/pixel-art-2d.html` is a working starting point: a 320 x 180 pixel buffer scaled up whole, colour ramps built
by hue shifting, ordered dithering, a light buffer, hard-edged pixel text, a stepped camera, and a sprite stack turning.
Copy it into `<video>/scenes/` and replace its `draw()`.

## Where the numbers come from

- **The method and the bar** are from pixelfx (github.com/patch-gg/pixelfx, MIT), 244 pixel art effects written as
  code, and from the method it credits to Hugo Duprez's Sprite Fusion effects: draft, render, look at it like a picky
  pixel artist, fix the worst thing, render again. Its rules on ramps, light, dithering, timing and the fixes table
  below are adapted from its `docs/AUTHORING.md` and its skill; nothing of its code is copied.
- **The grid** comes from the viewer's exports: they draw a 1920 x 1080 page at 2/3, 1, 4/3 and 2, so a pixel of 6
  page units is 4, 6, 8 and 12 device pixels, even in all four.
- **Steps of 12 a second** for poses are how hand-drawn sprites hold, and how pixelfx plays its characters.

## Canvas and the pixel grid

- Draw everything into a buffer of the page divided by 6: `320 x 180` for 16:9, `180 x 320` for 9:16, `180 x 180` for
  1:1. One buffer pixel is one art pixel. Scale the buffer to the canvas with smoothing off; every export then keeps
  square, even pixels.
- Never draw at the page's own resolution on top (a smooth line, anti-aliased text, a blurred shadow): mixed pixel
  sizes are the first thing that looks wrong. Everything, captions included, goes through the buffer.
- Whole pixels: round positions to the buffer grid before drawing. Sub-pixel motion makes edges crawl.

## Palette and colour

- Three to five ramps, each 5 to 8 steps from dark to bright, 16 to 32 colours in all. A ramp is hue-shifted: its
  shadows lean towards cool and deep (blue, violet), its highlights towards warm and pale (yellow, white). A ramp that
  only changes brightness looks dead. The template's `ramp(hue)` builds them; the brand's colour sits in the middle.
- Pick a step, never a mix: shapes are flat steps of a ramp. Smooth gradients belong only to light and to translucent
  smoke or mist.
- Saturated colour sits in the middle steps and in shadow; the brightest steps go pale, and pure white is kept for the
  hottest core or the one glint.
- The darkest colour is a near-black tinted to the palette (the template's `INK`), never `#000`.
- `lock()` in the template snaps the whole buffer to the palette at the end of a frame, so a tint, a fade or a stack's
  shading cannot bring in colours from outside it.

## Light

- Light is a second buffer added on top (`'lighter'`): a big soft pool at low strength, a tight hot one at the core,
  a small one on every spark and glint. Hot things look hot because of the light buffer, not because they are painted
  white.
- One light direction for the whole video, usually top left: the lit side of every shape is a step brighter, the far
  side a step darker. A sprite stack gets it from `shade` (darker towards the bottom) and from its colours.
- At night, darken the colour buffer first, then add the lights: windows, lamps and headlights carry the picture.
- Light strength 0.2 to 0.5. More washes the picture out.

## Drawing

- Clear silhouettes and clusters of one colour. No lone pixels inside a shape (speckle): noise that picks colours goes
  through whole cells, never per pixel on a small shape.
- Outlines are one pixel, in the darkest step of the object's own ramp or in `INK`. On the lit side an outline may go
  a step lighter.
- Ordered dithering (a 4 x 4 Bayer pattern) for fades of an opaque colour and for the steps of a big area such as a
  sky. Never a checkerboard for smoke: smoke is translucent, lit on top.
- Objects that turn are sprite stacks (`/__motlab/sprite.js`, made with the asset skill's `slices.py`), drawn at one
  voxel to one buffer pixel. Sprites that face the camera (characters, pickups) are sprite sheets, or strings of
  characters drawn in code as in the template.
- It must read at 1x: look at the buffer itself, not only the scaled frame. Fewer colours, a bigger shape and one focal
  point fix most frames that read as mush.

## Motion and timing

- Poses and frame-by-frame animation hold on steps of 12 a second (8 for chunkier); particles, light and the camera run
  at the video's frame rate but land on whole pixels.
- Fast in, slow out (`outQuart`, `outExpo`). A hit has a one or two frame white hero frame, freezes everything for 0.03
  to 0.2 s (longer for heavier), and shakes 1 to 2 pixels.
- Something always moves on a hold: a twinkle, a flicker, a bob of one pixel.
- An effect has phases: gathering, release, spread, a hold with glints, a slow decay. Big ones linger 2 to 4 s; hits
  are 0.3 to 0.8 s with follow-through.

## Camera

- The camera moves in whole buffer pixels (`camera.js` keys in buffer units, rounded before drawing). Pans and follows
  work well; a slow pan of 4 to 12 pixels a second reads as calm.
- A camera that follows something that moves is snapped to that thing's pixel, not rounded on its own:
  `camX = Math.round(x) - Math.round(x - cam.at(t).x)` (the template's `snapTo`). Rounded apart, the two cross half
  a pixel at different frames and the thing jumps a pixel back and forth on screen: in a 7.5 s test with a car
  followed with a lag, 5 times, each 6 screen pixels at 1080p. Snapped, it moved one way only, on screen and against
  the road.
- Zoom only in whole steps (1x, 2x), with a cut or a hard switch between them. A smooth zoom smears the grid.
- A roll is drawn inside the buffer, so the pixels stay chunky; keep stacks upright with `turn`. Use it rarely.
- Parallax layers each move in whole pixels; far layers move less.

## Text

- A pixel font at a size its grid is drawn for, in the buffer: Silkscreen at 8 or 16 (checked), or Press Start 2P at
  8 or 16, both from Google Fonts through the motlab skill's `get_font.py`. The template's `text()` draws it
  hard-edged, dropping the font's anti-aliasing. A one-pixel `INK` shadow under it.
- Short lines. A title can be bigger by drawing the font at 16 or 24 in the buffer, never by scaling the page.

## Shots and transitions

- Hard cuts, or transitions drawn in the buffer: a dither dissolve (the Bayer threshold sweeping), a diamond or iris
  wipe in whole pixels, a fade through the darkest step. A shader transition between scenes blurs the pixels; use one
  only if the references do.
- Shots of 2 to 4 s; a hold on the end card.

## Sound

- Short, dry sounds: blips, coin pings, small hits, a soft hum under the lights. The user's kit first, then
  `synth_sfx.py`. Music in a chiptune or lo-fi register if the user has none in mind.

## Fixes

| You see | Fix |
| --- | --- |
| it reads as mush at 1x | fewer colours, a clear silhouette, one focal point, bigger shapes |
| lone pixels inside shapes | no per-pixel noise on small shapes; quantize to ramp steps over whole cells |
| smooth gradients, a vector look | hard ramp steps; softness only in light and smoke |
| washed out | less light (0.2 to 0.5), darker edge steps, white only on the hottest core |
| flat | one light side: a step brighter top left, a step darker bottom right |
| floaty, no punch | fast in, slow out, a white hero frame, a freeze on contact, a shorter total |
| stiff | vary size, speed and delay of every particle; secondary motion |
| edges that crawl | whole-pixel positions; the camera rounded to the grid |
| a followed object jumps a pixel back and forth | snap the camera to its pixel (`snapTo`), don't round the two apart |
| uneven pixels in an export | a buffer of the page / 6, scaled whole; nothing drawn at page resolution |

## Checklist before opening the viewer

- [ ] Everything is drawn in the buffer; a still zoomed in shows square pixels of one size, text included
- [ ] The palette is the ramps and nothing else (`lock()` on, or checked with `palette.py`)
- [ ] Each ramp shifts hue from cool shadows to warm highlights
- [ ] Light comes from one side, and the light buffer stays under 0.5 except on cores
- [ ] No speckle inside shapes; the buffer reads at 1x
- [ ] Poses hold on 12 a second; positions are whole pixels; the camera does not zoom smoothly
- [ ] A camera that follows something is snapped to its pixel; step through the follow frame by frame
- [ ] Transitions are cuts or drawn in the buffer
