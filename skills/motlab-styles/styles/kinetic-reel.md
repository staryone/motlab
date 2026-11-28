# Kinetic reel

A ready-made look for 9:16 vertical videos (1080x1920 Reels, Shorts, TikTok, vertical explainers and talking-head edits), about 12 to 45 seconds long. Built around phone platform safe zones, an immediate hook on frame 0, layered 2.5D stat/info cards, and word-highlighted captions. Use it when the user asks for it.

`templates/kinetic-reel-2d.html` is a working 2D starting point: safe-zone headline hook, staggered layered cards with solid offsets (no `shadowBlur`), a slow-drifting grid backdrop, and a word-highlighted caption pill. Copy it into `<video>/scenes/` and replace `CARDS`, `WORDS` and `TOKENS`.

## Where the numbers come from

- **Safe zones (`x: 72..960`, `y: 180..1520` on 1080x1920):** the overlap of the unobscured area across Instagram Reels (bottom ~384 px caption/audio bar, right ~120 px action rail), YouTube Shorts (bottom ~380 px title/channel bar, right ~120 px icons) and TikTok (top ~150 to 180 px tabs, bottom ~380 to 400 px caption/sound, right ~120 px rail). Keeping text and faces inside `x: 72..960` and `y: 180..1520` leaves the right 120 px and bottom 400 px free on all three.
- **Minimum contrast (`4.5:1` body, `3:1` large headlines):** WCAG 2.1 Level AA for small phone screens viewed outdoors.
- **Layered flat offset instead of `shadowBlur`:** `docs/rendering.md` measured 160 `shadowBlur` calls capping 2D canvas rendering at about 32 fps at 1080p, so cards use a flat dark offset shape underneath instead of Gaussian canvas blur.
- **Talking-head cut list numbers (`punch: [1, 1.12]`, `glide: 0.25`, `drift: 0.008`, `y: 0.42`):** from `docs/projects.md#cut-lists`.

## Canvas and safe zones

- Base canvas: `1080 x 1920` (`--scale 1` = 1080x1920, `--scale 2` = 2160x3840).
- Keep all text, faces, badges and key visuals inside:
  - Top: `y >= 180` px
  - Bottom: `y <= 1520` px
  - Sides: `x` in `72 .. 960` px (right `120` px is reserved for platform action icons)
- Focal subject sits slightly above mathematical centre: `y = 760 .. 880` px.

## Structure and pacing

- **0.0 to 0.8 s (Hook):** The claim, headline or main number is already legible by `t = 0.08` s (no fade from black; frame 0 doubles as the cover thumbnail).
- **Beat length:** `1.6` to `3.2` s per visual beat. Change framing, card state or zoom at least every `2.5` s so the frame never feels parked.
- **End / CTA:** Hold the final `2.0` to `2.8` s steady inside the safe zone with one clear action.

## Shots and transitions

- Hard cuts with a **punch-in / punch-out** (`1.00x` -> `1.10x` -> `1.00x`), or `directionalwipe` / `crosswarp` (`0.28` to `0.38` s, `inOutCubic`) between major sections.
- For talking-head footage (`/__motlab/cuts.js`), use `punch: [1, 1.12]`, `glide: 0.25`, `drift: 0.008`, `y: 0.42`.
- Incoming cards rise `36` px while scaling `0.94 -> 1.00` over `0.32` to `0.36` s (`outExpo`), staggered `0.10` to `0.14` s apart.

## Framing and text

- Contrast: at least **4.5:1** for body and labels, **3:1** for headlines (`>= 68` px).
- Headline: `68` to `92` px, weight `700`, line height `1.08`, tight tracking (`-0.03em`), at most `5` words per line.
- Labels and body: `32` to `42` px, weight `500` to `600`. Never draw text smaller than `28` px on `1080x1920`.
- Burned-in captions (`edit.captions(transcript, { maxChars: 24, maxGap: 0.5, hold: 0.25 })`): sit around `y = 1400` px inside a rounded pill (`radius 22`, dark semi-opaque fill), with the active word highlighted in the accent colour.

## Background and finish

- Full-bleed dark gradient background with a faint `96` px grid (`alpha 0.045`) drifting `18` px/s vertically so holds stay alive.
- Cards use a crisp `2.5` px border and a solid dark `14` px vertical offset underneath instead of `shadowBlur`.

## Sound

- `whoosh` (`-10` dB, `peak`) on section wipes, `pop` or `tap` (`-14` dB, `start`) on card entrances, `hit` (`-6` dB, `start`) on the hook at `0.1` s.
- Duck the music bed `-9` dB under voice (`mix.py --voice ... --duck 9`).

## Checklist before opening the viewer

- [ ] Frame `0.08` s reads as a clear cover thumbnail (no black fade-in)
- [ ] No text or key UI outside `x: 72..960`, `y: 180..1520`
- [ ] Smallest text is at least `28` px and meets WCAG AA contrast
- [ ] Every beat is under `3.2` s and nothing is frozen except the end card
