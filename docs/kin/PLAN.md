# Kin: phase 1 plan

Phase 1 delivers a direct chat on the phone with one lead, on `GLDRoger/t3code`, with memory in `GLDRoger/kin-memory`, running on the Mac mini at L0. What phase 1 includes is in [DESIGN.md section 11](DESIGN.md#11-phases-each-one-works-on-its-own). Each task is described in full in its spec:

| Spec                            | Covers                                                                                                  | Tasks             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| [chat](specs/chat.md)           | Organizations, people, chats, messages, widgets, chat RPC and streams, `/kin/mcp`, floor manager, judge | CHAT-1 to CHAT-13 |
| [lead](specs/lead.md)           | Event queue, wake-ups, lead tools, memory reads and writes, workers, budget, stop switch, levels        | LEAD-1 to LEAD-14 |
| [approvals](specs/approvals.md) | `request_action`, pending actions, signed grants, executor, GitHub App, rulesets, audit                 | APPR-1 to APPR-15 |
| [triggers](specs/triggers.md)   | Webhooks, deferrals, routines, watchdogs, dreaming, secret scan, purge, contract tests, Mac mini        | TRIG-1 to TRIG-20 |
| [mobile](specs/mobile.md)       | Chat list, direct chat, cards, Waiting on you, notifications                                            | MOB-1 to MOB-12   |

Tasks marked phase 2, 3 or 5 in a spec wait: CHAT-11 to CHAT-13, APPR-12 to APPR-15.

## How to take a task

1. Pick a task whose dependencies have merged. The waves below show what's ready.
2. Claim it: open a draft PR against `kin` titled `<ID>: <title>` (for example `CHAT-3: Repository`) before writing much code. An open draft PR with that id means the task is taken.
3. Build exactly what the task's "What" and "Files" say. Its "Done when" is the acceptance test. Put the command you ran and its result in the PR.
4. If the spec is wrong, fix the spec in the same PR and say so in the description.

## Waves

A task can start once everything it depends on has merged. These waves come from each task's "Depends on" line; tasks in the same wave can run in parallel and touch different files. Many tasks can start before their whole wave above has finished, so check the task's own dependencies, not only the wave.

| Wave  | Backend                                                                                        | UI                                | Ops                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| 0     | CHAT-1 contracts, CHAT-2 Kin migration track                                                   | APPR-6 native approval key module | TRIG-20 Mac mini setup, BRAND-1 branding script, TRIG-19 `McpAppWebView` contract test |
| 1     | CHAT-3, LEAD-1, APPR-1, TRIG-1                                                                 | MOB-1                             |                                                                                        |
| 2     | CHAT-4, LEAD-2, LEAD-4, APPR-2, TRIG-2                                                         | MOB-2                             | APPR-8 GitHub App (needs Nishchay's GitHub sign-in)                                    |
| 3     | CHAT-5, LEAD-3 (with a TRIG-16 stub), LEAD-5, LEAD-6, APPR-5, APPR-10, TRIG-3, TRIG-4, TRIG-12 | MOB-3, MOB-4                      | APPR-11 rulesets and CODEOWNERS                                                        |
| 4     | CHAT-6, CHAT-7, LEAD-10, APPR-3, APPR-4, TRIG-9, TRIG-16, TRIG-18                              |                                   | TRIG-15 memory repo guard rails                                                        |
| 5     | CHAT-8, CHAT-9, LEAD-7, MOB-10, TRIG-11, TRIG-13                                               | MOB-5, APPR-7 phone signing flow  |                                                                                        |
| 6     | CHAT-10, LEAD-8, LEAD-9, TRIG-7, TRIG-14                                                       | MOB-6, MOB-11                     |                                                                                        |
| 7     | LEAD-11, LEAD-12, LEAD-13                                                                      | MOB-7, MOB-8                      |                                                                                        |
| 8     | APPR-9 executor, LEAD-14 dry run, TRIG-8                                                       | MOB-9                             |                                                                                        |
| 9     | TRIG-5 GitHub webhooks, TRIG-17 purge                                                          | MOB-12                            |                                                                                        |
| 10–11 | TRIG-6 GitHub events, TRIG-10 watchdogs                                                        |                                   | Shadow week on the Mac mini                                                            |

**Critical path:** CHAT-1 → CHAT-3 → CHAT-4 → CHAT-5 → CHAT-7 → LEAD-7 → LEAD-9 → LEAD-11 → APPR-9 → TRIG-5 → TRIG-6 → TRIG-10. Review those PRs first. GitHub webhooks come late only because TRIG-5 creates repo hooks through the executor. If that becomes the bottleneck, TRIG-5 can create the hook directly with the bot's token and move to wave 5.

**BRAND-1. Branding script.** `scripts/kin-brand.ts`, `branding/rules.yaml`, `branding/assets/`, as described in [KIN.md](../../KIN.md#branding-at-build-time). Done when: running it on a clean checkout produces a copy that typechecks, shows "Kin" in the mobile, desktop and web app names, installs alongside T3 Code (different bundle ids and scheme), and its drift check fails when a rule matches nothing. Owner: backend.

## Shared decisions the specs settled

Where specs overlapped, this is who owns what:

- **One Kin migration track.** CHAT-2 creates it (`kin_sql_migrations`, separate from upstream's numbered list). Every other spec adds its tables there.
- **One Kin MCP endpoint, `/kin/mcp`.** CHAT-7 creates it. The chat tools (`kin_chat_post`, `kin_chat_read`, `kin_widget_upsert`, `kin_floor_bid`), the lead tools (LEAD-7, LEAD-8, including `kin_defer`) and `request_action` (APPR-3) all live there, and only lead threads are given it. Nothing Kin adds goes into upstream's `layerTools`.
- **Workers start with `ThreadLaunchService.launch`, not `delegate_task`,** so a worker finishing doesn't wake the lead outside the queue (lead spec, correction 1).
- **Scheduled triggers don't start agent threads.** They write to `kin_trigger_inbox`, and the lead's queue reads it (TRIG-4).
- **The approval card is split.** MOB-8 draws the card. APPR-7 owns `approvePendingAction`: the challenge, the biometric signature and the submit.
- **Dream auto-merge waits for delegations** (APPR-12, phase 3). Until then the owner approves both dream PRs.

## Design corrections found by the specs

The specs checked the design against the code and found these. Until DESIGN.md is updated, the spec wins.

- T3 has no notion of a person. A paired device gets environment-wide scopes, including terminal access. Members need Kin's own people records and a narrow `kin:chat` scope before anyone else pairs a phone (chat spec).
- T3's mobile device key is a software key used only for the relay. Kin needs its own approval key in the Secure Enclave or Keystore behind Face ID (approvals spec).
- Agent CLIs inherit the server's `gh` login. Kin on the Mac mini must run as a dedicated macOS user whose GitHub identity is the bot, and leads stay at L0 until it does (lead and approvals specs).
- T3's merge doesn't pin the head SHA, so the executor calls GitHub's merge API with the SHA itself. The GitHub review comes from the phone, never from the server (approvals spec).
- `fixed_time` triggers use the machine's timezone and skip runs more than 10 minutes late, so Kin runs its own time triggers on T3's scheduler (triggers spec).
- Kin needs its own push sender and an APNs key, because T3's relay pushes have no action buttons (mobile spec).
- The lock screen shows **Review** for approvals, never Approve, because approving needs Face ID inside the app (mobile spec).
- There's no general way to read plan headroom, so the budget counts tokens per turn (lead spec).

## Waiting on Nishchay

- **An APNs key** (and an FCM key for Android) for Kin's push sender. Blocks MOB-10.
- **The GitHub App:** creating it and installing it on `GLDRoger/t3code` and `GLDRoger/kin-memory` needs your GitHub sign-in. Blocks APPR-8.
- **The Mac mini:** a dedicated macOS user for Kin, and a choice between automatic login and FileVault (the triggers spec explains why they conflict). Blocks TRIG-20.
- **Jev from TypeSafe:** pricing and API access. Until then the judge is the no-op stub (CHAT-10).
