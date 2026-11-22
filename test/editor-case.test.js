import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('case-distinct project folders have separate slugs and serve their own files', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-editor-'));
  let child;
  try {
    const workspace = join(dir, 'workspace'), home = join(dir, 'home');
    mkdirSync(workspace); mkdirSync(home);
    mkdirSync(join(workspace, 'demo'));
    if (existsSync(join(workspace, 'Demo'))) return t.skip('requires a case-sensitive filesystem');
    mkdirSync(join(workspace, 'Demo'));
    for (const name of ['demo', 'Demo']) writeFileSync(join(workspace, name, 'project.json'), JSON.stringify({ name, scenes: [] }));
    const editor = new URL('../src/editor.js', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      import { startEditor } from ${JSON.stringify(editor)};
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => startEditor(undefined, port));
      });
    `], { cwd: workspace, env: { ...process.env, HOME: home, USERPROFILE: home, MOTLAB_VIEWER_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((ok, no) => {
      let output = '';
      child.stdout.on('data', d => { output += d; const m = /Editor: (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (m) ok(m[1]); });
      child.stderr.on('data', d => output += d);
      child.once('error', no);
      child.once('exit', code => no(new Error(`editor exited ${code}: ${output}`)));
    });
    const { projects } = await fetch(`${base}/projects`).then(r => r.json());
    assert.equal(projects.length, 2);
    assert.deepEqual(projects.map(p => p.slug).sort(), ['demo', 'demo-2']);
    for (const p of projects) {
      const page = await fetch(`${base}/p/${p.slug}/`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes(`<title>${p.name}`));
      assert.deepEqual(await fetch(`${base}/p/${p.slug}/project.json`).then(r => r.json()), { name: p.name, scenes: [] });
      const opened = await fetch(`${base}/open`, { method: 'POST', body: JSON.stringify({ file: join(workspace, p.name) }) }).then(r => r.json());
      assert.equal(opened.url, `/p/${p.slug}/`);
    }
    assert.equal((await fetch(`${base}/projects`).then(r => r.json())).projects.length, 2);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  }
});
