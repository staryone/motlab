# Technique: how a scene is built and checked

These hold for every video, whatever it looks like. They are about working accurately, not about a look: the look
comes from the user's references, from another skill, or from a style in the motlab-styles skill.

## 1. Real assets, measured to the pixel

- Every picture on screen is the user's real material: screenshots, logos, photos, footage. Nothing is invented when
  a real version exists.
- Measure before you draw, and keep the numbers as constants: a logo's visible bounding box
  (`{ x: 13, y: 14, w: 913, h: 912 }`), a picture's rectangle inside a screenshot (`[128, 267, 823, 823]`), each crop
  rectangle. Placing, centring and morphing then land exactly, and a logo is placed by what you see, not by the file's
  canvas with its empty margins. `scripts/grid.py` overlays pixel coordinates to read them off.
- Crop pieces out of screenshots and move them separately (tiles, a header, list rows), so a flat screenshot becomes
  layers. Cover personal details (a profile photo becomes a grey circle).
- Rebuild anything the camera gets close to as vector shapes, so it stays sharp at 4K while the screenshot around it
  would blur.

## 2. One block of beat times

```js
const B = { morph1: 1.05, tilesIn: 1.5, tap: 3.0, flood2: 3.15, artist: 3.7, press: 5.9, END: 12 };
window.EVENTS = [{ name: 'tap', t: B.tap }, { name: 'press_play', t: B.press }];
```

Every animation reads its times from `B`, and `EVENTS` is built from the same constants. Re-timing a note ("slower
here") is one number, and the sound effects follow because the cues point at event names (`sound-and-music.md`).

## 3. Every shot change is decided in the plan

Each planned shot has a time range, what we see, what moves, and how it meets the next one: a hard cut, a shader
transition (which type), a layer over the cut, or something carried across inside the pages (a shape that grows into
the next shot, a camera move that continues). Write that line for every shot, so no join is left undecided while
building. The look decides which kind; with nothing in the references or the brief, ask.

## 4. Motion done accurately

- Pieces that move together are driven from one shared value with even spacing, so they never collide or drift apart.
- A camera on a 2D page is keys in `/__motlab/camera.js`, which eases zoom in log space so a push feels even from
  far to near (`motion-and-libraries.md`). A 3D camera's distance eases the same way:
  `Math.exp(lerp(Math.log(2500), Math.log(1700), outCubic(prog(t, 1.1, 3.75))))`.
- A move that carries across a hard cut: the next scene's `t = 0` shows what the previous one would show at its
  `TOTAL`, one frame after its last frame.
- Fast moves smear instead of stepping with `motionBlur` from `/__motlab/motion.js` (`motion-and-libraries.md`).
- Random-looking motion (jitter, noise, particles) comes from a seed or a hash of the frame, so every render matches.

## 5. Text that can be read

- Text stays up long enough to read twice. At 1080p, text from a screen recording stays at least as large as in the
  original.
- In portrait and square clips, keep text and faces clear of the top and bottom, where the app's own interface sits.
- Fonts come from the brand first, then Google Fonts (`fonts.md`).

## Checklist before opening the viewer

- [ ] Every shot change is the one the plan says
- [ ] Stills checked at three or four points inside every transition, not only on the holds
- [ ] Things placed by their visible bounds, measured, not guessed
- [ ] Assets crisp at 4K where the camera gets close
- [ ] Beat times in one block, events derived from them
- [ ] The chosen look's own rules checked (its checklist, if it is a motlab-styles style)
