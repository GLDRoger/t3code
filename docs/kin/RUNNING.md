# Running Kin

Kin is this repo's `kin` branch. The command is `kin`. `t3 kin` is the same command.

## Mac

Install Node `26.12.1`. The repo refuses other versions. [nvm](https://github.com/nvm-sh/nvm) is the straightforward way:

```sh
nvm install 26.12.1
nvm use 26.12.1
node -v   # v26.12.1
```

Install `vp` (Vite+) once, on that Node:

```sh
npm i -g vite-plus@1.4.0
vp --version
```

`vp` is the package manager and the task runner. It brings its own pnpm. Do not use a different Node for `vp` commands. Node 22 fails the oxlint `node:sea` bundle.

## First checkout

```sh
git clone https://github.com/GLDRoger/t3code.git
cd t3code
git switch kin
vp i
```

`vp i` installs the workspace. Run it again after a pull that changes dependencies.

## App

From the repo root:

```sh
vp run dev
```

That starts the server and the web app. Read the `[dev-runner]` line for the real ports. Open the printed pairing URL once (`http://localhost:<port>/pair#token=...`) so the browser can talk to the server.

Desktop:

```sh
vp run dev:desktop
```

The desktop app bundles the same server. State lives under the worktree's `.t3` directory, not your everyday `~/.t3`, unless you pass `--home-dir`.

## Kin files

Initialize a project you want Kin to work in:

```sh
kin init
# or, from a checkout that has not installed the kin shim yet:
node apps/server/src/bin.ts kin init --root .
```

`kin init` writes `CLAUDE.md` as `@AGENTS.md` when that file is missing, `.kin/owner-rules.md`, and house maps under `docs/agent-maps/`. It leaves an existing `AGENTS.md` alone.

Profiles:

- Project: `.kin/agents/<name>.md`
- You: `~/.kin/agents/<name>.md`
- Model preferences: `~/.kin/md/models.md`

The main agent reads `models.md` when it picks a child's model. Routing & Budget in Settings shows the hard caps: 20 active children on a main thread, and a lower cap per plan.

Other commands, also available as `t3 kin …`:

```sh
kin verify
kin chaos run --tier smoke --seed 1 --commit HEAD
kin sweep --dir ~/.kin/reliability
```

Live chaos canary and weekly runs stay off unless you set `KIN_CHAOS=1` and `KIN_CHAOS_LIVE=1` in a process that is not production. `KIN_CHAOS_SEAM` picks which adapter seam is faulted (`provider.stream` or `tool.json`). With the flag unset, those seams do nothing.

Provider processes receive the lane name in `KIN_LANE_LABEL`. `EEVEE_LANE_LABEL` is set to the same value.
