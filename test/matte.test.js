// motlab matte: where a mask is, and, with MOTLAB_MODEL_TESTS=1, the whole run on a made clip. The run downloads
// SAM 2.1 tiny (about 80 MB) on its first go and needs Chrome, so it is left out of the usual test run and CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { maskShape, matteClip } from '../src/matte.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-matte-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('maskShape finds points well inside a mask, spread over it, and its box', () => {
  const w = 40, h = 20, m = new Uint8Array(w * h);
  for (let y = 4; y < 16; y++) for (let x = 2; x < 38; x++) m[y * w + x] = 200;   // a wide bar
  const s = maskShape(m, w, h);
  assert.deepEqual(s.box, [2, 4, 38, 16]);
  assert.ok(s.points.length >= 2, `${s.points.length} points`);
  for (const [x, y] of s.points) assert.ok(m[Math.floor(y) * w + Math.floor(x)] >= 128 && y > 6 && y < 14, `${x}, ${y} is inside, away from the edge`);
  const [[ax], [bx]] = s.points;
  assert.ok(Math.abs(ax - bx) >= 9, 'the points are apart');
  assert.equal(maskShape(new Uint8Array(w * h), w, h), null, 'an empty mask has no shape');
});

test('a disc moving over a textured floor is matted in every frame', { skip: !process.env.MOTLAB_MODEL_TESTS && 'set MOTLAB_MODEL_TESTS=1 (downloads SAM 2.1 tiny)' }, async () => {
  // 48 frames, 640 x 360: a red disc of radius 50 crossing from x 150 to 490
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'cellauto=s=640x360:rate=24:rule=110,format=gray,format=rgb24,lutrgb=r=val*0.5:g=val*0.5:b=val*0.4',
    '-vf', "geq=r='if(lt(hypot(X-(150+340*N/47),Y-180),50),220,r(X,Y))':g='if(lt(hypot(X-(150+340*N/47),Y-180),50),40,g(X,Y))':b='if(lt(hypot(X-(150+340*N/47),Y-180),50),40,b(X,Y))'",
    '-frames:v', '48', '-pix_fmt', 'yuv420p', '-y', join(dir, 'disc.mp4')]);
  assert.equal(made.status, 0, String(made.stderr));
  const r = await matteClip(join(dir, 'disc.mp4'), { clicks: [[150, 180]], name: 'disc' });
  assert.equal(r.frames, 48);
  const d = JSON.parse(readFileSync(join(dir, 'disc.track.json'), 'utf8')), tr = d.tracks.disc;
  assert.deepEqual([tr.kind, tr.first, tr.file, tr.rate], ['matte', 0, 'disc.disc.matte.webm', 30]);
  const [mw, mh] = tr.size, raw = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, tr.file), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 }).stdout;
  assert.equal(raw.length, mw * mh * 48);
  for (const k of [0, 24, 47]) {   // the matte against the true disc, in matte pixels
    let both = 0, either = 0;
    const cx = (150 + 340 * k / 47) * mw / 640, cy = 180 * mh / 360;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const truth = Math.hypot((x + 0.5 - cx) * 640 / mw, (y + 0.5 - cy) * 360 / mh) < 50, got = raw[(k * mh + y) * mw + x] >= 128;
      both += truth && got; either += truth || got;
    }
    assert.ok(both / either > 0.8, `frame ${k}: overlap ${(both / either).toFixed(2)}`);
  }
});
