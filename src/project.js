// A project is a folder of scene pages plus a project.json:
//   { "fps": 30, "scenes": ["scenes/01.html", ...], "audio": [{ "file": "audio/music.wav", "start": 0, "volume": 0.8 }] }
// Scenes play back to back in list order. A scene may be { "file": ..., "transition": { "type": "crosswarp",
// "duration": 0.6, "ease": "inOutCubic", "params": {} } }: the previous scene turns into it over that time, so the two
// overlap and the video is that much shorter. Audio files are mixed at their start time (seconds) and volume (1 = as is).
// An audio entry may also be a video file (its sound is used), with optional "from" (seconds into the file) and "duration".
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findChrome, launchChrome } from './chrome.js';
import { frameCount } from './codecs.js';
import { finalize, probeVideo, run } from './ffmpeg.js';
import { parseOverlays, placeOverlays } from './page/overlays.js';
import { findTransition, isTransitionFile, layerFrames, parseTransition, transitionHead, transitionOverlap, transitionProgress, transitionTail } from './page/transitions.js';
import { cacheDir } from './probe.js';
import { readPageInfo, renderShot, renderVideo } from './render.js';
import { startServer } from './server.js';

// How many parts render at once without --parallel: 3, fewer on a smaller machine. On the test laptop (16 threads) a
// project of 12 short scenes got faster up to 3 at once and no faster at 4, and 3 Chrome processes rendering 4K used
// about 2.5 GB together, so each part gets 4 threads and 1 GB of free memory. Each part is its own Chrome and encoder.
export const defaultParallel = () => Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4), Math.floor(freemem() / 1e9)));

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// The scenes as { file, transition }, each transition with its length in frames (n): its duration on the frame grid,
// at least 1. The viewer applies the same rule. root: the project folder, where a transition's .glsl file or layer
// module is checked. A layer transition ({ layer, duration }) is drawn over a hard cut instead of mixing two scenes.
export function projectScenes(p, root) {
  return p.scenes.map((s, i) => {
    const scene = typeof s === 'string' ? { file: s } : { ...s };
    if (!scene.file) throw new Error(`scene ${i + 1} has no "file"`);
    const tr = scene.transition;
    if (tr && i === 0) throw new Error(`scene 1 (${scene.file}) has a transition, but there is no scene before it`);
    if (tr) {
      scene.transition = { ease: 'inOutCubic', params: {}, ...tr, n: Math.max(1, Math.round((Number(tr.duration) || 0) * p.fps)) };
      try {
        if (tr.layer !== undefined) {
          if (tr.type !== undefined) throw new Error('a transition has "type" (a shader that mixes the two scenes) or "layer" (a module drawn over the cut), not both');
          if (!/\.m?js$/i.test(String(tr.layer))) throw new Error(`the layer ${tr.layer} must be a .js module that exports draw(ctx, p, W, H)`);
          if (root && !existsSync(join(root, tr.layer))) throw new Error(`the layer file ${tr.layer} does not exist`);
        }
        else if (!isTransitionFile(tr.type)) scene.transition.type = findTransition(tr.type).name;
        else if (root) {   // its uniforms are read here; a GLSL mistake shows when Chrome compiles it, before the first frame
          if (!existsSync(join(root, tr.type))) throw new Error(`the transition file ${tr.type} does not exist`);
          parseTransition(readFileSync(join(root, tr.type), 'utf8'), tr.type);
        }
        transitionProgress(0, 1, scene.transition.ease);
      }
      catch (e) { throw new Error(`scene ${i + 1} (${scene.file}): ${e.message}`); }
    }
    return scene;
  });
}

// The query of __motlab/transition.html for the transition from scene i into the next, given scene i's length in frames.
// gap: how much later the next scene starts than this one, for the two pages' SCENE_START.
function transitionQuery(scenes, i, pageFrames, fps) {
  const next = scenes[i + 1].transition;
  return new URLSearchParams({ from: scenes[i].file, to: scenes[i + 1].file, offset: (pageFrames - transitionTail(next)) / fps, frames: next.n,
    gap: (pageFrames - transitionOverlap(next)) / fps, fps, ...(next.layer ? { layer: next.layer } : { type: next.type, ease: next.ease, params: JSON.stringify(next.params) }) });
}

// A project is named by its folder (which holds project.json) or by a .json file in it, such as storyboard.json.
// Paths inside the file are relative to that folder, and `name` is used for output files.
export function projectPaths(target) {
  const t = resolve(target), isFile = t.toLowerCase().endsWith('.json'), root = isFile ? dirname(t) : t;
  const file = isFile ? t : join(root, 'project.json'), stem = basename(file).replace(/\.json$/i, '');
  if (!existsSync(file)) throw new Error(`no project file at ${file}`);
  return { root, file, name: stem === 'project' ? basename(root) : `${basename(root)}-${stem.replace(/^project-/, '')}` };   // project-tiktok.json: <folder>-tiktok
}

// only: the 1-based scenes to re-render (for example [3], or [3, 5]). The rest come from the cache of scene parts
// in ~/.cache/motlab/parts on macOS and Linux, %LOCALAPPDATA%\motlab\parts on Windows (or MOTLAB_CACHE_DIR),
// which a full render leaves behind; a scene with no cached part is rendered, and the transitions touching a
// re-rendered scene are re-rendered too. The cache key holds the motlab version too, so parts made by an older
// version are rendered again after an update, and a finished render removes the cached parts it did not use.
// The key is the scene page itself, so a file the scene loads (a shared script, a font, a picture) changing is
// not noticed: render the whole project again then, or delete the cache folder.
// qp and codec: the file size against quality (docs/rendering.md#file-size). They come from the options, else from
// "qp" and "codec" in project.json, so the viewer's Export uses them too, else the encoder's defaults.
export async function renderProject({ dir, out, scale, only, parallel, qp, codec, log = console.log, signal }) {   // signal: an AbortSignal that stops the render
  const { root, file, name } = projectPaths(dir);
  dir = root; out = resolve(out || join(dir, 'out', name + '.mp4'));
  const p = JSON.parse(readFileSync(file, 'utf8'));
  qp ??= p.qp; codec ??= p.codec;
  if (qp !== undefined && !(Number.isInteger(qp) && qp >= 0 && qp <= 51)) throw new Error(`qp must be a whole number from 0 to 51, not ${JSON.stringify(qp)}`);
  if (codec !== undefined && !['auto', 'h264', 'hevc'].includes(codec)) throw new Error(`codec must be auto, h264 or hevc, not ${JSON.stringify(codec)}`);
  const tmp = mkdtempSync(join(tmpdir(), 'motlab-project-')), partial = out + '.part';
  // Share one static server and a small pool of headless Chrome processes across parts, opening a fresh tab per part
  // instead of cold-starting Chrome for every scene and transition. A Chrome that hits an error or abort is closed, not reused.
  let serverPromise, closingChromes = Promise.resolve();
  const getServer = () => (serverPromise ??= startServer({ root: dir }));
  const idleChromes = [], allChromes = new Set();
  const takeChrome = async () => {
    if (idleChromes.length) return idleChromes.pop();
    const c = await launchChrome({ chromePath: findChrome() });
    allChromes.add(c);
    return c;
  };
  const closeChromes = () => {
    const list = [...allChromes]; allChromes.clear(); idleChromes.length = 0;
    return Promise.all(list.map(c => c.close()));
  };
  const renderPart = async (opts, jobSignal) => {
    const server = await getServer(), chrome = await takeChrome();
    const onAbort = () => { allChromes.delete(chrome); void chrome.close(); };
    jobSignal.addEventListener('abort', onAbort, { once: true });
    let ok = false;
    try {
      const res = await renderVideo({ ...opts, server, browser: chrome, signal: jobSignal });
      ok = true;
      return res;
    } finally {
      jobSignal.removeEventListener('abort', onAbort);
      if (ok && !jobSignal.aborted && allChromes.has(chrome)) idleChromes.push(chrome);
      else { allChromes.delete(chrome); await chrome.close(); }
    }
  };
  try {
    // One MP4 per scene. The first scene picks the encoder and the rest are forced to the same one, so the parts
    // can be joined without re-encoding.
    // A transition is a part of its own between the two scenes: their overlapping frames, mixed by
    // __motlab/transition.html, and left out of the scenes' own parts.
    const parts = [], scenes = projectScenes(p, dir), same = () => parts[0] && { encoder: parts[0].hw ? 'hw' : 'sw', codec: parts[0].codec };
    const used = new Set();   // the cache keys this render used, for pruning the ones it did not
    if (only && only.some(n => !Number.isInteger(n) || n < 1 || n > scenes.length))
      throw new Error(`--only takes scene numbers from 1 to ${scenes.length}`);
    const cacheRoot = join(cacheDir(), 'parts', createHash('sha256').update(file).digest('hex').slice(0, 16));
    const hash = f => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
    const hashes = scenes.map(s => hash(s.file));
    const key = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
    // Each scene's SCENE_START: the lengths of the scenes before it, less the frames their transitions overlap, as the
    // viewer lays them out. A scene's length is known once its page has loaded or its cached part is found, and a scene
    // waits for the ones before it, which started first.
    const known = [], learned = new EventTarget();
    const learn = (i, frames) => { known[i] = frames; learned.dispatchEvent(new Event('frames')); };
    const framesOf = (i, signal) => known[i] !== undefined ? known[i] : new Promise((ok, no) => {
      const done = () => { learned.removeEventListener('frames', check); signal.removeEventListener('abort', abort); };
      const check = () => { if (known[i] !== undefined) { done(); ok(known[i]); } };
      const abort = () => { done(); no(signal.reason); };
      learned.addEventListener('frames', check); signal.addEventListener('abort', abort);
    });
    const startOf = async (i, signal) => {
      let frames = 0;
      for (let j = 0; j < i; j++) frames += await framesOf(j, signal) - transitionOverlap(scenes[j + 1].transition);
      return frames / p.fps;
    };
    const sceneKey = i => key({ kind: 'scene', file: scenes[i].file, hash: hashes[i], fps: p.fps, scale, qp, codec, version: VERSION,
      head: transitionHead(scenes[i].transition), tail: transitionTail(scenes[i + 1]?.transition) });

    // Overlays (src/page/overlays.js) are drawn into the parts they show in. Placing them takes every scene's length,
    // so a project with overlays reads those first: from the cached part when there is one, else from the page.
    const overlays = parseOverlays(p.overlays, scenes.length);
    for (const o of overlays) if (!existsSync(join(dir, o.layer))) throw new Error(`the overlay file ${o.layer} does not exist`);
    let placed = [];
    if (overlays.length) {
      const waiting = scenes.map((_, i) => i), width = Math.max(1, parallel ?? defaultParallel());
      await Promise.all(Array.from({ length: Math.min(width, scenes.length) }, async () => {
        for (let i; (i = waiting.shift()) !== undefined;) {
          let m = null;
          try { m = JSON.parse(readFileSync(join(cacheRoot, sceneKey(i) + '.json'), 'utf8')); } catch {}
          if (m?.pageFrames) { learn(i, m.pageFrames); continue; }
          const server = await getServer(), chrome = await takeChrome();
          try {
            const info = await readPageInfo({ page: join(dir, scenes[i].file), root: dir, server, browser: chrome, scale, signal });
            if (!(info.total > 0)) throw new Error(`${scenes[i].file}: window.TOTAL must be a positive number of seconds`);
            learn(i, frameCount(info.total, p.fps));
          } finally { idleChromes.push(chrome); }
        }
      }));
      const none = new AbortController().signal, starts = [];
      for (let i = 0; i < scenes.length; i++) starts.push(await startOf(i, none));
      placed = placeOverlays(overlays, starts, scenes.map((_, i) => known[i] / p.fps)).map(o => ({ ...o, hash: hash(o.layer) }));
      log(`Overlays: ${placed.map(o => `${o.layer} ${o.start.toFixed(2)} to ${o.end.toFixed(2)} s`).join(', ')}`);
    }
    // The overlays that show between two times of the video, for the part there whose t = 0 is at videoAt, and what
    // the cached part keeps of them (sig), so that a change to one renders again only the parts it touches.
    const overlaysFor = (from, to, videoAt) => {
      const list = placed.filter(o => o.start < to - 1e-6 && o.end > from + 1e-6);
      if (!list.length) return {};
      return { overlays: list.map(({ layer, start, end, params }) => ({ layer, start, end, params })), videoAt,
        sig: key({ videoAt, list: list.map(o => [o.layer, o.hash, o.start, o.end, o.params]) }) };
    };
    // Why a cached part cannot be used although its scenes did not change, or ''.
    const stale = async (i, m, sig, signal) => m.startRead && Math.abs(await startOf(i, signal) - m.sceneStart) >= 1e-9 ? 'it reads SCENE_START, which moved'
      : (m.overlays ?? '') !== (sig ?? '') ? 'its overlays changed' : '';
    // A part is reused only when its cached file still probes as the manifest says, and its encoder and colour range
    // match the first part, because a stream copy join is only safe when codec, encoder and resolution match. A part
    // whose page read SCENE_START, or that has overlays, is reused only as it was; stale(manifest) says why not.
    const getPart = async (k, forced, label, log, render, fits, keep = {}) => {
      used.add(k);
      let suffix = '';
      if (!forced) {
        let m = null, why = '';
        try { m = JSON.parse(readFileSync(join(cacheRoot, k + '.json'), 'utf8')); } catch {}
        if (m?.key === k && existsSync(join(cacheRoot, k + '.mp4'))) {
          const v = await probeVideo(join(cacheRoot, k + '.mp4')).catch(() => null);
          if (v && v.frames === m.frames && Math.abs(v.duration - m.duration) <= 0.5 / p.fps && v.width === m.width && v.height === m.height
              && (!parts[0] || (m.hw === parts[0].hw && m.codec === parts[0].codec && m.fullRange === parts[0].fullRange)) && !(why = await fits(m))) {
            log(`${label} (cached)`);
            return { out: join(cacheRoot, k + '.mp4'), width: m.width, height: m.height, duration: m.duration, frames: m.frames, pageFrames: m.pageFrames, fullRange: m.fullRange, codec: m.codec, hw: m.hw, startRead: m.startRead, sceneStart: m.sceneStart };
          }
        }
        suffix = why ? ` (${why}, so rendering it again)` : ' (no cached part, rendering it)';
      }
      log(label + suffix);
      const summary = await render();
      try {
        mkdirSync(cacheRoot, { recursive: true });
        writeFileSync(join(cacheRoot, k + '.json'), JSON.stringify({ key: k, codec: summary.codec, hw: summary.hw, fullRange: summary.fullRange,
          width: summary.width, height: summary.height, frames: summary.frames, pageFrames: summary.pageFrames, duration: summary.duration,
          ...(summary.startRead ? { startRead: true, sceneStart: summary.sceneStart } : {}), ...keep }));
      } catch (e) { log(`(could not save the cached part: ${e.message})`); }
      return summary;
    };
    // The parts in order: each scene, and after it the transition into the next one. Scene 1 renders first and
    // alone, because it picks the encoder (and times the encoders on a new machine). The rest render `parallel` at a
    // time, each in its own Chrome; a transition waits for the scene before it, which tells it where that scene ends.
    const jobs = scenes.flatMap((scene, i) => [{ kind: 'scene', i }, ...(scenes[i + 1]?.transition ? [{ kind: 'transition', i }] : [])]);
    let progress = true;   // the frame counter on the terminal, off while parts render in parallel
    const renderJob = async (j, log, signal) => {
      const { i } = jobs[j], scene = scenes[i], into = scene.transition, next = scenes[i + 1]?.transition;
      signal.throwIfAborted();
      if (jobs[j].kind === 'scene') {
        const k = sceneKey(i), at = placed.length ? await startOf(i, signal) : 0;
        const { sig, ...over } = placed.length ? overlaysFor(at + transitionHead(into) / p.fps, at + (known[i] - transitionTail(next)) / p.fps, at) : {};
        const part = await getPart(k, !only || only.includes(i + 1), `\nScene ${i + 1}/${scenes.length}: ${scene.file}`, log, () => renderPart({ page: join(dir, scene.file), root: dir,
          out: join(cacheRoot, k + '.mp4'), fps: p.fps, scale, qp, codec, log, progress, head: transitionHead(into), tail: transitionTail(next), ...same(), ...over,
          sceneStart: frames => { learn(i, frames); return startOf(i, signal); } }, signal), m => { learn(i, m.pageFrames); return stale(i, m, sig, signal); }, sig ? { overlays: sig } : {});
        // a stream copy join of parts with different sizes makes an MP4 that changes resolution partway through
        if (parts[0] && (part.width !== parts[0].width || part.height !== parts[0].height))
          throw Object.assign(new Error(`${scene.file} is ${part.width}x${part.height} but ${scenes[0].file} is ${parts[0].width}x${parts[0].height}. All scenes in a project must have the same canvas size`), { final: true });
        return part;
      }
      const from = parts[j - 1];
      const tk = key({ kind: 'transition', from: scene.file, to: scenes[i + 1].file, fromHash: hashes[i], toHash: hashes[i + 1],
        type: next.type, glsl: isTransitionFile(next.type) ? hash(next.type) : undefined, layer: next.layer, layerHash: next.layer ? hash(next.layer) : undefined, n: next.n, ease: next.ease, params: next.params, fps: p.fps, scale, qp, codec, version: VERSION });
      const query = transitionQuery(scenes, i, from.pageFrames, p.fps);
      const at = placed.length ? await startOf(i, signal) + (from.pageFrames - transitionTail(next)) / p.fps : 0;
      const { sig, ...over } = placed.length ? overlaysFor(at, at + next.n / p.fps, at) : {};
      return getPart(tk, !only || only.includes(i + 1) || only.includes(i + 2), `\nTransition ${i + 1} to ${i + 2}: ${next.layer ? `layer ${next.layer}` : next.type}, ${next.n} frames`, log,
        () => renderPart({ url: '__motlab/transition.html', query: String(query), root: dir, out: join(cacheRoot, tk + '.mp4'),
          fps: p.fps, scale, qp, codec, log, progress, ...same(), ...over, sceneStart: () => startOf(i, signal) }, signal), m => stale(i, m, sig, signal), sig ? { overlays: sig } : {});
    };
    // Runs the parts that have no result yet, `width` at a time. When one fails the others are stopped, and the parts
    // that finished are kept. A part's log is printed in one piece when it ends, so parallel logs do not interleave.
    const runAll = async width => {
      const ctrl = new AbortController(), stop = () => ctrl.abort(signal.reason);
      signal?.addEventListener('abort', stop);
      let free = width; const waiting = [];
      const slot = () => free > 0 ? (free--, Promise.resolve()) : new Promise(r => waiting.push(r));
      const release = () => waiting.length ? waiting.shift()() : free++;
      const promises = [];
      try {
        for (let j = 0; j < jobs.length; j++) {
          if (parts[j]) { promises.push(Promise.resolve(parts[j])); continue; }
          const before = jobs[j].kind === 'transition' ? promises[j - 1] : null;
          promises.push((async () => {
            if (before) await before;
            await slot();
            const lines = [], out = width > 1 ? l => lines.push(l) : log;
            try { return parts[j] = await renderJob(j, out, ctrl.signal); }
            catch (e) { if (!ctrl.signal.aborted) ctrl.abort(e); throw e; }
            finally { lines.forEach(l => log(l)); release(); }
          })());
        }
        const failed = (await Promise.allSettled(promises)).find(r => r.status === 'rejected');
        if (failed) throw ctrl.signal.reason ?? failed.reason;   // the first failure, not the ones it caused by stopping the rest
      } finally { signal?.removeEventListener('abort', stop); }
    };
    parts[0] = await renderJob(0, log, signal ?? new AbortController().signal);
    const width = Math.max(1, Math.min(parallel ?? defaultParallel(), jobs.length - 1));
    if (width > 1) { progress = false; log(`\nRendering ${jobs.length - 1} more parts, ${width} at a time`); }
    try { await runAll(width); }
    catch (e) {
      // Too many Chrome processes for the memory, or more hardware encoder sessions than the GPU allows, show up as a
      // failed part. The parts still missing are rendered one at a time; a part that fails then fails for real.
      if (width === 1 || e.final || signal?.aborted) throw e;
      log(`\nA part failed with ${width} at a time (${String(e?.message || e).split('\n')[0]}). Rendering the remaining parts one at a time.`);
      await closeChromes();
      progress = true; await runAll(1);
    }
    // Start shutting down the Chrome pool while ffmpeg mixes audio and joins the parts.
    closingChromes = closeChromes();
    const duration = parts.reduce((sum, s) => sum + s.duration, 0);

    let audio;
    if (p.audio?.length) {
      audio = join(tmp, 'mix.wav');
      // A mono file goes to both channels at full level, as the viewer (WebAudio) plays it. ffmpeg's own up-mix to
      // stereo would put it 3 dB lower.
      const channels = await Promise.all(p.audio.map(a => run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', join(dir, a.file)], signal)));
      const chains = p.audio.map((a, i) => `[${i}:a]${channels[i].trim() === '1' ? 'pan=stereo|c0=c0|c1=c0,' : ''}adelay=${Math.round((a.start || 0) * 1000)}:all=1,volume=${a.volume ?? 1}[a${i}]`);
      await run('ffmpeg', ['-y', '-loglevel', 'error', ...p.audio.flatMap(a => [...(a.from ? ['-ss', String(a.from)] : []), ...(a.duration ? ['-t', String(a.duration)] : []), '-i', join(dir, a.file)]), '-filter_complex',
        `${chains.join(';')};${p.audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${p.audio.length}:normalize=0[mix]`,
        '-map', '[mix]', '-ar', '48000', '-ac', '2', '-t', duration.toFixed(6), audio], signal);
    }

    // Written beside the output first and renamed when complete, so a stopped or failed render leaves no half file.
    signal?.throwIfAborted();
    mkdirSync(dirname(out), { recursive: true });
    if (parts.some(s => s.fullRange !== parts[0].fullRange)) throw new Error('the scenes were encoded with different colour ranges');
    await finalize({ inputs: parts.map(s => s.out), codec: parts[0].codec, fps: p.fps, audio, out: partial, duration, tmp, signal, fullRange: parts[0].fullRange });
    rmSync(out, { force: true }); renameSync(partial, out);
    // Parts from earlier edits that this render did not use would pile up: one scene edited three times leaves
    // three versions of its part. A finished render clears out the ones it did not use.
    let pruned = 0;
    try {
      const stale = [...new Set(readdirSync(cacheRoot).map(f => f.match(/^([0-9a-f]{64})\.(mp4|json)$/)?.[1]).filter(Boolean))].filter(k => !used.has(k));
      for (const k of stale) { rmSync(join(cacheRoot, k + '.mp4'), { force: true }); rmSync(join(cacheRoot, k + '.json'), { force: true }); pruned++; }
    } catch {}
    if (pruned) log(`(removed ${pruned} unused cached part${pruned === 1 ? '' : 's'})`);
    log(`\nSAVED ${out} (${scenes.length} scenes${parts.length > scenes.length ? `, ${parts.length - scenes.length} transitions` : ''}, ${duration.toFixed(3)} s${audio ? `, ${p.audio.length} audio files` : ''})`);
  } finally {
    await Promise.all([closingChromes, closeChromes(), serverPromise?.then(s => s.close())]);
    rmSync(partial, { force: true }); rmSync(tmp, { recursive: true, force: true });
  }
}

// Stills of a project at times of the video, as the render draws them there: the scene or the transition, with
// SCENE_START and the overlays. Files are named by time, as for a page.
export async function renderProjectStills({ dir, outDir, times, scale = 1, format = 'png', log = console.log }) {
  const { root, file } = projectPaths(dir), p = JSON.parse(readFileSync(file, 'utf8')), fps = p.fps;
  const scenes = projectScenes(p, root), overlays = parseOverlays(p.overlays, scenes.length);
  for (const o of overlays) if (!existsSync(join(root, o.layer))) throw new Error(`the overlay file ${o.layer} does not exist`);
  outDir = resolve(outDir); mkdirSync(outDir, { recursive: true });
  const server = await startServer({ root }), chrome = await launchChrome({ chromePath: findChrome() });
  try {
    const frames = [], first = [];   // each scene's length, and the frame of the video where it starts
    let end = 0;
    for (const [i, s] of scenes.entries()) {
      const info = await readPageInfo({ page: join(root, s.file), root, server, browser: chrome, scale });
      if (!(info.total > 0)) throw new Error(`${s.file}: window.TOTAL must be a positive number of seconds`);
      frames.push(frameCount(info.total, fps)); first.push(end - transitionOverlap(s.transition)); end = first[i] + frames[i];
    }
    const starts = first.map(f => f / fps), placed = placeOverlays(overlays, starts, frames.map(f => f / fps)), files = [], counts = new Map();
    for (const t of times) {
      if (!(t >= 0 && t < end / fps)) throw new Error(`${t} s is outside the video, which is ${(end / fps).toFixed(3)} s long`);
      const at = Math.floor(t * fps + 1e-6), i = first.findLastIndex(f => f <= at), f = at - first[i];
      const into = scenes[i].transition, out = scenes[i + 1]?.transition, cut = out?.layer ? frames[i] - layerFrames(out.n).before : Infinity;
      // the transition this frame is in, as [scene it comes from, frame k of the transition], or none
      const tr = into && !into.layer && f < into.n ? [i - 1, f] : into?.layer && f < layerFrames(into.n).after ? [i - 1, layerFrames(into.n).before + f]
        : f >= cut ? [i, f - cut] : null;
      const shot = tr
        ? { url: '__motlab/transition.html', query: String(transitionQuery(scenes, tr[0], frames[tr[0]], fps)), t: tr[1] / fps, sceneStart: starts[tr[0]],
            videoAt: starts[tr[0]] + (frames[tr[0]] - transitionTail(scenes[tr[0] + 1].transition)) / fps }
        : { page: join(root, scenes[i].file), t: f / fps, sceneStart: starts[i], videoAt: starts[i] };
      const name = t.toFixed(2), count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      const over = placed.filter(o => o.start < at / fps + 1e-6 && o.end > at / fps + 1e-6).map(({ layer, start, end, params }) => ({ layer, start, end, params }));
      files.push(await renderShot({ ...shot, root, server, browser: chrome, scale, format, overlays: over, out: join(outDir, `${name}${count > 1 ? `-${count}` : ''}.${format === 'jpg' ? 'jpg' : 'png'}`) }));
    }
    log(`stills -> ${outDir} (${files.length})`);
    return files;
  } finally { await chrome.close(); await server.close(); }
}
