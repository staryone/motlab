import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEEP, historyDir, listCheckpoints, restoreCheckpoint, saveCheckpoint } from '../src/history.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-history-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const project = name => {
  const root = join(dir, name);
  mkdirSync(join(root, 'scenes'), { recursive: true }); mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'project.json'), JSON.stringify({ fps: 10, scenes: ['scenes/a.html'] }));
  writeFileSync(join(root, 'scenes', 'a.html'), 'A1');
  writeFileSync(join(root, 'out', 'render.mp4'), 'not kept'); writeFileSync(join(root, 'selection.json'), '{}');
  return root;
};
const read = (root, f) => readFileSync(join(root, f), 'utf8');

test('history: checkpoints keep the project files once each, skip a round that changed nothing, and restore all or one file', async () => {
  const root = project('p1');
  const a = await saveCheckpoint(root, { why: { kind: 'before', notes: [3] } });
  assert.deepEqual(Object.keys(a.files).sort(), ['project.json', 'scenes/a.html']);   // no render, no selection.json
  assert.equal(await saveCheckpoint(root, { why: { kind: 'after' } }), null);          // nothing changed
  writeFileSync(join(root, 'scenes', 'a.html'), 'A2'); writeFileSync(join(root, 'scenes', 'b.html'), 'B');
  const b = await saveCheckpoint(root, { why: { kind: 'after', notes: [3] } });
  const named = await saveCheckpoint(root, { name: 'before the new music' });         // a named one is kept even unchanged
  assert.equal(named.name, 'before the new music');
  assert.equal(readdirSync(join(historyDir(root), 'objects')).length, 4);              // project.json, A1, A2, B

  const list = await listCheckpoints(root);
  assert.deepEqual(list.map(c => c.id), [named.id, b.id, a.id]);
  assert.deepEqual(list[1].changed, ['scenes/a.html', 'scenes/b.html']);
  assert.ok(list[2].first);
  assert.deepEqual(list[2].differs, ['scenes/a.html', 'scenes/b.html']);
  assert.deepEqual(list[0].differs, []);

  // one file back: only it changes, and a checkpoint of how it was is the way back
  writeFileSync(join(root, 'scenes', 'b.html'), 'B2');
  const one = await restoreCheckpoint(root, a.id, { file: 'scenes/a.html' });
  assert.deepEqual(one.changed, ['scenes/a.html']);
  assert.equal(read(root, 'scenes/a.html'), 'A1'); assert.equal(read(root, 'scenes/b.html'), 'B2');
  // the whole project: b.html did not exist then, so it goes; renders and selection.json stay
  const all = await restoreCheckpoint(root, a.id);
  assert.deepEqual(all.changed, ['scenes/b.html']);
  assert.ok(!existsSync(join(root, 'scenes', 'b.html')));
  assert.equal(read(root, 'out/render.mp4'), 'not kept'); assert.equal(read(root, 'selection.json'), '{}');
  assert.deepEqual(await restoreCheckpoint(root, a.id), { changed: [], before: null });   // nothing to do
  // undone with the checkpoint kept before it
  await restoreCheckpoint(root, all.before);
  assert.equal(read(root, 'scenes/b.html'), 'B2');
  await assert.rejects(restoreCheckpoint(root, 'nope'), /no checkpoint nope/);
});

test(`history: the last ${KEEP} unnamed checkpoints stay with every named one, and objects no checkpoint holds go`, async () => {
  const root = project('p2');
  const named = await saveCheckpoint(root, { name: 'keep me' });
  for (let i = 0; i < KEEP + 2; i++) { writeFileSync(join(root, 'scenes', 'a.html'), `v${i}`); await saveCheckpoint(root, { why: { kind: 'after' } }); }
  const list = await listCheckpoints(root);
  assert.equal(list.filter(c => !c.name).length, KEEP);
  assert.ok(list.some(c => c.id === named.id));
  // A1 (in the named one), project.json, and the KEEP versions still held; v0 and v1 are gone
  assert.equal(readdirSync(join(historyDir(root), 'objects')).length, KEEP + 2);
});

test('history: motlab working keeps one before and after, and motlab history lists, saves and restores', () => {
  const root = project('p3'), cli = fileURLToPath(new URL('../bin/motlab.js', import.meta.url));
  // working also tells a running viewer, if there is one; the checkpoints come first either way
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  run('working', root, 'fix the title', '--note', '2');
  writeFileSync(join(root, 'scenes', 'a.html'), 'A2');
  run('working', root, '--done');
  const listed = run('history', root);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /after the agent worked\n {4}changed: scenes\/a\.html/);
  assert.match(listed.stdout, /before the agent worked: notes 2: fix the title\n {4}the first checkpoint, 2 files/);
  const id = listed.stdout.trim().split('\n').at(-2).split(' ')[0];
  const back = run('history', root, 'restore', id, '--file', 'scenes/a.html');
  assert.match(back.stdout, /Restored scenes\/a\.html/);
  assert.equal(read(root, 'scenes/a.html'), 'A1');
  assert.match(run('history', root, 'save', 'kept by hand').stdout, /Kept checkpoint .* \(kept by hand, 2 files\)/);
});

test('history: the viewer lists, keeps and restores checkpoints, and serves one read only for the compare', async () => {
  const root = project('p4'), port = 4197;
  const a = await saveCheckpoint(root, { name: 'first' });
  writeFileSync(join(root, 'scenes', 'a.html'), 'A2');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startEditor } from ${JSON.stringify(new URL('../src/editor.js', import.meta.url).href)}; startEditor(process.argv[1], ${port});`, root],
    { cwd: root, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  try {
    await new Promise((ok, no) => { let text = ''; child.stdout.on('data', d => { text += d; if (text.includes('in the menu:')) ok(); }); child.on('exit', c => no(new Error(`viewer exited ${c}`))); });
    const base = `http://127.0.0.1:${port}/p/${basename(root).toLowerCase()}/`;
    const list = await (await fetch(base + 'history')).json();
    assert.deepEqual(list.map(c => [c.name, c.differs]), [['first', ['scenes/a.html']]]);
    assert.equal((await fetch(base + 'history', { method: 'POST', body: '{"name":" "}' })).status, 400);
    assert.equal((await fetch(base + 'history', { method: 'POST', body: '{"name":"by hand"}' })).status, 200);
    // the checkpoint as it was, its page bare, and nothing that is not in it
    const page = await (await fetch(`${base}@${a.id}/?v=project.json`)).text();
    assert.match(page, new RegExp(`"at":"${a.id}"`));
    const scene = await fetch(`${base}@${a.id}/scenes/a.html`);
    assert.equal(await scene.text(), 'A1'); assert.match(scene.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}@${a.id}/selection.json`)).status, 404);
    assert.equal((await fetch(`${base}@nope/scenes/a.html`)).status, 404);
    // a write from another site is refused, as for every other write
    assert.equal((await fetch(base + 'history/restore', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ id: a.id }) })).status, 403);
    const r = await (await fetch(base + 'history/restore', { method: 'POST', body: JSON.stringify({ id: a.id, file: 'scenes/a.html' }) })).json();
    assert.deepEqual(r.changed, ['scenes/a.html']);
    assert.equal(read(root, 'scenes/a.html'), 'A1');
  } finally {
    const exited = new Promise(ok => child.once('exit', ok));
    child.kill(); await exited;
  }
});
