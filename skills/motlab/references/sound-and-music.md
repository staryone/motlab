# Sound effects, voiceover and music

Sound can be built with the first version or added later, once the user has music and effects. Any revision that moves
a beat moves the sound with it, so run the mix again after timing changes.

## Effects: `scripts/mix.py`

### 1. Take the beats from the page

Never type beat times into the mix by hand. Give each scene a `window.EVENTS` list made from the same constants that
drive its animation, for example `[{ name: 'card.open', t: T.cardOpen }, ...]`, and include beats that are computed
(every step of a sequence, every landing, every word of a headline). Export it with
`motlab events page.html events.json`. A cue that names `"event": "card.open"` then follows the animation when it is
re-timed. `EVENTS` times are per scene: for cues across several scenes, add each scene's start in the video. That is
the end of the scene before it, less the length of a shader transition into it (not a layer transition), so not the sum
of the `TOTAL`s before it when there are transitions. The page itself gets it as `window.SCENE_START`, but only once
`renderAt` runs, so `EVENTS` cannot use it.

When the animation holds poses (8 or 12 a second), pass the same number as `--quant`: each event moves to the start of
the pose in which its change is first visible.

### 2. Find the sounds

- Ask whether the user has a sound library, or look for folders of WAV files on the machine. List them by name and
  folder before choosing, and with earshot (below) by what they actually sound like. Copy the ones this video uses
  into its folder. Recorded libraries sound richest, but read their licence for this kind of use.
- With no library, `python3 scripts/synth_sfx.py sounds/` writes a small set made from noise and sine waves (whooshes,
  a pop, a tick, a thud, a shutter, a riser, an air bed). Plainer than recordings, but free and offline. Add a function
  to the script when a video needs a sound it lacks.
- For recorded sounds, `python3 scripts/get_sfx.py search "soft whoosh" --max 2` searches Openverse (CC0 by default;
  `--license commercial` adds CC BY and BY-SA, which need a credit), and
  `python3 scripts/get_sfx.py get <id> ... --out <video>/audio/sfx` downloads them and writes `CREDITS.md` with a credit
  line for each. Without a key Openverse allows 20 requests a minute and 200 a day. Most results are Freesound's MP3
  previews, which are fine for UI sounds and whooshes. Ask before downloading, and tell the user which sounds need a
  credit.

On music: with the track's `beats.json` from `beats.py` (see [Timing to music](#timing-to-music)), pass
`--beats beats.json` and a cue can say `"bar": 5` (the first beat of bar 5, from 1), `"bar": 5, "beat": 3` (its third
beat) or `"beat": 12` (the twelfth beat of the track). A bed can end on `"to_bar"`.

### 3. Write the cues

`cues.json` has one entry per beat, for example `{"event": "card.open", "file": "pop", "role": "pop"}`. The header of
`mix.py` lists every field.

- `role` sets the level and how the sound sits on the beat, so most cues need nothing else. Levels are the cue's peak
  in dBFS, from the [Clipwing real-sfx skill](https://clipwing.pro/skills/real-sfx): `hit` -4, `whoosh` -9, `riser` -12,
  `click`, `ui`, `pop`, `tap`, `key` and `tick` -14, `ambience` -24. A quiet layer under another sound takes its own
  `"db"`, for example -28.
- The anchor is the point of the sound placed on the beat. Struck sounds use the moment they become audible, past any
  silence at the start of the file, so they never come before the motion. A whoosh uses its loudest point, in the middle
  of the move. A riser uses its end, on the reveal. Library files often start with 30 to 150 ms of near silence, so a
  file placed by its first sample sounds late; measuring where it becomes audible avoids that.
- Without a role, `align` is `auto` and measured from the sound: `start` if it peaks within 60 ms of becoming audible,
  `arrive` (first within 3 dB of the peak) if it is nearly full at least 100 ms before its peak, `peak` otherwise. Set
  `"align"` to `start`, `arrive`, `peak` or `end` to choose. The printout marks automatic choices with `*`. Cue files
  from before 2026-11-13 without `align` used `peak`; add `"align": "peak"` to keep that.
- `pitch` varies a repeated sound (a run of clicks climbing from 0.9 to 1.3), `lp` and `hp` soften it, `dur` cuts a long
  tail, `pan` places it left or right.
- Beds (`"type": "bed"`) are long layers: looped if short, faded in and out, with an `env` of level changes over time.
  The default fades are 0.5 s in and 1 s out. When they do not fit, both are shortened in proportion so the bed
  still reaches its level where they meet.

### 4. Mix

```
python3 scripts/mix.py cues.json "<video>/audio/sfx.wav" --lib sounds/ --events events.json [--gain -2]
```

It reads WAV, AIFF, MP3, FLAC, OGG, Opus and M4A. For each cue it prints how far the anchor landed from its beat
(0 ms is right; more than a frame is a bug), then the peak level. With a voiceover, add `--voice <video>/audio/voice.wav`
(the voice as it plays in the video, from 0 s): effects drop 9 dB while it speaks (`--duck 6` for less). On a test mix
that measured -9.0 dB under speech and less than 1 dB of reduction half a second after the speech stopped.

It warns about:

- a cue outside 0 to `--len`, which is cut off or silent (often a per-scene event time missing its scene's start);
- one file five or more times in a row (except ticks and keys): use another file or vary `pitch`;
- `tick`, `key` and `pop` cues closer than 66, 87 and 114 ms, where they start to blur (from earshot's launch kit).

Last, it lists up to five moments to **listen to by ear**: the first sound, the loudest cue, the busiest second, any
gap of more than 2.5 s, and with `--voice` the loudest cue under speech. You cannot hear the result, so pass these
moments on to the user when you open the viewer.

A full sound bed usually has three layers: two to four quiet beds (a soft tonal pad, a high airy layer, a faint
texture) that lift towards the reveal; soft whooshes (-26 to -33 dB) under camera and object moves; and the hits, pops
and clicks on top, with a riser and a low hit under the final reveal. Measure the loudness with
`ffmpeg -i sfx.wav -af loudnorm=print_format=summary -f null -` and look at a waveform (`showwavespic`) for silent
stretches. An effects-only track around -20 LUFS with peaks below -2 dBFS leaves room for music.

### 5. Add it to the project

Save the WAV in `<video>/audio/` and list it in `project.json`. The viewer plays it and Export mixes it in.

### Taste

- Aim for clean, light sounds: soft pops, tonal clicks, wooden or glassy taps, airy whooshes.
- Save whooshes for things that travel: the camera, a sliding panel. A cut or a shape change sounds better as a pop,
  a tick or a soft hit.
- Leave out bells and dings, typing sounds and hums, and never play one file identically several times in a row.
- Let the sound say what happens: pieces locking together click, a panel opening slides, a reveal rises and lands.

## earshot, when the user has it

[earshot](https://github.com/Leonxlnx/earshot) (MIT, CPU only) turns sound into words and numbers an agent can read.
motlab does not depend on it, so check once at the start of the sound work:

- `motlab doctor` has an earshot line: `ok` means the CLI and its models are there, `warn` says which is missing.
  `earshot --help` running is enough for the CLI. If the session lists earshot MCP tools, use those instead.
- Neither: carry on with the steps above. Mention earshot once only if the user asks how to pick sounds better.
- The analysis commands need about 1.1 GB of models (`earshot doctor --fetch`). Ask before fetching them.

With earshot, use it at three points, and read `earshot <command> --help` for the arguments rather than guessing them:

1. **Choosing sounds** (step 2). `earshot find` and `match` search a library by what the sounds are, not their names,
   and `describe` says what one sound is. Use them to shortlist from a big library, then still check onset and length
   with `mix.py`'s printout. Each call loads the models again (20 to 40 s), so batch questions into few calls.
2. **Checking the mix** (step 4). `earshot measure` gives LUFS, true peak and loudness range without loading models.
   Measure the effects track and a full mix with voice and music. `critique` and `timeline` on the full mix can point
   at silent stretches or a cue that covers a word.
3. **Filling a gap** with no fitting sound in the library: `earshot sfx list --kind whoosh`, then
   `earshot sfx render <id> -o <video>/audio/sfx/<name>.wav --dur 0.8` renders one from code, nothing downloaded.

Its words are hints, not taste: it cannot judge whether a sound fits the brand, knows nothing of licences, and hears
nothing above 14 kHz. Say in the hand-off which checks came from earshot, and keep the "listen by ear" moments for the user.

## Voiceover

If the user has ElevenLabs connected to the agent (a connector or MCP server), the agent can write the script to the
exact timing of the scenes and generate the voice in the same session. Each take costs the user ElevenLabs
credits, so make one only on request. Without the connection, the user pastes your script into ElevenLabs themselves.

- Budget roughly 2.2 words per second so the delivery is not rushed. A 10-second video holds 18 to 22 words.
- Write a line for each shot in the way the brand talks, and finish on what the viewer should do or remember.
- Only claims the user can back up; no promised results.
- Add delivery notes (pace, mood, pauses, which word carries the stress) and offer a second version aimed at another
  audience. When the real take arrives, re-time the scene constants to it.

## Timing to music

When the music is there before the animation, the shots follow it. `scripts/beats.py` measures the track and writes
its tempo, beats and bars in video time:

```bash
python3 scripts/beats.py <video>/audio/music.mp3 <video>/audio/beats.json --start 0 --from 0
```

Give it the same `start`, `from` and `duration` as the track's entry in `project.json`, and run it again when they
change. It prints the tempo, how many bars there are, where bar 1 is, the bar with the biggest rise (a drop or a
chorus) and the loudness of each bar. In `beats.json`, `beats` and `bars` are lists of seconds, bar 1 first; beats
before bar 1 are a pickup.

- The tempo can come out half or double the felt one. If the beats are twice too many or too few, pass `--bpm`.
- Bar 1 is a guess (the beat with the most kick in its place in the bar), and often wrong. Tell the user which beat
  bar 1 starts on, ask them to listen, and pass `--downbeat K` when they say it starts elsewhere. `--meter 3` for a
  waltz.
- Plan the shots in bars: a cut on the first beat of a bar, the biggest change on `rise`. A scene reads `beats.json`
  in `ready` and compares `window.SCENE_START + t` with its times (`docs/projects.md`, "Where a scene starts"). Set
  each scene's `TOTAL` from the plan, as constants: a scene that ends on a bar line has the length of the bars it
  covers, and the next one starts on it. A scene's length is rounded to whole frames, so a cut lands up to half a
  frame from its beat.
- A visible hit goes on the frame on or just before its beat: sound ahead of the picture is noticed sooner (about
  45 ms) than sound behind it (about 125 ms, ITU-R BT.1359).
- `mix.py --beats` places effects on bars and beats (above).

Tried on one 32 s hip-hop track (MP3): 103.8 BPM and 56 beats. earshot's own beat tracker also heard 103.8 BPM and 56
beats, and all 56 of ours fell on its beat grid. On a made-up click track at 120 BPM the beats were within 3 ms of
the clicks (`test/beats.test.js`), but the 11 ms that every beat is moved later was measured on that same track. The
guess for bar 1 on the real track was right by ear, with a tick mixed in on every bar. Not tried: tracks that
change tempo, swing, or start with a long intro without drums.

## Music

Write a prompt for a music generator such as Suno with the exact length the video needs. The user generates the track and
sends the file, which goes into `project.json` at a level below the effects and the voice. Check whether the user has
a connector for the service before assuming they work in its website, and point out that commercial use can depend on
their plan.

- Match the tempo to anything rhythmic on screen: pulses every 0.62 s are 97 BPM.
- Offer two or three directions that fit the video's look. For each, give a style line and a structure (intro, build,
  drop, outro, instrumental) with the lift landing on the video's biggest moment. For example: "warm minimal house, 97 BPM, instrumental, soft round kick, muted
  plucks, gentle chords, bright and calm", or "playful indie electronic, 97 BPM, instrumental, hand claps, bouncy bass,
  toy-piano melody, cheerful".
- Cut the track so its biggest change lands on that moment, and keep the music 8 to 10 dB under the effects so the
  details still come through.
