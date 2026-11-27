import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const beats = fileURLToPath(new URL('../skills/motlab/scripts/beats.py', import.meta.url));
const mix = fileURLToPath(new URL('../skills/motlab/scripts/mix.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const dir = mkdtempSync(join(tmpdir(), 'motlab-beats-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// 16 s at 120 BPM from 0.5 s: a low kick on the first beat of each bar, a short high tick on the others, and the
// last 4 bars 9 dB louder. Beat n (from 0) is at 0.5 + n * 0.5 s in the file.
const track = join(dir, 'click.wav');
const made = spawnSync(python, ['-c', `
import sys, wave
import numpy as np
rate = 44100
x = np.zeros(int(16.5 * rate))
t = np.arange(int(0.12 * rate)) / rate
kick = np.sin(2 * np.pi * 60 * t) * np.exp(-t * 30)
tick = np.random.default_rng(1).standard_normal(len(t)) * np.exp(-t * 200) * 0.3
for n in range(32):
    at = int((0.5 + n * 0.5) * rate)
    gain = 2.8 if n >= 16 else 1.0
    x[at:at + len(t)] += (kick if n % 4 == 0 else tick) * gain * 0.3
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
`, track], { encoding: 'utf8' });
assert.equal(made.status, 0, made.stderr);

const run = (...args) => {
  const r = spawnSync(python, [beats, track, join(dir, 'beats.json'), ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(readFileSync(join(dir, 'beats.json'), 'utf8')), log: r.stdout };
};

test('beats: tempo, beats, the first beat of the bar and the rise of a click track, in video time', () => {
  // in the project the track starts at 2 s in the video and is read from 0.25 s into the file
  const { out, log } = run('--start', '2', '--from', '0.25');
  assert.ok(Math.abs(out.tempo - 120) < 1, `tempo ${out.tempo}`);
  const want = Array.from({ length: 32 }, (_, n) => 0.5 + n * 0.5 - 0.25 + 2);
  assert.equal(out.beats.length, 32, log);
  const off = out.beats.map((b, i) => Math.abs(b - want[i]));
  assert.ok(Math.max(...off) < 0.015, `beats off by up to ${Math.max(...off).toFixed(3)} s: ${out.beats.join(', ')}`);
  assert.equal(out.downbeat, 1);   // the kicks
  assert.equal(out.bars.length, 8);
  assert.ok(Math.abs(out.rise - want[16]) < 0.015, `rise at ${out.rise}, want ${want[16]}`);   // bar 5, the loud half
  assert.equal(out.levels.length, 8);
  assert.match(log, /guessed: check by ear/);
});

test('beats: --downbeat and --bpm override the guesses, and mix.py places a cue on a bar and a beat', () => {
  const { out, log } = run('--downbeat', '2', '--bpm', '120');
  assert.equal(out.downbeat, 2);
  assert.ok(Math.abs(out.bars[0] - out.beats[1]) < 1e-9);
  assert.equal(out.bars.length, 8);   // beats 2, 6, ..., 30
  assert.doesNotMatch(log, /guessed/);
  const r = spawnSync(python, ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('mix', sys.argv[1])
mix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mix)
music = json.load(open(sys.argv[2]))
when = mix.Timeline({}, 0, music)
b = music['beats']
assert when.cue_time({'bar': 1}) == b[1], when.cue_time({'bar': 1})
assert when.cue_time({'bar': 2, 'beat': 3}) == b[1 + 4 + 2]
assert when.cue_time({'beat': 5, 'offset': 0.1}) == b[4] + 0.1
assert mix.label({'bar': 2, 'beat': 3}) == 'bar 2.3' and mix.label({'beat': 5}) == 'beat 5'
`, mix, join(dir, 'beats.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const outside = spawnSync(python, ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('mix', sys.argv[1])
mix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mix)
mix.Timeline({}, 0, json.load(open(sys.argv[2]))).cue_time({'bar': 9})
`, mix, join(dir, 'beats.json')], { encoding: 'utf8' });
  assert.match(outside.stderr, /bar 9 beat 1 is beat 34, outside the 32 beats of the music/);
});

test('beats: bar 1 set in the viewer is kept when beats.py runs again, and --downbeat overrides it', async () => {
  const { setDownbeat } = await import('../src/editor.js');
  run('--start', '2', '--from', '0.25');
  const before = JSON.parse(readFileSync(join(dir, 'beats.json'), 'utf8'));
  const out = setDownbeat(join(dir, 'beats.json'), 7);   // beat 7 starts a bar, so bar 1 starts on beat 3
  assert.equal(out.downbeat, 3); assert.equal(out.downbeatBy, 'viewer'); assert.equal(out.levels, undefined);
  assert.deepEqual(out.bars, before.beats.filter((_, i) => i >= 2 && (i - 2) % 4 === 0));
  assert.ok(out.bars.includes(out.rise));
  assert.throws(() => setDownbeat(join(dir, 'beats.json'), 99), /beat must be from 1 to 32/);
  const again = run('--start', '2', '--from', '0.25');
  assert.equal(again.out.downbeat, 3); assert.match(again.log, /set in the viewer, kept/);
  assert.equal(run('--start', '2', '--from', '0.25', '--downbeat', '1').out.downbeat, 1);
  setDownbeat(join(dir, 'beats.json'), 7);
  assert.equal(run('--start', '3').out.downbeat, 1);   // another place in the video: the old choice no longer holds
});
