# Releasing Kin

A Kin release is a commit on `kin` that runs on the host. The release check runs every Kin check we have on this Mac and compares the result with the last release, so only new findings need a decision. Deploying stays a manual step.

## Steps

1. On a clean checkout of the commit you want to ship: `KIN_RELEASE_CHECK_DIR=~/code/kin-lane-a/release-check BOMBADIL=<path to bombadil> node scripts/kin-release-check.ts --full`. Use `--quick` (under 10 minutes) for a small fix.
2. Read `summary.md` or `report.html` in the folder it prints. NEW findings block the release. STILL PRESENT ones were already there at the last release. FIXED ones are gone.
3. Deploy the commit you checked: `ssh` to the host, then `sudo -iu kin ~/t3code/ops/kin/host/update.sh <commit>`; `summary.md` ends with the line when the check passed. It builds that commit even if `kin` has moved on, so a merge after the check doesn't ship unchecked. It backs up the database, switches, checks health, and rolls back by itself. A non-zero exit means the host is on the previous build again. Its last lines say why. The first deploy that brings the Kin name and its check needs the host's clone fast-forwarded first: see [Update](../../ops/kin/host/README.md#update).
4. Mark it: `node scripts/kin-release-check.ts --mark-released <commit>`, then commit `ops/kin/releases.json` to `kin`.

## The release check

| Stage        | Runs                                                                                                | Mode  |
| ------------ | --------------------------------------------------------------------------------------------------- | ----- |
| `static`     | `vp run check:changed <last release>`, including the Kin rules in `docs/kin/RULES.md`               | quick |
| `models`     | `node scripts/kin-model.ts`, skipping models `static`'s `check:changed` already ran                 | quick |
| `properties` | the `*.property.test.ts` files beside Kin's pure rules                                              | quick |
| `lifecycle`  | every verify-kin lifecycle script (`run-all.sh --list`), shared across parallel instances           | quick |
| `migrate`    | the last release's company database, started on this build, then `doctor` and two lifecycle scripts | full  |
| `ui-fuzz`    | Bombadil as owner, co-owner, lead and member, 2 minutes each (`--fuzz-time`)                        | full  |
| `lookbook`   | the [look book](kin-lookbook.md) captured and compared with the owner's accepted set                | full  |

- Every failure becomes a finding with a fingerprint built from the stage, check, step, role and normalised message, so the same failure matches across runs. `findings.json` holds them.
- By default a run is compared with the last release in `ops/kin/releases.json`. `--against <commit|findings.json>` picks another. A finding that is not in the baseline is NEW.
- The exit is non-zero on any finding from a deterministic stage, and on a NEW fuzz finding. A deterministic failure stops the later stages unless you pass `--keep-going`. `--only <stage,…>` runs a subset.
- `lookbook` makes each changed, new, missing or uncaptured screen a finding, so a release with a screen the owner hasn't seen fails until he accepts the set (`kin-lookbook accept`). It compares with `~/.kin-lookbook/accepted` (or `$KIN_LOOKBOOK_ACCEPTED`) and skips, saying so, on a machine that has none.
- No model is called. Provider CLIs are stubbed on `PATH` for every stage, and the fuzz runner fails if any agent turn produced a token.
- `lifecycle` splits the scripts across `--lifecycle-workers N` instances (default: a third of the cores, at most 4), each taking the next script left. A script that needs another's state lives in that script, so order across workers doesn't matter.
- A `--full` run keeps `<dir>/<commit>/fixture`, the first lifecycle instance's company after its share of the scripts (all of them with `--lifecycle-workers 1`). The next release's `migrate` stage starts the new build on a copy of it. If the last release has no fixture, `migrate` is skipped and says so. Fuzz traces are deleted after summarising, unless you pass `--keep-traces`.

## What update.sh does on the host

Only after the build passes does it stop `kin-server` and take a `sqlite3 .backup` of `~/.t3/userdata/statev2.sqlite` into `~/kin-update-backups` (or `$KIN_UPDATE_BACKUPS`). It keeps the 10 newest (3 while the nightly backup last succeeded within 36 hours) and never touches files it didn't name. It refuses to start when a disk it writes to lacks room for that copy, twice the database and 1 GiB to spare. Then it switches `~/kin-current` and starts the server. The build is healthy when the service is up with no restarts, the server answers on its port, and the database's T3 and Kin migrations have reached the build's highest. If any of those fails, it switches back to the previous build. If the failed build had already migrated the database, it also restores the backup. The migrated copy stays beside it as `statev2.sqlite.failed-<sha>`. The restore copies the backup beside the database and checks it before renaming it into place. If that fails, it starts nothing: `kin-server` stays stopped with its data intact, and the last line names the backup, where the migrated copy is, and the command that finishes the restore. A failure after the stop but before the new build starts puts back the previous env file, units and link and starts the previous build. It keeps the 3 newest builds, about 7 GB each. `scripts/kin-update.test.ts` runs these paths against a fake host.

A host backup, this one or the nightly one, holds everything, every person's own mail cards and the connection keys included, and is for the operator only.

## Running it on a second machine

A full check takes over an hour on a laptop. A faster machine you can reach over ssh can run it instead. This is optional: when that machine is off, asleep, busy with another run, or can't fetch the commit, the check runs on this one, and the result is the same either way.

1. On the second machine: a clone of this repo with `vp i`, Java 21, `fd`, `rg` and `lsof` on `PATH`, Chromium for Playwright (`node <playwright-core>/cli.js install --with-deps chromium` from `scripts/`), and Bombadil with `BOMBADIL` pointing at it. Run it as a normal user: as root, the server tests that expect a permission error fail, so `static` reports findings this machine wouldn't. `KIN_VERIFY_HEADLESS=1` keeps browser windows off its screen.
2. Give it a command that sets that environment and runs `bash <clone>/scripts/kin-release-remote.sh "$@"`.
3. Here, set `KIN_RELEASE_REMOTE` to the ssh host (an alias in your `~/.ssh/config`) and `KIN_RELEASE_REMOTE_COMMAND` to that command. The commit must be pushed. Pass `--here` to run locally anyway.

The findings, summary and (on `--full`) the new fixture come back into the usual folder here, with the full output in `remote.log`. A `--full` run sends the last release's fixture there first, so `migrate` checks the same thing on either machine. No credentials go to the second machine: no stage needs one.

## Pictures on the host

Kin draws each picture in a browser held in a user systemd scope (1 GB of memory, 256 tasks) where the host has one. A host without a user scope, such as a container, draws without it and relies on the container's own memory limit.
