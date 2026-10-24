# Kin: design doc

Status: draft v1, 24 Oct 2026 (IST). Owner: Nishchay Chandra (Questili).
Base: `GLDRoger/t3code`, Questili's fork of T3 Code (upstream https://github.com/pingdotgg/t3code, MIT, TypeScript). Upstream `main` is merged into the fork first. All Kin work then lands on a long-lived `kin` branch, which is Kin's trunk.

Kin is one app you launch (CLI command `kin`). Lineages are its core feature: Kin tracks each house's lineage. Inside it are two separate backends: an agent-orchestration IDE (Phase 1, product-defining) and a personal assistant (Phase 2). They talk only through one narrow, typed interface.

Convention: any file path marked "(to confirm)" is a proposal or an unverified location. Every other upstream path below was seen in the upstream repo tree on 24 Oct 2026.

---

## 1. Goals and non-goals

### Goals
- G1. Run Codex and Claude Code as first-class underlying agents. This is mandatory. Pi and the other upstream providers keep working but are optional.
- G2. Give every main agent and every subagent its own system prompt. Subagents are malleable: each can have its own prompt and its own user MD files.
- G3. Support global user MD files (`AGENTS.md`, `CLAUDE.md`) and project MD files without double-injecting what the CLIs already load natively.
- G4. Multi-agent orchestration with roles (main, implementer, reviewer, researcher, archivist, …) and divisions (houses).
- G5. Lineages as the core idea: knowledge passes from agent to heir through crownings, wills and a shared notes board, so a codebase's agent team stays coherent over weeks.
- G6. An archivist that keeps a fresh, bounded chronicle, plus three layers of context, a chaos program, self-healing, and durable owner rules.
- G7. A Bend verification layer (`kin verify`) that every agent runs on its own work, tied into the chaos program and self-healing (section 10).
- G8. One launchable app, with the assistant side as a separate module that reaches the IDE only through the interface in section 12.

### Non-goals
- Not a new agent runtime. Kin drives the Codex and Claude Code CLIs through T3 Code's adapters and does not reimplement them.
- Multi-model routing is not product-defining. Cross-model review and escalation are an optional policy, off by default (section 9).
- No rewrite of Kin itself in Bend (section 10 explains why).
- The assistant side (day threads, sagas, memory keeper) is not in Phase 1.
- No cloud service of our own in Phase 1. Everything runs where T3 Code's server runs.

---

## 2. What upstream T3 Code already gives us

T3 Code calls itself an "agent harness control surface". It drives Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity and Pi through their own CLIs and subscriptions. It has web, Electron desktop and mobile clients.

| Area | Upstream location | What Kin uses it for |
|---|---|---|
| Server: WebSocket, orchestration, providers, checkpoints | `apps/server` | Host for the Lineage services |
| Pure orchestrator (commands to events, no I/O) | `apps/server/src/orchestration-v2/Orchestrator.ts` | Crowning and will commands get serialized ordering for free (this replaces the old `flock`) |
| Event sink (events, projections, receipt and outbox in one transaction) | `apps/server/src/orchestration-v2/EventSink.ts` | Kin projections commit with the run that produced them |
| Effect worker (side effects after intent) | `apps/server/src/orchestration-v2/EffectWorker.ts` | Archivist runs, sweeps and follow-up turns |
| Run finalization | `apps/server/src/orchestration-v2/RunFinalizationService.ts` | The "will before exit" gate hooks here (to confirm exact hook) |
| Codex adapter | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/provider/CodexDeveloperInstructions.ts` | Per-agent system prompt goes in as `developer_instructions` |
| Claude adapter | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | Per-agent system prompt goes in through `append-system-prompt` |
| Shared instructions | `packages/provider-core/src/server/runtimeInstructions.ts`, `packages/provider-core/src/server/orchestrationInstructions.ts` | Kin prompt layers compose after these |
| Provider drivers | `apps/server/src/provider/Drivers/{CodexDriver,ClaudeDriver,ClaudeHome,CodexHomeLayout,ClaudeSkills}.ts` | Home/config isolation for each agent profile (to confirm feasibility) |
| Orchestrator MCP tools | `packages/contracts/src/orchestratorMcp.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/mcp/toolkits/orchestrator/` | Already has `delegate_task` (roles `implementation`, `research`, `review`, `design`, `test`, `general`; isolation `shared` or `worktree`; mode `async` or `wait`), task status/cancel, `create_threads`, thread list/read/send/wait/interrupt, capabilities and `schedule_task` |
| MCP toolkit pattern | `apps/server/src/mcp/toolkits/<name>/{tools,handlers}.ts`, `apps/server/src/mcp/McpToolAccess.ts` | New `lineage` toolkit, and per-role tool access (reviewers are blind to wills) |
| Scheduled tasks | `apps/server/src/scheduledTasks/` | Hourly error sweep, archivist trigger checks |
| Usage limits | `packages/contracts/src/providerUsageLimits.ts`, `apps/server/src/usage/` | Optional usage-aware scheduling |
| Review service | `apps/server/src/review/ReviewService.ts` | SHIP / FIX FIRST verdicts (to confirm fit) |
| Migrations | `apps/server/src/persistence/Migrations/` | Lineage tables |
| Contracts and RPC | `packages/contracts/src/rpc.ts` | New Kin RPCs for the UI |

Upstream's `AGENTS.md` rules carry over. Complexity stays at the adapter boundary, orchestration stays pure, and the UI stays dumb. Server features are Effect services, and transports (WS handler, MCP tool) stay thin.

Our fork `GLDRoger/t3code` added `delegate_task`, `schedule_task`, `task_status` and `t3_thread_send`. Upstream now ships its own versions of these. When upstream `main` is merged into the fork, prefer upstream's tools and keep a fork tool only where it fills a real gap (open question Q1). Expect conflicts in the MCP and orchestrator code.

---

## 3. Architecture

```
                ┌────────────── Kin app (Electron desktop / web / mobile) ──────────────┐
                │   IDE views (threads, houses, lanes, chronicle)   Assistant views (Phase 2)│
                └───────────────┬──────────────────────────────────────────┬─────────────┘
                                │ typed RPC (packages/contracts)            │
        ┌───────────────────────▼───────────────┐        ┌─────────────────▼──────────────┐
        │ IDE backend (T3 Code server, forked)   │◄──────►│ Assistant backend (Phase 2)    │
        │  Orchestrator ─ EventSink ─ EffectWorker│ Bridge │  Day threads, Sagas            │
        │  Lineage service (houses, lanes,       │ (sec.12)│  Memory keeper (Keeper, life   │
        │   crowns, wills, notes)                │        │   scope)                       │
        │  Agent profiles + prompt composer      │        └────────────────────────────────┘
        │  Keeper (archivist scope)              │
        │  Chaos hooks, error sweep, Bend verifier   │
        └───────┬───────────────────┬────────────┘
                │ adapters          │ MCP (t3-code + lineage toolkits)
        ┌───────▼──────┐    ┌───────▼──────┐
        │ Codex CLI     │    │ Claude Code  │   (Pi and other upstream providers optional)
        └───────────────┘    └──────────────┘
```

- The IDE backend is the forked T3 Code server plus new Effect services: `LineageService`, `AgentProfileService`, `PromptComposer`, `Keeper`, `ChaosHooks`, `ErrorSweep` and `BendVerifier`. Proposed home: `apps/server/src/lineage/` (to confirm).
- The assistant backend is a separate module with its own storage. Proposed home: `apps/assistant` or `packages/assistant` (to confirm). It never imports IDE internals.
- `packages/keeper` holds the shared Keeper component (section 7), used by both sides.
- The bridge is the only crossing point. It's a typed contract in `packages/contracts/src/kinBridge.ts` (to confirm), and every call is logged on both sides.

---

## 4. Agents, system prompts and MD files

### 4.1 Agent profiles
An agent profile is a file. Project profiles live in `.kin/agents/<name>.md` and user profiles in `~/.kin/agents/<name>.md` (to confirm). Each has frontmatter plus a body, and the body is the system prompt.

```yaml
---
name: house-implementer
role: implementer          # main | implementer | reviewer | researcher | archivist | custom
provider: codex            # codex | claudeAgent | pi | inherit
model: inherit
reasoningEffort: inherit
userMd:                    # extra MD files this agent alone reads
  - .kin/md/house-rules.md
  - ~/.kin/md/nishchay-style.md
tools:                     # lineage toolkit access
  lineage: [add, read, areas, crown, will, lineages]
crownable: true
seesWills: true
---
You are an implementer in house {{house}}. ...
```

- The main agent has a profile too (`main.md`). Subagents spawned with `delegate_task` pick a profile by name. This is a proposed new optional `profile` field on `OrchestratorMcpDelegateTaskInput`.
- Profiles are malleable. A main agent can define an ad-hoc subagent by passing an inline prompt and MD list, which is saved to `.kin/agents/_adhoc/` for audit.

### 4.2 Prompt composition order
1. T3 runtime and orchestration instructions (upstream, unchanged).
2. The Kin base prompt: lineage rules, the "Start here" step, the will requirement.
3. The profile body (role prompt).
4. The profile's `userMd` files, in order.
5. The brief: the task, then Your family, The court, house wills and notes (section 5.3).

Global MD files are not re-injected when the CLI already loads them. Claude Code reads `CLAUDE.md` and `~/.claude/CLAUDE.md`, and Codex reads `AGENTS.md` and `~/.codex/AGENTS.md`. Kin only injects files the target CLI would not discover. So that both CLIs see one source of truth, the project `CLAUDE.md` is a one-line import of `AGENTS.md`.

Delivery: Codex gets the composed prompt through `developer_instructions` (CodexAdapterV2) and Claude through `append-system-prompt` (ClaudeAdapterV2).

### 4.3 Provider-native subagents
Claude Code and Codex can spawn their own internal subagents. Kin cannot fully control those prompts. Only Kin-spawned subagents (separate T3 threads) are guaranteed their own profile. Whether profiles can also be mirrored into native subagent definitions (for example `.claude/agents/`) is open question Q4.

---

## 5. Lineages (core)

### 5.1 Concepts
- House: an area of the codebase, for example `server-orchestration` or `web-ui`. Lanes map to houses by lane-name regex patterns, held in `.kin/houses.tsv` (pattern → house). This replaces the old `lineages.tsv`, and an importer reads the old file.
- Lane: one unit of work run by one agent thread. A lane's identity is carried in thread metadata, which replaces the old `EEVEE_LANE_LABEL`. The env var is still exported for compatibility.
- Crowning: when an agent finishes a lane, it is crowned in its house with the next regnal number (for example "web-ui IV"). Numbers come from a serialized orchestrator command, so they stay monotonic without file locks.
- Will: a message of at most 2,500 characters from a crowned agent to its heir. It is required before exit.
- Line: the chain of agents that worked the same lane lineage. `line_of()` resolves it.
- Notes board: a shared, append-only board of short notes tagged by house.

### 5.2 Lineage MCP toolkit
New toolkit: `apps/server/src/mcp/toolkits/lineage/{tools,handlers}.ts` (to confirm, following the upstream pattern).

| Tool | Purpose |
|---|---|
| `lineage_add` | Add a note to the board, tagged with house(s) |
| `lineage_read` | Read notes (by house, since, author) |
| `lineage_areas` | List houses and their patterns |
| `lineage_crown` | Crown the calling agent in its house and return its regnal number |
| `lineage_will` | Write the will (max 2,500 chars; rejected if longer) |
| `lineage_lineages` | Show houses, reigns and lines |

### 5.3 Brief assembly (heir view)
Each brief for a crownable agent opens with this, in order:
1. **Start here**: which files and notes to read first, with a pointer to the house agent map.
2. **Your family**: wills from the agent's own line (same lane lineage, via `line_of()`), newest first.
3. **The court**: the latest wills from other houses that touch this lane's files.
4. **House wills and notes**: the rest of the house's wills and recent notes.

### 5.4 Rules
- A will is required before exit. If a crownable lane's run ends with no will, run finalization sends one follow-up turn asking for it. If the will is still missing, the lane is marked `will_missing` and shown in the UI. Agents cannot skip the will silently.
- Reviewers are never crowned and are blind to wills. A reviewer profile has `crownable: false` and `seesWills: false`, and `McpToolAccess` denies `lineage_will` reads for it. Reviews stay independent of what the author's line believes.
- First reads is required. Our evaluation (25 crownings, 22 wills) found heirs read only 16 of 28 predecessor wills. So every lane report must open with a "First reads" line listing which wills and notes the agent actually read. The server checks it against the `lineage_read` calls it logged, and the UI flags any mismatch.
- Misleading notes is required. Every lane report must carry a "Misleading notes" line naming notes or wills that turned out wrong, or saying "none". Flagged notes are marked on the board, and the archivist sees the flags.

---

## 6. Three layers of context

1. `AGENTS.md` at the repo root: durable project rules. `CLAUDE.md` is a one-line import of it.
2. Per-house agent maps at `docs/agent-maps/<house>.md`: what lives in the house, its invariants and its traps.
3. The live notes board: the Lineage toolkit.

Every brief starts with the Start here step pointing into these layers. Warm-start (handing a new agent the previous agent's working context) showed only a marginal gain before, so it is optional and off by default.

---

## 7. Keeper: shared component (archivist now, memory keeper later)

The archivist and the memory keeper are the same pattern at different scopes. We build it once in `packages/keeper` (to confirm).

```ts
interface KeeperScope {
  id: string;                         // "repo:<projectId>" | "life:<userId>"
  sources(): AsyncIterable<Entry>;    // wills+notes | day-thread entries
  trigger: { minNewWills?: number; minNewNotes?: number; minNewEntries?: number; schedule?: string };
  output: { path: string; maxBytes: number; maxAgeHours: number };
  rebuildEvery: number;               // full rebuild cadence in passes
}
```

### Archivist (repo scope; Phase 1B)
- One long-lived session per project, using the main agent's provider by default.
- Runs when at least 8 new wills or at least 30 new notes have piled up since the last pass.
- Writes `chronicle.md` starting with "As of <time>".
- Consumers (the brief builder) ignore a chronicle that has no timestamp, is older than 12 h, or is larger than 24 KB.
- Wills written after the "As of" time are appended verbatim below the chronicle in the brief.
- It never summarizes its own summaries. Each pass reads primary sources (wills and notes), not the previous chronicle body.
- Every 4th pass rebuilds from scratch.
- It must actually run and be observable. Last time the archivist never ran, so Phase 1B's acceptance includes a test that fires the trigger and checks the chronicle is fresh.

---

## 8. Reliability: chaos program, self-healing, owner rules

### 8.1 Chaos program
- Four tiers of fault injection, from simple to severe. The tier contents get re-derived from the old `CHAOS-PROGRAM.md`, which should be imported first.
- Nine invariant oracles. Two examples are "no lost work" and "every action recorded". The full list is ported from the old program and expressed as checks over the T3 event log and projections.
- Hooks are compiled in but active only when `KIN_CHAOS=1` (to confirm name). With the flag off, they're no-ops.
- Each oracle runs as a test using upstream's drainable workers and replay testkit (`apps/server/src/orchestration-v2/testkit/`).
- Where an oracle fits a model, it is also checked by the Bend verification layer (section 10.3).

### 8.2 Self-healing
- An hourly error sweep is a scheduled task. It reads server logs, failed runs and oracle failures, deduplicates them by signature, and opens a fix lane per new signature in the right house.
- Rate limit and dedupe live in the sweep. The parameters are open question Q6.
- A fix only counts as healed once `kin verify` passes with the failing trace in the regression corpus (section 10.4).

### 8.3 Durable owner rules
- Owner rules live in files so they survive context compaction: `.kin/OWNER-RULES.md` in the project and `~/.kin/OWNER-RULES.md` globally (to confirm). They are injected in every brief by the prompt composer, never only in chat.
- They replace the old `OWNER-AUTHORIZATION.md` and `LEDGER.md` pattern. An importer reads those files.

---

## 9. Routing policy (optional, off by default)

This is not product-defining. It depends on a user's budget and willingness to run more than one model at once. It turns on when a second provider is connected and the user enables it.

- Cross-model review: the reviewer runs on the other model, and the verdict is SHIP or FIX FIRST.
- Fresh-author escalation: a stuck lane is handed to a fresh author on the other model with a "fix the whole class" rule. In one case this took 131 wrong answers to 0 of 300.
- Usage-limit-aware scheduling: work is deferred or rerouted when a provider is near its limit, using upstream's usage-limit data.

The policy sits behind a settings toggle and a policy module, so the core never branches on it.

---

## 10. Bend verification layer

Nishchay's direction: Bend is a verification layer that every agent uses to check its own work. It ties into the chaos program (oracles and invariant checks) and into self-healing (verifying fixes).

### 10.1 What the sources actually say
- **Verification is real and central to Bend 2.** Bend 2 calls itself "a fast language that blocks AI mistakes via proof". Its type checker is a proof checker. Owners write rules in `LAWS.bend`, agents write proofs in `PROOF.bend`, and `bend PROOF.bend` must pass before committing. Its own pitch is "`LAWS.bend` is `AGENTS.md` backed by proof". Parallel execution (C, CUDA, Metal; divide-and-conquer across cores or the GPU) is a second pillar, not the only one. Bend 1 and HVM do not carry over. The claim Nishchay heard is therefore directionally right.
- **Fast checking is the project's own claim.** The project says the checker runs in under a second where other proof assistants take minutes. Its benchmarks are its own, and it says it has fewer checker benchmarks than it would like. The bend2.dev notes record 0.08 s for one `--check-only` run on an M3 Max. I found no independent evaluation.
- **The guarantees are narrow.**
  - Proofs cover only the laws that were written, about Bend code. They say nothing about TypeScript code, runtime I/O, or requirements nobody wrote down.
  - The everyday checker has no proof and may have bugs. `--verdict` rechecks with a small kernel that has Lean proofs, but the translation into that kernel is unproved, and `--verdict` needs an exact Lean version.
  - The compiler, apart from the kernel, is described as 99% AI-written and not fully audited.
  - There are no tactics and no proof search, so proofs are explicit terms and take real effort.
- **The gate can be gamed unless the harness owns it.** Issue `bendlang/bend#776` (Sep 2026) showed that `bend PROOF.bend` exited 0 when an `@unsafe` def sat in the import graph, or when `PROOF.bend` simply didn't import `LAWS.bend`. The missing-import case was fixed in 2.0.8. Later bend2.dev notes say the checker rejects proofs that rely on `@unsafe` or foreign code, which we should confirm on the installed version. Bend's own docs warn that an agent can weaken a law until its proof passes.

Bottom line: Bend is a credible proof checker for Bend code, and it is young. Kin's own code and most client code are TypeScript, so Bend cannot verify them directly. The honest design uses Bend in three ways: (a) proofs for Bend code and for small Bend models of critical logic, (b) fast, massively parallel checking of those models against real execution traces and generated inputs, and (c) a harness-owned gate, so an agent cannot quietly weaken or skip the check.

### 10.2 The layer: `kin verify`
Every agent calls `kin verify` (also exposed as the MCP tool `lineage_verify`) before it asks to be crowned. Kin then reruns the same check itself, and the crown depends on Kin's run, not the agent's. The command runs whichever levels the project has:

| Level | What runs | What it proves or checks | Applies to |
|---|---|---|---|
| V0 Gate integrity | Kin checks law ownership and the Bend config | `LAWS.bend` unchanged, or its diff approved by the owner or a reviewer; `PROOF.bend` imports `LAWS.bend`; no `@unsafe` or foreign defs reachable from proofs; exit status 0 | any project with `LAWS.bend` |
| V1 Proofs | `bend PROOF.bend` (optional `--verdict` strict mode) | the written laws hold for the Bend code | Bend code, and Bend models |
| V2 Model laws | Laws over a small Bend model of critical logic | e.g. for Kin: regnal numbers strictly increase within a house; no lane is crowned without a will; a reviewer is never crowned; a lane in `will_missing` never becomes `crowned` without a will | Kin itself (lane state machine), and client modules with a clear state machine |
| V3 Trace conformance | A Bend program replays recorded event-log traces through the model, splitting the trace set in halves so the work spreads over cores or the GPU | the real TypeScript system's observed behaviour stays inside the proven model | chaos runs, CI and replay fixtures |
| V4 Bounded property sweeps | Bend generates many inputs or operation sequences for the model and checks unproven properties in parallel | a property survives exhaustive checking up to a bound; it is evidence, not proof | invariants not yet proven |

Levels the TypeScript tests and chaos oracles already cover are not duplicated in Bend. Bend is added where a model plus laws gives a stronger guarantee than a test.

### 10.3 Ties to the chaos program
- Each of the nine oracles is labelled `proved-in-model` (V2), `trace-checked` (V3), `swept` (V4) or `runtime-only` (needs the TypeScript oracle). For example, "every action recorded" fits V3 as a per-trace check; "no lost work" needs runtime checks over git and worktree state and stays mostly runtime-only.
- Chaos runs export traces in a compact line or numeric format, because Bend has no JSON library and its strings are slow linked lists. V3 checks every trace from every tier.
- A trace the model rejects is either a real bug, which opens a fix lane, or a model gap, which opens a model lane where the owner reviews the law change.

### 10.4 Ties to self-healing
A fix lane opened by the hourly sweep only counts as healed when all of these hold:
1. The failing trace or input is added to the regression corpus.
2. V3 passes on it, together with the whole corpus.
3. V1 and V2 still pass.
4. V0 confirms no law was weakened. Any `LAWS.bend` diff goes to owner or reviewer review, never self-approved.

The fix lane's will records which levels ran.

### 10.5 What we are not claiming
- Bend does not formally verify TypeScript. V2 and V3 verify a model and check that real traces conform to it.
- V4 is bounded checking, not proof.
- Speed figures are the Bend project's own. Phase 1C should measure `kin verify` on our own models and corpus before we rely on it in the hot path.
- Writing Kin's orchestrator or server in Bend is out. Bend currently has no HTTP, TLS, JSON or regex in its base library, its JS target is single-core, and orchestration is I/O-bound.
- Bend is opt-in per project. It runs on Linux and macOS only (no Windows; WSL works), and needs clang 14+ for native builds.

### 10.6 Toolchain support
- Detect the `bend` binary, pin a version per project, and record the version in every gate result.
- Offer to add Bend's recommended AGENTS.md block: run `bend guide`, keep rules in `LAWS.bend`, run `bend PROOF.bend` before committing, and parallelize. Add Kin's stricter line: never edit `LAWS.bend` without asking.
- Show `LAWS.bend` in a house's agent map as that house's hard rules.
- Add a `bend-implementer` agent profile.
- `.bend` editor support via `bend-fmt-lsp` or the community `bend2-lsp` (to confirm how T3 Code's editor views load LSPs).

## 11. Assistant side (Phase 2, separate module)

- **Day threads**: a fresh thread each day, which forms the timeline.
- **Sagas**: topics that span days and can correlate with or build on earlier sagas (for example "Avalon Flow launch on X" builds on "Avalon Flow v1"). A saga has a status, links to parent and related sagas, and a running summary.
- **Memory keeper**: a Keeper instance at life scope. It files each day thread's work into sagas, opens new sagas, links related ones, and self-regulates memory: it decides what to keep verbatim, what to summarize, and what to drop, under the same rules as the archivist (fresh primary sources, no summaries of summaries, periodic rebuild).
- **Where it runs**: a separate backend module inside the Kin app. Nishchay considered building this side on an open-source agent desktop such as Cua. That is an option to evaluate in Phase 2, mainly for its memory and thread model, and not a decision.

---

## 12. IDE ↔ assistant interface (the bridge)

The bridge is narrow, explicit and typed, and every call is logged on both sides. The assistant never drives agents, edits code, or reads raw wills or notes.

| Direction | Call | Effect | Consent |
|---|---|---|---|
| Assistant → IDE | `ide.status({projectId?})` | Read-only: open lanes, recent crownings, chronicle head ("As of" + first section), failing gates | none |
| Assistant → IDE | `ide.request_lane({projectId, goal, house?, priority, sagaId?})` | Creates a lane in `proposed` state | the user approves in the IDE before it runs (default) |
| Assistant → IDE | `ide.subscribe({events: ["lane.crowned","lane.failed","review.verdict","sweep.opened"]})` | Event stream | none |
| IDE → Assistant | `assistant.post_to_day({summary, links, sagaHint?})` | Appends an entry to today's day thread; the memory keeper files it | none |
| IDE → Assistant | `assistant.saga_context({sagaId})` | Read-only saga summary the main agent can attach to a brief | the user's per-project toggle |

Contract file: `packages/contracts/src/kinBridge.ts` (to confirm). Transport: an in-process service call when both run in one server, and authenticated RPC if they are split later.

---

## 13. Data model

| Entity | Key fields | Notes |
|---|---|---|
| House | `id`, `projectId`, `name`, `patterns[]`, `agentMapPath` | patterns from `.kin/houses.tsv` |
| Lane | `id`, `projectId`, `houseId`, `label`, `threadId`, `lineId`, `profile`, `state` (`proposed`/`running`/`awaiting_will`/`will_missing`/`gated`/`crowned`/`failed`) | one T3 thread per lane |
| Line | `id`, `houseId`, `rootLaneId` | resolves Your family |
| Crowning | `laneId`, `houseId`, `regnalNumber`, `agentProfile`, `provider`, `model`, `at` | number assigned by a serialized command |
| Will | `id`, `crowningId`, `body` (≤ 2,500 chars), `at` | hidden from reviewer profiles |
| Note | `id`, `houseIds[]`, `authorLaneId`, `body`, `at`, `flaggedMisleadingBy[]` | append-only |
| LaneReport | `laneId`, `firstReads[]`, `misleadingNotes[]`, `verifiedReads[]` | `verifiedReads` from the server's read log |
| Chronicle | `projectId`, `asOf`, `path`, `bytes`, `pass`, `rebuilt` | fresh if timestamped, ≤ 12 h old and ≤ 24 KB |
| AgentProfile | `name`, `role`, `provider`, `model`, `promptPath`, `userMd[]`, `crownable`, `seesWills` | file-backed |
| OwnerRule | `scope` (global/project), `path`, `hash` | injected in every brief |
| GateResult | `laneId`, `kind` (`bend`/`tests`/…), `passed`, `output`, `at` | Bend proof gate |
| DayThread (P2) | `date`, `threadId`, `entries[]` | one per local day |
| Saga (P2) | `id`, `title`, `status`, `parentSagaIds[]`, `relatedSagaIds[]`, `summary`, `asOf` | maintained by the memory keeper |
| SagaEntry (P2) | `sagaId`, `dayThreadId`, `entryRef`, `at` | links a day entry to a saga |

Storage: Lineage tables go in the T3 server database via `apps/server/src/persistence/Migrations/`, written through orchestration events so replay stays consistent. A human-readable mirror goes in `.kin/` in the repo (houses, profiles, owner rules, chronicle). Whether wills and notes are also mirrored to the repo is open question Q3.

---

## 14. Roadmap

### Branching model (applies to every phase)
- Step 0: merge upstream `pingdotgg/t3code` `main` into `GLDRoger/t3code` `main`. Resolve conflicts with the old fork's MCP tools in favour of upstream unless Q1 finds a gap.
- Create a long-lived `kin` branch from the merged `main`. `kin` is Kin's trunk.
- Feature branches and worktrees (for example `kin/lineage-core`, `kin/archivist`) branch from `kin` and merge back into `kin`. Nothing Kin-specific lands on `main`.
- Upstream updates flow `pingdotgg/main` → fork `main` → `kin`, on a regular cadence (Q7).

### Phase 1A: Kin core and lineages (first milestone; a coding agent can start now)
1. On the `kin` branch: add `docs/kin/DESIGN.md` (this file), keep upstream's AGENTS.md rules, rename the app to Kin, and add the `kin` CLI command (to confirm how upstream's `t3` CLI entry is packaged). Change only name and branding strings in this step.
2. Add Lineage tables and migrations: house, lane, line, crowning, will, note, lane report.
3. Add `LineageService` (Effect service) and orchestrator commands for crown and will, so regnal numbers are serialized.
4. Add the `lineage` MCP toolkit with the six tools in section 5.2.
5. Load `.kin/houses.tsv`, with an importer for the old `lineages.tsv`.
6. Add agent profiles (`.kin/agents/*.md`), the prompt composer (section 4.2), and an optional `profile` field on `delegate_task`, wired into both CodexAdapterV2 (`developer_instructions`) and ClaudeAdapterV2 (`append-system-prompt`).
7. Add the brief builder: Start here, Your family, The court, then house wills and notes.
8. Add the will-before-exit gate in run finalization, with the `will_missing` state.
9. Make reviewer profiles blind: never crowned, and no will reads via `McpToolAccess`.
10. Require First reads and Misleading notes lines in lane reports, verified against the read log.
11. Add a minimal UI: a Houses panel listing reigns and wills, and lane state on each thread.

Acceptance:
- A Codex lane and a Claude Code lane in the same house each get crowned with consecutive numbers and leave wills.
- The heir's brief shows Your family first.
- The reviewer's tool list has no will read.
- A lane with no will ends `will_missing`.
- A report whose First reads doesn't match the logs is flagged.
- Tests use the upstream testkit.

### Phase 1B: archivist and context layers
- `packages/keeper` with the archivist scope and its triggers (8 wills / 30 notes), freshness rules (As of, 12 h, 24 KB), verbatim newer wills, no summaries of summaries, and a rebuild every 4th pass.
- Agent maps at `docs/agent-maps/<house>.md`, and the `CLAUDE.md` one-line import.
- Owner rules files injected in every brief.

### Phase 1C: reliability and Bend
- Chaos hooks behind the env flag, 4 tiers, 9 oracles as tests.
- The hourly error sweep opening fix lanes.
- Bend verification layer: `kin verify` with V0 gate integrity and V1 proofs; a Bend model of the lane state machine with V2 laws; V3 trace conformance over chaos traces; V4 sweeps; and toolchain support (section 10). Measure check times on our own corpus.
- The optional routing policy (section 9), behind a toggle.

### Phase 2: assistant side
- Assistant module, day threads, sagas, the memory keeper (Keeper at life scope), the bridge (section 12), and assistant views in the same app.
- Evaluate Cua or a similar open-source agent desktop as a base before building.

### Phase 3: experiments
- Extend Bend models to more of the event log and to client projects with clear state machines; try `--verdict` as the default strict mode.
- Warm-start, if later evaluations show more than a marginal gain.

---

## 15. Open questions

- Q1. Gap analysis between `GLDRoger/t3code`'s MCP tools and upstream's current `delegate_task`, `schedule_task`, `task_status` and `thread_send`: is anything worth porting?
- Q2. Naming: upstream already uses "lineage" in a test fixture (`grok_subagent_lineage`, a parent-to-child subagent chain). Do we namespace ours as "house line" in code to avoid confusion?
- Q3. Should wills and notes be mirrored into the repo (`.kin/`) so they travel with the code, or kept only in the app database?
- Q4. Can agent profiles be mirrored into provider-native subagent definitions (for example `.claude/agents/`), or do we rely only on Kin-spawned threads?
- Q5. Can profiles isolate CLI home and config per agent (ClaudeHome, CodexHomeLayout) without breaking the user's subscriptions?
- Q6. Error sweep: what are the rate limit, dedupe signature and fix-lane cap per hour?
- Q7. Upstream sync cadence: how often do we merge upstream `main` into the fork's `main` and then into `kin`? Keeping Kin code in its own packages and services keeps those merges small.
- Q8. Phase 2 base: build the assistant natively in the fork, or on Cua or a similar SDK?
- Q9. The chaos program's four tiers and nine oracles: import the exact lists from the old `CHAOS-PROGRAM.md` before Phase 1C.
- Q10. Who owns `LAWS.bend` in a lane: only the owner, or also a reviewer? And which oracles are worth modelling in Bend first?

---

## 16. Budget, caching and scale

Owner's reference setup (24 Oct 2026): two $200 Claude plans, a $100 Codex plan, a $100 Grok plan, and about $100/month on OpenRouter for smaller models. Comfortable throughput is about 8 billion tokens a week, with 10 to 20 agents orchestrated by one main thread.

Rules:
- Concurrency is a setting. It defaults to the owner's numbers (up to 20 agents per main thread), and a lower cap applies per provider plan. A main agent only spawns a subagent for separable work; small tasks stay inline.
- Cache first. Prompts are composed in a fixed order: runtime rules, Kin base, profile, user MD files, house map, chronicle and wills, and finally the per-task brief. Everything before the brief is byte-stable across agents in a house, so provider prompt caches (Anthropic prompt caching, OpenAI cached input) hit. Volatile data such as timestamps and counters never goes in the stable prefix.
- Reuse context. House maps, the chronicle and wills are built once and shared by every agent in the house. Repo reads go through a shared, content-hashed read cache per lane run, and heirs start from the will rather than re-exploring.
- Right-size models. Cheap OpenRouter models handle triage, error-sweep classification, note dedupe and archivist drafts. Big plans are reserved for authoring and review.
- Plan-aware routing. Kin tracks usage per subscription (upstream `providerUsageLimits`) and sends new lanes to the plan with headroom. It pauses new launches near a limit instead of failing mid-lane.
- Escalate, don't fan out. Review and fresh-author escalation trigger on failure or risk, never on every change.
- Visible spend. Every lane shows tokens in and out, the cache-hit rate and the plan used. Chaos tiers and the error sweep carry daily caps.
- Acceptance: within one house, the second agent's run shows a nonzero cache-read share on Claude and Codex.

---

## Sources
- T3 Code: https://github.com/pingdotgg/t3code (README, AGENTS.md, docs/internals/overview.md, docs/internals/providers.md, packages/contracts/src/orchestratorMcp.ts, repo tree), read 24 Oct 2026.
- Bend: https://bend-lang.com/, https://github.com/HigherOrderCO/Bend (README, Limitations), https://bend2.dev/notes/what-is-bend2/, https://bend2.dev/notes/bend2-vs-lean/, https://bend2.dev/notes/ai-agents-bend/, https://bend2.dev/learn/types-as-specifications/, and https://github.com/bendlang/bend/issues/776, read 24 Oct 2026.
- Prior lineage/EEVEE work: the T3 thread 981458cb (session ac79ff46), summarized in our earlier research.
