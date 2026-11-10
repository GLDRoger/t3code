# Kin: roadmap

The road from today's Kin to [VISION.md](VISION.md), in waves. The task ids (CHAT-n, LEAD-n, APPR-n, TRIG-n, MOB-n) in the [specs](specs/) record how phase 1 was built. New work is tracked by the wave ids below.

**How to read it.**

- At most three workers run at once.
- Tasks in a wave touch different files unless a note says which one merges first.
- ★ marks a task that touches authority: approvals, identity, permissions or who may speak.
- **Reviews:** W1-1, W1-2 and W5-1 each get one independent high-effort review. UI tasks need captures from a real client. On every other ★ task, the orchestrator reads the authority diff itself.

## Owner decisions behind this plan (10 Nov 2026)

- No level ladder, no shadow week and no promotions (this supersedes the earlier "shadow week in groups only"). A lead works at L2 from day one in its DM with its owner and in groups the owner owns; merges and every other privileged action still need a signed grant. The server's permission gate stays internal, for chats members create later.
- Group floor: the mentioned agent speaks, else the group's lead. No bids and no judge model; the judge code is deleted.
- The chief of staff is also the router.
- The first non-engineering leads are growth and marketing, finance and billing, and social media.
- Members can create their own leads through a form (name, domain, charter, model). These leads run on the main host, with authority taken from the member who made them and capped at that member's. Self-hosted and outside agents are deferred.
- DMs between two people are private from agents.
- Who pays for a teammate's requests, and for member-created leads, is decided before W5-5.
- The first teammate uses iOS. Android comes last.

## Wave 0: make what exists work

| Task              | Goal                                                   | Acceptance                                                                                                                                 |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| W0-1 Push live    | Lock-screen pushes for replies, reminders and cards    | With the app closed, a lead reply reaches a locked iPhone within 5 s and opens the right chat; a reminder does the same; no APNs refusals  |
| W0-2 Latency      | Something visible in under 1 s, first words in seconds | Stage times recorded per wake-up; p50 first visible state < 1 s, first token < 8 s cold and < 4 s warm on the host. **Merged** (#133)      |
| W0-3 Live checks  | Know what's broken on each surface and fix it          | Checklist run on iOS, web and desktop against a seeded dev server; every failure fixed or listed. **Merged** (#134)                        |
| W0-4 Reply polish | Replies feel live and failures are visible             | Claude drafts stream; a failed wake-up shows a notice and a retry at once; refusals name their reason; the warm provider process is reused |

## Wave 1: close the loop

Start W1-2 after W0-3, since both edit `apps/mobile/src/features/chats/**`. W1-1 and W1-3 both edit `docs/kin/specs/lead.md`, and W1-3 lands second.

| Task                              | Goal                                                                          | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1-1 ★ Worker isolation           | A worker can't read Kin's state, the memory key or the executor's credentials | The GitHub App key and the owner's merge credential are unreadable from a worker's shell (transcript); holds for workers of several leads at once; the `workerLaunchReady` seam is deleted                                                                                                                                                                                                                                                                          |
| W1-2 ★ Phone approvals            | Enrol a key, see an approval card, sign with Face ID                          | Works for `merge_pull_request`, `set_level` and key enrolment. The card names who asked when the request came from below the owner                                                                                                                                                                                                                                                                                                                                  |
| W1-3 ★ Many leads                 | A lead per domain                                                             | A second and third lead can be created from the CLI and from an owner-only RPC through one service method that takes the creating person and their ceiling; a non-owner session is refused. Each lead has a domain and a charter only the owner can change. A lead works at L2 in its owner's DM. Group rules load only for group wake-ups. Routines, budget notices and dreams name the right lead; budget stays one daily figure per org, with use shown per lead |
| W1-4 Delegation end to end (gate) | The whole loop works on the host and the phone                                | From the iPhone: ask Tech lead for a small change; a worker starts; the task card updates in place; the report wakes the lead; a draft PR exists; the approval card arrives; Face ID; merged at the pinned SHA; audit row present. A push after approval voids it                                                                                                                                                                                                   |

## Wave 2: a company of leads, one list, one switcher

| Task                                       | Goal                                                | Acceptance                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2-1 One wake-up per lead                  | One lead's reply never waits on another's           | Two leads answer two messages at once (real-orchestrator test). Two memory writes in the same second both land in order, each validated. Pause still stops everything. W0-2's latency holds with three leads active                           |
| W2-2 Kin list, switcher, new lead (mobile) | Kin is a list of chats, one tap from coding threads | The brand mark switches between coding threads and Kin; the app reopens to the list last used. Every lead and chat is listed, with **Waiting on you** first. A "New lead" sheet creates one through W1-3's RPC. With Kin off, nothing changes |
| W2-3 Kin list and switcher (web, desktop)  | The same on the laptop                              | The sidebar mark switches lists; a setting picks the first list; command palette entry and keybinding; unread count outside Kin; desktop notification for a reply, also against a remote host                                                 |

**Checkpoint A:** the owner alone, daily. Several leads, each delegating and remembering, approvals from the phone, push on the lock screen, one list.

## Wave 3: rooms of agents (server), controls, push

| Task                              | Goal                                         | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3-1 ★ Groups of owner and agents | A group exists and its agents answer in turn | Only the owner creates groups and adds or removes agents (test). A group message wakes the mentioned agent, else the group's lead. The server binds the grant to the wake-up and the reply bridge posts under it; no token is ever in a prompt or tool argument. An agent's @mention queues the next agent; six agent turns close the run. The floor's leftover bid parameters are removed. A lead new to a group is at L0 there. Group Undo reaches the lead |
| W3-2 Kin settings                 | One place to control Kin                     | Pause and resume, budget, time zone, routine times, quiet hours, approval devices, and per lead: name, charter, projects, retire. Pause is two taps from any chat                                                                                                                                                                                                                                                                                             |
| W3-3 Push for many chats          | The right person gets the right ping         | Titles name the lead or group. In groups a person is pushed for mentions, cards waiting on them and replies to them. Per-chat mute; badge equals unread plus waiting; quiet hours hold; tapping opens the right chat from a cold start                                                                                                                                                                                                                        |

## Wave 4: rooms of agents (clients), and the first lead that doesn't code

| Task                           | Goal                                            | Acceptance                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4-1 Group chat (mobile)       | A group reads like a group                      | New group, member list, add and remove agents, an @ picker, author name and avatar on every bubble. An agent run folds into one line. An approval the viewer can't sign reads "Waiting on Nishchay"     |
| W4-2 Group chat (web, desktop) | The same on the laptop                          | Same checks; folds and mentions follow W4-1's shared files                                                                                                                                              |
| W4-3 Workspace projects        | A growth or marketing lead produces real output | A non-engineering lead has a private documents repo. Asked for a launch plan, it starts a worker that writes files as a PR; the task card links the document; approving the PR approves the deliverable |

## Wave 5: the first teammate

W5-1 lands a contract-only PR first. Then W5-1, W5-2 and W5-3 run together, then W5-4 and W5-6, then W5-5.

| Task                                        | Goal                                                     | Acceptance                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W5-1 ★ People, invites, devices, `kin:chat` | A teammate has an account that can chat and nothing else | A single-use, expiring invite creates a person and a session holding only `kin:chat`. That session uses `kin.*` chat methods for its own chats and is refused on T3 streams, terminals, files and projects (test and transcript). The owner revokes a member's devices |
| W5-2 Chat-only clients                      | A member's app works with a chat-only session            | A device paired by invite shows only the Kin list and never subscribes to T3 streams. Invite to first message in under two minutes, over the tailnet and the tunnel                                                                                                    |
| W5-3 ★ People in chats, provenance ceilings | A member can talk and ask for work, within their role    | The owner adds people to groups. A DM between two people wakes nothing, and no agent, dream or memory reads it. Work a member starts runs under the member's ceiling. A member's approval is refused. Member Undo can't cancel an owner-trust item                     |
| W5-4 People in the app                      | People are first-class in the list                       | Invite sheet with a share link; people DMs and mixed groups in the list; the owner sees and removes members and their devices                                                                                                                                          |
| W5-6 ★ Member-created leads                 | A member creates their own lead                          | A member creates a lead through the form (name, domain, charter, model) on the main host. Its authority is capped at the creating member's, never the group's (test)                                                                                                   |
| W5-5 First teammate, live (gate)            | Two real people, two phones, one week                    | The teammate joins by invite, shares a group with the owner and two leads, and asks a lead for a change the owner approves. The hostile-member checklist passes from the teammate's device                                                                             |

**Before W5-5:** decide who pays for a teammate's requests and for member-created leads, and confirm the separate executor user from W1-1.

### ▶ Milestone: usable daily by the owner and the first teammate

Measured over one week at the end of wave 5: both people use Kin every working day; at least three leads are live, one not engineering; at least one mixed group is active; every merge went through a phone approval; no reminder was missed; nothing on the hostile-member checklist succeeded.

## Wave 6: proactive

Server work in separate folders, so any task can move into an idle server slot from wave 3 on.

| Task                                  | Goal                                                 | Acceptance                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6-1 GitHub awareness                 | PR and CI events reach the right chat, without noise | An event goes to the lead whose projects include the repo; a failed CI run on a watched PR is one useful message; routine pushes are silent; under 10 notices a day |
| W6-2 Dreams and briefs for many leads | A week of dreams and briefs worth reading            | Seven nightly dreams in a row complete on the host. Each lead with something to say sends one morning message; the chief of staff sends one digest across leads     |
| W6-3 Chief of staff as router         | "Tell whoever handles this" works                    | The chief of staff hands a message to the right lead word for word, keeping author and provenance. One agenda across leads flags two leads planning the same thing  |
| W6-4 Voice and images                 | Talk to Kin; send a screenshot                       | Works in DMs and groups                                                                                                                                             |

## Wave 7: team depth

Run three at a time, in this order.

| Task                                           | Goal                                                        | Acceptance                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| W7-1 ★ Delegations and the low-risk merge gate | The owner hands a narrow approval to a person, by signature | A delegated docs merge by a member succeeds with their own signed grant; out of scope fails; revoking stops it at once |
| W7-2 Guests and group cards                    | Suggest-only guests; polls and decisions                    | The chat spec's CHAT-12 and CHAT-13 done-when lines                                                                    |
| W7-3 What Kin knows about me                   | Members can read, dispute and opt out                       | A member sees what Kin remembers about them, disputes an item, and turns off being chased                              |
| W7-4 ★ First outside action                    | One domain's lead can act in the world, by signature        | The chosen action runs only on a signed grant showing the exact content; a changed draft voids it                      |
| W7-5 ★ Next of kin                             | Someone can undo when the owner can't be reached            | The approvals spec's APPR-14 done-when line                                                                            |
| W7-6 Cleanup                                   | Less to carry                                               | Kin tests green; the docs describe the product that exists                                                             |

## Wave 8: organizations (last)

| Task                                       | Goal                                        | Acceptance                                                                                                      |
| ------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| W8-1 ★ A second organization and its walls | Two companies on one host, nothing crossing | A second org with its own memory repo, leads, budget and keys; a test per store proves no read or write crosses |
| W8-2 Organization switcher                 | One app, several companies                  | A switcher on the Kin list; **Waiting on you** gathers every org, each item labelled                            |
| W8-3 ★ Organization policy and roles       | Approvers by role, locked settings          | "Merges in this repo need a tech admin" holds; a locked setting can't be changed by a member or an agent        |
| W8-4 ★ External members and partners       | The consultant case                         | A partner manages setup without reading content. Outside agents stay deferred (owner decision)                  |

## Done

Kin is done when all of these hold for four straight weeks:

- The owner and at least two teammates use it every working day, from phones, with desktop as a second screen.
- At least four leads are live in at least three domains, each producing output the owner used that month. At least one acts in the outside world by signed approval.
- The list holds all four kinds of chat, and at least one group mixes people and several agents on different models, with agent talk folded.
- Every privileged action in the audit log has an owner-signed grant, `kin.audit.verify` is clean, and the hostile-member checklist passes on the current build.
- No reminder was missed. With three leads active, W0-2's latency targets still hold.
- A second organization runs on the same app and the walls suite is green.

## Waiting on the owner

- **The GitHub App:** creating and installing it needs the owner's GitHub sign-in. Blocks the merge in W1-4 and all of W6-1.
- **One paid eval run,** now with group cases.
- **Teammate cost:** decided before W5-5.
