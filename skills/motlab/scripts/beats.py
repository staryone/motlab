"""Find the tempo, beats, bars and the biggest rise of a music track, in seconds of the video, and write them as JSON.

    python3 beats.py <track> <beats.json> [--start 0] [--from 0] [--duration D] [--bpm N] [--meter 4] [--downbeat K]

--start, --from, --duration   the track's entry in project.json: where it starts in the video, where in the file it
                              starts reading, and how much of it plays. Every time written is in video time, so a
                              scene compares it with SCENE_START + t and mix.py places cues on it as it is.
--bpm N       use this tempo instead of the measured one (the measure can pick half or double the tempo).
--meter 4     beats in a bar.
--downbeat K  the K-th beat (from 1) is the first beat of a bar. Without it the beat with the most low end (the kick)
              in its place in the bar is taken, which is often wrong: listen, and give it when the bars are off.
              Bar 1 set in the viewer (B on a beat) is kept when this runs again on the same track and entry.

beats.json:
    {"tempo": 128.0, "meter": 4, "downbeat": 1, "beats": [0.231, ...], "bars": [0.231, ...], "rise": 15.234,
     "levels": [-21.3, ...], "start": 0, "from": 0, "file": "audio/music.mp3"}
  beats   every beat. bars: the first beat of each bar, bar 1 first; beats before it are a pickup.
  rise    the start of the bar where the track gets loudest compared with the four bars before it (a drop, a chorus).
  levels  each bar's loudness in dB, for checking the rise. downbeatBy: "viewer" when bar 1 was set there (B); the
          viewer drops levels then, since they were measured on the old bars.

The method: an onset curve (how much the spectrum rises at each moment, in 40 bands), the tempo from its
autocorrelation weighted towards 120 BPM, and the beats from the dynamic-programming beat tracker of Ellis 2007
("Beat Tracking by Dynamic Programming", Journal of New Music Research 36(1)), as librosa implements it, but held
four times tighter to the tempo (tightness 400, librosa's default is 100): music for a video keeps one tempo, and at
100 the beats bent towards a loud hit off the beat on the track this was tried on.
"""
import argparse
import json
import subprocess
import sys

import numpy as np

RATE = 22050
HOP = 256            # 11.6 ms per onset frame
FFT = 1024           # 46 ms: a longer window puts beats up to half of it early
FPS = RATE / HOP
# The onset curve rises as soon as a hit enters the window, before the window is centred on it. On the click track in
# test/beats.test.js the beats came out 10.8 ms early on average (standard deviation 1.7 ms), so they are moved this much.
LATENCY = 0.011


def fail(msg):
    sys.exit(f'beats.py: {msg}')


def decode(path, skip, length):
    cmd = ['ffmpeg', '-v', 'error', *(['-ss', str(skip)] if skip else []), *(['-t', str(length)] if length else []),
           '-i', path, '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-']
    try:
        pcm = subprocess.run(cmd, capture_output=True, check=True).stdout
    except subprocess.CalledProcessError as e:
        fail(f'ffmpeg could not read {path}: {e.stderr.decode(errors="replace").strip()}')
    return np.frombuffer(pcm, np.float32).astype(np.float64)


def bands(count=40, low=30.0, high=8000.0):
    """Triangular filters spaced evenly on a log frequency scale, as a (count, FFT/2+1) matrix."""
    freqs = np.fft.rfftfreq(FFT, 1 / RATE)
    edges = np.geomspace(low, high, count + 2)
    out = np.zeros((count, len(freqs)))
    for i in range(count):
        a, b, c = edges[i:i + 3]
        out[i] = np.clip(np.minimum((freqs - a) / (b - a), (c - freqs) / (c - b)), 0, None)
    return out, edges[1:-1]


def spectrum(x):
    """Band levels in dB per onset frame. Frame k is centred at k * HOP samples."""
    x = np.pad(x, FFT // 2)
    frames = 1 + (len(x) - FFT) // HOP
    window = np.hanning(FFT)
    idx = np.arange(FFT)[None, :] + HOP * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(x[idx] * window, axis=1)) ** 2
    fb, centres = bands()
    level = 10 * np.log10(np.maximum(power @ fb.T, 1e-10))
    return np.maximum(level, level.max() - 80), centres, power.sum(axis=1)


def onsets(level):
    """How much the bands rise from one frame to the next, averaged, with slow changes taken out."""
    rise = np.maximum(0, np.diff(level, axis=0, prepend=level[:1])).mean(axis=1)
    k = int(FPS)   # about one second
    slow = np.convolve(rise, np.ones(k) / k, mode='same')
    curve = rise - slow
    return curve / (curve.std() + 1e-9)


def measure_tempo(curve, low=50.0, high=220.0, centre=120.0, octaves=1.0):
    n = len(curve)
    spec = np.fft.rfft(curve - curve.mean(), 2 * n)
    ac = np.fft.irfft(np.abs(spec) ** 2)[:n]
    lags = np.arange(1, min(n, int(4 * FPS)))
    bpm = 60 * FPS / lags
    weight = np.exp(-0.5 * (np.log2(bpm / centre) / octaves) ** 2)
    score = ac[lags] * weight * ((bpm >= low) & (bpm <= high))
    i = int(np.argmax(score))
    if 0 < i < len(score) - 1:   # a parabola through the peak and its neighbours, for a lag between frames
        a, b, c = score[i - 1:i + 2]
        shift = 0.5 * (a - c) / (a - 2 * b + c) if a - 2 * b + c else 0.0
    else:
        shift = 0.0
    return 60 * FPS / (lags[i] + shift)


def track_beats(curve, bpm, tightness=400.0):
    period = 60 * FPS / bpm
    k = int(round(period))
    window = np.exp(-0.5 * (np.arange(-k, k + 1) * 32.0 / period) ** 2)
    local = np.convolve(curve, window, mode='same')
    n = len(local)
    score, back = np.zeros(n), np.full(n, -1)
    lo, hi = int(round(period / 2)), int(round(2 * period))
    for t in range(n):
        first, last = max(0, t - hi), t - lo
        if last < first:
            score[t] = local[t]
            continue
        prev = np.arange(first, last + 1)
        cost = -tightness * np.log((t - prev) / period) ** 2
        options = score[prev] + cost
        j = int(np.argmax(options))
        score[t] = local[t] + options[j]
        back[t] = prev[j]
    peaks = np.flatnonzero((score[1:-1] > score[:-2]) & (score[1:-1] >= score[2:])) + 1
    if not len(peaks):
        fail('found no beats: the track may be silent or too short')
    good = peaks[score[peaks] >= 0.5 * np.median(score[peaks])]
    beats = [int(good[-1])]
    while back[beats[-1]] >= 0:
        beats.append(int(back[beats[-1]]))
    beats = np.array(beats[::-1])
    strong = 0.5 * np.sqrt((local[beats] ** 2).mean())
    keep = np.flatnonzero(local[beats] >= strong)   # quiet beats before the music starts or after it ends
    return beats[keep[0]:keep[-1] + 1] if len(keep) else beats


def refine(curve, frames):
    """Each beat between onset frames: the top of a parabola through its frame and the two beside it."""
    out = frames.astype(float)
    for i, f in enumerate(frames):
        if 0 < f < len(curve) - 1:
            a, b, c = curve[f - 1:f + 2]
            bend = a - 2 * b + c
            if bend < 0:
                out[i] += np.clip(0.5 * (a - c) / bend, -0.5, 0.5)
    return out


def viewer_downbeat(opt, count):
    """Bar 1 as the user set it in the viewer (B) in the beats.json being replaced, when it is for the same track."""
    try:
        with open(opt.out, encoding='utf8') as f:
            old = json.load(f)
    except (OSError, ValueError):
        return None
    same = (old.get('downbeatBy') == 'viewer' and old.get('file') == opt.track and old.get('start') == opt.start
            and old.get('from') == opt.skip and old.get('meter') == opt.meter)
    down = old.get('downbeat')
    return down if same and isinstance(down, int) and 1 <= down <= count else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('track')
    ap.add_argument('out')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--from', dest='skip', type=float, default=0.0)
    ap.add_argument('--duration', type=float)
    ap.add_argument('--bpm', type=float)
    ap.add_argument('--meter', type=int, default=4)
    ap.add_argument('--downbeat', type=int)
    opt = ap.parse_args()
    if opt.meter < 1:
        fail('--meter must be 1 or more')

    x = decode(opt.track, opt.skip, opt.duration)
    if len(x) < RATE * 2:
        fail(f'{opt.track} has less than 2 s of sound to read')
    level, centres, energy = spectrum(x)
    curve = onsets(level)
    bpm = opt.bpm or measure_tempo(curve)
    frames = track_beats(curve, bpm)
    if len(frames) < opt.meter:
        fail(f'found {len(frames)} beats, fewer than one bar')
    times = refine(curve, frames) / FPS + LATENCY
    # The tempo the beats keep, which the tracker may have nudged from the measured one.
    tempo = 60 / np.median(np.diff(times)) if len(times) > 1 else bpm

    low = onsets(level[:, centres < 200])   # the kick drum, for the first beat of the bar
    kept = viewer_downbeat(opt, len(frames)) if not opt.downbeat else None
    if kept:
        down, guessed = kept, False
    elif opt.downbeat:
        if not 1 <= opt.downbeat <= len(frames):
            fail(f'--downbeat must be from 1 to {len(frames)}')
        down = opt.downbeat
        guessed = False
    else:
        phase = [low[frames[p::opt.meter]].mean() for p in range(opt.meter)]
        down = int(np.argmax(phase)) + 1
        guessed = True
    bar_frames, bar_times = frames[down - 1::opt.meter], times[down - 1::opt.meter]

    # Loudness per bar (RMS of the band power), and the bar that rises most above the four before it.
    ends = np.append(bar_frames[1:], len(energy))
    levels = np.array([10 * np.log10(energy[a:b].mean() + 1e-12) for a, b in zip(bar_frames, ends)])
    levels -= levels.max()
    rise_bar = None
    if len(levels) >= 3:
        lift = [levels[b:b + 4].mean() - levels[max(0, b - 4):b].mean() for b in range(1, len(levels))]
        rise_bar = int(np.argmax(lift)) + 1

    video = lambda t: round(float(t) + opt.start, 3)
    out = {
        'tempo': round(float(tempo), 2), 'meter': opt.meter, 'downbeat': down,
        'beats': [video(t) for t in times], 'bars': [video(t) for t in bar_times],
        'rise': video(bar_times[rise_bar]) if rise_bar is not None else None,
        'levels': [round(float(v), 1) for v in levels],
        'start': opt.start, 'from': opt.skip, 'file': opt.track,
        **({'downbeatBy': 'viewer'} if kept else {}),
    }
    with open(opt.out, 'w', encoding='utf8') as f:
        json.dump(out, f, indent=1)

    print(f'tempo {out["tempo"]} BPM ({"measured" if not opt.bpm else "given"}), {len(times)} beats, '
          f'{len(bar_frames)} bars of {opt.meter} from beat {down}'
          f'{" (guessed: check by ear, set --downbeat)" if guessed else " (set in the viewer, kept)" if kept else ""}')
    print(f'first beat {out["beats"][0]:.3f} s, bar 1 at {out["bars"][0]:.3f} s, last beat {out["beats"][-1]:.3f} s (video time)')
    if rise_bar is not None:
        print(f'biggest rise: bar {rise_bar + 1} at {out["rise"]:.3f} s')
    print('bar levels (dB): ' + ' '.join(f'{i + 1}:{v:.0f}' for i, v in enumerate(levels)))


if __name__ == '__main__':
    main()
