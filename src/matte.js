// Mattes of an object through a clip: which pixels are the object, frame by frame, for drawing animation behind it
// (/__motlab/comp.js). SAM 2.1 tiny (Apache 2.0, about 80 MB) cuts the object out of each frame, run in headless
// Chrome by models.js. transformers.js has SAM 2 for single pictures only, so the object is carried from frame to
// frame the way SAM-PT does it (Rajic et al., WACV 2025): each frame is asked with points the object is known to be
// at, from a points track of track.py when there is one, otherwise from the mask of the frame before (a point inside
// it and the box around it).
//
// SAM 2 sees every frame stretched to 1024 x 1024, and its mask is 256 x 256 over the whole frame. The matte is that
// mask before it is enlarged, as a grey video where 128 is the edge and lighter is surer, so the page sharpens or
// softens the edge at its own size. It goes next to the
// clip as <clip>.<name>.matte.webm (VP9, lossless), and its entry into <clip>.track.json with the tracks.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PAGE_HELPERS, TRANSFORMERS, modelPage } from './models.js';

export const MODEL = 'onnx-community/sam2.1-hiera-tiny-ONNX';
const SIDE = 1024;   // SAM's input: the frame stretched to SIDE x SIDE
const RATE = 30;     // the matte video's frames are numbered, one every 1/30 s, whatever the clip's own rate

const PAGE = `<!doctype html><meta charset="utf-8"><title>motlab matte</title><script type="module">
import { Sam2Model, AutoProcessor, RawImage } from '${TRANSFORMERS}';
${PAGE_HELPERS}
let model, processor;
window.matteSetup = async cpu => {
  const gpu = !cpu && navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const device = gpu ? 'webgpu' : 'wasm', enc = gpu ? (gpu.features.has('shader-f16') ? 'fp16' : 'fp32') : 'q8';
  const suffix = { fp16: '_fp16', fp32: '', q8: '_quantized' }[enc];
  const files = ['onnx/vision_encoder' + suffix + '.onnx_data', 'onnx/prompt_encoder_mask_decoder.onnx_data'];
  model = await Sam2Model.from_pretrained('${MODEL}', { device, dtype: { vision_encoder: enc, prompt_encoder_mask_decoder: 'fp32' }, progress_callback: await progress('${MODEL}', files) });
  processor = await AutoProcessor.from_pretrained('${MODEL}');
  return { device, dtype: enc };
};
// prompt: { points: [[x, y]], labels: [1 | 0], box: [x1, y1, x2, y2] } in the image's pixels. Returns all of SAM's
// masks one after another as bytes (128 + 16 x its logit, 0 to 255), with their scores and whether the object is there.
window.matteOf = async (url, prompt) => {
  const image = await RawImage.read(url), opts = {};
  if (prompt.points?.length) { opts.input_points = [prompt.points]; opts.input_labels = [prompt.labels]; }
  if (prompt.box) opts.input_boxes = [[prompt.box]];
  const inputs = await processor(image, opts);
  const out = await model(inputs);
  const iou = [...out.iou_scores.data], n = iou.length;
  const [mh, mw] = out.pred_masks.dims.slice(-2), [rh, rw] = inputs.reshaped_input_sizes[0];
  const h = Math.round(mh * rh / ${SIDE}), w = Math.round(mw * rw / ${SIDE});
  const all = out.pred_masks.data, bytes = new Uint8Array(n * w * h);
  for (let k = 0; k < n; k++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    bytes[(k * h + y) * w + x] = Math.max(0, Math.min(255, Math.round(128 + 16 * all[(k * mh + y) * mw + x])));
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { w, h, masks: btoa(s), iou, present: out.object_score_logits ? out.object_score_logits.data[0] > 0 : true };
};
</script>`;

function probe(clip) {
  const s = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation', '-of', 'json', clip], { encoding: 'utf8' }).stdout || '{}').streams?.[0];
  if (!s) throw new Error(`${clip}: no video stream (ffprobe could not read it)`);
  let { width: w, height: h } = s;
  const rot = Math.abs(Number(s.side_data_list?.find(d => 'rotation' in d)?.rotation || 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  const [num, den] = s.r_frame_rate.split('/').map(Number);
  const times = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', clip], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .stdout.split(/\s+/).map(v => v.replace(/,$/, '')).filter(v => v && v !== 'N/A').map(Number).sort((a, b) => a - b);
  return { w, h, fps: num / den, times: times.map(t => t - times[0]) };
}

// Where the mask is, in mask pixels: up to three points well inside it and far apart, and its box; null when it is
// empty.
export function maskShape(m, w, h) {
  const d = new Float32Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (m[i] < 128) { d[i] = 0; continue; }
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    d[i] = Math.min(x > 0 ? d[i - 1] + 1 : 1, y > 0 ? d[i - w] + 1 : 1);
  }
  if (x1 < 0) return null;
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {   // chamfer distance to the edge
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], x < w - 1 ? d[i + 1] + 1 : 1, y < h - 1 ? d[i + w] + 1 : 1);
  }
  // the deepest point, then the deepest ones at least a quarter of the box's size from those already taken
  const points = [], apart = Math.max(3, 0.25 * Math.hypot(x1 - x0, y1 - y0));
  for (let k = 0; k < 3; k++) {
    let best = 1.5, at = -1;
    for (let i = 0; i < w * h; i++) {
      if (d[i] <= best) continue;
      const x = i % w, y = (i / w) | 0;
      if (points.every(([px, py]) => Math.hypot(px - x, py - y) >= apart)) { best = d[i]; at = i; }
    }
    if (at < 0) break;
    points.push([at % w + 0.5, Math.floor(at / w) + 0.5]);
  }
  if (!points.length) points.push([(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2]);
  return { points, box: [x0, y0, x1 + 1, y1 + 1] };
}

// clip: a video file. at: seconds into it where the clicks, box and points track are true. clicks: [[x, y]] on the
// object, exclude: [[x, y]] next to it that are not, box: [x1, y1, x2, y2], all in the clip's pixels. points / not:
// names of points tracks in <clip>.track.json to ask with in every frame. range: [from, to] seconds. name: the
// matte's name. Returns { file, frames, seconds, device, dtype, weak }.
export async function matteClip(clip, { at = 0, clicks = [], exclude = [], box, points, not, range, name = 'matte', chromePath, cpu = false, log = () => {} } = {}) {
  clip = resolve(clip);
  if (!existsSync(clip)) throw new Error(`${clip} not found`);
  if (!clicks.length && !box && !points) throw new Error('matte needs --click, --box or --points: where the object is');
  if (!/^[\w-]+$/.test(name)) throw new Error(`--name "${name}": letters, numbers, - and _ only`);
  const { w, h, fps, times } = probe(clip), n = times.length;
  const idx = t => { let i = 0; while (i + 1 < n && times[i + 1] <= t + 1e-6) i++; return i; };
  const [first, last] = range ? [idx(range[0]), idx(range[1])] : [0, n - 1];
  const start = Math.min(Math.max(idx(at), first), last);
  const trackFile = join(dirname(clip), basename(clip, extname(clip)) + '.track.json');
  let doc = existsSync(trackFile) ? JSON.parse(readFileSync(trackFile, 'utf8')) : null;
  if (doc && (doc.width !== w || doc.height !== h || doc.times?.length !== n)) { log(`${trackFile} was made from a different clip; starting it again`); doc = null; }
  const tracked = nm => {
    const tr = doc?.tracks?.[nm];
    if (!tr || tr.kind !== 'points') throw new Error(`no points track "${nm}" in ${trackFile}: make it with track.py --points ${nm}=...`);
    return i => { const v = tr.points[Math.min(Math.max(i - tr.first, 0), tr.points.length - 1)]; return v && v.reduce((a, x, j) => (j % 2 ? a[a.length - 1].push(x) : a.push([x]), a), []); };
  };
  const pos = points && tracked(points), neg = not && tracked(not);

  // the frames SAM sees, stretched to its own size, in a folder of their own
  const kx = SIDE / w, ky = SIDE / h;
  const tmp = mkdtempSync(join(tmpdir(), 'motlab-matte-'));
  try {
    log(`${basename(clip)}: frames ${first} to ${last} of ${n} (${w}x${h}, ${fps.toFixed(3)} fps), from frame ${start}`);
    const ex = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=between(n\\,${first}\\,${last}),scale=${SIDE}:${SIDE}:flags=area`, '-fps_mode', 'passthrough',
      '-q:v', '2', '-start_number', String(first), join(tmp, 'f%06d.jpg')]);
    if (ex.status !== 0) throw new Error(`ffmpeg could not read ${clip}: ${String(ex.stderr).trim()}`);
    const serve = path => { const m = /^\/frame\/(\d+)$/.exec(path); const f = m && join(tmp, `f${m[1].padStart(6, '0')}.jpg`); return f && existsSync(f) ? [readFileSync(f), 'image/jpeg'] : null; };
    const { page, close, base } = await modelPage(PAGE, { ready: 'matteSetup', serve, chromePath, log });
    const masks = new Map(), t0 = performance.now();
    let how, mw, mh;
    try {
      how = await page.evaluate(`window.matteSetup(${cpu})`);
      // one way through the clip from the start frame, each frame asked where the last one left the object
      const run = async order => {
        let prev = null;
        for (const i of order) {
          const prompt = { points: [], labels: [] };
          const add = (pts, label) => { for (const p of pts || []) { prompt.points.push([p[0] * kx, p[1] * ky]); prompt.labels.push(label); } };
          if (i === start) { add(clicks, 1); add(exclude, 0); if (box) prompt.box = [box[0] * kx, box[1] * ky, box[2] * kx, box[3] * ky]; }
          if (pos) add(pos(i), 1);
          if (neg) add(neg(i), 0);
          if (i !== start && !pos && prev) {   // carried from the frame before
            const sx = SIDE / mw, sy = SIDE / mh, m = 0.1;   // mask pixels to SAM's pixels, and the margin around the box
            const [x0, y0, x1, y1] = prev.box, bw = (x1 - x0) * sx, bh = (y1 - y0) * sy;
            for (const p of prev.points) { prompt.points.push([p[0] * sx, p[1] * sy]); prompt.labels.push(1); }
            prompt.box = [Math.max(0, x0 * sx - bw * m - 8), Math.max(0, y0 * sy - bh * m - 8), Math.min(SIDE, x1 * sx + bw * m + 8), Math.min(SIDE, y1 * sy + bh * m + 8)];
          }
          if (!prompt.points.length) { delete prompt.points; delete prompt.labels; }
          const r = await page.evaluate(`window.matteOf('${base}/frame/${i}', ${JSON.stringify(prompt)})`);
          mw = r.w; mh = r.h;
          // SAM gives three masks (the object, a part of it, something bigger). Take the one that overlaps the last
          // frame's most, so the object does not change into its neighbour; in the first frame, SAM's best.
          const got = Buffer.from(r.masks, 'base64'), size = mw * mh, cands = r.iou.map((_, c) => got.subarray(c * size, (c + 1) * size));
          const overlap = c => { let a = 0, b = 0; for (let j = 0; j < size; j++) { const p = prev.mask[j] >= 128, q = c[j] >= 128; a += p && q; b += p || q; } return b ? a / b : 0; };
          const fits = cands.map((c, k) => prev ? overlap(c) : r.iou[k]), pick = fits.indexOf(Math.max(...fits));
          const mask = Buffer.from(cands[pick]);
          const shape = r.present ? maskShape(mask, mw, mh) : null;
          if (prev && fits[pick] < 0.3) {   // it jumped to something else: hold the last frame's matte and ask again from there
            masks.set(i, { mask: prev.mask, score: 0 });
          } else {
            masks.set(i, { mask, score: shape ? Math.round(r.iou[pick] * Math.min(1, prev ? fits[pick] / 0.7 : 1) * 1000) / 1000 : 0 });
            if (shape) prev = { ...shape, mask };   // an empty frame keeps asking where the object was last seen
          }
          const done = masks.size, all = last - first + 1;
          if (done % 50 === 0) log(`  ${done} of ${all} frames, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        }
      };
      await run(Array.from({ length: last - start + 1 }, (_, j) => start + j));
      if (start > first) await run(Array.from({ length: start - first + 1 }, (_, j) => start - j));
    } finally { await close(); }

    // the matte video: VP9 lossless, one frame every 1/30 s for clip frames first..last
    const out = join(dirname(clip), `${basename(clip, extname(clip))}.${name}.matte.webm`);
    const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${mw}x${mh}`, '-r', String(RATE), '-i', '-',
      '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p', '-row-mt', '1', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = ''; enc.stderr.on('data', d => { err += d; });
    for (let i = first; i <= last; i++) enc.stdin.write(masks.get(i).mask);
    enc.stdin.end();
    if (await new Promise(ok => enc.on('close', ok)) !== 0) throw new Error(`ffmpeg could not write ${out}: ${err.trim()}`);

    doc ||= { clip: basename(clip), width: w, height: h, fps: Math.round(fps * 1e4) / 1e4, times: times.map(t => Math.round(t * 1e5) / 1e5), tracks: {} };
    const score = Array.from({ length: last - first + 1 }, (_, j) => masks.get(first + j).score);
    doc.tracks[name] = { kind: 'matte', first, file: basename(out), size: [mw, mh], rate: RATE, confidence: score };
    writeFileSync(trackFile, JSON.stringify(doc));
    return { file: out, track: trackFile, frames: score.length, seconds: (performance.now() - t0) / 1000, ...how, weak: score.filter(s => s < 0.5).length };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
