import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Other agents check a skill's frontmatter and skip it without a word when it is off: the Agent Skills spec wants a
// lowercase name that matches the folder and a description of at most 1024 characters, and Codex's docs say 500.
test('every skill has frontmatter that Codex, Cursor and the others accept', () => {
  for (const dir of readdirSync('skills')) {
    const head = readFileSync(join('skills', dir, 'SKILL.md'), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(head, `${dir}: no frontmatter`);
    const field = k => head.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1];
    assert.equal(field('name'), dir, `${dir}: name must match the folder`);
    assert.match(dir, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    // A strict YAML parser, such as the one in the skills CLI behind skills.sh, skips the whole skill when a plain
    // value holds ": " or " #", so a description with those has to be in double quotes, with no " inside.
    for (const line of head.split(/\r?\n/)) {
      const v = line.match(/^[a-z-]+: (.*)$/)?.[1];
      if (v && !/^".*"$/.test(v)) assert.ok(!/: | #/.test(v), `${dir}: put "${line.slice(0, 40)}..." in double quotes`);
      if (v && /^".*"$/.test(v)) assert.ok(!/[^\\]"/.test(v.slice(1, -1)), `${dir}: a quoted value has a " inside`);
    }
    const d = (field('description') || '').replace(/^"(.*)"$/, '$1');
    assert.ok(d.length > 0 && Buffer.byteLength(d) <= 500, `${dir}: description is ${Buffer.byteLength(d)} bytes, keep it at 500 or less`);
  }
});
