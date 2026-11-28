// Analysis models for motlab depth and motlab matte. They measure pictures and make none. transformers.js runs them
// in headless Chrome, on the GPU through WebGPU when Chrome has it and on the CPU otherwise. transformers.js, the
// ONNX runtime and the models come from jsDelivr and Hugging Face on the first run and stay in a Chrome profile kept in
// motlab's cache folder, so later runs need no network.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { attachPage, findChrome, launchChrome } from './chrome.js';
import { cacheDir } from './probe.js';

export const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
// A made-up https origin, the same on every run: Chrome keeps what a page saved per origin, so the models stored on
// the first run are found again. Chrome asks motlab for every request to it, so nothing goes to the network. The
// name and the profile folder are kept from when the depth map was the only model, so its download stays.
export const ORIGIN = 'https://motlab-depth.invalid';

// For a model page: say() sends a message to Node, and progress(repo, files) gives a progress_callback that reports
// downloads only (transformers.js reports reading its cache as progress too).
export const PAGE_HELPERS = `
const say = m => window.__motlabEmit?.(JSON.stringify(m));
async function progress(repo, files) {
  const c = await caches.open('transformers-cache').catch(() => null);
  const hits = c ? await Promise.all(files.map(f => c.match('https://huggingface.co/' + repo + '/resolve/main/' + f))) : [];
  if (hits.length && hits.every(Boolean)) return () => {};
  const seen = {};
  return p => {
    if (p.status !== 'progress' || !p.total) return;
    seen[p.file] = [p.loaded, p.total];
    const v = Object.values(seen); say({ loaded: v.reduce((a, f) => a + f[0], 0), total: v.reduce((a, f) => a + f[1], 0) });
  };
}`;

// Opens html (a module page that sets window[ready] when it has loaded) at the origin above, under a folder new to
// this run, so nothing a run before kept in Chrome's cache is used. serve(path) answers the page's other requests
// (path without that folder): [Buffer, content type], or nothing for a 404. Returns { page, close, base }, where base
// is the folder's address for the page's own requests.
export async function modelPage(html, { ready, serve = () => null, chromePath, log = () => {} }) {
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
      if (!m.total || m.total < 1e6 || (m.loaded - shown < 10e6 && m.loaded < m.total)) return;
      shown = m.loaded; log(`downloading the model: ${(m.loaded / 1e6).toFixed(0)} of ${(m.total / 1e6).toFixed(0)} MB`);
    });
    const run = `/run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, base = ORIGIN + run;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
    chrome.on('Fetch.requestPaused', ({ requestId, request }) => {
      let path = new URL(request.url).pathname;
      path = path.startsWith(run + '/') ? path.slice(run.length) : null;
      const [body, type] = path === '/' ? [Buffer.from(html), 'text/html'] : path && serve(path) || [];
      // no-store: the profile is kept, and Chrome would otherwise answer the next run with this run's page and frames
      page.send('Fetch.fulfillRequest', body
        ? { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }], body: body.toString('base64') }
        : { requestId, responseCode: 404, body: '' }).catch(() => {});
    });
    await page.navigate(`${base}/`);
    const loaded = await page.evaluate(`new Promise(ok => { const t0 = performance.now();
      (function wait() { window.${ready} ? ok(true) : performance.now() - t0 > 60000 ? ok(false) : setTimeout(wait, 50); })(); })`);
    if (!loaded) throw new Error(`transformers.js did not load from ${TRANSFORMERS}${page.errors.length ? `: ${page.errors[0]}` : ''}. The first run needs the network.`);
    return { page, close: () => chrome.close(), base };
  } catch (e) { await chrome.close(); throw e; }
}
