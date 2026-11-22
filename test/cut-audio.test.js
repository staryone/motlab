import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/cut_pauses.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  return r.stdout;
}

for (const dissolve of [0, 0.1]) test(`cut pauses: exports matching audio with dissolve ${dissolve}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-cut-pauses-'));
  try {
    const src = join(dir, 'take.wav'), cuts = join(dir, 'cuts.json'), audio = join(dir, 'audio out.wav');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', src]);
    run(python, [script, src, cuts, '--drop', '1-2', '--dissolve', String(dissolve), '--audio-out', audio]);
    const data = JSON.parse(readFileSync(cuts, 'utf8'));
    assert.deepEqual(data.segments, [{ from: 0, to: 1 }, { from: 2, to: 3 }]);
    assert.equal(data.duration, 2 - dissolve);
    const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio]));
    assert.ok(Math.abs(duration - data.duration) < 0.001, `audio duration ${duration}, cuts ${data.duration}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
