# Kin

`kin` is the trunk for Kin: a team of AI leads in messaging-style chats, built on this fork of [T3 Code](https://github.com/pingdotgg/t3code). New to Kin? Start with the [handover brief](docs/kin/KT.md). The design is in [docs/kin/DESIGN.md](docs/kin/DESIGN.md), the phase 1 plan in [docs/kin/PLAN.md](docs/kin/PLAN.md) and the specs in [docs/kin/specs/](docs/kin/specs/). The earlier lineages design and code are kept at the tag `archive/kin-lineages-2026-11-07`.

- `main` mirrors upstream `pingdotgg/t3code` and only fast-forwards. Never commit to it.
- Kin work lands on `kin`.
- Put Kin code in its own files (`packages/contracts/src/kinChat.ts`, `apps/server/src/kin/`, `apps/mobile/src/features/chats/`, `apps/web/src/kin/`). Touch shared upstream files only with the smallest hook you can, such as one line in a layer list or a route map.
- **Never rename in source.** The code keeps upstream's names, so merges never conflict over branding. Kin's name, icons and app identities are applied at build time (below).

## Branding at build time

`scripts/kin-brand.ts` (planned) turns a checkout into Kin inside the build, on a copy. Its output is never committed.

- **It changes only what's listed** in `branding/rules.yaml`. Upstream has about 800 uses of "T3 Code" across 370 files, and some must not change: the Codex `clientInfo`, MCP server ids, `T3CODE_*` environment variables, `@t3tools/*` package names, storage keys, and agent instructions. So the list says what to change, not what to skip.
- **Text** is replaced in string literals and JSX text only, found with `ast-grep`, so identifiers are never touched. Tests are skipped.
- **Assets:** files in `branding/assets/` are copied over upstream's (app icons, splash screens, the web favicon and logo).
- **App identities** get new values so Kin installs alongside T3 Code without clashing: iOS and Android bundle ids and URL schemes (`apps/mobile/app.config.ts`), the desktop `productName` and app id, and the desktop data folder.
- **Drift check** after each upstream sync:
  - It lists new "T3 Code" text that no rule covers, so it can be added or explicitly left alone.
  - It fails when a rule no longer matches anything.
  - It runs typecheck on the branded copy.
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
git push origin main kin
```
