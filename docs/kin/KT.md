# Kin: handover brief

Read this first if you're joining Kin, whether you're a person or an agent. It takes about 10 minutes. After it you should be able to pick up a task and ship it without asking anyone.

## What Kin is

Kin puts AI team leads into chat, built on [T3 Code](https://github.com/pingdotgg/t3code). Leads and people talk in messaging-style chats on the phone and desktop. A lead answers PRs and questions, keeps track of objectives, deferrals and promises, chases people, and hands the actual coding to Claude Code and Codex threads that T3 already runs. Think of a project lead you can message, who remembers, follows up and never merges without you.

Three examples of what it should do:

- You say "let's defer rate limiting to Friday". On Friday at 8:30 it says "Heads up, starting rate limiting at 9:00", then does the work and comes back with a PR.
- A PR is ready. The merge button appears only on your phone, behind Face ID. Nothing anyone else types in the group can approve it.
- Overnight it "dreams": it tidies its memory into a pull request you can read, and has a morning brief ready.

## Where we are (7 Nov 2026)

- The **design** is done: [DESIGN.md](DESIGN.md).
- The **specs** for phase 1 are done: [specs/](specs/). Each one is grounded in T3's real code, lists the files to add, and ends with numbered tasks.
- **The plan:** [PLAN.md](PLAN.md) puts all the tasks in order, shows which can run in parallel, and lists what's waiting on Nishchay.
- **No Kin code exists yet.** Phase 1 is a direct chat with one lead on the phone, running on a Mac mini at L0 (the lead only drafts, and the owner sees what it would have done).

## Read in this order

1. This brief.
2. [DESIGN.md](DESIGN.md) sections 1, 3, 5, 9 and 11 (about 20 minutes). Read the rest when your task needs it.
3. [KIN.md](../../KIN.md): branch rules, branding and syncing. It's short, and the rules matter.
4. [PLAN.md](PLAN.md), then the spec that owns your task.
5. Upstream's [AGENTS.md](../../AGENTS.md): how T3's code is built and checked. Everything there applies to Kin code too.

## The rules everything depends on

Break one of these and a PR won't merge.

1. **Authority never passes through a model.** An agent can only _propose_ a privileged action (merge, deploy, spend, change permissions) with `request_action`. Server code carries it out only after a signed approval from the right person's device. Chat text, including "Nishchay approved", never counts. See DESIGN section 9 and [specs/approvals.md](specs/approvals.md).
2. **The lead talks, workers build.** The lead never writes code. Workers are T3 threads in their own worktrees. Reviewers see only the diff and never run on the author's model.
3. **Memory is plain files in git** ([kin-memory](https://github.com/GLDRoger/kin-memory), private). Only the lead writes it, nothing is ever deleted (items are marked invalid instead), and every item records who said it.
4. **Everything carries `orgId`,** from the first migration onwards, even while there's only one organization.
5. **Kin code lives in its own files.** Upstream files get a hook of a line or two at most. Kin's tables use their own migration track, and its agent tools use their own `/kin/mcp` endpoint.
6. **Never rename T3 Code in source.** Kin's name and icons are applied at build time (KIN.md), so upstream merges never conflict.
7. **The public repo holds code only.** `GLDRoger/t3code` is public. Organization data, memory, tokens and keys never go in it.

## Repo map

| Where                                 | What                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GLDRoger/t3code`, branch `kin`       | All Kin work. A public fork of `pingdotgg/t3code`.                                                |
| branch `main`                         | An exact mirror of upstream. Never commit to it.                                                  |
| tag `archive/kin-lineages-2026-11-07` | The old Kin design and code (lineages, houses, wills). Superseded; don't build on it.             |
| `GLDRoger/kin-memory` (private)       | The lead's memory: rules, objectives, commitments, deferrals, decisions, people, claims, journal. |
| `packages/contracts/src/kin*.ts`      | Kin schemas shared by server and apps (new).                                                      |
| `apps/server/src/kin/`                | Kin server code (new).                                                                            |
| `apps/mobile/src/features/chats/`     | Kin mobile screens (new).                                                                         |
| `apps/web/src/kin/`                   | Kin web screens (new, later).                                                                     |
| `docs/kin/`                           | This brief, the design, the plan and the specs.                                                   |

## Setting up

```sh
git clone https://github.com/GLDRoger/t3code.git && cd t3code
git switch kin
git remote add upstream https://github.com/pingdotgg/t3code.git
vp i                 # installs; needs Node 26 and the vite-plus `vp` CLI
vp run dev           # server and web, with your own state in this checkout's .t3
```

Upstream's [development runbook](../operations/development.md#first-checkout) covers prerequisites, the mobile dev client (`vp run mobile:install ios`) and desktop builds. Use the free `Replay (dev)` provider to watch agent turns without paying for them (AGENTS.md).

## Shipping a task

1. Pick a task from [PLAN.md](PLAN.md) whose dependencies have merged.
2. Claim it with a draft PR titled `<ID>: <title>`, for example `CHAT-3: Repository`.
3. **Open the PR against the fork, never upstream.** `gh pr create` on a fork targets the parent repo by default, so always pass the repo and base:
   ```sh
   gh pr create --repo GLDRoger/t3code --base kin --draft --title "CHAT-3: Repository"
   ```
   Kin PRs don't belong on `pingdotgg/t3code`, and upstream doesn't take unsolicited features.
4. Build what the task says. Its "Done when" is the acceptance test.
5. Before pushing, run `vp run check:changed upstream/main`, plus the task's own test. Don't run repo-wide checks; CI does that.
6. Commits use Conventional Commits (`feat(kin): …`, `docs(kin): …`). The PR body is three short parts: **Why**, **How**, **Tests** (the commands you ran and their results).
7. If the spec turns out to be wrong, fix the spec in the same PR and say so.

**Security-sensitive tasks** need a second, careful review before merging: every APPR task, LEAD-3 (memory writer), LEAD-8 (level gating), LEAD-11 (stop switch), TRIG-5 (webhooks), TRIG-16 (secret scan) and TRIG-17 (purge). Nishchay approves these himself.

## If you're an agent

- Do your task within its files and stop. Don't start other tasks or refactor upstream code around it.
- Cite the files you changed and the checks you ran, with their results, in the PR.
- Nobody answers questions in the middle of a task. Make the reasonable call, then list your assumptions in the PR description.
- Never give yourself, or any agent, a way to approve, merge or change permissions. If a task seems to need one, stop and say so in the PR.

## Words we use

| Word                   | Meaning                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Lead                   | The agent that talks in a chat, decides and keeps memory. One per team at first.                             |
| Worker                 | A T3 thread a lead starts to do one piece of work, in its own worktree.                                      |
| Wake-up                | One run of the lead: it loads memory, handles the queued events, writes memory back and exits.               |
| Owner                  | The person whose machine, subscriptions and repos Kin uses. Only the owner approves privileged actions.      |
| Pending action / grant | What an agent asks for, and the owner's signed, single-use approval of it.                                   |
| Executor               | The server service that carries out a pending action once it has a valid grant.                              |
| Deferral               | "Let's do this Friday": a memory item with a due time and what to do then (remind, start, ask or chase).     |
| Dreaming               | The nightly job that tidies memory into a PR and prepares the morning brief.                                 |
| L0–L3                  | How much a lead may do on its own, from shadow (drafts only) to merging low-risk changes after a grant.      |
| Floor manager          | Plain code that decides which agent may speak in a group chat.                                               |
| Judge                  | A cheap classifier that answers soft questions ("does anyone need to reply?") and never authorises anything. |
| Next of kin            | The person who can approve undo actions when the owner can't be reached (phase 3).                           |

## Who to ask

Nishchay Chandra ([GLDRoger](https://github.com/GLDRoger)) owns the design and approves security-sensitive PRs. Questions about a task go on its PR. Questions about the design go in a PR that edits DESIGN.md, so the answer ends up written down.
