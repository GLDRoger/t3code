# Kin

`kin` is the trunk for Kin: a team of AI leads in messaging-style chats, built on this fork of [T3 Code](https://github.com/pingdotgg/t3code). The design is in [docs/kin/DESIGN.md](docs/kin/DESIGN.md). The earlier lineages design and code are kept at the tag `archive/kin-lineages-2026-11-07`.

- `main` mirrors upstream `pingdotgg/t3code` and only fast-forwards. Never commit to it.
- Kin work lands on `kin`.
- Put Kin code in its own files (`packages/contracts/src/kinChat.ts`, `apps/server/src/kin/`, `apps/mobile/src/features/chats/`, `apps/web/src/kin/`). Touch shared upstream files only with the smallest hook you can, such as one line in a layer list or a route map.
- Display copy keeps the T3 Code name until launch, so upstream merges stay conflict-free.

## Syncing upstream

Sync often; a few days of upstream merges in minutes.

```sh
git switch kin
git fetch upstream
git branch -f main upstream/main
git merge upstream/main
vp i
vp run check:changed upstream/main
git push origin main kin
```
