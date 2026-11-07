# Kin: leads, chats and widgets (design addendum)

Status: draft v1, 7 Nov 2026. Extends [DESIGN.md](DESIGN.md); where the two disagree, the open decisions at the end say which way to go.

Kin Phase 1 keeps a codebase's agent team coherent (houses, lineages, wills, keeper). This addendum adds the layer people talk to: **leads** that answer in messaging-style chats, chase objectives, deferrals and promises, and send the work to Phase 1 lanes. It replaces most of Phase 2's assistant side with one chat app on mobile and desktop.

## 1. What maps onto what Kin already has

| Idea                        | Kin piece it builds on                                                                  | New                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Lead (the agent that talks) | Main agent + agent profile (`.kin/agents/lead.md`)                                      | Fresh session per wake-up; never runs long                               |
| Workers                     | Lanes, crowned, with wills                                                              | Nothing; leads just open lanes                                           |
| Reviewers                   | Blind reviewer profiles                                                                 | Nothing                                                                  |
| Lead memory                 | Keeper, at a new `team:<id>` scope; `.kin/` mirror                                      | Objectives, commitments, deferrals, decisions, people                    |
| Journal                     | Day threads (DESIGN.md §11)                                                             | Becomes the lead's daily journal                                         |
| Objectives                  | Sagas (§11)                                                                             | A saga with a deadline, a definition of done and risks                   |
| Team                        | House (code area)                                                                       | **Team**: a company function (tech, marketing, finance) that owns houses |
| Router                      | Main agent across teams                                                                 | Thin dispatcher; owns the shared agenda                                  |
| Reacting to GitHub          | `schedule_task` webhook triggers (signature check, dedupe, filters, 24 h offline relay) | Lead skill handlers                                                      |
| Routines                    | `fixed_time` and `interval` triggers                                                    | Morning brief, evening summary, watchdog sweep                           |
| Deferrals                   | Thread snooze (`snoozedUntil`)                                                          | **One-off trigger** (`at`) in `scheduledTask.ts`; offer it upstream      |
| Interactive widgets         | `McpAppWebView` bridge (`callTool`, `sendMessage`, real-tap check), `HtmlRenderWebView` | Chat widget messages; native cards                                       |

## 2. Chats

A chat is a conversation with leads and people. A thread stays a lane's work log. A task card in the chat opens the thread.

- **Kinds:** direct (you and a lead), team group (people + that team's agents), project group (across teams), and the router chat ("Ask anything").
- **Members:** owner, member, guest. Guests reuse `guestShare.ts` (suggest-only).
- **Messages** record their author (human or agent, and which one) and may carry a widget.
- **Push** uses the existing `expo-notifications` path, with action buttons.

New code lives in its own files: `packages/contracts/src/kinChat.ts`, `apps/server/src/kin/chat/`, `apps/mobile/src/features/chats/`, `apps/web/src/kin/chats/`. Shared upstream files get one-line hooks only (KIN.md rule).

## 3. Agents in a group

Several agents per team group, on different models: lead, architect, builders, QA, release. More can join for one discussion and leave after.

**Floor manager** (plain code, `apps/server/src/kin/chat/FloorManager.ts`):

1. An agent named with @ speaks first.
2. Otherwise each agent can ask to speak, giving a one-line reason; the role that fits wins.
3. The same agent never speaks twice in a row without a human in between.
4. At most 6 agent turns before a human must speak.
5. An agent speaks only to add evidence, an objection or a decision.

**Judge** (`Judge` interface; Jev first, a cheap LLM as fallback) answers the soft questions in one request: does anyone need to respond, which role, how urgent, does a human need to decide, does the message defer or promise something. Code holds the thresholds. Low confidence goes to an LLM or to the user. The judge never authorises an action. It runs in shadow mode, logging its calls, before it decides anything.

Agent-to-agent discussion folds into one line with its outcome. A disagreement left unresolved becomes a decision card.

## 4. Deferrals and automations

```yaml
id: def-0142
what: Rate limiting on the public API
source: chat #tech, message 8812
due: 2026-11-13T09:00+05:30
on_due: start            # remind | start | ask | chase (someone else's promise)
owner: tech-lead
context: [issue #88, decision D-031]
recheck: still open, nobody else on it
```

1. Confirm right away: "Deferred to Fri 13 Nov, 9:00. I'll start then." [Change] [Just remind me]
2. Bring it up if the topic comes up before then, and list it in the Monday brief.
3. When due: recheck first; if anything changed, ask instead of starting.
4. Give a heads-up with a 30-minute grace period: [Start now] [Monday] [Cancel]. Silence means go.
5. Close the loop with the PR and its proof.

The router owns one agenda across teams: it wakes the right lead, spreads big starts out by priority and plan headroom (`usedPercent`), and flags conflicts between teams before they land.

| Kind                                                               | Trigger                                       |
| ------------------------------------------------------------------ | --------------------------------------------- |
| Routines                                                           | `fixed_time`                                  |
| GitHub events                                                      | `webhook`                                     |
| Deferrals, reminders                                               | snooze + one-off `at`                         |
| Conditions ("when #212 merges")                                    | `webhook` + filters                           |
| Watchdogs (stale review, promise past its date, objective at risk) | `interval` sweep comparing memory with GitHub |
| Follow-ups                                                         | A deferral created automatically by a ping    |

Pinging people: at most one ping per person per item per day, then escalate to the owner. Batch each person's pings into one message, respect quiet hours, and always include a concrete next step.

## 5. Widgets

1. **Native cards:** approval, decision, task, deferral, poll, checklist, short form, date picker. Defined by a schema.
2. **Generated:** agent-written HTML through the `McpAppWebView` bridge. Sandboxed; no network except bridge calls; actions only on a real tap.
3. **Live:** cards or HTML fed by data the server pushes (PR and CI state, deploys, objective burn-down, running lanes).

Rules: a click posts a structured message that the lead acts on under its permissions. State lives on the server. Agents update a widget in place instead of posting a new one. Widgets can be pinned to the chat header or saved as templates. Built as MCP App resources so ChatGPT and Claude.ai can show them too. Outside the chat: notification actions, Live Activities, and a home screen agenda widget (next to `src/widgets`).

## 6. Rules for an uncluttered interface

1. One chat list for people and agents. Only **Waiting on you** is highlighted.
2. Agents post only decisions, evidence and questions. Status lives in widgets that update in place.
3. Agent-to-agent talk folds into one line.
4. Every request for your input carries its buttons: in the chat, the notification and the lock screen.
5. One composer: @mention to target; everything else goes to the router.
6. Plain words ("Deferred to Fri 9:00"). Model names appear only on task cards, small.
7. Agents get an outlined square avatar, people a filled circle.
8. Diffs, logs and terminals stay in threads, one tap away.

## 7. Permission levels

L0 shadow (writes only to the owner's summary) → L1 comment and ping → L2 open lanes and draft PRs → L3 merge low-risk changes (docs, dependency bumps; never auth, security or migrations). Set per lead and per chat.

## 8. Phases (each one works on its own)

0. Run `scripts/kin-sync.ts` (`kin` is about 1,600 commits behind upstream).
1. **Direct chat:** chat contracts and service; mobile chat list and direct chat; task, approval and deferral cards; lead profile and `team:` keeper scope; routines; GitHub webhooks; deferrals with the one-off trigger. The lead runs at L0 on the pilot repo.
2. **First group:** lead + QA; floor manager; judge in shadow; decision cards and polls; generated widgets; notification actions. Raise the lead to L1, then L2.
3. **Teams and router:** more teams; the router and its agenda; cross-team requests; live widgets, Live Activities, pinned dashboards.
4. **Front doors:** an MCP hub so ChatGPT, Grok and Claude.ai reach the same leads and widgets.
5. **Experiments:** one lead with skills vs. team agents vs. team agents plus the router (measure wrong routes, handoff losses, cross-team items settled without the owner, cost); self-improving rules; a chief of staff only if cross-team conflicts appear.

## 9. Open decisions

- **D1. The bridge rule.** DESIGN.md §12 says the assistant never drives agents, and lanes it requests need approval in the IDE. Leads open lanes themselves from L2. Proposal: leads live on the IDE side, and the §12 bridge keeps covering the personal (life-scope) assistant only.
- **D2. Phase 2.** Proposal: chats replace the separate assistant views; day threads become the lead's journal; sagas become objectives.
- **D3. Pilot repo.**
- **D4. Who else is on the team,** and on which devices.
