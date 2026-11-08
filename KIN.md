# Kin

`kin` is the trunk for Kin: a team of AI leads in messaging-style chats, built on this fork of [T3 Code](https://github.com/pingdotgg/t3code). New to Kin? Start with the [handover brief](docs/kin/KT.md). The design is in [docs/kin/DESIGN.md](docs/kin/DESIGN.md), the phase 1 plan in [docs/kin/PLAN.md](docs/kin/PLAN.md) and the specs in [docs/kin/specs/](docs/kin/specs/). The earlier lineages design and code are kept at the tag `archive/kin-lineages-2026-11-07`.

- `main` mirrors upstream `pingdotgg/t3code` and only fast-forwards. Never commit to it.
- Kin work lands on `kin`.
- Put Kin code in its own files (`packages/contracts/src/kinChat.ts`, `apps/server/src/kin/`, `apps/mobile/src/features/chats/`, `apps/web/src/kin/`). Touch shared upstream files only with the smallest hook you can, such as one line in a layer list or a route map.
- **Never rename in source.** The code keeps upstream's names, so merges never conflict over branding. Kin's name, icons and app identities are applied at build time (below).

## Branding at build time

`scripts/kin-brand.ts` turns a checkout into Kin inside the build, on a copy. Its output is never committed. Run `node scripts/kin-brand.ts` to write the copy to `../<checkout>-kin` (or `--target <dir>` outside the checkout), and add `--check` before shipping a build. The copy holds the tracked files plus the uncommitted branding files.

- **It changes only what's listed** in `branding/rules.yaml`. Upstream has about 800 uses of "T3 Code" across 370 files, and some must not change: the Codex `clientInfo`, MCP server ids, `T3CODE_*` environment variables, `@t3tools/*` package names, storage keys, and agent instructions. So the list says what to change, not what to skip.
- **Text** is replaced in string, template, regex and JSX text, found with `ast-grep`. Strings that are code are never touched: import, `require`, `require.resolve`, `import.meta.resolve` and `new URL(_, import.meta.url)` paths, type literals, object keys, member names, subscripts. Text that empties a JSX element removes the element, so a `gap-*` row keeps no empty item. In files it can't parse (Kotlin, Swift, shell, XML), a quoted string on one line is a literal. Tests are skipped.
- **Assets:** files in `branding/assets/` are copied over upstream's (app icons, the wordmarks, the Linux metainfo, the web favicon). A copied source file, such as a wordmark `.tsx`, has its upstream sha256 in `sourceAssets` in the rules, and the run fails once upstream changes that file, so the copy gets reviewed against the change. Files in `remove` are left out of the copy, such as the `.well-known` app-link files, so a server running Kin claims no app.
- **App identities** get new values so Kin installs and runs alongside T3 Code without sharing anything: bundle ids and URL schemes, the schemes the server, pairing and sign-in links accept, the desktop app id and data folders, the boot service, and the data home, `~/.kin` instead of `~/.t3`. A `T3CODE_HOME` set in the shell still overrides the data home, so don't export one that points at `~/.t3`.
- **No T3 releases.** Kin publishes none yet, so the copy's `t3 update`, `t3 service install` and `t3 up` (which installs the service) stop with "Kin doesn't publish releases yet; run Kin from source." (`scripts/lib/kinBrandGuards.ts`). SSH remote launch still downloads T3's published `t3` to run on the remote host, but on Kin's own `~/.kin` home, state and runtime folder there, so it never adopts or restarts a T3 Code server on that host. The settings row that links to T3 Code's mobile app is hidden.
- **Mobile accounts:** the branded `apps/mobile/app.config.ts` drops T3's Apple team, EAS project and OTA updates, Expo owner, and Clerk and `app.t3.codes` links. Mobile passkey sign-in (Clerk `relyingParty`) is off until Kin has its own domain. Set `KIN_APPLE_TEAM_ID`, `KIN_EAS_PROJECT_ID` and `KIN_EXPO_OWNER` for a store or OTA build; `--check` warns about each one that is unset.
- **Shared with T3 Code on purpose:**
  - Managed policy: Kin reads T3 Code's macOS policy plist (`com.t3tools.t3code`) and Windows policy key, so admin policy for T3 Code also governs Kin.
  - Telemetry is off by default: upstream's default PostHog key and host are T3's project. Set `T3CODE_TELEMETRY_ENABLED=true` with Kin's own `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST` to turn it on.
  - The GNOME Shell SnapShots extension is installed under upstream's uuid, so the two apps share it. It answers only T3 Code's D-Bus names, so expect GNOME snapshots from Kin to fail with "Only T3 Code may request a snapshot."
  - Hosted links: Kin has no hosted web app, so copied thread links, hosted pairing and prompt links use `app.t3.codes`, T3's static client, which talks to the Kin server straight from the browser. Set `T3CODE_HOSTED_APP_URL` and `VITE_HOSTED_APP_URL` once Kin has its own. Provider sign-in never returns to `app.t3.codes`.
- **The run fails** when a rule, `remove` entry or guard matches nothing, an asset has no upstream file to replace, or the copy still has T3's identity (`t3code://`, `com.t3tools.t3code`, a `~/.t3` home, T3's Apple, Expo or Clerk ids, `app.t3.codes`) that `leaks.allow` in the rules doesn't excuse with a reason.
- **`--check` also** fails on upstream identity text missing from `branding/drift-baseline.txt`, so an upstream sync shows only what's new. A second identical literal in a file counts as new. Brand it, ignore it, or accept it with `--update-drift-baseline`. Then it installs and typechecks the copy.
- If upstream ever adds a central place for the app's name and assets, use it instead and shrink this script to a config file.

## CI on the fork

Upstream's CI runs on Blacksmith runners that only `pingdotgg` has, so on this fork those jobs would wait forever. Kin changes two things:

- `ci.yml` and `mobile-fingerprint-check.yml` run on GitHub-hosted runners instead (`ubuntu-24.04`, `macos-26`). They're free for public repos. If a merge from upstream conflicts on a `runs-on:` line, keep the GitHub-hosted one; the `sed` in the sync steps below puts back any that upstream re-adds.
- Workflows that only make sense for upstream (releases, deploys, preview builds, AUR, the contributor vouch list, issue triage, Windows tests) are turned off in the fork's Actions settings, not deleted, so the files still merge cleanly. Turn one back on with `gh workflow enable <file> --repo GLDRoger/t3code`.

Test Web has a 20-minute timeout for slower GitHub-hosted runners; keep that headroom when syncing upstream.

No upstream secrets exist here. CI's task cache token is optional, so CI runs without it, just slower.

## Syncing upstream

Sync often; a few days of upstream merges in minutes.

```sh
git switch kin
git fetch upstream
git branch -f main upstream/main
git merge upstream/main
sed -i.bak -E 's/runs-on: blacksmith-[0-9]+vcpu-ubuntu-2404/runs-on: ubuntu-24.04/; s/runs-on: blacksmith-[0-9]+vcpu-macos-26/runs-on: macos-26/' .github/workflows/ci.yml .github/workflows/mobile-fingerprint-check.yml && rm .github/workflows/*.bak
vp i
vp run check:changed upstream/main
(cd apps/server && vp test run kin-contract)
git push origin main kin
```
