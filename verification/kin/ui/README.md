# Kin UI fuzzing with Bombadil

[Bombadil](https://github.com/antithesishq/bombadil) taps around Kin's web client at random, as
each role, and checks properties on every screen it reaches. It runs against a fresh, isolated Kin
with an invented company; no model is called and nothing leaves the machine.

## Run

```sh
node verification/kin/ui/run.ts --out ~/kin-ui-fuzz-out          # every role, 3 minutes each
node verification/kin/ui/run.ts --out <dir> --roles member,lead --time 90s --headed
```

It needs the `bombadil` binary on `PATH` or in `BOMBADIL` (macOS arm64:
[release](https://github.com/antithesishq/bombadil/releases) asset `bombadil-aarch64-darwin`; check
its sha256 against the digest GitHub shows for the asset). Bombadil drives its own headless Chrome.

The runner wipes and uses `<worktree>/.t3/kin-ui-fuzz` (gitignored), starts `vp run dev` there
with `KIN_ENABLED=true` and a throwaway dev token, imports `seed.jsonl`, runs `seed.ts` (people,
roles, private entries) and snapshots the result. Each role then walks a fresh copy of that
snapshot, so one role's taps can't change what the next one sees. It writes `summary.json` and
stops the server it started. It refuses an `--out` under `~/.t3`.

No model is ever called: the server runs with stub `claude`, `codex` and other provider CLIs first
on its `PATH`, so any agent turn fails at once, and the runner fails if any turn produced a token.
(An early version without the stubs let a walk create an agent and tap its suggestion chips: 18
real Opus turns.)

For each role, `<out>/<role>/trace` holds Bombadil's trace and screenshots:

- `bombadil browser inspect <out>/<role>/trace` opens a timeline viewer.
- `node verification/kin/ui/explain.ts <out>/<role>` prints the taps before each violation.

## The company

Rhea Kapoor (owner), Arjun Mehta (co-owner), Dev Iyer (member who leads the Lumen Grove project),
Zoya Sheikh (member, no Clients place) and Kabir Rao (member with Clients). Three clients, three
projects, milestones, tasks held by different people, an overdue invoice of ₹7,31,941
(INV/26-27/731), two quotes, a contact with email and phone, and two owner-private tasks titled
`CANARY-PRIVATE-…`. Leaks are detected by these strings.

## Properties

| Property                                                                                      | Meaning                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacyMoney`                                                                                | Members see no amount (₹, Rs, INR, 7,31,941-style numbers) and no invoice or quote number.                                                              |
| `privacyOwnerPrivate`                                                                         | Lead and members never see an owner-private `CANARY-PRIVATE` title.                                                                                     |
| `privacyContact`                                                                              | A member without the Clients place never sees the contact's email or phone.                                                                             |
| `noCouldntLoad`, `noGoneRecord`, `noSomethingWrong`, `noNotAvailable`                         | No screen reached by tapping what the app offered says it couldn't load, the thing is gone, something went wrong, or it is not available.               |
| `enabledNeverRefused`                                                                         | A tapped control never brings up a refusal ("You can't do that here", "Only the owner … can") that wasn't on screen before it.                          |
| `noConnectionBlame`                                                                           | Nothing says to check the connection or that Kin isn't answering: the server is up, so a refusal or an empty result never reads as one.                 |
| `noBlankScreen`, `spinnersEnd`                                                                | The main area is never blank for more than 6 s; a spinner ends within 10 s.                                                                             |
| `countMatchesList`                                                                            | Tapping something labelled "N open/dates/clients…" shows a new list of N items.                                                                         |
| `noDeadControls`                                                                              | A tapped button or link changes the screen, opens a sheet, or shows a message within 3 s.                                                               |
| `noRecordInRecord`, `noSheetOnSheet`                                                          | Nothing deeper than dock tab → list → record → sheet: one record open at a time, one sheet at a time. Confirmation prompts and toasts don't count.      |
| `noBrokenValues`, `noATeammate`, `noInternalWords`, `noRawIds`                                | No `undefined`/`NaN`/`[object Object]`/`null`, no "A teammate", no internal words (widget, wake, deferral, L2, "lead agent", pulse, floor), no raw ids. |
| `backClosesWhatOpened`                                                                        | Opening something and pressing Back returns to where you were.                                                                                          |
| `noUncaughtExceptions`, `noUnhandledPromiseRejections`, `noConsoleErrors`, `noHttpErrorCodes` | Bombadil's defaults: the console stays clean and no request fails.                                                                                      |

Each property reports its first failure per run, so the kinds are split to keep one leak from
hiding another.

## Excluded

The walk only taps, scrolls and presses Back. It never types, so nothing is sent to an agent. The
taps come from `spec.ts`'s own generator, which lists visible, enabled controls by their visible
name and leaves out any whose name starts with Create, New agent, Add agent, Remove, Delete,
Revoke, Retire, Sign out, Log out, Leave, Confirm, Send, Archive, Void, Pay, Approve, Reset,
Disconnect, Turn off, Run now, Connect, Sign in, Hand back, Give back, Mark done, Reopen, Drop,
Share, Unshare, Make private, Only me, Change, Upload, Attach, Download, Copy link, Switch to coding,
Usage or Pull requests: they are irreversible, reach outside, create agents, or leave Kin. Outside
`/kin` the walk only presses Back and no property is checked. The company has no agents, so chats
and money or send cards are not exercised.
