// Depth maps of photos and frames, for parallax layers (skills/motlab/scripts/depth_layers.py cuts a photo along one).
// The model is Depth Anything V2 Small (Apache 2.0; the larger V2 models are CC-BY-NC), about 70 MB with
// transformers.js and the ONNX runtime, run in headless Chrome by models.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PAGE_HELPERS, TRANSFORMERS, modelPage } from './models.js';

export { TRANSFORMERS };
export const MODEL = 'onnx-community/depth-anything-v2-small';
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };

export const depthOut = file => join(dirname(file), basename(file, extname(file)) + '.depth.png');

const PAGE = `<!doctype html><meta charset="utf-8"><title>motlab depth</title><script type="module">
import { pipeline } from '${TRANSFORMERS}';
${PAGE_HELPERS}
window.depthSetup = async cpu => {
  const gpu = !cpu && navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const device = gpu ? 'webgpu' : 'wasm', dtype = gpu ? (gpu.features.has('shader-f16') ? 'fp16' : 'fp32') : 'q8';
  const file = { fp16: 'model_fp16', fp32: 'model', q8: 'model_quantized' }[dtype] + '.onnx';
  window.estimate = await pipeline('depth-estimation', '${MODEL}', { device, dtype, progress_callback: await progress('${MODEL}', ['onnx/' + file]) });
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
  const serve = path => {
    const i = /^\/image\/(\d+)$/.exec(path)?.[1];
    return i !== undefined && files[i] ? [readFileSync(files[i]), TYPES[extname(files[i]).toLowerCase()]] : null;
  };
  const { page, close, base } = await modelPage(PAGE, { ready: 'depthSetup', serve, chromePath, log });
  try {
    const how = await page.evaluate(`window.depthSetup(${cpu})`);
    const done = [];
    for (const [i, file] of files.entries()) {
      const t0 = performance.now();
      const r = await page.evaluate(`window.depthOf('${base}/image/${i}')`);
      const to = out(file);
      writeFileSync(to, Buffer.from(r.png, 'base64'));
      done.push({ file, out: to, width: r.width, height: r.height, seconds: (performance.now() - t0) / 1000 });
    }
    return { ...how, maps: done };
  } finally { await close(); }
}
