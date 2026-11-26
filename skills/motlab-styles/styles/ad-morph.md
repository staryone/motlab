# Ad morph

A style for short product, app and brand ads, about 8 to 20 seconds, where there is not one cut or cross dissolve:
every shot grows into the next. It comes from a 12-second Spotify spec ad built with motlab from nothing but eight
phone screenshots and two logo files. Use it when the user asks for it. Once it is on, it applies to every scene, not
only to the scene a note was about.

`templates/ad-morph-2d.html` is a working example in 2D: shots on flat colour fields, a shot change that grows a shape
from the outgoing shot, headlines that rise word by word, a slow push on each shot, and optional held poses, jitter and
flat shadows. Copy it into `<video>/scenes/` and replace its `SHOTS`. In 3D, the same rules go into the motlab skill's
`template-3d.html` or `template-three.html`.

## Structure

- Pick one path through the product and show it as 5 to 10 beats, one per line of voiceover: for an app, opening it,
  finding something, choosing, using it, then the brand. Each beat is a shot.
- Plan each shot with a time range, one line on what we see, one on what moves, and one on how it becomes the next
  shot. That last line is the design: if you cannot write it, the shot needs rethinking.
- Open on something that grabs the eye within a second: a flood of the brand colour, the logo flying in, a character
  caught mid-move.
- Leave time. Viewers need longer than a first draft gives them, especially for anything with text or a quick flip;
  when in doubt, slow a fast moment by half again.
- When the user wants several versions, make them differ in camera and look, not just in copy.

## Shots become each other

Each shot hands its key shape to the next one. In the Spotify ad:

| From | Becomes |
|---|---|
| the logo disc | the phone screen (circle to rounded rectangle, green to dark) |
| a round photo on a tile | the orange background of the artist page (it grows past the frame edges) |
| the mini player bar | the full-screen now-playing background |
| the album cover in the bar | the big cover in the centre, on one curve |
| the white pause disc | the green logo, then the wordmark slides out from behind it |

- An object in the outgoing shot (a button, a card, a logo, an avatar) grows until it fills the frame and becomes the
  next shot's background. Circles, rounded squares and cards turn into each other.
- Paint the growing shape in the next shot's colour first, and let the next shot's content settle in a beat later,
  scaling from 93% to 100%. Cutting straight to the next shot inside the shape looks abrupt by comparison.
- A small squash just before the shape grows gives it a push: about 8% one pose before it grows,
  `1 - 0.08 * bump(prog(t, start - 0.14, start + 0.02))`.
- Pieces that move together share one speed and one spacing, and things meant to happen at once happen at once.
- Curves keep bending the same way while they morph; one that flattens and flips looks broken.
- Shader transitions between scenes are not used: a shader between two scenes that already morph into each other only
  blurs the morph. A layer over a cut only when the user asks for one.

## Camera

- In 3D, one camera for the whole ad. Moves start quickly and settle slowly (an exponential ease out), with no sudden
  bursts of speed in the middle of a move.
- A move keeps its direction. Do not push in and then pull back on the same subject, and do not let an orbit swing
  back. If a card has to end facing the camera, let the move arrive there. Ease distance in log space, so a push feels
  even from far to near:

  ```js
  const D = Math.exp(lerp(Math.log(2500), Math.log(1700), outCubic(prog(t, 1.1, 3.75))));
  ```

- Something is always moving, even if only a slow drift: a 3 to 5% push on holds, rings pulsing behind the cover. A
  still frame reads as a mistake, except on the end card.
- On a long scroll or pan, change the angle as it goes so the screen does not sit flat and still.

## Easing

- Entrances: `outExpo` or `outCubic` (fast, then a long settle). First drafts are nearly always too fast.
- Shape morphs: `inOutCubic`. Fades: a sine, never an ease that ends abruptly.
- Staggers of 0.08 to 0.1 s between items in a cascade (tiles, list rows, words).

## Framing and text

- Centre the subject, and keep the last shot perfectly still and centred, using the logo's visible bounds.
- Leave space for headlines, usually at the top, and keep them away from where things will move.
- Headlines in the brand's font, sentence case, short, ending in a full stop, with tight letter spacing (about -3%).
  Words come in one at a time, 0.06 to 0.09 s apart: each rises about 20 px while it goes from blurred to sharp, and
  they go out the same way. No bounces, letter-by-letter typing, pops in scale or hard wipe edges.
- A gradient on text only on dark backgrounds, on the lower half of the letters. On a colour field use solid ink.
- On the end card, the tagline or URL is much smaller than the wordmark and sits below it. Typing the URL into a search
  field with a blinking caret is a clear call to action.

## Interfaces and assets

- Use the product's real screens, from the user's screenshots, cleaned up: personal names and photos replaced with
  neutral placeholders, notifications and unrelated apps removed, and every state correct (a playing track shows pause).
- Icons, wordmarks and buttons that the camera moves close to are drawn again as vector paths; a screenshot blurs at
  that size in 4K.
- A phone is built, not photographed: dark glass, a thin bezel, a frame with some depth. Side buttons only if their
  exact position is known.
- Characters from a brand's illustrations are cut out and puppeted; objects are redrawn as shapes (the motlab skill's
  `engine-2d-puppet.md`).
- For a spec ad (made without the brand's involvement), add a small note at the end saying so, and do not borrow the
  brand's campaign lines.

## Depth and finish

- UI panels sit in real 3D (`gl3d.js`) with a perspective camera and shallow depth of field, so the background goes
  soft and it feels filmed. A physical product gets a single soft light (the motlab skill's `blender.md`).
- Motion blur on fast moves: every frame averages 12 renders spread over half a frame's time (`motionBlur`).
- One soft light source, a gentle glow behind the hero, a single light sweep across the final logo. Leave out soft drop
  shadows everywhere, lens flares, light leaks, wobbly text and glow on everything.
- Flat 2D work can hold poses (8 to 12 a second, rendered at 24 fps), with a pixel or two of jitter per pose and hard
  flat shadows, which gives it a hand-made feel.
- Reward the payoff beats with something small: a burst of short lines, a check mark stamping in, a little confetti in
  the brand colours, a quick flash as the logo lands, a light sweeping across the wordmark.
- End with what the viewer should do: download it, visit the URL, sign up.

## Sound

- Repeated ticks rise in pitch (0.90, 1.00, 1.10, 1.20) and alternate pan. Whooshes only under movement, pops and soft
  hits on morphs and landings, a riser that ends on the logo. In the Spotify ad the song came in on the play press,
  with a quiet air bed under the whole ad.
- Music: give its prompt a structure (intro, build, drop, outro) with the lift landing on the reveal, and cut the track
  so its biggest change lands there.
- Voiceover: a line for each shot in the way the brand talks, finishing on its slogan, and the end card's last two
  seconds stay quiet.

## Checklist before opening the viewer

- [ ] Every shot change has a shape that carries across it
- [ ] Nothing reverses direction, and nothing is fully still except the end card
- [ ] Subject centred by its visible bounds, end card dead still and centred
- [ ] Headlines word by word, sentence case, tight tracking
- [ ] It ends on what the viewer should do
