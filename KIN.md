# Kin

`kin` is the long-lived trunk for Kin, a multi-agent orchestration IDE based on this fork of [t3code](https://github.com/pingdotgg/t3code). The design is in [docs/kin/DESIGN.md](docs/kin/DESIGN.md).

- Branch Kin features and worktrees from `kin`.
- Merge that work back into `kin`.
- `main` mirrors upstream `pingdotgg/t3code` and only fast-forwards. Never commit to it; fork-only fixes go on `kin`.

## Syncing upstream

Sync often. A few days of upstream merges in minutes; a few weeks is an afternoon.

```sh
git switch kin
node scripts/kin-sync.ts          # fast-forwards main, merges it into kin, runs vp i
vp run check:changed upstream/main
git push origin main kin
```

`kin-sync` resolves conflicts that come only from the product rename. Kin replaced "T3 Code" with "Kin" across a few hundred files, so any upstream edit near that text conflicts. It rebuilds `pnpm-lock.yaml` from upstream's, because a lockfile that merges without conflicts can still be broken. It also turns on `git rerere`, so a conflict you resolve by hand once is replayed on later syncs.

Keep the rename to display copy. Protocol identities stay `T3 Code`: Codex `clientInfo`, MCP server ids, `T3CODE_*` env vars, and package names. Renaming them breaks provider handshakes and replay fixtures.

To keep syncs cheap, put Kin code in its own files (`apps/server/src/kin/`, `packages/keeper`, `packages/kin-reliability`). Touch shared upstream files with the smallest hook you can, such as one line in a layer list or a handler map.
