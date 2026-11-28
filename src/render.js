// The three render modes. A page is opened in headless Chrome, checked against the contract, then driven by the
// in-page runtime (src/page/runtime.js).
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { attachPage, findChrome, launchChrome } from './chrome.js';
import { frameCount, splitFrames } from './codecs.js';
import { hasMediabunny } from './doctor.js';
import { finalize, probeVideo, spawnProres } from './ffmpeg.js';
import { label, rate, selectEncoder } from './probe.js';
import { startServer } from './server.js';

const RUNTIME = readFileSync(new URL('./page/runtime.js', import.meta.url), 'utf8');

// Without --root, a page is served from the nearest folder above it that holds a project.json, the folder the viewer
// serves, so a scene can load ../ files; a page outside a project is served from its own folder.
function projectRoot(page) {
  for (let dir = dirname(page); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'project.json'))) return dir;
    if (dirname(dir) === dir) return dirname(page);
  }
}

function locate(o) {
  if (o.url) return { root: resolve(o.root), url: o.url };   // a page the server provides itself, e.g. __motlab/transition.html
  const page = resolve(o.page), root = resolve(o.root || projectRoot(page)), rel = relative(root, page);
  if (rel.startsWith('..')) throw new Error(`page ${page} is outside the served folder ${root}; pass --root`);
  return { root, url: rel.split(sep).map(encodeURIComponent).join('/') };
}

async function openPage({ server, chromePath, browser, url, scale, query, signal }) {
  signal?.throwIfAborted();
  const owned = !browser, chrome = browser || await launchChrome({ chromePath });
  let page;
  const stop = () => { void (owned ? chrome.close() : page?.close()); };
  signal?.addEventListener('abort', stop);
  try {
    signal?.throwIfAborted();
    page = await attachPage(chrome, { create: !owned });
    await page.navigate(`${server.origin}/${url}?t=0&scale=${scale}${query ? '&' + query : ''}`);
    // Wait for the contract. Give up 8 s after the document has finished loading (or 5 s after a script error).
    const t0 = Date.now(); let loadedAt = 0;
    for (;;) {
      signal?.throwIfAborted();
      const state = await page.evaluate('typeof window.renderAt === "function" && typeof window.ready !== "undefined" ? "ok" : document.readyState').catch(() => 'loading');
      if (state === 'ok') break;
      const now = Date.now(), errs = page.errors.length ? ` Page errors: ${page.errors.slice(0, 3).join(' | ')}` : '';
      if (state === 'complete' && !loadedAt) loadedAt = now;
      if (now - t0 > 60000 || (loadedAt && now - loadedAt > 8000) || (errs && now - t0 > 5000)) throw new Error(`the page did not expose window.renderAt and window.ready.${errs}`);
      await sleep(50, undefined, { signal });
    }
    // ready has no time limit (a heavy page can take long), but a page whose ready never resolves should not wait in silence
    const waiting = setTimeout(() => console.warn(`Still waiting for window.ready after 30 s (${url}).${page.errors.length ? ` Page errors: ${page.errors.slice(0, 3).join(' | ')}` : ''}`), 30000);
    try { await page.evaluate('Promise.resolve(window.ready).then(() => true)'); } finally { clearTimeout(waiting); }
    await page.evaluate(RUNTIME);
    return { ...page, chrome, owned };
  } catch (e) { await (owned ? chrome.close() : page?.close()); signal?.throwIfAborted(); throw e; }
  finally { signal?.removeEventListener('abort', stop); }
}

const closePage = p => p.owned ? p.chrome.close() : p.close();

async function openPages(count, args) {
  const settled = await Promise.allSettled(Array.from({ length: count }, () => openPage(args)));
  const failed = settled.find(s => s.status === 'rejected');
  if (failed) { await Promise.all(settled.filter(s => s.status === 'fulfilled').map(s => closePage(s.value))); throw failed.reason; }
  return settled.map(s => s.value);
}

// A page's info (size, TOTAL, EVENTS) without rendering it: for a project, the lengths of its scenes. o as for
// renderVideo, with o.browser a Chrome to open a tab in.
export async function readPageInfo(o) {
  const { url } = locate(o);
  const page = await openPage({ server: o.server, browser: o.browser, chromePath: o.browser ? undefined : findChrome(o.chrome), url, scale: o.scale ?? 1, query: o.query, signal: o.signal });
  try { return await page.evaluate('window.__motlab.info()'); } finally { await closePage(page); }
}

async function readInfo(page, log) {
  const info = await page.evaluate('window.__motlab.info()');
  log(`GPU: ${info.gpu.renderer || 'none (no WebGL: Chrome is not using a GPU)'}`);
  return info;
}

export async function renderVideo(o) {
  const log = o.log || console.log, fps = o.fps ?? 24, scale = o.scale ?? 2, workers = Math.max(1, o.workers ?? 1), started = Date.now();
  const { root, url } = locate(o), out = resolve(o.out), part = out + '.part';   // written here first, renamed when complete
  if (o.codec === 'prores4444' && !out.toLowerCase().endsWith('.mov')) throw new Error(`--codec prores4444 writes a .mov file, not ${out}`);
  const ownServer = !o.server, server = o.server || await startServer({ root }), tmp = mkdtempSync(join(tmpdir(), 'motlab-render-'));
  let pages = [];
  // o.signal (an AbortSignal) stops the render: closing Chrome (or its tab) rejects whatever the render is waiting on.
  const stop = () => pages.forEach(p => void closePage(p));
  o.signal?.addEventListener('abort', stop);
  try {
    const browser = workers === 1 ? o.browser : undefined;
    pages = await openPages(workers, { server, chromePath: browser ? undefined : findChrome(o.chrome), browser, url, scale, query: o.query, signal: o.signal });
    o.signal?.throwIfAborted();
    const info = await readInfo(pages[0], log), { width, height } = info, prores = o.codec === 'prores4444';
    if (!(info.total > 0)) throw new Error('window.TOTAL must be a positive number of seconds');
    if (!prores && (width % 2 || height % 2)) throw new Error(`canvas is ${width}x${height}; H.264 and HEVC need even dimensions`);
    // head and tail leave out frames at the start and the end, which a scene transition draws instead.
    const pageFrames = frameCount(info.total, fps), head = o.head || 0, tail = o.tail || 0, frames = pageFrames - head - tail;
    if (frames < 1) throw new Error(`the page has ${pageFrames} frames, too few for transitions of ${head} and ${tail} frames at its start and end`);
    const ranges = splitFrames(frames, workers).map(r => ({ start: r.start + head, end: r.end + head }));
    for (const extra of pages.splice(ranges.length)) await closePage(extra);
    log(`Page: ${width}x${height}, ${info.total} s, ${frames} frames at ${fps} fps${head || tail ? ` (frames ${head} to ${pageFrames - tail} of ${pageFrames})` : ''}${ranges.length > 1 ? `, ${ranges.length} Chrome processes` : ''}`);
    // The page's SCENE_START. A project passes a function, which learns this page's length and waits for the scenes before it.
    const sceneStart = typeof o.sceneStart === 'function' ? await o.sceneStart(pageFrames) : o.sceneStart || 0;
    o.signal?.throwIfAborted();

    const enc = prores
      ? { codec: 'prores4444', hw: false, source: 'ffmpeg' }
      : await selectEncoder({ pages, machine: { chrome: pages[0].chrome.version, gpu: info.gpu.renderer }, width, height, fps,
        mode: o.encoder || 'auto', codec: o.codec || 'auto', bitrate: o.bitrate, qp: o.qp, reprobe: o.reprobe, log });
    log(prores ? 'Encoder: ProRes 4444, yuva444p10le + alpha (ffmpeg prores_ks)' : `Encoder: ${label(enc)}, ${rate(enc)}, ${enc.codecString} (${enc.source})`);

    const done = ranges.map(() => 0); let lastLine = 0;
    pages.forEach((p, i) => p.onEmit(m => {
      if (m.type !== 'progress') return; done[i] = m.done;
      // o.progress is false when project parts render in parallel, whose frame counts would overwrite each other
      if (o.progress !== false && process.stdout.isTTY && Date.now() - lastLine > 200) { lastLine = Date.now(); process.stdout.write(`\r${done.reduce((a, b) => a + b, 0)}/${frames} frames`); }
    }));

    mkdirSync(dirname(out), { recursive: true });
    let res;
    if (prores) {
      // Straight RGBA frames are read from the canvas and piped directly into ffmpeg prores_ks (no raw RGBA temp file).
      const procs = ranges.map((_, i) => spawnProres({ width, height, fps, out: join(tmp, `prores-${i}.mov`), signal: o.signal }));
      const sinks = procs.map(p => server.createPipeSink(p.stdin));
      const t0 = Date.now(); let stats;
      try {
        stats = await Promise.all(ranges.map((r, i) => pages[i].evaluate(`window.__motlab.captureRange(${JSON.stringify({
          ...r, sceneStart, overlays: o.overlays, videoAt: o.videoAt ?? sceneStart, scale, fps, base: server.base, sink: sinks[i].id })})`)));
        await Promise.all(sinks.map(s => s.close()));
        await Promise.all(procs.map(p => p.finish()));
      } catch (e) {
        await Promise.all(sinks.map(s => s.close()));
        await Promise.all(procs.map(p => p.abort()));
        o.signal?.throwIfAborted(); throw e;
      }
      const encodeMs = Date.now() - t0;
      await finalize({ inputs: procs.map(p => p.path), codec: 'prores4444', fps, audio: o.audio && resolve(o.audio), out: part, duration: frames / fps, tmp, signal: o.signal, fullRange: false });
      res = { mux: 'prores', encodeMs, stats, fullRange: false };
    } else {
      const ext = enc.codec === 'hevc' ? 'h265' : 'h264';
      // Each worker writes its own part into the temp folder: an MP4 muxed in the page by Mediabunny, or a raw Annex B
      // stream. ffmpeg then stream-copies the parts into the final file, which is where the colour tags are written
      // into the bitstream, parallel parts are joined and audio is added.
      const attempt = async mux => {
        const jobs = [];
        for (let i = 0; i < ranges.length; i++) jobs.push(await server.createSink(join(tmp, `${mux}-${i}.${mux === 'raw' ? ext : 'mp4'}`)));
        const t0 = Date.now(); let stats;
        try {
          stats = await Promise.all(ranges.map((r, i) => pages[i].evaluate(`window.__motlab.encodeRange(${JSON.stringify({
            ...r, sceneStart, overlays: o.overlays, videoAt: o.videoAt ?? sceneStart, scale, fps, codec: enc.codec, codecString: enc.codecString, hw: enc.hw, rc: enc.rc, qp: enc.qp, bitrate: enc.bitrate, mux, base: server.base, sink: jobs[i].id,
            keyInterval: Math.max(1, Math.round(fps * 2)) })})`)));
        } catch (e) { o.signal?.throwIfAborted(); throw e; } finally { await Promise.all(jobs.map(j => j.close())); }
        const encodeMs = Date.now() - t0;
        let inputs = jobs.map(j => j.path);
        if (mux === 'raw' && inputs.length > 1) {   // Annex B streams join by plain concatenation
          const all = join(tmp, `all.${ext}`), w = createWriteStream(all);
          for (const p of inputs) await pipeline(createReadStream(p), w, { end: false });
          await new Promise(r => w.end(r)); inputs = [all];
        }
        const fullRange = stats[0].fullRange;
        if (stats.some(s => s.fullRange !== fullRange)) throw new Error('the workers encoded different colour ranges');
        await finalize({ inputs, raw: mux === 'raw', codec: enc.codec, fps, audio: o.audio && resolve(o.audio), out: part, duration: frames / fps, tmp, signal: o.signal, fullRange });
        return { mux, encodeMs, stats, fullRange };
      };

      const want = o.mux || 'auto';
      try { res = await attempt(want === 'raw' ? 'raw' : 'mediabunny'); }
      catch (e) {
        if (want !== 'auto' || o.signal?.aborted) throw e;
        // Without the npm package the page only says it "failed to fetch" mediabunny.mjs, so the cause is named here.
        const why = hasMediabunny() ? e.message.split('\n')[0] : `mediabunny is not installed: run npm ci in ${fileURLToPath(new URL('..', import.meta.url))}`;
        log(`\nMediabunny path failed (${why}). Retrying with raw bitstream and ffmpeg.`);
        res = await attempt('raw');
      }
    }
    if (o.progress !== false && process.stdout.isTTY) process.stdout.write('\r');
    rmSync(out, { force: true }); renameSync(part, out);

    const v = await probeVideo(out), wantDur = frames / fps;
    const muxLabel = prores
      ? `RGBA pipe to ffmpeg prores_ks${ranges.length > 1 ? ` (concat of ${ranges.length} parts)` : ''}${o.audio ? ' with PCM audio' : ''}`
      : `${res.mux === 'raw' ? 'raw bitstream' : 'Mediabunny in the page'}, then ffmpeg -c copy${ranges.length > 1 ? ` (concat of ${ranges.length} parts)` : ''}${o.audio ? ' with audio' : ''}`;
    const summary = { out, frames: v.frames, expectedFrames: frames, pageFrames, sceneStart, startRead: res.stats.some(s => s.startRead), duration: v.duration, width, height, fps, gpu: info.gpu.renderer,
      encoder: prores ? 'ProRes 4444' : label(enc), codec: enc.codec, hw: enc.hw,
      rate: prores ? 'yuva444p10le' : rate(enc), mux: muxLabel, fullRange: res.fullRange, workers: ranges.length, encodeSeconds: res.encodeMs / 1000, totalSeconds: (Date.now() - started) / 1000, size: v.size,
      color: { range: v.color_range, space: v.color_space, transfer: v.color_transfer, primaries: v.color_primaries } };
    log(`Mux: ${muxLabel}`);
    log(`Colour tags: ${v.color_space || 'none'} / ${v.color_range || 'none'} (primaries ${v.color_primaries || 'none'}, transfer ${v.color_transfer || 'none'})`);
    if (v.frames !== frames || Math.abs(v.duration - wantDur) > 0.5 / fps) throw new Error(`output check failed: ${v.frames} frames, ${v.duration} s; expected ${frames} frames, ${wantDur} s (${out})`);
    log(`SAVED ${out} (${v.frames} frames, ${v.duration.toFixed(3)} s, ${(v.size / 1e6).toFixed(1)} MB; encode ${summary.encodeSeconds.toFixed(1)} s = ${(frames / summary.encodeSeconds).toFixed(1)} fps, total ${summary.totalSeconds.toFixed(1)} s)`);
    return summary;
  } finally {
    o.signal?.removeEventListener('abort', stop);
    await Promise.all(pages.map(closePage));
    if (ownServer) await server.close();
    rmSync(part, { force: true }); rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderStills(o) {
  const log = o.log || console.log, { root, url } = locate(o), outDir = resolve(o.outDir);
  const jpg = (o.format || 'png') !== 'png', server = await startServer({ root });
  let page;
  try {
    page = await openPage({ server, chromePath: findChrome(o.chrome), url, scale: o.scale ?? 1 });
    await readInfo(page, log);
    mkdirSync(outDir, { recursive: true });
    const files = [], counts = new Map();
    for (const t of o.times) {
      const name = t.toFixed(2), count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      const sink = await server.createSink(join(outDir, `${name}${count > 1 ? `-${count}` : ''}.${jpg ? 'jpg' : 'png'}`));
      try { await page.evaluate(`window.__motlab.still(${JSON.stringify({ t, type: jpg ? 'image/jpeg' : 'image/png', quality: o.quality ?? 0.92, base: server.base, sink: sink.id })})`); } finally { await sink.close(); }
      files.push(sink.path);
    }
    log(`stills -> ${outDir} (${files.length})`);
    return files;
  } finally { if (page) await page.chrome.close(); await server.close(); }
}

// One still of a page into o.out, in a tab of o.browser served by o.server: frame o.t, with SCENE_START o.sceneStart and
// the overlays (o.overlays, o.videoAt) as a project render draws them. For `motlab stills` of a project.
export async function renderShot(o) {
  const { url } = locate(o), page = await openPage({ server: o.server, browser: o.browser, url, scale: o.scale ?? 1, query: o.query });
  const sink = await o.server.createSink(o.out);
  try {
    await page.evaluate(`window.__motlab.still(${JSON.stringify({ t: o.t, type: o.format === 'jpg' ? 'image/jpeg' : 'image/png', quality: o.quality ?? 0.92,
      base: o.server.base, sink: sink.id, sceneStart: o.sceneStart, overlays: o.overlays, videoAt: o.videoAt, scale: o.scale ?? 1 })})`);
  } finally { await sink.close(); await closePage(page); }
  return o.out;
}

export async function dumpEvents(o) {
  const log = o.log || console.log, { root, url } = locate(o), out = resolve(o.out), server = await startServer({ root });
  let page;
  try {
    page = await openPage({ server, chromePath: findChrome(o.chrome), url, scale: 1 });
    const info = await page.evaluate('window.__motlab.info()');
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(info.events));
    log(`${info.events.length} events -> ${out}`);
    return info.events;
  } finally { if (page) await page.chrome.close(); await server.close(); }
}
