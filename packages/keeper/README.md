# @t3tools/keeper

Scope-agnostic Kin keeper. The archivist is the repo scope. Phase 2's memory keeper is the same pass at life scope.

`ArchivistKeeper.tick` is the run. It writes `.kin/chronicle.md` only after at least 8 new wills or 30 new notes since the last pass. Hosts call `tick` from a scheduled task (`0 * * * *` in `ARCHIVIST_CHECK_SCHEDULE`) or start `runDaemon` on the effect worker. The schedule decides when to look. The counts decide whether a pass runs.

## `kin init`

Lane 1 owns the `kin` binary. Register a `kin init` subcommand and call `initKinProject` (`KIN_INIT_USAGE`). The helper:

- writes `CLAUDE.md` as the one-line import `@AGENTS.md` when that file is missing
- leaves an existing `AGENTS.md` in place, and writes a short stub only when the file is absent
- creates `.kin/owner-rules.md` (importing a legacy `OWNER-AUTHORIZATION.md` or `LEDGER.md` when that is the file that exists)
- generates `docs/agent-maps/<house>.md` when `.kin/houses.tsv` is present

## Brief slot

`renderBriefSlot` is the section lane 1's prompt composer and lane 2's brief builder should place before the per-task brief. Owner rules are inside every brief. The task is last. Chronicle text and house maps change only when a pass or a generator run changes them.

`KeeperSource` is the wills-and-notes port. Lane 2's `LineageService` should satisfy it. `KeeperSummarizer` is the model port. The default layer is a deterministic digest of the raw entries. A host that calls a cheap model should send `renderSummarizerPrompt` and reuse the session id from the tick result until a rebuild pass (every 4th) replaces it.
