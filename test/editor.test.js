import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

const editor = new URL('../src/editor.js', import.meta.url).href;

for (const target of ['', 'project.json', 'project-alt.json']) test(`editor URLs preserve ${target || 'a folder'}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-editor-'));
  for (const file of ['project.json', 'project-alt.json', 'project-a & b.json']) writeFileSync(join(dir, file), JSON.stringify({ scenes: [] }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startEditor } from ${JSON.stringify(editor)}; startEditor(process.argv[1], 4199);`, join(dir, target)], { cwd: dir, env: { ...process.env, HOME: dir } });
  try {
    const output = await new Promise((ok, no) => {
      let text = '';
      child.stdout.on('data', d => { text += d; if (text.includes('in the menu:')) ok(text); });
      child.on('error', no);
      child.on('exit', code => no(new Error(`editor exited: ${code}`)));
    });
    const base = 'http://127.0.0.1:4199', path = `/p/${basename(dir).toLowerCase()}/`;
    const expected = path + (target === 'project-alt.json' ? '?v=project-alt.json' : '');
    assert.ok(output.includes(base + expected + '  ('), output);
    assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), expected);
    for (const file of ['', 'project.json', 'project-alt.json', 'project-a & b.json', 'project.json']) {
      const r = await fetch(base + '/open', { method: 'POST', body: JSON.stringify({ file: join(dir, file) }) });
      const url = path + (file && file !== 'project.json' ? `?v=${encodeURIComponent(file)}` : '');
      assert.equal((await r.json()).url, url);
    }
    assert.equal((await fetch(base + '/open', { method: 'POST', body: '{}' })).status, 400);
  } finally {
    const exited = new Promise(ok => child.once('exit', ok));
    child.kill(); await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
