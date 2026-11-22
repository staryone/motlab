import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/cut_pauses.py', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'motlab-cut-pauses-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const python = process.platform === 'win32' ? 'python' : 'python3';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result;
}

for (const subtitle of [1, 6]) {
  test(`cut pauses: a ${subtitle}s subtitle does not set a 4s recording's duration`, () => {
    const sub = join(dir, `subtitle-${subtitle}.srt`);
    const src = join(dir, `take-${subtitle}.mp4`);
    const out = join(dir, `cuts-${subtitle}.json`);
    writeFileSync(sub, `1\n00:00:00,000 --> 00:00:0${subtitle},000\nCaption\n`);
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=25:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-i', sub,
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'mpeg4', '-c:a', 'aac', '-c:s', 'mov_text', src]);
    run(python, [script, src, out]);
    const cuts = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(cuts.duration, 4);
    assert.deepEqual(cuts.segments, [{ from: 0, to: 4 }]);
  });
}

test('cut pauses: audio-only input and an explicit end still work', () => {
  const src = join(dir, 'voice.wav'), out = join(dir, 'voice.json');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', src]);
  run(python, [script, src, out, '--end', '2']);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).segments, [{ from: 0, to: 2 }]);
});

test('cut pauses: shorter audio still limits the take', () => {
  const src = join(dir, 'short-audio.mp4'), out = join(dir, 'short-audio.json');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'mpeg4', '-c:a', 'aac', src]);
  run(python, [script, src, out]);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).segments, [{ from: 0, to: 3 }]);
});

test('cut pauses: container duration is used when stream durations are unavailable', () => {
  const src = join(dir, 'voice.mkv'), out = join(dir, 'fallback.json');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'pcm_s16le', src]);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=duration', '-of', 'json', src]).stdout);
  assert.ok(probe.streams.every(s => s.duration === undefined));
  run(python, [script, src, out]);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).duration, 4);
});

test('cut pauses: unreadable input fails', () => {
  const result = spawnSync(python, [script, join(dir, 'missing.mp4'), join(dir, 'missing.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ffprobe/);
});

test('cut pauses: an all-silent recording fails instead of writing an empty cut list', () => {
  const src = join(dir, 'silence.wav'), out = join(dir, 'silence.json');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', src]);
  const result = spawnSync(python, [script, src, out], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing left to keep/);
});
