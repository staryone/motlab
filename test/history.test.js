import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEEP, historyDir, historyOn, listCheckpoints, restoreCheckpoint, saveCheckpoint, setHistoryOn } from '../src/history.js';

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
const write = (root, f, text) => writeFileSync(join(root, f), text);

test('history: checkpoints keep the project files once each, skip a round that changed nothing, and restore all or one file', async () => {
  const root = project('p1');
  const a = await saveCheckpoint(root, { auto: true, why: { kind: 'before', notes: [3] } });
  assert.deepEqual(Object.keys(a.files).sort(), ['project.json', 'scenes/a.html']);   // no render, no selection.json
  assert.equal(await saveCheckpoint(root, { auto: true, why: { kind: 'after' } }), null);   // nothing changed
  write(root, 'scenes/a.html', 'A2'); write(root, 'scenes/b.html', 'B');
  const b = await saveCheckpoint(root, { auto: true, why: { kind: 'after', notes: [3] } });
  assert.equal(readdirSync(join(historyDir(root), 'objects')).length, 4);              // project.json, A1, A2, B

  const list = await listCheckpoints(root);
  assert.deepEqual(list.map(c => c.id), [b.id, a.id]);
  assert.deepEqual(list[0].changed, ['scenes/a.html', 'scenes/b.html']);
  assert.ok(list[1].first);
  assert.deepEqual(list[1].differs, ['scenes/a.html', 'scenes/b.html']);
  assert.deepEqual(list[0].differs, []);

  // one file back: only it changes, and a checkpoint of how it was is the way back
  write(root, 'scenes/b.html', 'B2');
  const one = await restoreCheckpoint(root, a.id, { file: 'scenes/a.html' });
  assert.deepEqual(one.changed, ['scenes/a.html']);
  assert.equal(read(root, 'scenes/a.html'), 'A1'); assert.equal(read(root, 'scenes/b.html'), 'B2');
  // the whole version: b.html did not exist then, so it goes; renders and selection.json stay
  const all = await restoreCheckpoint(root, a.id);
  assert.deepEqual(all.changed, ['scenes/b.html']);
  assert.ok(!existsSync(join(root, 'scenes', 'b.html')));
  assert.equal(read(root, 'out/render.mp4'), 'not kept'); assert.equal(read(root, 'selection.json'), '{}');
  assert.deepEqual(await restoreCheckpoint(root, a.id), { changed: [], before: null });   // nothing to do
  await restoreCheckpoint(root, all.before);   // undone with the checkpoint kept before it
  assert.equal(read(root, 'scenes/b.html'), 'B2');
  await assert.rejects(restoreCheckpoint(root, 'nope'), /no checkpoint nope/);
});

test('history: turned off, the agent rounds keep nothing, and a restore still keeps how it was', async () => {
  const root = project('off');
  assert.equal(historyOn(root), true);
  const a = await saveCheckpoint(root, { auto: true, why: { kind: 'before' } });
  setHistoryOn(root, false);
  write(root, 'scenes/a.html', 'A2');
  assert.equal(await saveCheckpoint(root, { auto: true, why: { kind: 'after' } }), null);
  assert.equal((await listCheckpoints(root)).length, 1);
  const r = await restoreCheckpoint(root, a.id);   // the user asked for it: A2 is kept first, so it can be undone
  assert.deepEqual(r.changed, ['scenes/a.html']);
  assert.equal((await listCheckpoints(root)).length, 2);
  setHistoryOn(root, true);
  assert.equal(historyOn(root), true);
});

test('history: a restore of one version leaves the other versions and the files only they use alone', async () => {
  const root = project('versions');
  // project-tiktok.json shares a.html and lib.js, and has a scene of its own
  write(root, 'scenes/lib.js', 'L1'); write(root, 'scenes/t.html', 'T1');
  write(root, 'project-tiktok.json', JSON.stringify({ fps: 10, scenes: ['scenes/a.html', 'scenes/t.html'] }));
  const a = await saveCheckpoint(root, { auto: true, why: { kind: 'before' } });
  write(root, 'scenes/a.html', 'A2'); write(root, 'scenes/lib.js', 'L2'); write(root, 'scenes/t.html', 'T2');
  write(root, 'project-tiktok.json', JSON.stringify({ fps: 10, scenes: ['scenes/a.html', 'scenes/t.html', 'scenes/t2.html'] }));
  write(root, 'scenes/t2.html', 'NEW');
  // a version made after the checkpoint, with its own scene
  write(root, 'project-square.json', JSON.stringify({ fps: 10, scenes: ['scenes/sq.html'] })); write(root, 'scenes/sq.html', 'SQ');

  const main = (await listCheckpoints(root, { version: 'project.json' }))[0];
  assert.deepEqual(main.differs, ['scenes/a.html', 'scenes/lib.js']);   // what a restore of project.json would put back
  assert.equal((await listCheckpoints(root, { version: 'project-square.json' })).length, 0);   // it did not exist then
  const r = await restoreCheckpoint(root, a.id, { version: 'project.json' });
  assert.deepEqual(r.changed, ['scenes/a.html', 'scenes/lib.js']);   // shared files go back; tiktok's own stay
  assert.equal(read(root, 'scenes/t.html'), 'T2'); assert.equal(read(root, 'scenes/t2.html'), 'NEW');
  assert.match(read(root, 'project-tiktok.json'), /t2\.html/); assert.equal(read(root, 'scenes/sq.html'), 'SQ');
  // the tiktok version puts back its own scene and project file, and deletes the scene it added since
  const t = await restoreCheckpoint(root, a.id, { version: 'project-tiktok.json' });
  assert.deepEqual(t.changed, ['project-tiktok.json', 'scenes/t.html', 'scenes/t2.html']);
  assert.ok(!existsSync(join(root, 'scenes', 't2.html')));
  assert.equal(read(root, 'scenes/sq.html'), 'SQ');   // the square version's scene is not tiktok's to delete
  await assert.rejects(restoreCheckpoint(root, a.id, { version: 'project-square.json' }), /project-square.json did not exist at checkpoint/);
  // a round on tiktok's own scene shows in its list, not in the main version's
  write(root, 'scenes/t.html', 'T3');
  const own = await saveCheckpoint(root, { auto: true, why: { kind: 'after', project: 'project-tiktok.json' } });
  assert.equal((await listCheckpoints(root, { version: 'project-tiktok.json' }))[0].id, own.id);
  assert.ok(!(await listCheckpoints(root, { version: 'project.json' })).some(c => c.id === own.id));
});

test('history: two writers at once take turns, so a change is kept once and no checkpoint is lost', async () => {
  const root = project('race');
  await saveCheckpoint(root, { auto: true });
  write(root, 'scenes/a.html', 'A2');
  const both = await Promise.all([saveCheckpoint(root, { auto: true }), saveCheckpoint(root, { auto: true })]);
  assert.equal(both.filter(Boolean).length, 1);
  assert.equal((await listCheckpoints(root)).length, 2);
  assert.ok(!existsSync(join(historyDir(root), 'lock')));
});

test(`history: the last ${KEEP} checkpoints stay, and stored files no checkpoint holds go once they are old`, async () => {
  const root = project('p2');
  for (let i = 0; i < KEEP + 2; i++) { write(root, 'scenes/a.html', `v${i}`); await saveCheckpoint(root, { auto: true }); }
  const list = await listCheckpoints(root);
  assert.equal(list.length, KEEP);
  // the stored files of the two dropped checkpoints are recent, so they stay until a later prune finds them old
  assert.equal(readdirSync(join(historyDir(root), 'objects')).length, KEEP + 3);
});

test('history: motlab working keeps one before and after, and motlab history lists, turns off and restores', () => {
  const root = project('p3'), cli = fileURLToPath(new URL('../bin/motlab.js', import.meta.url));
  // working also tells a running viewer, if there is one; the checkpoints come first either way
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  run('working', root, 'fix the title', '--note', '2');
  write(root, 'scenes/a.html', 'A2');
  run('working', root, '--done');
  const listed = run('history', root);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /after the agent worked\n {4}changed: scenes\/a\.html/);
  assert.match(listed.stdout, /before the agent worked on notes 2\n {4}the first checkpoint, 2 files/);
  const id = listed.stdout.trim().split('\n').at(-2).split(' ')[0];
  assert.match(run('history', root, 'off').stdout, /History off/);
  write(root, 'scenes/a.html', 'A3');
  run('working', root, '--done');
  assert.match(run('history', root).stdout, /History is off/);
  assert.equal(run('history', root).stdout.match(/the agent worked/g).length, 2);
  const back = run('history', root, 'restore', id, '--file', 'scenes/a.html');
  assert.match(back.stdout, /Restored scenes\/a\.html/);
  assert.equal(read(root, 'scenes/a.html'), 'A1');
  assert.match(run('history', root, 'on').stdout, /History on/);
});

test('history: the viewer lists a version\'s checkpoints, switches the history, restores, and serves one read only', async () => {
  const root = project('p4'), port = 4197;
  const a = await saveCheckpoint(root, { auto: true });
  write(root, 'scenes/a.html', 'A2');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startEditor } from ${JSON.stringify(new URL('../src/editor.js', import.meta.url).href)}; startEditor(process.argv[1], ${port});`, root],
    { cwd: root, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  try {
    await new Promise((ok, no) => { let text = ''; child.stdout.on('data', d => { text += d; if (text.includes('in the menu:')) ok(); }); child.on('exit', c => no(new Error(`viewer exited ${c}`))); });
    const base = `http://127.0.0.1:${port}/p/${basename(root).toLowerCase()}/`;
    const list = await (await fetch(base + 'history?v=project.json')).json();
    assert.equal(list.on, true);
    assert.deepEqual(list.checkpoints.map(c => c.differs), [['scenes/a.html']]);
    assert.deepEqual(await (await fetch(base + 'history/on', { method: 'POST', body: '{"on":false}' })).json(), { on: false });
    assert.equal(historyOn(root), false);
    await fetch(base + 'history/on', { method: 'POST', body: '{"on":true}' });
    // the checkpoint as it was, its page bare, and nothing that is not in it
    const page = await (await fetch(`${base}@${a.id}/?v=project.json`)).text();
    assert.match(page, new RegExp(`"at":"${a.id}"`));
    const scene = await fetch(`${base}@${a.id}/scenes/a.html`);
    assert.equal(await scene.text(), 'A1'); assert.match(scene.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}@${a.id}/selection.json`)).status, 404);
    assert.equal((await fetch(`${base}@nope/scenes/a.html`)).status, 404);
    // a write from another site is refused, as for every other write
    assert.equal((await fetch(base + 'history/restore', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ id: a.id }) })).status, 403);
    const r = await (await fetch(base + 'history/restore', { method: 'POST', body: JSON.stringify({ id: a.id, project: 'project.json', file: 'scenes/a.html' }) })).json();
    assert.deepEqual(r.changed, ['scenes/a.html']);
    assert.equal(read(root, 'scenes/a.html'), 'A1');
  } finally {
    const exited = new Promise(ok => child.once('exit', ok));
    child.kill(); await exited;
  }
});
