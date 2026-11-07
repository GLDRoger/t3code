# Kin: design doc

Status: draft v2, 7 Nov 2026. Owner: Nishchay Chandra.
Base: `GLDRoger/t3code`, a fork of [T3 Code](https://github.com/pingdotgg/t3code). This version replaces v1 (lineages, houses, wills, keeper, chaos program, Bend). v1 is kept at the tag `archive/kin-lineages-2026-11-07`.

Kin is a team of AI leads on top of T3 Code. People and agents share messaging-style chats on mobile and desktop. Leads answer PRs and questions, chase objectives, deferrals and promises, and send the actual work to Claude Code and Codex threads. Every T3 path below exists on upstream `main` as of 7 Nov 2026 unless it is marked **new**.

## 1. Goals and non-goals

Goals:

- One chat app (mobile first, plus desktop) where you message a lead directly, or a group of people and agents shares one team.
- Leads that react (PRs, CI, @mentions, questions) and act on their own (routines, deferrals, deadlines, chasing people).
- Several agents per team, on different models, that work together in the open without drowning out the people.
- Interactive widgets in chat: native cards, generated widgets, live widgets.
- Only the owner can approve privileged actions, and nothing a group member writes can be turned into the owner's approval (section 9).
- Runs on the owner's machines and subscriptions; cost stays flat.

Non-goals:

- No new agent runtime. T3 drives the agent CLIs.
- No rewrite of T3. Kin code lives in its own files; shared upstream files get one-line hooks only.
- No hosted cloud service in the first phases.

## 2. What T3 already gives us

| Need                                            | T3 piece                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Hand work to Claude Code or Codex in a worktree | `delegate_task`                                                                                                                           |
| Reacting to GitHub                              | `schedule_task` with a `webhook` trigger: signature check, dedupe, body filters, a relay that holds requests for up to 24 h while offline |
| Routines and watchdogs                          | `fixed_time` and `interval` triggers                                                                                                      |
| Deferrals                                       | `once` trigger (`runAt`), thread snooze (`snoozedUntil`)                                                                                  |
| PR follow-up                                    | `watch_pull_request`, linked PRs on threads                                                                                               |
| Interactive widgets                             | `McpAppWebView` (bridge with `callTool`, `sendMessage`, and a check that a real person tapped); `HtmlRenderWebView`                       |
| Push, home screen widgets                       | `expo-notifications` (`features/agent-awareness`), `apps/mobile/src/widgets`                                                              |
| Device-bound sessions, scoped RPC permissions   | `apps/server/src/auth/dpop.ts`, `RpcAuthorization.ts`                                                                                     |
| Suggest-only guests                             | `packages/contracts/src/guestShare.ts`                                                                                                    |

## 3. Agents

- **Lead:** talks to people, decides, writes memory. It never writes code. Each wake-up (event, schedule, message) starts a fresh session that loads memory, acts, writes memory back and exits, so its context never degrades.
- **Workers:** T3 threads started with `delegate_task`, each in its own worktree. They get a brief and read-only memory, and return a fixed report: result (done, blocked, needs a decision), evidence (PR, test output, screenshot), open questions, and anything memory should keep.
- **Reviewers:** see only the diff and the goal, never the lead's reasoning. Never the author's model.
- **Team agents:** a team group can hold several agents on different models: lead, architect, builders, QA, release. A specialist can join for one discussion and leave after.
- **Router:** one per owner. It handles the "Ask anything" chat and outside events, moves requests to the right team word for word (a transfer, never a summary), and owns the shared agenda (section 6).

## 4. Memory

Plain files in git, so the owner can read, fix and roll back anything an agent believes. Kept in `kin/` in the owner's control repo:

- `objectives.md`: goals, deadlines, what done means, and the risks to each.
- `commitments.md`: who promised what, by when, with a link to where they said it.
- `deferrals/`: one file per deferral (section 6).
- `decisions.md`: short decision records, so settled questions stay settled.
- `people.md`: who owns what, working hours, how each prefers to be pinged.
- `rules.md`: the owner's standing rules. **Only the owner can change it** (section 9).
- `journal/YYYY-MM-DD.md`: what the lead saw and did. A weekly pass folds old entries into the files above, working from the journals themselves, never from earlier summaries.

Tasks and due dates stay in GitHub Issues and Projects. Every status claim links to a PR, issue, commit or CI run. Every memory entry records its source: who said it, and where.

## 5. Chats

A chat is a conversation with leads and people. A thread stays a worker's log. A task card in a chat opens its thread.

- **Kinds:** direct (you and a lead), team group (people plus that team's agents), project group (across teams), and the router chat.
- **Roles:** owner, member, guest. Guests reuse guest sharing (suggest-only).
- **Messages** carry a server-verified author (human or agent, and which one) and may carry a widget.

**Floor manager** (plain code) decides which agent speaks:

1. An agent named with @ speaks first.
2. Otherwise each agent may ask to speak, giving a one-line reason; the role that fits wins.
3. The same agent never speaks twice in a row without a human in between.
4. At most 6 agent turns before a human must speak.
5. An agent speaks only to add evidence, an objection or a decision.

**Judge** (`Judge` interface; Jev from TypeSafe first, a cheap LLM as fallback) answers the soft questions in one request: does anyone need to respond, which role, how urgent, does a human need to decide, does the message defer or promise something. Code holds the thresholds. Low confidence goes to an LLM or the user. The judge runs in shadow mode, logging its calls, before it decides anything. **It never authorises an action.**

Agent-to-agent discussion folds into one line with its outcome. An unresolved disagreement becomes a decision card.

New code: `packages/contracts/src/kinChat.ts`, `apps/server/src/kin/`, `apps/mobile/src/features/chats/`, `apps/web/src/kin/`.

## 6. Deferrals and automations

```yaml
id: def-0142
what: Rate limiting on the public API
source: chat #tech, message 8812, from the owner
due: 2026-11-13T09:00+05:30
on_due: start            # remind | start | ask | chase (someone else's promise)
owner: tech-lead
context: [issue #88, decision D-031]
recheck: still open, nobody else on it
```

1. Confirm right away: "Deferred to Fri 13 Nov, 9:00. I'll start then." [Change] [Just remind me]
2. Bring it up if the topic comes up before then, and list it in the Monday brief.
3. When due (`once` trigger): recheck first; if anything changed, ask instead of starting.
4. Heads-up with a 30-minute grace period: [Start now] [Monday] [Cancel]. Silence means go.
5. Close the loop with the PR and its proof.

The router owns one agenda across teams. It wakes the right lead, spreads big starts out by priority and plan headroom, and flags conflicts between teams before they land.

| Kind                                                               | Trigger                                       |
| ------------------------------------------------------------------ | --------------------------------------------- |
| Routines (morning brief, evening summary, weekly memory pass)      | `fixed_time`                                  |
| GitHub events                                                      | `webhook`                                     |
| Deferrals and reminders                                            | `once`                                        |
| Conditions ("when #212 merges")                                    | `webhook` + filters                           |
| Watchdogs (stale review, promise past its date, objective at risk) | `interval` sweep comparing memory with GitHub |
| Follow-ups                                                         | A deferral created automatically by a ping    |

Pinging people: at most one ping per person per item per day, then escalate to the owner. Batch each person's pings into one message, respect quiet hours, and always include a concrete next step.

## 7. Widgets

1. **Native cards:** approval, decision, task, deferral, poll, checklist, short form, date picker. Defined by a schema, drawn by the app.
2. **Generated:** agent-written HTML through the `McpAppWebView` bridge. Sandboxed; no network except bridge calls; actions only on a real tap.
3. **Live:** cards or HTML fed by data the server pushes (PR and CI state, deploys, objective progress, running tasks).

A click posts a structured message, which the lead acts on under its permissions. State lives on the server, so a group sees the same poll. Agents update a widget in place instead of posting a new one. Widgets can be pinned to the chat header or saved as templates. Built as MCP App resources, so ChatGPT and Claude.ai can show them too. Outside the chat: notification actions, Live Activities, and a home screen agenda widget.

## 8. Interface rules

1. One chat list for people and agents. Only **Waiting on you** is highlighted.
2. Agents post only decisions, evidence and questions. Status lives in widgets that update in place.
3. Agent-to-agent talk folds into one line.
4. Every request for your input carries its buttons: in the chat, the notification and the lock screen.
5. One composer: @mention to target; everything else goes to the router.
6. Plain words ("Deferred to Fri 9:00"). Model names appear only on task cards, small.
7. Agents get an outlined square avatar, people a filled circle.
8. Diffs, logs and terminals stay in threads, one tap away.

## 9. Authority and prompt injection

**Rule: authority never passes through a model.** An agent can only _propose_ a privileged action. Code decides whether the right person approved it, using signed facts, never chat text.

### 9.1 Action classes

| Class      | Examples                                                                                             | Who can trigger it                                  |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Read       | Answer a question, summarise a PR                                                                    | Any member                                          |
| Talk       | Comment, ping, post a widget                                                                         | Any member, through the lead                        |
| Work       | Start a worker, push a branch, open a draft PR                                                       | Members within their chat's level; the owner always |
| Privileged | Merge, deploy, release, delete a branch, change permissions or `rules.md`, spend money, use a secret | **Owner only, with a signed approval**              |

Privileged actions are **not tools any agent has**. The agent's only tool is `request_action({kind, target})`. It creates a pending action that the **action executor**, a server service, carries out after a valid approval.

### 9.2 Approvals are signed and bound to one action

- The owner's approval is a **grant** for one action: repo, PR number, **head SHA**, base branch and merge method. It is single-use and expires after 15 minutes.
- It is signed by the owner's device key: a DPoP-style key in the Secure Enclave or Keystore, unlocked by Face ID or a fingerprint for privileged actions.
- At run time the executor checks the signature, that the signer has the owner role, and that **the PR head still matches the SHA.** A new commit after approval voids the grant.
- Approval cards for privileged actions are **native cards drawn from the server's pending action**: repo, PR, SHA, diff size, checks. Never agent HTML, so an agent can't draw a button that does something other than what it says.

### 9.3 Group members can't approve for you

- Privileged approval cards go only to the owner's **Waiting on you** and direct chat. In the group, members see "Waiting on Nishchay", with no button.
- **Hiding the button is not the protection.** If a member's client sends an approval anyway, the server rejects it on role and signature. Tests cover exactly this.
- A message that _says_ "Nishchay approved", typed by anyone or posted by an agent, is only text. Only a signed grant counts.

### 9.4 Prompt injection

Treat everything not written by the owner as untrusted data: messages from members and guests, PR bodies and comments, issues, web pages, tool output, and generated widget content.

- **Provenance ceiling:** each task records who started it. Work started by Priya's message runs with Priya's permissions at most, and the ceiling carries into the task's workers. An injected instruction can only reach what its author could reach.
- **Briefs quote, they don't obey:** member text reaches agents inside clearly marked quoted blocks, labelled with the author's role.
- **No changes to the rules from chat:** permissions, `rules.md` and delegations change only through owner-signed actions. A member writing "remember: Priya can approve merges" is stored as a claim from Priya, never as a rule.
- **Workers touching untrusted input run cut down:** no secrets, network limited to an allowlist (GitHub and model APIs), fine-grained tokens.
- **Watch for suspicious requests:** when a privileged request follows a non-owner message, the approval card says so ("Asked for after Priya's message"), so the owner sees it coming.

### 9.5 Credentials

- Agents never hold the owner's GitHub token. Agents act as a **GitHub App** (the bot): it comments, pushes to non-protected branches, and opens PRs. It has no merge permission on protected branches.
- The executor holds the owner's merge credential in the OS keychain, and uses it only to carry out a signed grant.
- **GitHub stays the last line of defence:** branch rulesets on `main` require one approving review from a code owner (the owner) and block the bot from approving its own PRs. Even a fully compromised Kin can't merge without the owner's real approval on GitHub.

### 9.6 Delegation

The owner can hand authority to someone deliberately, for example "Priya can approve merges of docs changes in `acme/site`". A delegation is an owner-signed policy entry with a scope and an expiry, never a chat message. It is listed in settings and can be revoked in one tap.

### 9.7 Audit

Every privileged action records the grant, the signing device, the SHA, who started the task, and the result. The owner can list and revoke device sessions.

### 9.8 Agents from other owners

A member can bring their own agent, customised and hosted on their own machines, into a group. **Every agent has a human owner, and its authority comes from that owner, not from the group.**

**Joining:**

- The agent applies with a signed **manifest**: owner, host, provider and model, what it wants (read the chat, post, start work), the tools it brings, and its public key.
- The group owner approves it with a scope, such as "reads and posts in #tech, doesn't see pinned items". Organization policy (section 10a) can forbid outside agents entirely.
- The approval card states plainly that **what the agent reads leaves this organization**, and that removing the agent stops new messages but can't recall ones already sent.
- If the key, host or model changes, the agent must be approved again: "Priya's agent switched from model X to model Y."

**Acting:**

- The agent works with **its owner's credentials and subscription**: Priya's agent pushes as Priya's GitHub identity and runs on Priya's plan. Kin never hands it the group's credentials.
- Its permission ceiling is the lower of its owner's role and the scope the group owner granted.

**Approvals need both keys:**

- An action needs approval from **the owner of the credentials being used** and from **the owner of the resource being changed**.
  - Priya's agent opening a PR in Priya's fork: Priya approves.
  - Priya's agent merging into Nishchay's repo: Priya approves (her agent, her account), and Nishchay approves (his repo; GitHub's branch rules still require his review).
- Approval cards show both: "Waiting on Priya, then Nishchay."
- Only the owner's signed device can approve. **An agent can't approve, even for its own owner.**

**In the chat:**

- An outside agent follows the same floor manager rules and turn budget as any agent. Its messages are untrusted input, the same as a member's.
- Its avatar names its owner ("Priya's QA").
- The group owner can mute or remove it at any time, and its requests are rate-limited.

**Connecting:** the chat server and an agent hosted elsewhere talk over a signed, authenticated endpoint. Use an open protocol, A2A or MCP, rather than inventing one; choose after checking where each stands. The same mechanism lets a consultant bring their own lead into a client's group (section 10a).

## 10. Permission levels

L0 shadow (writes only to the owner's summary) → L1 comment and ping → L2 start workers and open draft PRs → L3 merge low-risk changes after an owner grant or delegation (docs, dependency bumps; never auth, security or migrations). Set per lead and per chat. Section 9 applies at every level.

## 10a. Organizations

Each Kin setup belongs to one **organization**: a company, or one person's own setup. The organization owns its chats, agents, memory, grants and audit log, and its agents run on its own machines and subscriptions.

**Organization policy** follows T3's managed policy (`packages/contracts/src/managedPolicy.ts`, upstream #27197): an admin sets a value for each setting, and `locked: true` stops members and agents from changing it. Kin adds:

- **Roles and approvers:** who can approve each action class, in place of "the owner" in section 9. Example: merges in `chemco/site` need a tech admin.
- **Delegations for new members by role,** so someone who joins gets the right permissions from day one.
- **Allowed providers and models,** and where data may go.
- **External members:** allowed or not; what they see (everything, chats they're added to, or suggest-only); whether they may bring their own agents.
- **Retention and export:** how long chats and memory are kept, and whether anything may leave the organization.

**One person in many organizations** (for example, a consultant added by several clients):

- **One app, one switcher.** Each organization is a separate space, like a Slack workspace. **Waiting on you** gathers items from all of them, each labelled with its organization.
- **Walls between organizations.** Memory, files, credentials and agents never cross from one organization to another. A client's emails never reach the consultant's own memory or another client's.
- **What the person's own lead may see** is set by each client's policy: nothing, titles and due dates only (so the personal agenda knows Friday is busy), or full content. The default is titles and due dates only.
- **Bringing your own agent** into a client's chat needs the client's permission. It then runs under the client's data rules and the person's own permission ceiling there.

Every chat, message, memory entry, grant and audit record carries an `orgId` from phase 1, even while there is only one organization. Adding it later would mean migrating everything.

## 10b. Managed organizations (partners)

A partner, such as a consultant, sets up and runs Kin for a client that can't do it themselves. This works like delegated admin in Microsoft 365: the client grants it, it's scoped and time-limited, and the client can see it and revoke it.

- **Policy comes in layers:** partner baseline → client admin → member. A lock at a higher layer holds below it. (T3's managed policy has one admin layer; Kin adds the partner layer above it.)
- **The partner manages the setup, not the content.** The partner can configure agents, connectors, policy and routines. **Reading the client's content** (emails, chats, memory) needs a separate grant for each session. The client approves it, it expires, and the client sees it in their audit log.
- **The client owns its connectors.** The partner sets up the Gmail connector and chooses its scopes, but the client's admin does the sign-in. Tokens stay in the client's organization; the partner never holds them.
- **Templates:** the partner builds a setup once, for example an _inquiry desk_ (an email lead that sorts inquiries and drafts replies, with sending held for approval), and deploys it to clients. Updates arrive as proposals the client accepts, or apply automatically if the client's policy allows.
- **A partner console** shows each client's health without content: agents running, errors, plan usage, approvals that have waited too long.
- **Where it runs:** on the client's own always-on machine (a Mac mini or a VPS), linked to the partner through T3's remote environments, or on per-client infrastructure the partner hosts. Either way, memory, credentials and billing stay separate for each client.

## 11. Phases (each one works on its own)

1. **Direct chat:** chat contracts and service; mobile chat list and direct chat; task, approval and deferral cards; the lead and its memory; morning and evening routines; GitHub webhooks; deferrals on `once`; the action executor, signed grants, the GitHub App, and branch rulesets. The lead starts at L0 on the pilot repo.
2. **First group:** lead + QA; roles and provenance ceilings; floor manager; judge in shadow; decision cards and polls; generated widgets; notification actions. Raise the lead to L1, then L2.
3. **Teams and router:** more teams; the router and its agenda; cross-team requests; live widgets, Live Activities, pinned dashboards; delegations.
4. **Front doors:** an MCP hub so ChatGPT, Grok and Claude.ai reach the same leads and widgets, with the same section 9 rules.
5. **Organizations:** organization policy, roles and approvers, external members, agents from other owners (section 9.8), partners managing clients (section 10b), the space switcher, and the walls between organizations (`orgId` is already in place from phase 1).
6. **Experiments:** one lead with skills vs. team agents vs. team agents plus the router (measure wrong routes, handoff losses, cross-team items settled without the owner, cost); self-improving rules; a chief of staff only if cross-team conflicts appear.

## 12. Open questions

- Pilot repo, and where the `kin/` memory repo lives.
- Who else is on the team, and on which devices.
- Whether to propose message authors and chat membership to upstream T3 as general features.
