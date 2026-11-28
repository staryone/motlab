// Depth maps of photos and frames, for parallax layers (skills/motlab/scripts/depth_layers.py cuts a photo along one).
// The model is Depth Anything V2 Small (Apache 2.0; the larger V2 models are CC-BY-NC), run by transformers.js in
// headless Chrome, on the GPU through WebGPU when Chrome has it and on the CPU otherwise. It only measures a picture and
// makes none. transformers.js, the ONNX runtime and the model (about 70 MB together) come from jsDelivr and Hugging
// Face on the first run and stay in a Chrome profile kept in motlab's cache folder, so later runs need no network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { attachPage, findChrome, launchChrome } from './chrome.js';
import { cacheDir } from './probe.js';

export const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
export const MODEL = 'onnx-community/depth-anything-v2-small';
// A made-up https origin, the same on every run: Chrome keeps what a page saved per origin, so the model it stored on
// the first run is found again. Chrome asks motlab for every request to it, so nothing goes to the network.
const ORIGIN = 'https://motlab-depth.invalid';
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };

export const depthOut = file => join(dirname(file), basename(file, extname(file)) + '.depth.png');

const PAGE = `<!doctype html><meta charset="utf-8"><title>motlab depth</title><script type="module">
import { pipeline } from '${TRANSFORMERS}';
const say = m => window.__motlabEmit?.(JSON.stringify(m));
window.depthSetup = async cpu => {
  const gpu = !cpu && navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const device = gpu ? 'webgpu' : 'wasm', dtype = gpu ? (gpu.features.has('shader-f16') ? 'fp16' : 'fp32') : 'q8';
  // transformers.js reports progress when it reads the model from its cache too, so only a download is told.
  const file = { fp16: 'model_fp16', fp32: 'model', q8: 'model_quantized' }[dtype] + '.onnx';
  const cached = await caches.open('transformers-cache').then(c => c.match('https://huggingface.co/${MODEL}/resolve/main/onnx/' + file)).catch(() => null);
  const files = {};
  window.estimate = await pipeline('depth-estimation', '${MODEL}', { device, dtype, progress_callback: p => {
    if (cached || p.status !== 'progress' || !p.total) return;
    files[p.file] = [p.loaded, p.total];
    const v = Object.values(files); say({ loaded: v.reduce((a, f) => a + f[0], 0), total: v.reduce((a, f) => a + f[1], 0) });
  } });
  return { device, dtype };
};
window.depthOf = async url => {
  const { depth } = await window.estimate(url);
  const blob = await depth.toBlob('image/png');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { width: depth.width, height: depth.height, png: btoa(s) };
};
</script>`;

// images: paths. Writes each map as an 8-bit grey PNG of the image's size, nearer being lighter, to out(file).
// Returns [{ file, out, width, height, seconds }] and the device and number format the model ran with.
export async function depthMaps(images, { chromePath, cpu = false, out = depthOut, log = () => {} } = {}) {
  const files = images.map(f => resolve(f));
  for (const f of files) if (!TYPES[extname(f).toLowerCase()]) throw new Error(`${f}: a depth map needs a JPEG, PNG, WebP, AVIF or BMP image`);
  const profile = join(cacheDir(), 'depth-chrome');
  mkdirSync(profile, { recursive: true });
  // The profile is kept, so Chrome is told not to fill it with its own downloads (components, extensions it would
  // install for programs on the machine).
  const quiet = ['--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disable-default-apps', '--disable-sync'];
  const chrome = await launchChrome({ chromePath: findChrome(chromePath), profile, extraArgs: quiet });
  try {
    const page = await attachPage(chrome);
    let shown = 0;
    page.onEmit(m => {   // download progress on the first run, every 10 MB
      if (m.total < 1e6 || (m.loaded - shown < 10e6 && m.loaded < m.total)) return;
      shown = m.loaded; log(`downloading the model: ${(m.loaded / 1e6).toFixed(0)} of ${(m.total / 1e6).toFixed(0)} MB`);
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
    chrome.on('Fetch.requestPaused', ({ requestId, request }) => {
      const path = new URL(request.url).pathname, i = /^\/image\/(\d+)$/.exec(path)?.[1];
      const [body, type] = path === '/' ? [Buffer.from(PAGE), 'text/html'] : i !== undefined && files[i] ? [readFileSync(files[i]), TYPES[extname(files[i]).toLowerCase()]] : [null];
      page.send('Fetch.fulfillRequest', body
        ? { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: body.toString('base64') }
        : { requestId, responseCode: 404, body: '' }).catch(() => {});
    });
    await page.navigate(`${ORIGIN}/`);
    const loaded = await page.evaluate(`new Promise(ok => { const t0 = performance.now();
      (function wait() { window.depthSetup ? ok(true) : performance.now() - t0 > 60000 ? ok(false) : setTimeout(wait, 50); })(); })`);
    if (!loaded) throw new Error(`transformers.js did not load from ${TRANSFORMERS}${page.errors.length ? `: ${page.errors[0]}` : ''}. The first run needs the network.`);
    const how = await page.evaluate(`window.depthSetup(${cpu})`);
    const done = [];
    for (const [i, file] of files.entries()) {
      const t0 = performance.now();
      const r = await page.evaluate(`window.depthOf('${ORIGIN}/image/${i}')`);
      const to = out(file);
      writeFileSync(to, Buffer.from(r.png, 'base64'));
      done.push({ file, out: to, width: r.width, height: r.height, seconds: (performance.now() - t0) / 1000 });
    }
    return { ...how, maps: done };
  } finally { await chrome.close(); }
}
