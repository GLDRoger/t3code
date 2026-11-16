---
name: verify-kin
description: Verify Kin end to end without paying for a model. Starts an isolated, seeded Kin, acts as its seeded people on the web and over RPC, runs agent tools through the real MCP entry point with a scripted agent, and reads fake mail and the database. Use to prove a Kin change works for owner, co-owner, lead and member, to reproduce a Kin bug, or to run the lifecycle scripts. Use test-t3-mobile for the phone itself.
---

# Verify Kin

`node scripts/kin-verify.ts` drives a Kin dev instance the way its people would. Everything runs on
this checkout's `.t3/kin-verify/<instance>/`: never the live `~/.t3/userdata`, never a real model,
never real mail. Output is short and stable; every error says what to do next; every command can
be run again.

## Start, check, stop

```bash
node scripts/kin-verify.ts up            # cold ~20 s with the seed, warm (reuse) ~5 s
node scripts/kin-verify.ts doctor        # ours, on this commit, healthy? Lists each problem.
node scripts/kin-verify.ts down          # stops exactly what up, web and phone started
```

- `up --fresh` wipes the instance first; `up --seed empty` gives a bare company (owner only).
- `--instance <name>` (or `KIN_VERIFY_INSTANCE`) runs a second instance beside the first; each has
  its own ports, database and browsers.
- `down --wipe` also deletes the instance's state. Always `down` before you end your turn.
- The server runs under `node --watch`: a change under `apps/server/src` restarts it in a few
  seconds and the instance keeps its data. After a commit, `doctor` asks for `down && up`.

## The seeded company

The `lifecycle` seed is Ambermill Studio (invented, `.example` addresses), written through the real
entry points: owner RPCs, invite links, `kin import`, and one scripted agent turn.

| Who          | `as` name | Access                                          |
| ------------ | --------- | ----------------------------------------------- |
| Rhea Kapoor  | `owner`   | owner                                           |
| Meera Iyer   | `meera`   | co-owner                                        |
| Dev Malhotra | `dev`     | member, lead of P-1                             |
| Zoya Sheikh  | `zoya`    | member of P-1, Clients place on, holds W-1..W-3 |
| Arjun Rao    | `arjun`   | member of P-1, holds W-5                        |

Agents `chief` (Chief of staff, the team agent) and `finance` run on the scripted provider. Records:
clients C-1..C-3, projects P-1 (open, led by Dev), P-2 (retainer, renews in 9 days), P-3 (done),
tasks W-1..W-6 under P-1, invoice INV-1 (₹47,200, 12 days overdue), quotes QT-1 and QT-2,
milestone M-1, goal G-1, brief D-7. Dates are relative to today. `people` prints the ids.

## Drive

```bash
kv() { node scripts/kin-verify.ts "$@"; }
kv as zoya web open tasks                  # tasks | money | clients?client=C-1 | chat:chief | /settings/check-ins
kv as zoya web snapshot                    # the front sheet or dialog, else the main area; --full for the page
kv as owner web click --name "Add task"    # exact name first; --role option, --nth 2, --within "<card>"
kv as owner web type --name "What needs doing" "Check the logo files" --enter
kv as zoya web wait "Check the logo files" # or --gone; 20 s by default
kv as owner web screenshot /tmp/proof/new-task.png   # refuses any path under ~/.t3
kv as dev rpc kin.work.list '{"project":"P-1"}'      # orgId is filled in
kv tool finance money_summary '{}'                   # one real agent turn, no model
kv tool chief kin_relay '{"to":"Zoya Sheikh","text":"…"}' --as-turn-of zoya
kv tool chief people_read '{}' --reply "Checked." --hold 12   # stays working 12 s, to watch the status line
kv mail expire hello@ambermill.example              # its sign-in stops working; --back restores it
kv mail sent                                          # what the fake mailbox sent
kv mail deliver --to hello@ambermill.example --from "Anita <anita@orbitdental.example>" --subject "Re: invoice" --body "Paid today"
kv clock advance 3d                                   # every stored Kin time moves 3 days back
kv db "select key, state from kin_records where register_id = 'invoices'"
```

- Each person has their own headless Chrome, signed in the way they would sign in (pairing link
  for the owner, an invite link for others). It stays open between commands, so a page you opened
  is still there for `snapshot` and `click`.
- `tool` sends `[kv:<id>]` as the person to the agent's direct chat. The real wake-up starts the
  scripted agent (`scripts/kin-verify/script-agent.ts`), which calls the tool on `/kin/mcp` with the
  turn's own credentials, so the gate, levels and posting rules all apply. `"$event"` in the JSON
  becomes the turn's triggering event id; `"$chat"` the chat the turn replies to; `sourceEventId` is added when the tool takes one.
- `clock` stops the server, rewrites stored times in one transaction and starts it again. The
  server's own clock is untouched; `set-date` moves times so that today reads as that date.
- `db` opens the database read-only. Write through RPCs or tools, never SQL.

## Lifecycle scripts

`.agents/skills/verify-kin/scripts/` holds one script per lifecycle step. Each prints one `ok` or
`FAIL` line, exits non-zero on failure, and uses a fresh run token so it can run again on the same
instance.

```bash
.agents/skills/verify-kin/scripts/run-all.sh          # up --fresh, all ten, down; ~6 min
.agents/skills/verify-kin/scripts/run-all.sh send-card-once private-task-hidden
bash .agents/skills/verify-kin/scripts/relay-owner-to-member.sh   # one, on the running instance
```

| Script                     | Proves                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `assign-member-sees`       | owner's New task sheet gives Zoya a task; it is in her Tasks and her chat, not Arjun's               |
| `relay-owner-to-member`    | `kin_relay` in the owner's turn lands in Zoya's chat only                                            |
| `member-request-to-owner`  | `kin_relay` in Zoya's turn lands in the owner's chat, attributed to her                              |
| `private-task-hidden`      | "Only me" hides W-6 from the lead and members: Tasks, project page and count, search, pulse          |
| `member-no-money`          | 12 screens each for two members show no amount, invoice or quote                                     |
| `send-card-once`           | one Confirm on a send card sends exactly one mail; a second confirm is refused                       |
| `overdue-invoice-reminder` | INV-1's overdue fact reaches the owner only; the reminder is a reply in the invoice's thread         |
| `checkin-new-agent`        | a new agent gets a check-in from the Settings dialog; Kin settings are owner-level; Run now wakes it |
| `lead-adds-milestone`      | members see P-1's milestones and no Add; Dev, its lead, adds one and they see it                     |
| `owner-money-forms`        | a goal, the coming-up dates, an advance set against INV-1 once; members are refused                  |

A script that sees a known product bug prints a `known` line on stderr instead of passing
silently. Write a new script from `lib.sh`: `kv`, `fail`, `pass`, `expect_in`, `expect_not_in`,
`sent_count`, `card_id`. Assert on what a person sees (snapshot text) or what left the building
(mail), and add a negative check (someone who must not see it). Before trusting a new script,
break the behaviour in the product, watch it fail, and revert.

## Proof standards

- A claim about a screen needs a `snapshot` line or a screenshot path, as that person.
- A claim about hiding needs every place the thing could leak: list, record, count, search, pulse,
  chat. A screen that fails to load hides everything; check it loaded.
- A claim about mail needs `mail sent` before and after; count, thread and `inReplyTo`.
- A claim that something happens once needs the second attempt and its refusal.

## Phone

The phone app is the same server. To look at it on a simulator or device:

1. `vp run mobile:install ios` (or `android`) on the device host installs the dev client.
2. `node scripts/kin-verify.ts phone metro` starts Metro for this checkout; `down` stops it. It runs
   the Kin-only app (`EXPO_PUBLIC_KIN_ONLY=1`); `--full-app` shows Kin inside the T3 Code shell.
3. `node scripts/kin-verify.ts phone pair [--android] [--as zoya]` prints a `t3code-dev://` link.
   Open it on the device (see `test-t3-mobile` for the device tools). Without `--as` it pairs the
   owner; with it, the link joins that person through a fresh invite. To switch person, leave
   first (Kin settings, Sign out or Leave): a phone with full access refuses a join link.

`phone` does not tap the phone for you. Drive it with the device tools from `test-t3-mobile`, and
check the same facts through `as <person> rpc` while you do.

`bash .agents/skills/verify-kin/scripts/card-gallery.sh <person>` makes every chat card in that
person's chats with real scripted turns, about a minute: a long reply with a list, table, code and
link, a question, a plan, a chart, a visual, a relay, a working line, a reaction, and for the owner
and co-owner a check-in, a money chart, an invoice PDF, a send card and a receipt. It is a gallery to
look at, not a pass/fail check; each line says what was made or why Kin refused it.

## When it goes wrong

- `doctor` first. It names stale processes, a port someone else holds, an old commit, or a wake-up
  stuck for more than five minutes.
- The server log is `.t3/kin-verify/<instance>/verify/dev.log`; Chrome's are under `verify/chrome/`.
- A person's browser whose page stops answering is restarted on the same profile automatically.
- Never kill by pattern. `down` stops the process trees it recorded at spawn.
