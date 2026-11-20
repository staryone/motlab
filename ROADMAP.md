# Roadmap

What is not built, what has not been tested, and ideas that came up while using motlab. Nothing here is promised.

## Not built yet

- Alpha output (ProRes 4444).
- The viewer on a VPS with a domain. That needs security in front of it, or access only through Tailscale, which is also worth considering. From there, work could be run remotely on the personal laptop (when it is on) or on the VPS (when there is one).
- A dark mode for the viewer. Its colours are written into the CSS and the timeline's canvas code, so they need to become tokens with dark values checked for contrast first.

## Not tested yet

- The benchmark against Remotion and HyperFrames on macOS and Linux, with their own downloaded browsers, and on scenes heavy on text, images or footage. It was one scene on Windows, at 1080p and 4K.
- The npm package on macOS. It was installed on Windows, from the registry and with nvm for Windows 2.0 (where setup writes its own launcher), and on a Linux VPS from a packed tarball (docs/install.md).
- macOS, and Linux beyond the tests, including `motlab update` there. On Linux, CI renders the end-to-end tests on an Ubuntu runner, and a real video has been made there now: a 42 s, 1080x1920 project on Ubuntu 24.04 with no GPU, in about 82 s (issue #8). On macOS the Chrome paths and the Metal flag are in the code, but nothing has run.
- `render --parallel` and Export on a machine with fewer than 16 CPU threads or little memory, and on a GPU whose hardware encoder runs out of sessions, where the fallback to one part at a time should take over. The parallel render was measured on the test laptop only (docs/projects.md).
- Renders longer than 10 minutes, and a 10-minute render on a machine that is doing nothing else.
- A machine without a GPU beyond the tests. CI runs the end-to-end tests on Linux and Windows runners without a GPU, and the benchmark ran with Chrome drawing on SwiftShader on the test laptop (1080p and 4K, in `docs/rendering.md`). A real video has been rendered on such a machine now: a 42 s, 1080x1920 project on Ubuntu 24.04 with no GPU, in about 82 s (issue #8). No 3D (WebGL) scene has been rendered on one yet.
- Footage filmed on a phone (variable frame rate and HEVC were tested with files made by ffmpeg), and HEVC on a Chrome that cannot decode it.
- Scene transitions between scenes of different sizes in the viewer, and in a normal Chrome window. The render refuses scenes of different sizes.
- The cut voice from `cut_pauses.py` on a real person's take. The whole-take test used Windows text to speech. Sections and captions were tested on made-up recordings and a transcript shaped like Whisper's, not on a real take or real Whisper output.
- A `.glsl` transition copied from gl-transitions beyond the 11 built in, and one matched to a real reference video by the skill.
- Rive, Lottie text layers exported with glyphs, Theatre.js state exported from its studio, and the studio inside the viewer.
- p5.js `loadFont` and p5 add-on libraries.
- The asset skill (`motlab-assets`) on a real brief and a kit used in a real video. Its scripts were run on a test kit: an SVG character with a rig, a transition, a mug on both 3D paths and a Rigify figure.
- MPFB, which was not installed on the test laptop.
- The asset skill's FBX and OBJ files in programs other than Blender (Unity, Unreal, Maya, Cinema 4D).
- `svgparts.js` and `transition.js` in the viewer. They were checked with stills and a video render.
- Notes on a real touch screen. Touch was emulated in Chrome over the DevTools protocol. Moving and resizing a box was tried with the mouse only.
- The viewer on a real phone. The phone layout, its menus and notes drawn with touch were checked in Chrome with a phone emulated over the DevTools protocol, at 390 and 360 px upright and 844 and 740 px sideways. On an iPhone, Safari allows full screen for video elements only, so the viewer has no full screen there.
- The viewer's full screen outside Chrome on Windows.
- The skills in agents other than Claude Code. The installer was run with `--dry-run` for every target, and the folders come from each agent's docs. A Muse agent followed `skills/motlab/SKILL.md` from a clone and made a real video (a 42 s project on Ubuntu 24.04 with no GPU, issue #8). The skills installed with `--skill muse`, Hermes Agent (both added from their docs in November 2026) and the other agents have not been tried yet.

## Questions about speed

- Whether Chrome can be made to use NVENC on NVIDIA cards. On the test laptop `nvidia-smi` showed no encoder sessions during a hardware encode, so Chrome probably used the integrated GPU's encoder.
- Why the hardware encoder at 4K switches between about 34 and 17 fps from run to run.
