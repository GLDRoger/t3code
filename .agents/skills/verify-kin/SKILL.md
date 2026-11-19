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
| Dev Malhotra | `dev`     | member, lead of P-1, on P-2 (not its lead)      |
| Zoya Sheikh  | `zoya`    | member of P-1, Clients place on, holds W-1..W-3 |
| Arjun Rao    | `arjun`   | member of P-1, holds W-5                        |

Agents `chief` (Chief of staff, the team agent) and `finance` run on the scripted provider. Records:
clients C-1..C-3, projects P-1 (open, led by Dev), P-2 (retainer, renews in 9 days), P-3 (done),
tasks W-1..W-6 under P-1, invoice INV-1 (₹47,200, 12 days overdue), quotes QT-1 and QT-2,
milestone M-1, goal G-1, brief D-7. Dates are relative to today. `people` prints the ids.

## Drive

```bash
kv() { node scripts/kin-verify.ts "$@"; }
kv as zoya web open tasks                  # home | tasks | money | clients?client=C-1 | chat:chief | /settings/check-ins
kv as zoya web snapshot                    # the front sheet or dialog, else the main area; --full for the page
kv as owner web click --name "Add task"    # exact name first; --role option, --nth 2, --within "<card>"
kv as owner web type --name "What needs doing" "Check the logo files" --enter
kv as zoya web wait "Check the logo files" # or --gone; 20 s by default
kv as owner web screenshot /tmp/proof/new-task.png   # refuses any path under ~/.t3
kv as owner web view --width 390 --dark       # phone width or wide, light or dark; the size stays until changed
kv as dev rpc kin.work.list '{"project":"P-1"}'      # orgId is filled in
kv as meera wire kin.work.create '{"clientRequestId":"x","title":"Plan"}' --watch owner,zoya --find Plan  # what each open page got
kv tool finance money_summary '{}'                   # one real agent turn, no model
kv tool chief kin_relay '{"to":"Zoya Sheikh","text":"…"}' --as-turn-of zoya
kv tool chief people_read '{}' --reply "Checked." --hold 12   # stays working 12 s, to watch the status line
kv mail expire hello@ambermill.example              # its sign-in stops working; --back restores it
kv mail sent                                          # what the fake mailbox sent
kv mail deliver --to hello@ambermill.example --from "Anita <anita@orbitdental.example>" --subject "Re: invoice" --body "Paid today"
kv clock set "mon 09:01"                              # now moves forward to then, company zone
kv clock advance 3d                                   # now moves 3 days forward; nothing restarts
kv db "select key, state from kin_records where register_id = 'invoices'"
```

- Each person has their own headless Chrome, signed in the way they would sign in (pairing link
  for the owner, an invite link for others). It stays open between commands, so a page you opened
  is still there for `snapshot` and `click`.
- `tool` sends `[kv:<id>]` as the person to the agent's direct chat. The real wake-up starts the
  scripted agent (`scripts/kin-verify/script-agent.ts`), which calls the tool on `/kin/mcp` with the
  turn's own credentials, so the gate, levels and posting rules all apply. `"$event"` in the JSON
  becomes the turn's triggering event id; `"$chat"` the chat the turn replies to; `sourceEventId` is added when the tool takes one.
- A Team-room discussion plays from `<verify dir>/team-play.json`, `{"steps": [{"agent": "Finance",
  "calls": [...]}, {"agent": "Growth", "pass": true}]}`, in the order Kin must wake them. A woken
  agent that isn't the next step passes and logs a mismatch in `team-play.log.jsonl`, so a wrong
  turn order fails the script. `"$key"` in a later call is the record key an earlier one made.
- A check-in's reply (Run now) is `<instance>/verify/checkin-reply.md` when that file exists; the
  scripted agent posts it once and deletes it, to show a brief.
- `clock set|advance|show` move the instance's now forward only (`DevClock.ts`: Kin's clock and
  T3's scheduled tasks, on a dev server with `KIN_DEV_CLOCK`); a due slot runs on the next tick.
  T3's orchestration, which Kin's turns run through, keeps the real clock its worker reads, so a
  turn starts at once after a move. `mail deliver` stamps mail at the moved now.
  Kin's screens in kv's browsers follow on their next `web` command. `clock age 3d` is the old
  move: it stops the server, moves stored times back and starts it again.
- `db` opens the database read-only. Write through RPCs or tools, never SQL.

## Lifecycle scripts

`.agents/skills/verify-kin/scripts/` holds one script per lifecycle step. Each prints one `ok` or
`FAIL` line, exits non-zero on failure, and uses a fresh run token so it can run again on the same
instance.

```bash
.agents/skills/verify-kin/scripts/run-all.sh          # up --fresh, every script, down; ~17 min
.agents/skills/verify-kin/scripts/run-all.sh send-card-once private-task-hidden
bash .agents/skills/verify-kin/scripts/relay-owner-to-member.sh   # one, on the running instance
```

| Script                     | Proves                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assign-member-sees`       | owner's New task sheet gives Zoya a task; it is in her Tasks and her chat, not Arjun's                                                                                                                                                                                                                                                                 |
| `relay-owner-to-member`    | `kin_relay` in the owner's turn lands in Zoya's chat only                                                                                                                                                                                                                                                                                              |
| `member-request-to-owner`  | `kin_relay` in Zoya's turn lands in the owner's chat, attributed to her                                                                                                                                                                                                                                                                                |
| `private-task-hidden`      | "Only me" hides W-6 from the lead and members: Tasks, project page and count, search, pulse                                                                                                                                                                                                                                                            |
| `member-no-money`          | 12 screens each for two members show no amount, invoice or quote                                                                                                                                                                                                                                                                                       |
| `send-card-once`           | one Confirm on a send card sends exactly one mail; a second confirm is refused                                                                                                                                                                                                                                                                         |
| `social-week`              | Social on the fake Zernio: a pack and its reminder with nothing connected; our own accounts connected in Settings and a client's over RPC; five drafts (a picture-less Instagram post and a client's account refused), one card, remove one, Confirm, Undo one, three post after one Retry; the client's card waits for its OK; nothing crosses groups |
| `overdue-invoice-reminder` | INV-1's overdue fact reaches the owner only; the reminder is a reply in the invoice's thread                                                                                                                                                                                                                                                           |
| `checkin-new-agent`        | a new agent gets a check-in from the Settings dialog; Kin settings are owner-level; Run now wakes it                                                                                                                                                                                                                                                   |
| `lead-adds-milestone`      | members see P-1's milestones and no Add; Dev, its lead, adds one and they see it; New task offers Dev only P-1 and Zoya no client or project                                                                                                                                                                                                           |
| `owner-money-forms`        | a goal, the coming-up dates, an advance set against INV-1 once; members are refused                                                                                                                                                                                                                                                                    |
| `private-client-unnamed`   | C-3 marked private: in Zoya's turn touch_log, record_get, records_query answer as for no client                                                                                                                                                                                                                                                        |
| `told-once-quiet-hours`    | a late task is told once, an unchanged one starts no turn, a change is told; at 23:00 a check-in waits for quiet hours to end, survives a restart, runs once                                                                                                                                                                                           |
| `team-room-discussion`     | the brochure discussion: Growth pitches in, Finance widens once and decides, Social objects once; one "Finance replied" line with a link in Social's chat, "Sent by Social" in Finance's; Meera has the room with no count, Dev can't read it; "undo it" drops the task; a disagreement comes as one card                                              |
| `character-and-undo`       | Finance's character changes by chat, carries into the next turn and restores from history; Zoya can't read it; "undo it" puts back a linked move                                                                                                                                                                                                       |
| `github-delegated-task`    | GitHub connected: the owner's turn clones a repo and a delegated task opens a PR in its own worktree; one reply; Zoya's turn is refused and offered to the owner                                                                                                                                                                                       |
| `github-protect-branch`    | Connections reads each watched repo's default branch as open, open once a review approves (the owner's review-only rules), or out of the plan's reach; a member is refused; Protect all protects two and names the third; Remove takes off Kin's ruleset only                                                                                          |
| `member-attaches-file`     | Zoya attaches a PDF in her chat, Chief of staff takes the turn (its pages as pictures), and she fetches it; Arjun, Dev, Meera and the owner, outside that chat, get not-found by its id or a case-folded one                                                                                                                                           |     |
| `member-messages-teammate` | Zoya messages Arjun: one chat from either side; owner, Meera and Dev get not-found; the picker and the chat say only the two of them read it                                                                                                                                                                                                           |
| `member-refused-client`    | Arjun, without Clients, opening C-1 is told it isn't his to see, with no Retry or connection wording                                                                                                                                                                                                                                                   |
| `member-suggests-playbook` | Zoya's Suggest a change on the Chasing money playbook opens her team-agent chat with a starter line and sends the doc with it                                                                                                                                                                                                                          |
| `quote-invoice-loop`       | invoicing QT-1 links the invoice both ways and drops Make invoice; the draft invoice refuses a payment and says why; its PDF button is Make its PDF                                                                                                                                                                                                    |
| `work-change-five-people`  | five people with Tasks open: a new task, its assignment and its return reach each page as the task itself or nothing, with no Work read                                                                                                                                                                                                                |
| `agent-page`               | Finance's model changes from its page and by chat, the next turn runs on it and one on a switched-off provider is refused; its character is saved and restored; paused and resumed; retired and restored; Zoya gets neither the page nor a change                                                                                                      |
| `open-questions`           | Finance asks with a default and a day; Chief of staff asking the same is refused; the day passes, the default is taken once with one line and "undo it" reverses it; a question with no safe default is raised once, then waits in Waiting on you                                                                                                      |
| `github-events`            | GitHub watched with the owner's login: a teammate's PR gets one signed review and one line to the owner; "/kin" on it pushes a commit and replies; the kin label opens a PR that closes the issue; a stranger's "/kin" and the agent's own replies start nothing; a call made while Kin is down is handled once after a restart                        |
| `hours-two-zones`          | Arjun at 12:00 his time gets the owner's relay now; Zoya at 20:00 hers is told nothing until 10:00 her time, silent, and gets it once then; her switch off lets one through                                                                                                                                                                            |
| `relay-marked`             | the owner's relay reads "Sent by Rhea Kapoor" via Chief of staff in Zoya's chat and push; Zoya's answer reads as hers in the owner's                                                                                                                                                                                                                   |
| `asker-is-giver`           | a task Zoya asks the agent to give Arjun reads "Zoya gave this to you, via Chief of staff" and Hand back returns it to her                                                                                                                                                                                                                             |
| `remove-and-bring-back`    | removing Arjun keeps his task his, under Needs you, starts no agent, and closes the question an agent asked him; his browser says his access ended and Zoya's chat with him leaves her list; adding "Arjun Rao" again offers to bring him back, and that link brings back his level, chat history, task and that chat                                  |
| `decision-found-again`     | the owner answers Chief of staff's choice card; searching a word from it later finds it as Remembered and opens it in Settings → Memory; Zoya's search, over RPC and on screen, finds nothing                                                                                                                                                          |
| `teammate-reminder`        | Zoya sets her own reminder and nothing for anyone else; it comes due in her chat, not the owner's, rings her phone, and her Done finishes it                                                                                                                                                                                                           |
| `away-held`                | the owner marks Zoya away (Arjun can't); the relay to her waits with "Zoya Sheikh is away: it arrives at …" in the owner's chat; her I'm back lets it through once                                                                                                                                                                                     |
| `hand-over-all`            | Zoya's page offers Give all open tasks to… with her count; the owner gives them to Arjun, each a recorded change, Arjun told once, Undo gives them back; Arjun can't; Zoya gives hers to Dev                                                                                                                                                           |
| `retire-team-agent`        | retiring Chief of staff, the team agent, alone is refused; its page's Retire asks who the team talks to instead, and with Finance picked Zoya's list has Finance; restoring and picking it again puts it back                                                                                                                                          |
| `money-place-follows`      | Zoya has Money open while the owner switches her Money place on, then off: the page follows each way without her navigating                                                                                                                                                                                                                            |

`provider-conformance.sh <provider instance id> <model> [effort]` is the live half of the providers' conformance suite and is not in `run-all.sh`: it spends real model turns. It runs fourteen fixed turns (a plain reply, a Kin tool, a deferred tool, a choice card, a picture, scanned, text and compressed PDFs, a spreadsheet, the owner's signed shell and the web, then a teammate's same picture and PDF and no shell) and prints a table. Start the instance with the provider's credentials in its environment; see [Providers for Kin agents](../../../docs/kin/providers.md).

`node scripts/kin-release-check.ts` runs all ten with the models, property tests and UI fuzz before a release ([Releasing Kin](../../../docs/operations/kin-release.md)).

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

## Benchmark

`node scripts/kin-bench.ts --out <dir>` measures speed and prompt size on the `bench` seed: Ambermill
at a busy year's size (a 2,000-message group with chart and choice cards, 500 tasks, 200 clients,
300 docs, 12 months of invoices and expenses). It seeds its own instance (`bench`) from cold, then:

- captures the real prompt of each turn kind on the dev server, with the scripted agent keeping
  every prompt it is sent (`<verify dir>/capture-prompts`); tokens are UTF-8 bytes / 4;
- restarts the server as an installed host runs it (`t3 serve`, the production web build it
  serves itself) and times start-up and the hot reads;
- walks the web client in the owner's headless Chrome (cold load, long chat, switching, the four
  dock places, a task sheet, typing, scrolling, idle CPU) with WebSocket frames from CDP;
- opens all five people's browsers and counts what each receives after one change.

It writes `baseline-<commit>.json`, `.md` and `report.html`, then stops everything with `down`.
A run takes about 15 minutes; `--runs <n>` sets samples per action (default 5), `--reuse` skips
re-seeding, and `--only prompts` captures just the prompts and tool lists (about 4 minutes). A tool
listed as deferred (`_meta` anthropic/alwaysLoad false) counts apart from the upfront ones. `--compare <old.json> [--threshold 15]` adds old, new and change per metric and flags
what got worse. `--render <run.json> --findings <findings.json>` redraws the page with a written
"what stands out" list (`[{title, number, cause, where, worth}]`). It never calls a model.

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
and co-owner a check-in, a money chart, an invoice PDF, a send card and a receipt. It also makes a
turn that couldn't start and one that stopped partway, three pictures in one message, and for the
owner level a profile change, a nudge to Dev, a bank statement and a group with a mention. It is a
gallery to look at, not a pass/fail check; each line says what was made or why Kin refused it.

## When it goes wrong

- `doctor` first. It names stale processes, a port someone else holds, an old commit, or a wake-up
  stuck for more than five minutes.
- The server log is `.t3/kin-verify/<instance>/verify/dev.log`; Chrome's are under `verify/chrome/`.
- A person's browser whose page stops answering is restarted on the same profile automatically.
- Never kill by pattern. `down` stops the process trees it recorded at spawn.
