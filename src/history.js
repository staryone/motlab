// A project's history: checkpoints of its folder, kept in <folder>/.motlab/history, which the viewer's file watcher
// and project menu skip. Each file is stored once by its hash in objects/, so a checkpoint that changes one scene adds
// one small file, and checkpoints.json lists every checkpoint with the hash of each file it holds. Renders (out/),
// backup/, selection.json, selection/ and hidden files are left out, as the watcher leaves them out.
// A checkpoint is kept before and after each round of the agent's work (motlab working), when someone names one, and
// before a restore, so a restore can be undone. The last KEEP unnamed ones stay, with every named one.
import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
function writeJson(file, data) {   // whole or not at all, as two processes (the viewer and a command) may write it
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, file);
}
const state = root => readJson(join(historyDir(root), 'checkpoints.json'), { checkpoints: [] });

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

// Keeps a checkpoint. why says what it is: { kind: 'before' | 'after' | 'restore', notes, scenes, text, from }, or a
// name for one someone named. An unnamed one is skipped when nothing changed since the last; it returns null then.
export async function saveCheckpoint(root, { name, why, files } = {}) {
  files ??= await snapshot(root);
  const last = state(root).checkpoints.at(-1);
  if (!name && last && !changes(last.files, files).length) return null;
  const now = new Date(), id = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '') + '-' + randomBytes(2).toString('hex');
  const cp = { id, time: now.toISOString(), ...(name ? { name: String(name).slice(0, 80) } : {}), ...(why ? { why } : {}), files };
  const fresh = state(root);   // read again: another process may have added one while the files were hashed
  fresh.checkpoints.push(cp);
  prune(root, fresh);
  writeJson(join(historyDir(root), 'checkpoints.json'), fresh);
  return cp;
}

// The last KEEP unnamed checkpoints stay, and every named one; objects no checkpoint holds any more are deleted.
function prune(root, st) {
  const unnamed = st.checkpoints.filter(c => !c.name);
  const drop = new Set(unnamed.slice(0, Math.max(0, unnamed.length - KEEP)).map(c => c.id));
  st.checkpoints = st.checkpoints.filter(c => !drop.has(c.id));
  if (!drop.size) return;
  const used = new Set(st.checkpoints.flatMap(c => Object.values(c.files)));
  for (const f of readdirSync(objects(root))) if (!used.has(f)) rmSync(join(objects(root), f), { force: true });
}

// The checkpoints, newest first, each with what changed since the one before it and what differs from the files now.
export async function listCheckpoints(root) {
  const list = state(root).checkpoints, now = list.length ? await snapshot(root, { store: false }) : {};
  return list.map((c, i) => ({ id: c.id, time: c.time, name: c.name, why: c.why, files: Object.keys(c.files).length, first: !i,
    changed: i ? changes(list[i - 1].files, c.files) : [], differs: changes(c.files, now) })).reverse();
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

// Puts the project back as it was at a checkpoint: every file, or only `file`. A file the checkpoint did not have is
// deleted (only that file, when one is named). A checkpoint of the files as they are is kept first, so this can be
// undone. Returns the paths it changed and the checkpoint that undoes it (null when nothing changed).
export async function restoreCheckpoint(root, id, { file } = {}) {
  const c = checkpoint(root, id), now = await snapshot(root);
  const paths = (file ? [file] : [...new Set([...Object.keys(now), ...Object.keys(c.files)])]).filter(rel => now[rel] !== c.files[rel]);
  if (!paths.length) return { changed: [], before: null };
  const before = await saveCheckpoint(root, { why: { kind: 'restore', from: id, ...(file ? { file } : {}) }, files: now }) || state(root).checkpoints.at(-1);
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
  if (c.name) return c.name;
  const w = c.why || {}, notes = w.notes?.length ? `notes ${w.notes.join(', ')}` : w.scenes?.length ? `scenes ${w.scenes.join(', ')}` : '';
  if (w.kind === 'restore') return `before restoring ${w.file ? `${w.file} from ` : ''}${w.from}`;
  if (w.kind === 'before' || w.kind === 'after') return [w.kind === 'before' ? 'before the agent worked' : 'after the agent worked', notes, w.text].filter(Boolean).join(': ');
  return 'checkpoint';
}
