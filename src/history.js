// A project's history: checkpoints of its folder, kept in <folder>/.motlab/history, which the viewer's file watcher
// and project menu skip. Each file is stored once by its hash in objects/, so a checkpoint that changes one scene adds
// one small file, and checkpoints.json lists every checkpoint with the hash of each file it holds. Renders (out/),
// backup/, selection.json, selection/ and hidden files are left out, as the watcher leaves them out.
// A checkpoint is kept by itself before and after each round of the agent's work (motlab working), unless the history
// is turned off for the folder, and before every restore, so a restore can be undone. The last KEEP stay.
// The folder can hold several versions of the video (project.json, project-tiktok.json). A checkpoint holds them all,
// but a restore works on one version: it leaves alone the other versions' project files and the files only they use.
// Two writers (the viewer and a command) take turns through a lock, so neither loses the other's checkpoint.
import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ignored } from './live.js';

export const KEEP = 50;
export const historyDir = root => join(resolve(root), '.motlab', 'history');
const objects = root => join(historyDir(root), 'objects');
const left = rel => ignored(rel) || /^selection\.(json|png)$/.test(rel) || rel.endsWith('.part');

function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name), rel = relative(root, abs).split(sep).join('/');
    if (left(rel)) continue;
    if (e.isDirectory()) walk(root, abs, out); else if (e.isFile()) out.push(rel);
  }
  return out;
}

const hashFile = path => new Promise((ok, no) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no);
});

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) {   // whole or not at all
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, file);
}
const state = root => readJson(join(historyDir(root), 'checkpoints.json'), { checkpoints: [] });

// One writer at a time: a lock folder made with mkdir, which fails while another holds it. A lock left by a process
// that died is taken over after STALE ms.
const STALE = 60000;
async function withLock(root, fn) {
  const lock = join(historyDir(root), 'lock');
  mkdirSync(historyDir(root), { recursive: true });
  for (const t0 = Date.now(); ;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() - t0 > STALE) throw new Error(`the history of ${root} is locked (${lock})`);
      await sleep(25);
    }
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// Whether checkpoints are kept by themselves for this folder: on unless someone turned them off.
export const historyOn = root => readJson(join(historyDir(root), 'settings.json'), {}).enabled !== false;
export function setHistoryOn(root, on) { writeJson(join(historyDir(root), 'settings.json'), { enabled: !!on }); }

// The project's files as { path: hash }, each stored in objects/ if it is not there yet. A file whose size and time
// have not changed since it was last hashed keeps that hash (index.json), so large footage is read once. With
// store false nothing is copied: the files as they are, to compare with a checkpoint.
async function snapshot(root, { store = true } = {}) {
  const indexFile = join(historyDir(root), 'index.json'), index = readJson(indexFile, {}), next = {}, files = {};
  mkdirSync(objects(root), { recursive: true });
  for (const rel of walk(root).sort()) {
    const abs = join(root, rel), st = statSync(abs), seen = index[rel];
    const hash = seen && seen[0] === st.size && seen[1] === st.mtimeMs ? seen[2] : await hashFile(abs);
    const obj = join(objects(root), hash);
    if (store && !existsSync(obj)) copyFileSync(abs, obj, constants.COPYFILE_FICLONE);   // a copy-on-write clone where the disk has them
    next[rel] = [st.size, st.mtimeMs, hash]; files[rel] = hash;
  }
  writeJson(indexFile, next);
  return files;
}

// What changed from one set of files to the next, as sorted paths.
export function changes(a = {}, b = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(f => a[f] !== b[f]).sort();
}

// Keeps a checkpoint. why says what it is: { kind: 'before' | 'after' | 'restore', project, notes, scenes, text, from }.
// It is skipped, returning null, when nothing changed since the last one, and for the agent's rounds (auto) when the
// history is turned off.
export async function saveCheckpoint(root, { why, files, auto = false } = {}) {
  if (auto && !historyOn(root)) return null;
  files ??= await snapshot(root);
  return withLock(root, () => {
    const st = state(root), last = st.checkpoints.at(-1);   // read under the lock: another writer may have added one
    if (last && !changes(last.files, files).length) return null;
    const now = new Date(), id = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '') + '-' + randomBytes(2).toString('hex');
    const cp = { id, time: now.toISOString(), ...(why ? { why } : {}), files };
    st.checkpoints.push(cp);
    prune(root, st);
    writeJson(join(historyDir(root), 'checkpoints.json'), st);
    return cp;
  });
}

// The last KEEP checkpoints stay. Stored files no checkpoint holds any more are deleted, unless they are recent: a
// snapshot in another process may have just stored them for a checkpoint it has not written yet.
function prune(root, st) {
  if (st.checkpoints.length <= KEEP) return;
  st.checkpoints = st.checkpoints.slice(-KEEP);
  const used = new Set(st.checkpoints.flatMap(c => Object.values(c.files))), recent = Date.now() - 10 * 60000;
  for (const f of readdirSync(objects(root))) {
    const p = join(objects(root), f);
    if (!used.has(f) && statSync(p).mtimeMs < recent) rmSync(p, { force: true });
  }
}

// ---- versions: which files a restore of one version may touch

// The files a project file names: its scenes, their transitions' .glsl and layer modules, audio, overlays and beats.
function named(text) {
  let p; try { p = JSON.parse(text); } catch { return null; }
  if (!p || !Array.isArray(p.scenes)) return null;   // not a version of the video
  const out = new Set(), add = f => typeof f === 'string' && out.add(f.replaceAll('\\', '/').replace(/^\.\//, ''));
  for (const s of p.scenes) {
    add(typeof s === 'string' ? s : s?.file);
    const tr = s?.transition;
    if (tr && /\.glsl$/i.test(String(tr.type))) add(tr.type);
    add(tr?.layer);
  }
  for (const a of p.audio || []) add(a?.file);
  for (const o of p.overlays || []) add(o?.layer);
  add(p.beats);
  return out;
}

// The paths a restore of `version` (a project file at the top of the folder) leaves alone: the other versions'
// project files, and the files only they name, now or in the checkpoints given (file maps). Files every version
// shares are restored.
function othersOnly(root, version, ...thens) {
  const mine = new Set(), theirs = new Set(), skip = new Set();
  const read = (rel, then) => { try { return !then ? readFileSync(join(root, rel), 'utf8') : readFileSync(join(objects(root), then[rel]), 'utf8'); } catch { return null; } };
  const tops = then => (!then ? walk(root) : Object.keys(then)).filter(f => !f.includes('/') && f.toLowerCase().endsWith('.json'));
  for (const where of [null, ...thens]) for (const f of tops(where)) {
    const refs = named(read(f, where) ?? '');
    if (!refs) continue;
    if (f === version) refs.forEach(r => mine.add(r));
    else { skip.add(f); refs.forEach(r => theirs.add(r)); }
  }
  for (const r of theirs) if (!mine.has(r)) skip.add(r);
  return skip;
}

// The checkpoints, newest first: what changed in each since the one before it, and what differs from the files now.
// With a version, only the checkpoints that have it and changed something of it (a round on another cut's own scene
// is left out), what changed of it, and the differences a restore of it would put back.
export async function listCheckpoints(root, { version } = {}) {
  const all = state(root).checkpoints, now = all.length ? await snapshot(root, { store: false }) : {};
  return all.flatMap((c, i) => {
    if (version && !c.files[version]) return [];
    const first = !i || (version && !all[i - 1].files[version]), skip = version ? othersOnly(root, version, c.files) : new Set();
    const was = first || !version ? skip : othersOnly(root, version, c.files, all[i - 1].files);   // what other versions named either side
    const changed = first ? [] : changes(all[i - 1].files, c.files).filter(f => !was.has(f));
    if (version && !first && !changed.length) return [];
    return [{ id: c.id, time: c.time, why: c.why, files: Object.keys(c.files).length, first, changed, differs: changes(c.files, now).filter(f => !skip.has(f)) }];
  }).reverse();
}

export function checkpoint(root, id) {
  const c = state(root).checkpoints.find(c => c.id === id);
  if (!c) throw new Error(`no checkpoint ${id} in ${root}`);
  return c;
}

// The stored copy of a file in a checkpoint, or null.
export function fileAt(root, id, rel) {
  const hash = checkpoint(root, id).files[rel];
  return hash ? join(objects(root), hash) : null;
}

// Puts one version of the project back as it was at a checkpoint: every file it uses, or only `file`. A file the
// checkpoint did not have is deleted (only that file, when one is named). The other versions' project files and the
// files only they use stay as they are. A checkpoint of the files as they are is kept first, so this can be undone.
// Returns the paths it changed and the checkpoint that undoes it (null when nothing changed).
export async function restoreCheckpoint(root, id, { file, version = 'project.json' } = {}) {
  const c = checkpoint(root, id);
  if (!c.files[version]) throw new Error(`${version} did not exist at checkpoint ${id}`);
  const now = await snapshot(root), skip = othersOnly(root, version, c.files);
  const paths = (file ? [file] : [...new Set([...Object.keys(now), ...Object.keys(c.files)])]).filter(rel => now[rel] !== c.files[rel] && !skip.has(rel));
  if (!paths.length) return { changed: [], before: null };
  const before = await saveCheckpoint(root, { why: { kind: 'restore', from: id, project: version, ...(file ? { file } : {}) }, files: now }) || state(root).checkpoints.at(-1);
  const changed = [];
  for (const rel of paths) {
    const abs = join(resolve(root), rel);
    if (!abs.startsWith(resolve(root) + sep)) throw new Error(`${rel} is outside the project`);
    if (c.files[rel]) { mkdirSync(dirname(abs), { recursive: true }); copyFileSync(join(objects(root), c.files[rel]), abs); }
    else rmSync(abs, { force: true });
    changed.push(rel);
  }
  return { changed: changed.sort(), before: before.id };
}

// How a checkpoint reads in a list, in English, for the command line.
export function describe(c) {
  const w = c.why || {}, notes = w.notes?.length ? ` on notes ${w.notes.join(', ')}` : w.scenes?.length ? ` on scenes ${w.scenes.join(', ')}` : '';
  if (w.kind === 'restore') return 'before a restore';
  if (w.kind === 'before' || w.kind === 'after') return `${w.kind} the agent worked${notes}`;
  return 'checkpoint';
}
