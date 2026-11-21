import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { mergeNotes } from '../src/editor.js';

const html = readFileSync(new URL('../src/editor.html', import.meta.url), 'utf8');
const saving = html.slice(html.indexOf('  let saveTimer ='), html.indexOf('  function sync(file, other)'));

test('only edited notes are sent, and failed writes retain notes and pictures for retry', async () => {
  const payloads = [];
  let fail = true;
  const context = {
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
