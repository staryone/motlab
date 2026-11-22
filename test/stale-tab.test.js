import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { mergeNotes } from '../src/editor.js';

const html = readFileSync(new URL('../src/editor.html', import.meta.url), 'utf8');
const saving = html.slice(html.indexOf('  let saveTimer ='), html.indexOf('  function sync(file, other)'));

test('focus sync preserves a note while its save is in flight', async () => {
  const m = { id: 'a', n: 1, note: 'parallel edit A' };
  let acknowledge;
  const context = {
    PROJECT: 'project.json',
    notes: [m], active: m, popText: { value: m.note }, others: [],
    sel: { time: 0 }, range: null, rangeOut: r => r, images: new Map(), crypto: {},
    clearTimeout() {}, setTimeout() { return 1; },
    paint() {}, listNotes() {}, drawTimeline() {}, grow() {}, doneUI() {},
    fetch: (_url, options) => {
      const payload = JSON.parse(options.body);
      return new Promise(resolve => acknowledge = () => resolve({
        ok: true, json: async () => ({ marks: payload.marks, others: [], renumbered: [] }),
      }));
    },
  };
  const code = html.slice(html.indexOf('  let saveTimer ='), html.indexOf('  const reread ='));
  const sent = runInNewContext(`${code}\nknown.add('a'); save(notes[0]); flush()`, context);
  await Promise.resolve();
  try {
    runInNewContext("sync([{id:'a',n:1,note:'old text'}], [])", context);
    assert.equal(m.note, 'parallel edit A');
    assert.equal(context.popText.value, 'parallel edit A');
    runInNewContext('sync([], [])', context);
    assert.equal(context.notes.length, 1);
  } finally {
    acknowledge();
    await sent;
  }
  assert.equal(m.note, 'parallel edit A');
  runInNewContext("sync([{id:'a',n:1,note:'later remote edit'}], [])", context);
  assert.equal(m.note, 'later remote edit');
});

test('overlapping saves keep newer text until both writes are acknowledged', async () => {
  const requests = [], pending = [];
  const m = { id: 'a', n: 1, note: 'first edit' };
  const context = {
    PROJECT: 'project.json',
    notes: [m], active: m, popText: { value: m.note }, others: [],
    sel: { time: 0 }, range: null, rangeOut: r => r, images: new Map(), crypto: {},
    clearTimeout() {}, setTimeout() { return 1; },
    paint() {}, listNotes() {}, drawTimeline() {}, grow() {}, doneUI() {},
    fetch: (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return new Promise(resolve => pending.push(() => resolve({
        ok: true, json: async () => ({ marks: payload.marks, others: [], renumbered: [] }),
      })));
    },
  };
  const code = html.slice(html.indexOf('  let saveTimer ='), html.indexOf('  const reread ='));
  const first = runInNewContext(`${code}\nsave(notes[0]); flush()`, context);
  await Promise.resolve();
  m.note = context.popText.value = 'second edit';
  const second = runInNewContext('save(notes[0]); flush()', context);
  pending.shift()();
  await first;
  await new Promise(setImmediate);
  try {
    assert.equal(m.note, 'second edit');
    assert.equal(context.popText.value, 'second edit');
    assert.equal(requests[1].marks[0].note, 'second edit');
  } finally {
    pending.shift()();
    await second;
  }
  assert.equal(m.note, 'second edit');
  assert.equal(context.popText.value, 'second edit');
  assert.equal(await runInNewContext('flush().then(() => "settled")', context), 'settled');
  assert.equal(requests.length, 2);
});

test('only edited notes are sent, and failed writes retain notes and pictures for retry', async () => {
  const payloads = [];
  let fail = true;
  const context = {
    PROJECT: 'project.json',
    notes: [{ id: 'a', n: 1, note: 'edited' }, { id: 'b', n: 2, note: 'unchanged' }],
    sel: { time: 3 }, range: null, rangeOut: r => r, images: new Map([[1, 'data:image/png;base64,eA==']]),
    crypto: {}, clearTimeout() {}, setTimeout() { return 1; }, sync() {},
    fetch: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: !fail, status: 500, json: async () => ({ renumbered: [], marks: [], others: [] }) };
    },
  };
  await runInNewContext(`${saving}\nsave(notes[0]); send()`, context);
  fail = false;
  await runInNewContext('send()', context);
  await runInNewContext('send()', context);
  assert.deepEqual(payloads[0].marks, [context.notes[0]]);
  assert.deepEqual(payloads[1].marks, payloads[0].marks);
  assert.deepEqual(payloads[1].images, payloads[0].images);
  assert.deepEqual(payloads[2].marks, []);
});

test('sync reads remote edits but preserves unsaved local edits', () => {
  const context = {
    notes: [{ id: 'a', n: 1, note: 'old' }, { id: 'b', n: 2, note: 'local' }],
    images: new Map(), crypto: {}, clearTimeout() {}, setTimeout() { return 1; },
    active: null, others: [], paint() {}, listNotes() {}, drawTimeline() {},
  };
  const code = html.slice(html.indexOf('  let saveTimer ='), html.indexOf('  const reread ='));
  runInNewContext(`${code}\nsave(notes[1]); sync([{id:'a',n:1,note:'remote'}, {id:'b',n:2,note:'remote'}], []);`, context);
  assert.equal(context.notes[0].note, 'remote');
  assert.equal(context.notes[1].note, 'local');
});

test('an older tab seeking saves no stale notes over another tab’s edit', async () => {
  const project = 'project.json';
  const stale = { id: 'a', n: 1, note: 'original', project };
  let file = [stale];
  const tabA = structuredClone(file);
  file = mergeNotes(file, { marks: [{ ...stale, note: 'edited in tab B' }] }, project).all;
  let payload;
  await runInNewContext(`${saving}\nsend()`, {
    PROJECT: project,
    notes: tabA, sel: { time: 2 }, range: null, rangeOut: r => r,
    images: new Map(), crypto: {}, clearTimeout, setTimeout,
    sync() {},
    fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      file = mergeNotes(file, payload, project).all;
      return { ok: true, json: async () => ({ marks: file, others: [], renumbered: [] }) };
    },
  });
  assert.equal(file[0].note, 'edited in tab B');
  assert.equal(payload.time, 2);
  assert.deepEqual(payload.marks, []);
});
