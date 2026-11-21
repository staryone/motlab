import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The skills CLI (`npx skills add -g`, the one behind skills.sh) lists every skill it installed for the whole machine
// in one lock file: $XDG_STATE_HOME/skills/.skill-lock.json, else ~/.agents/.skill-lock.json (skills 1.9.0, read from
// its source). A motlab skill listed there is that CLI's to update and remove, so install.js and uninstall leave it.
export function skillsCliSkills({ env = process.env, home = homedir() } = {}) {
  const file = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : join(home, '.agents', '.skill-lock.json');
  try { return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).skills || {})); } catch { return new Set(); }
}
