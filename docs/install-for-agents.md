# Installing motlab (for an agent)

Follow these steps when a user asks you to install or update motlab. Ask before running any command that installs system software, and never install anything the user did not agree to.

## 1. Check what the machine has

```bash
node --version
ffmpeg -version
ffprobe -version
```

Node must be 24 or newer. If Node is missing or older, tell the user and give them the command from the table in [install.md](install.md#requirements) for their OS. Do the same for Chrome and ffmpeg. Do not continue until Node 24 is there; Chrome and ffmpeg can be fixed after the install, because `motlab doctor` reports them again.

## 2. npm or a clone

Ask which they want. npm is simpler for using motlab; a clone is for working on it.

With npm, pick the skill target as in step 3, then:

```bash
npm install -g @motlab/cli
npx @motlab/cli setup --skill <target> --dry-run
npx @motlab/cli setup --skill <target>
```

Setup takes the same skill options as the installer and runs `motlab doctor` at the end. When npm's command folder is not on PATH (nvm for Windows), it writes a `motlab` launcher to `~/.local/bin`; if it then prints that `~/.local/bin` is not on PATH, show the user the line and ask before changing their PATH. To update later, `motlab update` prints the two commands (`npm install -g @motlab/cli@latest`, then `motlab setup --update`). Then skip to step 4.

## Get the repository

For a clone: if the user has none yet, ask where it should live (a folder they keep, not a temporary one, because the `motlab` command runs from it):

```bash
git clone https://github.com/staryone/motlab.git <folder>
```

If they already have a clone and only want the newest version, run `motlab update` and skip to step 4: it pulls, runs `npm ci` and copies the skills again to every agent folder they were installed in. If it stops because the clone has local changes or commits of its own, show the user its message and ask what to do; do not stash, reset or discard anything yourself.

## 3. Run the installer

Pick the skill target for the agent you are, from the table in [install.md](install.md#with-the-installer): `claude` for Claude Code, `agents` for Codex, Cursor, OpenCode, GitHub Copilot, Gemini CLI, Amp, Windsurf and Muse Code, `antigravity` for the Antigravity App and CLI, `hermes` for Hermes Agent. If the user also works in other agents, ask which, and join the targets with commas. For an agent not in the table, look up its user skill folder in its own docs and pass `--skill-dir <folder>` instead. Run a dry run first and show the user where files will go:

```bash
node install.js --skill <target> --dry-run
node install.js --skill <target>
```

Use `--link` only when the user works on the skill itself. If the installer refuses because a folder without `SKILL.md` is at a skill path, ask the user what to do with it; pass `--force` only when they say so.

If the installer prints that `~/.local/bin` is not on PATH, show the user the line it printed and ask before changing their shell profile or Windows user PATH. Until it is on PATH, call the engine as `node <folder>/bin/motlab.js`.

## 4. Verify

```bash
motlab doctor
motlab --help
```

`doctor` must end with `Ready.` (warnings about Python are fine if the user does not need the skill's scripts). `motlab --help` prints the engine folder; it must be the clone from step 2, or the folder in npm's global `node_modules` for an npm install. If it is another folder, an older launcher comes first on PATH; tell the user which one.

Python packages for the skill's scripts, if the user wants them:

```bash
python -m pip install -r <folder>/skills/motlab/requirements.txt
```

## 5. Tell the user

Say in a few lines what was installed and where (the clone and the launcher, or the npm package, and the two skill folders), what `doctor` still reports, and how to start: `motlab edit <folder>/example` opens the example in the viewer (it starts the viewer in the background) and prints the address, `http://127.0.0.1:4173/p/example/`; `motlab stop` ends it. A new agent session may be needed before the skills show up.

## Do not

- create video projects inside the clone, the npm package or the installed skill folder; a project lives in its own folder
- delete or overwrite a folder you did not create
- render a user's project unless they ask for it; the user exports from the viewer
