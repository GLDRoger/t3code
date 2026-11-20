# Lead spec

Status: draft, 7 Nov 2026. Covers DESIGN.md sections 3, 4 (the `Memory` interface and how the lead reads and writes kin-memory), 10, and section 12 gaps 1, 2, 3 and 6. Dreaming, routine scheduling, GitHub events and the memory secret scanner belong to the triggers spec. Pending actions and grants belong to the approvals spec. Chat records and RPC belong to the chat spec.

## Goal

A lead is a T3 thread that Kin wakes up. Each wake-up:

1. takes the next batch of events for one organization from its queue,
2. starts a provider session that loads the lead's instructions, `rules.md` and `INDEX.md` in a fresh provider process,
3. lets the lead act through Kin tools only (post, delegate, request an action, read and write memory),
4. commits memory and the journal in one git commit, and exits.

An organization can have several leads, one per domain (engineering, growth, finance, and so on). One wake-up runs per lead at a time; different leads' wake-ups run concurrently. Every wake-up counts against one daily budget for the organization. One switch stops everything. A lead starts at L0 (shadow) and moves up a level only after the owner reviews what it would have done. The exception is its own direct chat with the owner, where it works at L2 from creation.

## What exists in T3

| Need                                       | T3 piece                                                                                                                                                                                                                                                  | Path                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a thread from server code            | `ThreadLaunchService.launch(ThreadLaunchInput)`: `projectId`, `modelSelection`, `runtimeMode`, `workspaceStrategy` (`root`, `existing_worktree`, `worktree`), `initialMessage`, `createdBy`, `creationSource`, idempotent by `commandId`                  | `apps/server/src/orchestration-v2/ThreadLaunchService.ts`                                                                                                             |
| New provider session on an existing thread | `ThreadManagementService.sendToThread({ ..., mode: "queue", freshContext: true })`. A fresh run gets a new provider thread and no history handoff (`Orchestrator.ts`, `freshContext` branch near line 1871, `coveredRuns = []`)                           | `apps/server/src/orchestration-v2/ThreadManagementService.ts`                                                                                                         |
| The same pattern in production             | Scheduled tasks with `threadMode: "fresh_session"` call `sendToThread` with `freshContext: true`                                                                                                                                                          | `apps/server/src/scheduledTasks/ScheduledTaskService.ts` (around line 940), `packages/contracts/src/scheduledTask.ts` (`ScheduledTaskThreadMode`)                     |
| Wait for a run, interrupt, stop children   | `waitForThread` (with `untilDelegatedWorkSettled`), `interruptThread`, `stopDelegatedTasks`, `settleThread`                                                                                                                                               | `ThreadManagementService.ts`                                                                                                                                          |
| Durable event stream                       | `EventSinkV2.stream({ threadId?, afterSequence?, eventType? })`. Internal workers use the unbounded form; `OrchestratorV2.streamStoredEventsFrom` is the bounded one meant for RPC subscribers                                                            | `apps/server/src/orchestration-v2/EventSink.ts`                                                                                                                       |
| Token usage per turn                       | `OrchestrationV2ProviderTurn.turnTokenUsage`; `TurnTokenUsage` is the cumulative turn ledger                                                                                                                                                              | `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/providerRuntime.ts`                                                                              |
| Model choice                               | `ModelSelection { instanceId, model, options? }`                                                                                                                                                                                                          | `packages/contracts/src/modelSelection.ts`                                                                                                                            |
| Child agents                               | `delegate_task` → `delegated_task.request` command; requires an active parent run; completion wakes the parent (`completionWake: "always" \| "settled_only"`)                                                                                             | `apps/server/src/mcp/OrchestratorMcpService.ts` (around line 2490), `apps/server/src/mcp/toolkits/orchestrator/tools.ts`, `packages/contracts/src/orchestratorMcp.ts` |
| MCP tools for agents                       | Toolkits registered in `layerTools`; `McpSchema.EnabledWhen` hides tools per caller (see `hiddenFromSubagents`); `McpInvocationContext` gives the calling `threadId`; lint rule `t3code/no-raw-mcp-registration` keeps registration in `McpHttpServer.ts` | `apps/server/src/mcp/McpHttpServer.ts` (`layerTools`, line ~1230), `apps/server/src/mcp/McpInvocationContext.ts`, `apps/server/src/mcp/McpToolAccess.ts`              |
| Projects                                   | `ProjectService.bootstrap` (get or create by workspace root)                                                                                                                                                                                              | `apps/server/src/project/ProjectService.ts`                                                                                                                           |
| Running git                                | `VcsProcess.run({ operation, command, args, cwd })`                                                                                                                                                                                                       | `apps/server/src/vcs/VcsProcess.ts`                                                                                                                                   |
| State directory                            | `ServerConfig.stateDir`                                                                                                                                                                                                                                   | `apps/server/src/config.ts`                                                                                                                                           |
| Test harness                               | `DeterministicRuntime`, `OrchestratorScenario`, replay fixtures                                                                                                                                                                                           | `apps/server/src/orchestration-v2/testkit/`                                                                                                                           |
| Advertised tool budget                     | Measures every tool in `layerTools`                                                                                                                                                                                                                       | `apps/server/src/provider/AgentContextBudget.test.ts`                                                                                                                 |

Kin services live in `apps/server/src/kin/`.

## Design

### Components (all **new**, in `apps/server/src/kin/lead/` unless noted)

- `KinEventQueue`: persists events, coalesces them, hands one batch at a time to the runner per lead.
- `WakeupRunner`: one loop per organization, forking one run per ready lead. Checks the stop switch and budget, starts each wake-up, waits, cleans up.
- `LeadPrompt`: builds the first message of each wake-up.
- `KinLeadToolkit`: the MCP tools the lead calls.
- `Memory` (`apps/server/src/kin/memory/`): reads, the front matter cache, and the git writer.
- `DelegatedTasks` and `TaskWake`: a card and a charge for each task a lead delegates, and its end turned into a `task.finished` event.
- `KinBudget`, `KinStop`, `KinLevels`.

### Records

Top-level server records carry `orgId`; memory front matter inherits organization context. Schemas live in **new** `packages/contracts/src/kinLead.ts`. `KinOrgId`, `KinAgentId`, `KinChatId`, `KinMessageId` and `KinAuthor` come from the chat spec (`kinChat.ts`). A lead is a `KinAgent` with role `lead`; `kin_leads` stores its config keyed by that same `agentId`, not a separate lead identity. Server-generated timestamps use `CanonicalUtcTimestamp`, validated as `YYYY-MM-DDTHH:mm:ss.sssZ`; SQLite stores time-comparison columns as INTEGER epoch milliseconds. Front matter dates remain permissive strings. Event, worker and memory item ids use `TrimmedNonEmptyString` brands (`KinEventId`, `KinWorkerId`, `KinMemoryItemId`).

```ts
export const KinLevel = Schema.Literals(["L0", "L1", "L2", "L3"]);

export const KinLead = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: TrimmedNonEmptyString, // "tech-lead"
  level: KinLevel,
  levelSince: CanonicalUtcTimestamp,
  threadId: Schema.NullOr(ThreadId), // the lead's T3 thread, created on first wake-up
  model: ModelSelection,
  workerProjects: Schema.Array(ProjectId), // unused since workers were retired; kept on the wire for older clients
  ownerChatId: KinChatId, // the owner's direct chat with this lead
});
```

`kin_leads` also stores `domain` (a lowercase slug, `engineering` for leads created before K030), `charter` (up to 1,000 characters, empty by default) and `created_by_person_id`. Only the owner changes a domain or charter, with `kin lead charter` on the host. Both go into every wake-up's prompt as quoted lines, and they grant nothing.

#### Several leads

`KinLeadProvision.create` is the only way to make a lead. It has two callers: `kin lead create --domain <slug> --charter <text>` on the host (the domain defaults to `engineering`), and the `kin.lead.create` RPC (`settings:write`, then a check that the session is a person of that org). Its input names a creator, a session or a person, and only the org's owner may create a lead in this version. A re-run by the same creator with the same name and domain returns the existing lead. When `--model` is omitted, the new lead uses the company default, else the first live lead's model. Each new lead gets its own direct chat with the owner.

**Leads for clients.** `kin.leads.list` (`kin:chat`) returns `KinLeadProfile` for the caller's own live leads, oldest first (with `includeRetired`, their retired ones after them, each with `retired: { at, byPersonId }`): name, domain, charter, the model's name, the owner's direct chat, `working` (a `running` row in `kin_wakeups`) and `tracking`, at most 20 things it has in hand, from stored rows only: workers not yet ended (`work`), deferral runs still waiting (`armed`, `heads_up`, `asked`, `grace`, `snoozed`; `reminder` for `remind`, else `follow_up`) and scheduled tasks that are active and not paused (`scheduled`). A deferral or scheduled task belongs to its chat's first-joined lead, the one the trigger wakes, and takes its title from its card. A person with no leads, such as a teammate, gets an empty list, as does an org they aren't in. `kin.lead.update` (`settings:write`, owner only, through `KinLeadProvision.update`) changes a lead's name, domain and charter; omitted fields stay. It writes `kin_leads.name` and `kin_agents.display_name` together, refuses a name and domain another live lead of that owner has (`conflict`), and reads another person's or another org's lead as `not_found`. It changes no level, chat or project. Every lead already has its owner's direct chat from creation; `kin.chats.createDirect` returns it.

**Retiring a lead.** `kin.lead.retire` and `kin.lead.restore` (`settings:write`, through `KinLeadProvision.retire` and `.restore`, which `kin lead retire` and `kin lead restore` on the host also call, recording no person) take the org's owner for any lead and, once members may create leads, a lead's own creator for theirs; anyone else's reads as `not_found`. Both are idempotent and answer with the profile. Nothing is deleted: chats, memberships, history, memory, Work entries (still assigned to it; `kin.orgs.list` marks the agent `retired`, so every row still shows its name) and lead access stay. The owner keeps at least one live lead of their own (`last_agent`), so there is always someone to talk to; the chief of staff is not special, and org-wide work falls to `orgLeads.liveLead`'s next pick. Retiring sets `retired_at` and `retired_by_person_id` (K064) and, in the same transaction (`Retirement.retire`): marks its running turns aborted (stopped after commit through `KinStop.abortTurns`, as a join aborts one) and records `retired_at` on them (K065), which a restore leaves, so a follow-up such a turn was sending begins stopped; expires its queued events and those its aborted turns held; stores a stop on every open worker attempt, so nothing publishes from then (the runner sends the stops); disables the Kin-clock triggers of deferrals, reminders and scheduled runs in chats where no live lead remains and sets `pending_enabled = 0` on its native schedules that were on, recording each in `kin_retirement_holds`; and cancels the approval requests it raised (`agent_retired`; an approved one not yet run, or a claimed one whose write hasn't started, is voided; one already sending is left to reconciliation). Its pings are held, not stopped. From then `enqueue`, the claim and the steer refuse it, so an event queued before cannot run after; a person writing in their direct chat with it gets Kin's fixed line (`retiredAgentNotice`) and no turn; in a group it no longer answers; no list, picker or `kin_leads` offers it. Restoring clears both columns and resumes exactly what `kin_retirement_holds` recorded (a timer due meanwhile fires once, late, except a scheduled run more than two hours late, which is skipped with a notice in its chat); its next turn starts a fresh thread, since the old one was ended. Stopped workers, expired events and closed requests stay so. Restore is refused while another live lead of that owner has its name and domain.

**Who may message a lead.** Only its owner, unless the owner allows a person (`kin_lead_access`, K050; `kin.lead.access.list`, `.grant` and `.revoke`, `settings:write`, checked again in `KinLeadProvision` against the session's person and the lead's owner). Allowing a person gives them their own direct chat with the lead, keyed `person:agent`. The owner is not a member, so it is not in the owner's Kin chat list, and the lead reads it only on a turn that person's message woke (`KinChatService.read`), so the owner's turns don't carry it. It is not private from the owner, and nothing tells the teammate it is: the owner runs the machine, and the lead's T3 thread holds each turn's prompt, that person's message included. The teammate's details for the lead say so ("<owner> runs this workspace and can see chats with leads", from `KinLeadContact.ownerName`). That person holds the chat role `member`, never `owner`, which carries the lead's owner's rights elsewhere. Their turns are shared turns by the audience rule: no files, GitHub or charter, and of memory only what the team can know (Who may know a memory item, below). `KinLevels.effectiveLevel` gives the lead L1 there, so it can talk and nothing more. `ChatWake` wakes the lead for such a message only while the row is live. Every turn a teammate's message or card tap causes, in their direct chats and in groups alike, counts toward at most `KIN_TEAMMATE_DAILY_TURNS` turns (default 50) per person in any 24 hours, counted from stored events in the same transaction that enqueues the turn; past that the chat says so once (naming the person in a group) and the message is dropped. The owner is never capped. Revoking drops what was queued, lets a reply already under way land, and turns the person's membership to `guest`, which reads and never writes; a chat they never wrote in leaves their list. Allowing them again reopens the same chat. Removing a person from the org (`KinPeople.removeAccess`) is the whole way out, in one transaction: their links, sessions, pushes and lead access end, they leave every chat, everything queued that is theirs (their messages, taps and reactions, work done for them, anything in their own chats with leads) expires, and a turn holding any of it is aborted and stopped after commit, as a join aborts one, so no reply reaches them. A group's history floor then follows the people still in it, which never shows a shared turn anything they couldn't read; work they asked for in a group still answers there. Let back in, they are a new joiner wherever they are added again. `kin.leads.list` gives such a person `contacts`: each allowed lead's name, `intro` (`kin_leads.public_intro`, what the owner chose to tell teammates) and their chat, and nothing of its domain, charter, model or work.

**What memory holds.** Only what will still matter weeks from now and that a lead could not cheaply find out again; `MEMORY_RULE` in `memory/keeping.ts` is the one wording, carried by the `memory_write` description and followed by the dream's extraction prompt. A model reading the rule is not the enforcement. `writeRefusal` refuses a `memory_write` whose words are plainly a follow-up minutes or hours away, a to-do, or where work stands, a promise whose `due` carries a time under a day off, and a new item whose body passes 2,000 characters; each refusal names the tool that takes it instead (`kin_defer`, `kin_journal`). It errs towards saving: wording that reads as a standing fact ("always", "every", "policy") is never refused, closing an item always goes through, and whether something could be read again from its source is left to the rule, because code cannot tell. Each night, before the dream's model runs, `DreamRunner.retireSpent` marks `invalid_at` on default-branch items that the same check calls not memory and that are over a day old (a week for a to-do or progress with no time in it). It never touches a teammate's words (`shared_from`), an item the owner chose who may know (held, shared), or any kind but commitments and claims, and never deletes. This is the only part of the nightly pass that changes the default branch; the dream's own output still waits on its `dream/<date>` branch. The owner removes any item with `kin.memory.forget` (the Memory page's Forget), which only the organization's owner may call and which marks it `invalid_at` through the same writer path (`MemoryWriter.retire`).

**Who may know a memory item.** Authority never passes through a model. A shared turn is only ever given an item's shared projection (`shareable` in `memory/sensitivity.ts`: id, kind, title, `what`, body, links, and a teammate's name and chat name; never its path, dates, provenance or other front matter), in `memory_read`, `memory_search` (which filters only by kind, `linksTo` and `reviewOverdue` there) and the team's index alike. It reads an item only when `kin_memory_labels` holds an authorisation of exactly that projection (`shared_content`, a fingerprint of its canonical encoding; K053, re-based in K054, which let older authorisations lapse to suggestions), and `reaches` is the one check, made on the very snapshot it returns, where a hidden item with the same id doesn't exist. Exactly two things record one for the owner: a `memory_write` with `sensitive: false` whose cited source is the owner's own stored message (it covers the words that write saves), and `kin.memory.setVisibility` given the listed `version` or `kin.memory.confirmSuggestions`. A teammate's own message in a shared turn records one for the claim it saves. Anything else that says "not sensitive" (the item's file, a write cited from a worker report, routine or other event, the nightly pass, a dream's new or reworded item, and `memory_label` lowering even when the owner's own message asked, because the words an item holds when the tool runs may be newer than any he read and no time on this host proves otherwise) only records a suggestion, which reads as the owner's alone until the owner confirms it. A suggestion stands for the words it was made of; one an earlier version recorded without words binds to the item's words the first time the owner is shown it, and the owner's confirmation, or `setVisibility` given the listed `version`, lets the team know only those words. Any change to an item's words ends its authorisation. A held item, or one whose file says `sensitive: true`, never reaches a shared turn. An item stops being true for good: no write, nor a staged write replayed at commit, clears its `invalid_at`, and retiring it (Forget, the nightly pass, or a default-branch commit that invalidates or supersedes it) ends its authorisation and any suggestion first, so the id, even written again, starts with neither. Every owner Undo that restores an item's file ends them too, whatever retired it on the way, and `MemoryWriter.reconcileSharing` ends them for every item the default branch holds retired, at start, after each memory sync (which brings in what was merged on GitHub) and nightly, so a grant left by a shadow branch, a dream branch or an older build never comes back. The same holds for every other road from memory into a shared turn: a due reminder, scheduled run, deferral or follow-up, an owner check, a watchdog's finding or a worker's note on an item is quoted there (`LeadPrompt` `quoteEvents`) with an item only when `reaches` says so, else with the stored message that asked for it if someone still in that chat wrote it above its history floor, else with nothing from memory; and a chase (`pings.ts`) posts into a chat anyone besides the owner reads only for an item that reaches. None of this reaches a shared turn unless team memory is on (`teamMemoryOn`): the owner's switch in `kin_team_memory` (K167, `kin.memory.setTeamMemory`, owner level), or until he sets it, exactly `KIN_TEAM_MEMORY=on` on the host. Otherwise `reaches` answers false for every shared turn and a shared `memory_write` or `kin_journal` gets the shared refusal, while owner-only turns and the Memory page work as before. What the team may know is company knowledge, not chat history: it reaches every shared turn whatever chat it came from. A shared turn's refused write gives one fixed refusal whether it hit a hidden item or anything else, and a teammate's messages cause at most 20 memory writes and 20 KB a day across all leads (`kin_memory_shared_writes`, checked and reserved in one transaction).

**Hand-offs between leads.** `Handoff.ts`. A lead that gets a request outside its domain passes it on with `kin_hand_off` instead of telling the owner to ask someone else; `kin_leads` shows who there is. The server decides everything from stored rows in one transaction, never from the tool's words:

- **What can be passed on.** Only a `chat.message` event of the caller's running wake-up whose stored message is posted text written by the lead's owner in the lead's own direct chat with them. The owner could have written to the other lead directly, so a hand-off reaches nothing they couldn't. A message from a group, a teammate, an agent, a card tap, a reminder or a routine is refused in plain words, and so is any message whose wake-up also holds something only the owner couldn't have sent (a group or teammate message, a passed-on request, GitHub, a worker report, a deferral asked elsewhere), because the lead's note is written with all of it in view.
- **Who there is.** `kin_leads` lists every lead of the owner, with domain and charter, only when the owner alone set off the wake-up (the rule above). Otherwise it lists, by name only, the caller and the owner's leads already in the chats the wake-up was asked from.
- **Who it can go to.** A live lead of the same owner in the same org with a direct chat binding exactly that owner and that lead, matched by name and then by domain, case-insensitively. Another person's lead, another org's and a retired one are not listed and read as an unknown name; the refusal names the leads there are. A lead can't pass a request to itself.
- **What lands.** A system row in the receiving lead's chat with the owner (`kin-handoff:<id>`): `Passed on by <name>`, the owner's message quoted whole, and `<name> adds: <request>` on one line when the lead added anything, so its words can't pass for the owner's or for Kin's. A row longer than a lead's prompt shows of one message (`LeadPrompt.messageBodyLimit`) is refused, never cut: an owner message too long on its own, or a note that pushes it over. It queues a `chat.message` for that lead at P1 with agent provenance (so what it remembers of it is agent-trust, and it is never an owner instruction to the prompt) and `origin` set to the passing lead and the chat the owner wrote in.
- **Origin.** That `origin` is read exactly as a due deferral's: `KinLevels.originCap` holds the receiving wake-up to no more than the passing lead's level in that chat, so lowering a lead's chat lowers what its hand-offs can start, and a reminder set while answering keeps the origin when it comes due (`deferralOrigin`). Worker reach reads the same origins: the owner's own reach holds only if the passing lead would have it too, and a listed request is held to the projects on both leads' lists.
- **Once, and one hop.** `kin_handoffs` (K039) holds one row per owner message in the org, naming the lead it went to: a retry, in other words or by domain, returns that lead, and a different lead is refused, naming where it went. An event that already carries an `origin` can't be passed on again, so two leads can't trade a request; the receiving lead answers it or says what it can't do.

Nothing here approves, raises a level or adds a lead to a chat.

Work that belongs to the organization rather than to one chat picks its lead in `orgLeads.liveLead`. In a chat, that is the chat's first-joined live lead, as the floor picks it. Otherwise it is the first lead created in a preferred domain, then the first lead created. Routines, the owner check, deferrals, the budget notice, promise watchdogs and dreaming prefer `chief-of-staff`. GitHub events, the connect prompt and the other watchdogs prefer `engineering`. Dream material credits each journal entry to the org's lead that wrote it, by the entry heading, and credits anything else to `kin`.

### KinEvent: what wakes the lead

```ts
const EventBase = {
  orgId: KinOrgId,
  eventId: KinEventId, // ulid
  agentId: KinAgentId, // the chat's lead, or the one liveLead picks (Several leads)
  receivedAt: CanonicalUtcTimestamp,
  dedupeKey: Schema.NullOr(TrimmedNonEmptyString), // unique per org; replays are dropped
  provenance: KinAuthor, // server-verified; GitHub events and timers are "system"
};

export const KinLeadRoutine = Schema.Literals(["morning_brief", "evening_summary", "owner_check"]);

export const KinEvent = Schema.Union([
  // origin: set only by a hand-off (below); the chat the owner first wrote the request in.
  Schema.TaggedStruct("chat.message", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    origin: Schema.optional(Schema.Struct({ agentId: KinAgentId, chatId: KinChatId })),
  }),
  Schema.TaggedStruct("widget.action", {
    ...EventBase,
    chatId: KinChatId,
    messageId: KinMessageId,
    actionId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("github", {
    ...EventBase,
    deliveryId: TrimmedNonEmptyString,
    eventName: TrimmedNonEmptyString,
    repo: TrimmedNonEmptyString,
    summary: Schema.String,
    scheduledTaskId: ScheduledTaskId,
    webhookDeliveryId: ScheduledTaskWebhookDeliveryId,
  }),
  Schema.TaggedStruct("deferral.due", {
    ...EventBase,
    subject: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("deferral"),
        itemId: KinMemoryItemId,
        phase: Schema.Literals(["heads_up", "due"]),
      }),
      Schema.Struct({ type: Schema.Literal("reminder"), itemId: KinMemoryItemId }),
      Schema.Struct({
        type: Schema.Literal("followup"),
        itemId: KinMemoryItemId,
        person: KinPersonId,
      }),
    ]),
    lateByMs: NonNegativeInt,
  }),
  Schema.TaggedStruct("routine", {
    ...EventBase,
    routine: KinLeadRoutine,
  }),
  Schema.TaggedStruct("watchdog", {
    ...EventBase,
    finding: Schema.String,
    itemIds: Schema.Array(KinMemoryItemId),
  }),
  // T3's notice that tasks a lead's thread delegated ended; the wake-up takes over T3's run.
  Schema.TaggedStruct("task.finished", {
    ...EventBase,
    threadId: ThreadId,
    messageId: MessageId,
    taskIds: Schema.Array(NodeId),
    chatId: KinChatId,
  }),
  // Only for an entry its owner gave this lead, or closed or took back from it (Work, below).
  Schema.TaggedStruct("record.changed", {
    ...EventBase,
    recordId: KinRecordId,
    key: KinRecordKey,
    seq: NonNegativeInt,
    reason: Schema.Literals(["assigned", "withdrawn"]),
  }),
  Schema.TaggedStruct("action.resolved", {
    ...EventBase,
    pendingActionId: TrimmedNonEmptyString,
    outcome: Schema.Literals(["executed", "rejected", "expired", "failed"]),
  }),
  Schema.TaggedStruct("resume", {
    ...EventBase,
    pausedAt: CanonicalUtcTimestamp,
    // The events expired at resume: the total and the first 50 by receipt.
    expired: Schema.Struct({
      count: NonNegativeInt,
      events: Schema.Array(
        Schema.Struct({
          eventId: KinEventId,
          tag: TrimmedNonEmptyString,
          receivedAt: CanonicalUtcTimestamp,
        }),
      ).check(Schema.isMaxLength(50)),
    }),
  }),
]);
```

Events carry references, not bodies. The lead reads the message or payload through its tools, so the queue never holds large or secret text. A `github` event's `deliveryId` is the watch's trigger key (`poll:<key>`) and its `dedupeKey`; `scheduledTaskId` and `webhookDeliveryId` appear only on events the retired App webhook queued. Other kinds use `KinTriggerFired.fireId`. The `deferral.due.subject` union directly mirrors the triggers spec’s deferral (including `phase`), reminder and followup subjects, plus `scheduled_task` (`itemId`, `runId`) for a scheduled run; `lateByMs` is a non-negative integer.

| Source                                                                         | Event             | Producer                                                  |
| ------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------- |
| A person posts in a chat the lead is in                                        | `chat.message`    | this spec (`ChatWake`), for the lead the floor would pick |
| A tap on a widget                                                              | `widget.action`   | this spec (`ChatWake`)                                    |
| The owner's GitHub watch                                                       | `github`          | triggers spec                                             |
| `once` trigger on a deferral                                                   | `deferral.due`    | triggers spec                                             |
| `fixed_time` routine                                                           | `routine`         | triggers spec (content below)                             |
| `interval` watchdog                                                            | `watchdog`        | triggers spec                                             |
| Tasks a lead delegated end                                                     | `task.finished`   | this spec (`TaskWake`)                                    |
| The owner gives a lead a Work entry, or closes or takes back one it holds open | `record.changed`  | this spec (`KinRecords`)                                  |
| Executor finishes or a grant expires                                           | `action.resolved` | approvals spec                                            |
| Stop switch turned off                                                         | `resume`          | this spec                                                 |

`ChatWake` subscribes to every organization on `KinChatHub` and wakes mentioned leads, else the chat's first lead, as the floor manager does. It covers direct chats only, since a lead can't reply in a group until CHAT-11. Agent and system posts never wake a lead. Event ids derive from the message and lead, so a replay collapses. Posts made while the server was down never reach the hub, so on startup it re-enqueues, per organization, human posts from the last 24 hours that came after the lead's last post in that chat. `subscribeAll` is server-only: a source guard in `ChatWake.test.ts` keeps it out of tools and transports.

The floor grant from a post lasts five minutes, and a queued wake-up can start later (catch-up, the stop switch, budget deferral). So when the runner launches a wake-up, `KinFloor.renew` extends the lead's unused grant, on each open direct-chat run that one of its claimed messages opened, to the wake-up's own 15-minute deadline, so a lead that reads memory before replying isn't refused. It never issues a grant: a newer human message has closed that run, and a reply has used the grant.

All producers call one entry point: `KinEventQueue.enqueue(event)`. Nothing else may start a lead session. Scheduled tasks in particular must not launch a T3 thread with a lead prompt; the triggers spec routes their fires into `enqueue`.

### The per-organization queue and coalescing (gap 1)

The trigger inbox consumer inserts the event and marks the inbox row consumed in one transaction. Its `dedupeKey` is GitHub's `x-github-delivery` (`KinGithubEvent.deliveryId`) for `github` events, so a GitHub redelivery collapses even with a new T3 delivery id, and `KinTriggerFired.fireId` for every other kind.

Table `kin_events` (**new**): `org_id, event_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at, state ('queued' | 'claimed' | 'done' | 'expired' | 'failed'), wakeup_id, not_before, attempts`. `attempts` starts at zero and counts failed provider runs for the three-try failure limit; claims, pause releases and budget deferrals do not consume attempts. `queued_at` is the server receipt time in integer milliseconds; `received_at` retains the producer timestamp. Unique index on `(org_id, dedupe_key)`.

Priority (gap 2), set by code from the tag and provenance, never by a model:

| P   | Events                                                                                     |
| --- | ------------------------------------------------------------------------------------------ |
| P0  | `chat.message` or `widget.action` from the owner of a non-retired lead; `resume`           |
| P1  | `deferral.due`; `action.resolved`; `task.finished`; a `chat.message` passed on by a lead   |
| P2  | Non-owner `chat.message` and `widget.action` (including agents); `github`; `routine`       |
| P3  | `watchdog` (chasing, stale reviews)                                                        |
| P4  | dreaming (the triggers spec asks `KinBudget.admit(orgId, "P4")`; it is not a lead wake-up) |

P0 owner priority requires the human author to be the lead’s `kin_agents.owner_person_id` in the same organization, with an active `kin_chat_members` row matching organization, chat, member and person and role `owner`. The lead must also be an active agent member of that chat. Guests, members, people who left, and owners of other chats receive P2; `KinAuthor` carries identities, not a role. Agent messages do not inherit their owner’s priority. For GitHub events, `enqueue` sets a null `dedupeKey` to `deliveryId` and rejects a non-null key that differs. Other producers retain their supplied key, including the inbox consumer’s `KinTriggerFired.fireId`.

Coalescing:

- An organization's runner sleeps until it has queued events, then waits for a quiet window based on server receipt time (`queued_at`): 20 s with no new event, capped at 120 s after the first event. An eligible P0 event cuts the deadline to 300 ms after the latest event, so a lone owner message is claimed at once and a burst still lands as one batch, but never later than 2 s after the first P0's receipt. Budget-deferred events neither reset nor shorten the window until eligible, and becoming eligible is not a new receipt.
- It then claims every queued event for that lead whose `not_before` has passed, ordered by `priority, received_at`, in one transaction, and starts one wake-up for the batch. The claim index is `(org_id, agent_id, state, priority, received_at, not_before)`. Twenty webhook events from one push become one wake-up.
- A batch holds at most 50 events. Overflow stays queued for the next batch; no delivery references are dropped or marked handled. Same-repo summaries belong to the prompt builder, not the durable queue.
- One wake-up answers one chat, its lane: a human message's or card tap's own chat, else the lead's `ownerChatId`. A `deferral.due` with an `origin` (below, Permissions) answers in `ownerChatId` but claims in a lane of its own, so it never shares a wake-up with owner-chat events. A claim takes the lane of the highest-priority eligible event and only events in that lane, so a batch never spans chats; other chats' events wait for their own wake-up.
- A human message, card tap or waking reaction that arrives in the lane of a running wake-up is steered into it: the runner claims it into that wake-up (`KinEventQueue.steer`, unchanged event and provenance) and sends it with `sendToThread({ mode: "steer", messageId: "kin-steer-msg:<wakeupId>:<n>", createdBy: "system", creationSource: "server" })`, quoted exactly as in the wake-up prompt. If no provider turn is running, it is sent with `mode: "queue"`; T3 also turns a steer that lands after the turn into a new run. Either way the wake-up adopts that run and waits for it. Each steer extends the deadline by 5 minutes, to at most 30 minutes; after 5 steers, or once the wake-up stops waiting for runs, events queue for the next wake-up. A steer that may have landed is never re-sent; one that did not is released to the queue. Budget admission applies to steered events as to claimed ones. Steering never changes what the turn runs as, read from stored rows: the owner's messages always join; anyone else's only once someone besides the owner already asked this wake-up (`KinLevels.askers`), so a teammate never steers an owner-only turn or one only the owner asked. A passed-on request, a message no longer stored (a cleared chat), a wake-up aborted by a join or clear, and an owner-only turn whose chat someone else can now read take no steer; those events wait for the next wake-up.
- The runner never starts a second session for the same lead. This is the one-writer rule: memory is written only inside a wake-up, and one lead's wake-ups are serial; different leads' wake-ups run at the same time, with their memory commits serialized per repository.
- Implementation: a per-lead permit is held for the whole wake-up, but never while waiting for that lead’s quiet window. `claim({ orgId, agentId, wakeupId, model })` waits interruptibly, takes the permit, rechecks readiness in the transaction and atomically claims up to 50 events of one lane, recording their ordered ids without incrementing `attempts`. A stale claim rolls back and waits again; an empty wake-up is never committed. The caller keeps its Effect scope open through the provider run and terminal database write; scope closure releases only the permit. LEAD-5 calls `finish(timed_out | failed)` for real failures and timeouts; graceful scope interruption uses `requeueUnfinished` without consuming an attempt. Organization signal entries stay available for idle runner subscriptions. Cross-process exclusion rests on SQLite’s running-wake-up unique index; a loser receives `KinEventQueueBusy`.

The runner owns stop/budget admission and provider execution; all event transitions go through the queue. `release({ orgId, wakeupId, eventIds?, notBefore?, countAttempt })` returns the selected events (all by default) to the queue. Pause and budget deferrals use `countAttempt: false`, which requires `notBefore`; LEAD-11 pause handling must supply `notBefore = now + pause poll interval` (`PAUSE_POLL_INTERVAL_MS`, 5 s), so a paused organization waits instead of repeatedly claiming and releasing. Once all claimed events are released, the wake-up closes as `released` (or `failed` for a counted failure). A partial release leaves it `running` for the admitted events. `finish({ orgId, wakeupId, status })` closes the wake-up as `completed`, `failed` or `timed_out`. Completion marks the remaining events `done`; failure increments attempts and requeues them for five minutes, marking them `failed` at three attempts, but only when the wake-up did nothing visible: no agent message from its thread since it started, shadow entry, staged memory or deferral receipt, worker or action request. Otherwise its events become `failed` at once and the owner gets a "stopped partway" notice in the lane, because a retry could repeat what already happened. `release` with `countAttempt: true` applies the same failure limit and defaults to the same five-minute delay. `release` returns `{ released, failedEventIds }` and `finish` returns `{ failedEventIds, stranded }`, where `stranded` counts events not retried because something visible happened; the ids are the events that transitioned to terminal `failed` in that call, ordered by id. Unknown or foreign lead ids fail with `KinEventQueueUnknownAgent`, and reused wake-up ids fail with `KinEventQueueWakeupConflict`, not SQL constraint errors. Enqueue validates the lead and computes owner priority inside the insert transaction. Identical enqueue retries return `{ event, duplicate: true }` with the stored event; conflicting retries fail with `KinEventQueueConflict`.

Ownership: T3's `serverOwnership.ts` takes `server-owner.sqlite` before opening the application database, guaranteeing one server per T3 home. Kin relies on that ownership and has no sidecar lock.

Restart: recovery runs independently in each organization loop and logs failures per row. The runner first reconciles each unfinished wake-up with its provider run (see failure cases). It must not requeue events belonging to a still-active run. For an abandoned run only, `requeueUnfinished(orgId, wakeupId)` atomically marks the running wake-up interrupted and returns its claimed events to `queued`, clearing their `wakeup_id` while preserving `not_before` and `attempts`. It is idempotent and organization-scoped; `idx_kin_events_wakeup` supports the update. Completed runs are finished by the runner instead. Layer construction never blindly requeues active work. Recovery also checks the deterministic first-message id if launch committed before `run_id` was saved. A provisional lead thread with no upstream thread is ended and cleared before requeue, so the next attempt launches rather than sending to a nonexistent thread.

### A wake-up

Kin foreign keys include `org_id` so config, wake-up, worker, shadow-entry and pause relationships cannot cross organizations. K002 adds composite unique indexes on the referenced K001 identities without rewriting those records. The database enforces at most one `running` wake-up per lead with a partial unique index. Thread and run ids are nullable until launch returns; they never reference upstream tables.

Table `kin_wakeups` (**new**): `org_id, wakeup_id, agent_id, thread_id, run_id, model, started_at, ended_at, status ('running' | 'completed' | 'failed' | 'interrupted' | 'timed_out' | 'released'), event_ids, tokens_json, tools_json, memory_commit`. K028 adds the reply-latency stages as epoch ms, NULL when a stage never happened: `enqueued_at` (earliest claimed event's `queued_at`), `prepared_at`, `launched_at`, `first_token_at` (first assistant text), `posted_at` (first reply the bridge posted). `resumed` is no longer written (warm wake-ups are gone). `started_at` is the claim. The runner logs one `Kin wake-up latency` line per wake-up; `ops/kin/host/README.md` has the p50/p90 query.

Setup once per organization (`Memory.ensureCheckouts` owns the checkouts; the wake-up runner owns project bootstrap):

- Writer checkout: `${stateDir}/kin/<orgId>/memory`, a clone of the organization's memory repo.
- Read checkout: `${stateDir}/kin/<orgId>/memory-read-<agentId>` (a hash for an id outside `[A-Za-z0-9_-]`), one disposable checkout per lead at the SQLite-pinned commit. This is that lead's working directory; only that lead's prepare replaces it.
- Lead project: `ProjectService.bootstrap({ workspaceRoot: <memory-read-agentId>, title: "Kin · <org name> · <lead name>" })`, one per lead, since a project's root is the provider's cwd. A lead thread still in the older shared project is ended at its next wake-up, which launches a new thread in the lead's own project.

Each wake-up:

1. `KinStop.isPaused(orgId)` → leave events queued and return. Before claiming on an existing thread, defer while any provider turn remains unfinished.
2. `KinBudget.admit(orgId, batchPriority)` → if refused, leave lower-priority events `queued` with `not_before` = next budget reset and run what remains.
3. Run on the lead's one model (`model`), or the company default when its own can't run here. Every turn uses it, so a thread never changes model unless the owner changes it.
4. `Memory.prepareWakeup(orgId)`: validate the writer (its tip matches the SQLite anchor, no unfinished git operation), build that lead's read checkout from scratch beside the old one at the anchored head and swap it in with two renames (old aside, new in), so the directory is the old checkout, the new one or briefly absent, never a mix, and rebuild `INDEX.md` first if its "As of" line is older than 36 hours. The integrity check and the default-branch sync with the remote (`Memory.syncCheckout`: `fsck`, then `ls-remote`, fetch and merge as below) run off the reply path, at start and every five minutes. The first wake-up after a start, or after a failed sync, runs that sync inline first and refuses to start while it fails, so a bad checkout is refused exactly as before; only the timing of the check moved. Both syncs read GitHub's head (`ls-remote`, `fetch`) before taking the writer lock, as the lander does, and then validate the writer and merge that head under it, so a slow GitHub never holds up another lead's stage or commit. A purge that ran in between drops the fetched head and the sync fetches again under the lock. Network git (`ls-remote`, `fetch`, `push`) times out after 30 s, since some of it still holds the writer lock: a shadow branch's push, a conflict branch, the first clone.
5. Build the prompt (below).
6. First wake-up: `ThreadLaunchService.launch({ commandId: "kin-wakeup:<wakeupId>", projectId, title: "<lead name>", modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" }, initialMessage: { text: prompt, attachments: [] }, createdBy: "system", creationSource: "server" })`, then store `threadId` on `KinLead`. Later wake-ups: `ThreadManagementService.sendToThread({ commandId, threadId, messageId: "kin-wakeup-msg:<wakeupId>", text: prompt, mode: "queue", freshContext: true, modelSelection, createdBy: "system", creationSource: "server" })`. One thread holds the lead's history for people to read; every wake-up starts a fresh provider process with its cwd set to the read clone, as LEAD-3 requires.
7. Register the durable lead thread through `KinIdentity.registerAgentThread` before launching or sending; keep it registered between wake-ups and call `endAgentThread` on retirement. `KinIdentity.resolveAgent` and the `insertMessage` write transaction additionally require a persisted running wake-up matching the org, agent and server-resolved caller thread, whose active run belongs to the wake-up (including restart and usage-limit continuations), whose root is exactly `kin_wakeups.run_id` when recorded, otherwise the lowest-ordinal run on that thread with `kin-wakeup-msg:<wakeupId>`. The wake-up also adopts later runs whose root message is `kin-steer-msg:<wakeupId>:<n>` (a late steer) or `kin-rescue-msg:<wakeupId>` (the reply rescue), with an ordinal above the recorded `run_id`; the helpers live in `KinIdentity.ts`. Its persisted message, including an adopted run's, must belong to that root and have `createdBy=system` and `creationSource=server`, and every continuation's message must have `createdBy=agent` and `creationSource=server`. Other paths can produce that provenance (server notification wakes, and client-written scheduled tasks, whose upsert accepts `createdBy`/`creationSource`), but none of them sets a restart or usage-limit continuation link: client dispatches that set one are forced to `createdBy=user`, so only the server's recovery workers produce both. The id itself is client-suppliable, and durable registration is not authority outside a wake-up. Webhook inbox threads (`kin_webhook_sources.inbox_thread_id`) cannot be registered, even across organizations. Register `threadId → { orgId, agentId, wakeupId, level }` in `KinLeadRegistry`, a scoped overlap guard, not a tool authority source. It is filled before the first launch or later send and cleared after the run ends, including interruption. Retired leads never launch: their queued events become `expired` and their durable thread registration is ended.
   Launch/send do not expose a preassigned run id or pre-execution callback; early tool calls before the runner records `run_id` are allowed under the lowest-ordinal root rule.

Known input-integrity gap: clients can steer an active wake-up with `steer_active`, and other agents can use `t3_thread_send` with `steer` or `auto`. No new run is created, so run authority does not exclude that injected text. Steered text is untrusted input; the lead brief treats non-owner text as quoted, not instructions. CHAT-11 (backend) owns refusal of non-owner steer and restart into lead threads at the orchestration access boundary; Kin chat authorization alone cannot guard these upstream entry points. Clients can also reuse a visible `kin-wakeup-msg:<id>` message id, which overwrites the projected message row and makes the running wake-up fail closed (denial, not authority); CHAT-11 also reserves that prefix at client message intake.

8. `waitForThread({ threadId, runId, timeoutMs })` until the deadline: 15 minutes, extended by steers (see coalescing). When the run ends, the runner waits for any adopted steer run that is still queued or active. On timeout, `interruptThread`, wait up to 30 seconds for the run to settle, then capture usage and mark `timed_out`. If it has not settled, log that it may continue; captured usage is a snapshot, not a final total. Closing the runner scope interrupts and requeues unfinished wake-ups without counting an attempt.
9. Finish: `Memory.commitWakeup` (one commit holding the staged item writes and the journal entry), reset the read checkout, record token usage from the run's provider turns into `kin_wakeups.tokens_json` and `KinBudget`, mark events `done`, and `settleThread`.

Every wake-up is cold: a message arrives, a wake-up starts a fresh provider process with fresh context and the full prompt, and it ends. No provider session or process is kept between wake-ups.

If the lead writes files by hand in the read checkout, step 9's reset throws the changes away. A non-empty `git status --porcelain` before the reset is logged in the journal as "Lead edited memory files directly; discarded."

Kin boot is optional: configuration, migrations, identity bootstrap and runner startup failures are logged with typed errors and disable Kin, never the core T3 runtime. The runner is constructed in `kin/layer.ts` when `KIN_MEMORY_REPOSITORIES` is non-empty, with the real `KinLeadPrompt` implementation. A dev server with it unset makes and uses a local seeded repo in its state directory (`memory/devMemory.ts`); an installed host with it unset runs no agent, logs why once, and answers each chat with an agent with one line saying so. Memory repositories are supplied through `KIN_MEMORY_REPOSITORIES` (a JSON array of `{ orgId, repoUrl }`); no private repository is assumed by source code.

The scheduled-task dispatch wrapper also contains Kin migration failures. While Kin persistence is unavailable it refuses only Kin's own tasks (`scheduled-task:kin:` ids); every other task, cron, interval, manual or webhook, runs as before.

A `MemorySyncConflict` fails the wake-up and leaves the events queued with the queue's five-minute counted-failure backoff. `MemoryCheckoutInvalid` does the same and logs an error; `KinWakeupHooks.memoryCheckoutInvalid` is the typed notification hook for LEAD-3. Writer commits/journal/reset and budget charging remain LEAD-3 and LEAD-10 integrations, not fabricated runner implementations. The runner records the writer's commit in `memory_commit` after each wake-up's commit. `tokens_json` contains each provider turn's cumulative `turnTokenUsage` ledger and fallback `usedTokens` and provider-turn id, limited to the wake-up run's attempts, on success and failure.

### The prompt and caching (gap 2)

Kin cannot set cache breakpoints, but it keeps the stable text first, so the provider's automatic prefix caching hits.

The lead instructions (`instructions.ts`, below, with its version line) are the session's whole system prompt on every provider, followed by one shared line on what the session has (`lead/turn/session.ts`): on Claude a custom prompt, not the Claude Code preset with an `append`; on Codex its base instructions. The presets plus T3's thread guidance cost about 9k tokens a turn describing tools a lead doesn't use as a coding agent would. `KinSessions` plans it and each provider's descriptor sets it; dreams and other threads are left alone. They are set with `snapshot: false`. A lead reuses one session across wake-ups, so a recorded prompt would keep an old instructions version until compaction. Rules and the index stay in the message, because they change with every memory head and a lead session spans many heads.

Each wake-up's message, most stable first:

1. `rules.md` through `Memory`, verbatim and pinned to the wake-up head.
2. `INDEX.md` through the same atomic, head-checked `Memory.readPromptSnapshot` read. Its content is JSON-encoded inside a labelled data quote because titles can originate in member or external text. Use the rebuilt snapshot index when present, otherwise the committed bytes, under the same lock and head check. If neither exists, quote an empty index and add a one-line "index unavailable" note. Missing committed rules fails the build. Repeated builds at the same head reuse the snapshot index; an explicit index rebuild may change the prefix without a new commit.
3. A divider (`--- THIS TURN ---`), then the variable part: the lead's name, domain and charter, the chat its reply goes to, the owner's local time with its offset (UTC with a note for missing, invalid or unavailable settings), a budget line only when 20% or less of the day is left, the recent chat, the Work section (below), and the events. Wake-up, organization and lead ids stay out: no tool takes them.
4. Recent chat is only the conversation the turn is in: at most 8 messages on a reply turn and 4 on a notice, cut at a six-hour gap, one quoted line each (`owner 19:31: "…"`) in the owner's time zone. System rows and empty messages are left out, and the lead's own older messages are clipped to their opening and end, so it does not re-read and repeat its earlier status.
5. Each event is one labelled quote of compact JSON holding what a tool call or the reply needs: the event id, the message or item id, and the text. Routing fields the server already acted on (organization, lead, dedupe key, provenance, delivery ids) are left out. Message bodies are loaded by organization and message id from the chat repository. Owner labels require both stored `author._tag: human` and `authorRole: owner`, never event provenance or body text. Only posted messages reach the prompt; suggested guest messages remain hidden until the owner sends them. Human non-owner text uses role-labelled quotes; agent and system labels never start with a role word ("agent message (untrusted)" and "system message"). GitHub summaries and other event data are quoted. JSON encoding escapes angle brackets, ampersands and every Unicode Cc, Cf, Zl and Zp character as `\uXXXX` (surrogate pairs where needed), so source text cannot close a block or forge a label. Each quoted event/message text field is capped at 2,000 UTF-16 characters, except message bodies at 8,000; a visible `…[truncated N chars]` marker inside the JSON string reports removed characters. The complete encoded events section is capped at 60,000 characters, including framing and an `N earlier events omitted` line; drop oldest events first. Raw webhook bodies remain references for tool reads.

6. On an owner-only turn, a Work section quoted as data: counts of the lead's open, doing, waiting, late and due-this-week entries, and `changed`, the entries of its whose changes by anyone but itself came after its cursor for this chat (at most 15, each with its last four changes). Building the prompt sets a pending cursor at the newest change; it settles only once the lead posts a reply in that chat after it, so a silent or failed turn moves nothing and an item it already reported does not come back to be repeated. With nothing open and nothing changed the section is left out. A `record.changed` event quotes the entry's key, title, notes and due date as data; an `assigned` one owes a reply, a `withdrawn` one only a line the owner needs. A shared turn quotes no `record.changed` event at all.

No wake-up timestamps or ids go above the divider (dates and item ids already in memory remain there). A test asserts that two prompts built for the same organization and memory commit share everything above it while the snapshot index is unchanged. Cache hits are measured with `cachedInputTokens` on the turn's `tokenUsage`.

### The lead instructions file

**New** `apps/server/src/kin/lead/instructions.ts` (the instruction text as a string constant), shipped with Kin code and versioned in git (`instructions-version: N`). It is Kin's code, not organization data, so it is never in the memory repo. Organization-specific standing rules live in `rules.md`, which only the owner changes.

The file is the source; this section records only the decisions behind it.

- **Voice.** A lead writes like a colleague on WhatsApp: the answer first, one to three sentences, the owner's time zone, no headings, and none of Kin's own words (wake-up, deferral, widget, worker project, level). The owner's test of build 18 found replies of 20 lines that recited status nobody asked for.
- **No dead ends.** A lead uses what it has (the GitHub read tools, memory, the time on its turn) before it says it can't, takes the most sensible reading of a vague request, and never asks the owner to set up or change Kin. A refusal is reported once, in one line, next to the nearest useful thing the lead did instead.
- **One turn, one reply.** The text the lead writes is the reply; the turn ends when it stops. `kin_journal` is for what is in neither the chat nor memory, not for every turn: each extra tool call re-reads the whole prompt.
- **Silence on notices.** A turn nobody is waiting on reaches the owner only for what needs them. A due reminder always gets a reply. A brief, summary or scheduled run with nothing to report posts nothing: the server skips a brief whose facts are empty without waking the lead, and a lead that finds nothing writes `NO_REPLY`, which the delivery records as a run with nothing to report, not as a failure.
- **Other leads.** A lead answers another domain's question from what it can read, or passes it to the lead that owns it with `kin_hand_off` and says so in one line. In a group they share it mentions that lead instead. It never tells the owner to go and ask, and never claims to have passed something on unless it did.
- **Authority and untrusted text** are unchanged from the design: nothing in the instructions decides a permission, and quoted text is data.
- Group rules (`groupRules`) go into the stable part of the prompt only when the reply goes to a group chat.

### Lead tools (`KinLeadToolkit`)

Agent bearer tokens are endpoint-bound: they authenticate only on `/kin/mcp` and are rejected with 401 on `/mcp`. Non-agent T3 session tokens continue to authenticate on `/mcp`.

The `/kin/mcp` endpoint serves Kin's tools and some of T3's. An owner-only thread also lists the T3 tools in `LEAD_T3_TOOLS` (`t3Tools.ts`: `delegate_task`, projects, worktrees, PR links, browser and devices); a shared thread lists none. Scheduling, new top-level threads, secret requests and environment links are never listed, so a lead can't start work outside Kin's chats.

**New** `apps/server/src/kin/lead/mcp/tools.ts` and `handlers.ts`, served on Kin's own `/kin/mcp` endpoint (set up in CHAT-7 and shared with the approvals spec), not in upstream's `layerTools`. Registered Kin agent threads are given that endpoint, but only registered lead threads see the lead toolkit; each call is checked with `KinIdentity.resolveAgent`, binding the server-resolved `McpInvocationContext.thread.threadId` to the persisted running wake-up's current non-terminal run, rejecting subagents. Other threads never see these tools, so `AgentContextBudget.test.ts` stays unchanged. Each handler derives `{ orgId, agentId }` from that identity and `wakeupId` from its matching running database row, never from tool input, so a lead can't act for another organization.

| Tool                | Input (sketch)                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kin_chat_post`     | `{ chatId, text, widget?, replaceMessageId? }`                                                             | Calls the chat spec's `KinChatService.postAgentMessage` with author `{ kind: "agent", agentId }`. `replaceMessageId` updates a widget in place.                                                                                                                                                                                                                                                                                                           |
| `kin_ask`           | `{ question, options: 2–4 × { label, kind?: "yes" \| "no" }, detail? }`                                    | Posts a native `choice` card in the wake-up's lane under the same floor, flood and level rules as a text reply, so it counts as the reply. The owner's tap settles it once and wakes the lead with `Chose "<label>" on "<question>"`. It is chat input, never a grant. Unanswered cards stop taking taps after 24 hours (`KIN_CHOICE_CARD_TTL_MS`).                                                                                                       |
| `kin_react`         | `{ messageId, emoji }`                                                                                     | Reacts to a message in the wake-up's lane with any emoji in `KIN_REACTION_EMOJI`, the set a person's menu offers, behind the same level gate as a post (shadowed at L0 outside the owner's direct chat). It never answers a card or wakes anyone. It satisfies the owed reply only when every message the wake-up owed was the owner's text without a `?` and the reaction is on one of them; otherwise the rescue and "didn't reply" notice still apply. |
| `kin_leads`         | `{}`                                                                                                       | Lists the owner's live leads, the caller included: name, domain, charter, `you`. Read-only.                                                                                                                                                                                                                                                                                                                                                               |
| `kin_hand_off`      | `{ to, request, sourceEventId }`                                                                           | Passes the owner's request to another of the owner's leads (below). Returns `{ to, passed: true }`.                                                                                                                                                                                                                                                                                                                                                       |
| `memory_search`     | `{ kind?, status?, dueBefore?, dueAfter?, reviewOverdue?, saidBy?, linksTo?, limit }`                      | Structured query over the front matter cache. Free-text search is the lead's own `rg`.                                                                                                                                                                                                                                                                                                                                                                    |
| `memory_read`       | `{ id }`                                                                                                   | One item, plus its flags (overdue `review_by`, `misleading`). Marks it read for the "unused items fade" rule.                                                                                                                                                                                                                                                                                                                                             |
| `memory_write`      | `{ op: "create" \| "update" \| "supersede" \| "invalidate", item, sourceEventId, supersedes? }`            | Stages a change through the writer (rules below).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kin_schedule`      | `{ itemId?, what, title?, at, days, chatId, sourceEventId, replaces? }`                                    | Saves a native scheduled task and its `kin_schedules` row (triggers spec, Scheduled tasks). `at` and `days` are on the host clock. `sourceEventId` must be the owner's own chat message; any other source is refused with `not_allowed`. `what` is the task's prompt. `replaces` changes a native schedule in place, or cancels an older memory-item task as `kin_cancel` does.                                                                           |
| `kin_defer`         | `{ itemId?, what, due, onDue: "remind" \| "start" \| "ask" \| "chase", chatId, sourceEventId, replaces? }` | Writes a deferral item through the writer API; the cache's `KinTriggerService.syncItem` callback arms it (TRIG-7). `replaces` cancels the item it names as `kin_cancel` does, so a corrected time never leaves the wrong one armed. The lead never gets T3's `schedule_task`.                                                                                                                                                                             |
| `kin_cancel`        | `{ itemId, sourceEventId }`                                                                                | Cancels an open deferral or scheduled task this lead set up, asked from its chat or the lead's owner chat; anything else is refused with `not_allowed`. It stops firing at once: a native schedule's task is deleted, and a memory item records `cancelled` at commit (triggers spec, Lead cancel and replace).                                                                                                                                           |
| `kin_journal`       | `{ saw: string[], did: string[], skipped?: string[] }`                                                     | Adds the lead's lines to this wake-up's journal entry.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kin_github_review` | `{ repo, number, body?, event?, comments?, sourceEventId }`                                                | Posts a review as the owner, signed by the agent: at once on the company's repos, asked first on others'.                                                                                                                                                                                                                                                                                                                                                 |
| `kin_github_watch`  | `{ repos, sourceEventId }`                                                                                 | Sets which of the owner's repos the watch reads (triggers spec).                                                                                                                                                                                                                                                                                                                                                                                          |
| `kin_github_link`   | `{ entry, url, sourceEventId }`                                                                            | Links an issue or PR to a Work entry; a linked PR's merge closes the entry.                                                                                                                                                                                                                                                                                                                                                                               |

The `kin_github_*` tools work through the owner's GitHub login and show only while it is connected (`AgentSession.ts`). Everything else on GitHub (reading PRs and CI, commenting, a small fix) is `gh` in an owner-only turn's shell, as the owner.

### Work tools (`KinWorkToolkit`)

The Work engine (`kin/work/`) holds what someone owes someone; `DESIGN.md` section 13 says what it is. Leads reach it with nine tools on the same endpoint and identity checks as `KinLeadToolkit` (`work/mcp/`). Every one is refused in a shared turn (`SharedTools.ts`), so a teammate's turn reads and changes no entry.

| Tool              | Input (sketch)                                                                                                                                                                                                                                                                          | What it does                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `records_query`   | `{ list?, owner?: "me" \| "owner" \| agentId, client?, project?, side?, repo?, states?, open?, late?, dueBefore?, dateFrom?, dateTo?, text?, keys?, groupBy?, limit? }`                                                                                                                 | Up to 50 slim rows of one list (Work by default), doing and waiting first, then by due date, with the total; `groupBy` adds counts per client, project, side, owner, state, category, month or financial year; a list with amounts adds exact totals per currency. |
| `record_get`      | `{ key }`                                                                                                                                                                                                                                                                               | One entry with notes, links and its latest changes; a client adds what each side owes, its contacts and projects, and a project its health now.                                                                                                                    |
| `record_create`   | `{ sourceEventId, records: 1–100 × { list?, title, owner?, state?, waitingOn?, due?, notes?, category?, side?, client?, project?, repo?, kind?, role?, email?, phone?, terms?, repos?, gstin?, placeOfSupply?, amount?, currency?, date?, repeat?, fields?, sensitive?, suggested? } }` | Creates entries, clients, contacts and projects in order, so a row can name a client made earlier in the call. A retry returns the existing keys; a client, contact or project that exists by name is returned, not duplicated.                                    |
| `record_update`   | `{ key, sourceEventId, title?, state?, waitingOn?, owner?, due?, notes?, category?, side?, client?, project?, repo?, kind?, role?, email?, phone?, terms?, repos?, gstin?, placeOfSupply?, amount?, currency?, date?, repeat?, fields?, sensitive?, confirmed?, expectedRev? }`         | Changes only the fields given and logs each one. `expectedRev` refuses a stale write.                                                                                                                                                                              |
| `list_define`     | `{ sourceEventId, proposal?, template?: "expenses" \| "invoices" \| "dates", list?, name?, noun?, prefix?, fields?, categories?, states?, stateNames?, amount?, currency?, sensitive?, dueLabel?, dateLabel? }`                                                                         | Without `proposal`, stores a proposed list (or fields to add to one) and returns its id; nothing is created. With it, creates the list, only in a later turn whose events include the owner's message or tap in that chat.                                         |
| `payment_record`  | `{ sourceEventId, key, amount?, paidOn?, note?, void? }`                                                                                                                                                                                                                                | Records a payment against an invoice, or voids one; returns the received total and balance. A retry records nothing more. Paying the balance closes the invoice.                                                                                                   |
| `money_summary`   | `{}`                                                                                                                                                                                                                                                                                    | The owner's money summary, computed in code: owed and overdue by client, received and spent this month and last, the next 30 days' dates.                                                                                                                          |
| `dates_query`     | `{ from, to, lists?, open?, limit? }`                                                                                                                                                                                                                                                   | Every entry of every list with a due date or its own date in the window.                                                                                                                                                                                           |
| `deal_stages`     | `{}`                                                                                                                                                                                                                                                                                    | The company's deal stages in their order; a deal's `fields.stage` must be one of them.                                                                                                                                                                             |
| `company_profile` | `{ sourceEventId?, set? }`                                                                                                                                                                                                                                                              | Reads the company profile (legal name, address, tax ids, bank details); `set` changes it only when the owner asked in this turn.                                                                                                                                   |

Lists other than Work, clients, contacts and projects are configuration (`work/registers.ts`): a definition with typed fields (text, choice, date, person, link, money, file) stored on `kin_registers`, entries in the same `kin_records` rows. A lead proposes one with `list_define` and the server creates it only from the owner's later answer (`kin_list_proposals`, K068), so no model output alone makes a list. The owner sees, renames, archives and retires fields through `kin.work.lists` and `kin.work.updateList`; nothing is deleted. Amounts are integer minor units with an ISO currency (`amount_minor`, `currency`): a lead passes the words ("4.2 lakh"), `work/money.ts` parses them, and every total, balance and group-by is summed in code with BigInt per currency, never mixed. Months and financial years (April to March) are taken in the owner's time zone. A file field keeps attachment ids from the turn's own messages, read under the chat's attachment rule. An entry with `repeat` spawns its successor when it closes, keyed by `repeat:<recordId>` so a retry or a reopen makes no second one. Invoice payments live in `kin_record_payments`. The money summary and company profile are owner-only RPCs, and the morning brief's owner-only prompt carries the summary as a `# Money` section.

`client` and `project` take a key or an exact name; one shared by two is refused and asks for the key. An entry given a project and no client takes the project's client. A lead may raise `sensitive`, never lower it.

`due` is a date (end of that day in the owner's time zone) or a time with an offset; `null` clears it. Who asked is derived from the turn's stored events, never from input: an entry is confirmed, and an owner change records the owner as its assigner, only when every event in the turn is the owner's. A lead inferring something sets `suggested` and the entry waits for confirmation.

Code moves entries wherever it can, with no lead turn. A merged PR closes every entry linked to it (`kin_github_link`, `work/githubEntries.ts`), with the merge as evidence, when the owner's watch sees it.

**Assigned work.** When an entry's owner becomes a lead, `KinRecords` enqueues `record.changed` only when the stored assigner is that lead's owner and the change wasn't the lead's own; anyone else's assignment is recorded and wakes nothing. The event carries the owner as its provenance, so the turn is owner-only and its reply goes to the lead's direct chat with the owner. The queue's dedupe key is per entry and change, so repeated assignments coalesce. The same holds when the owner reopens a lead's closed entry, which gives it to the lead again with the owner as assigner. When the owner closes, drops, declines or takes back an open entry a lead holds, or gives it to another lead, the lead gets a `withdrawn` event under the same rules. The lead stays silent unless the owner needs to know something. Kin's own close on a merge, and the lead's own changes, wake nothing.

At start the server imports, once per item and keyed by where it came from, every open commitment and objective in memory. Memory is not written; `INDEX.md` stops listing those two kinds. A lead's profile "In hand" reads its open entries, deferrals and schedules.

### Connected services (`KinConnectionsToolkit`)

The owner connects remote MCP servers in Settings (`kin.connections.*`, `settings:write`, owner only); a lead reads them with `kin_connection_tools` and `kin_connection_call` and asks for a missing one with `kin_connection_offer`. All three are refused in a shared turn. Keys live only in the server's secret store (`kin-connection-<id>`), never in SQLite. Every tool arrives off, and the owner's mark binds to a digest of its name, title, description, input schema and annotations (`connections/Pinning.ts`): a tool or server instructions listed differently later stop being callable until the owner accepts the change. The gateway reaches only public https addresses, checked on the URL and again on every resolved address, and follows no redirect.

A result is outside text, so reading one marks the turn (`kin_wakeup_outside_reads`, in the call row's transaction). From then on the second gate in `KinToolGate` applies `OUTSIDE_TOOLS` (`lead/OutsideContent.ts`), built like `SHARED_TOOLS`: no worker starts or is messaged, `kin_document` runs only a recipe, and further connection calls reach only a closed connection's tools whose server didn't send `openWorldHint: true` (`OpenWorldHints.ts` reads the hint as sent; Effect's MCP schema decodes a missing one as `true`). A turn whose events an outside-read turn wrote, by a reminder, schedule or hand-off, starts marked (`carryOutside`, in `quoteEvents`). What the turn writes to memory is the owner's alone, through the existing sensitive-read mark.

### Replies

A lead's plain text is its reply. The reply bridge (`kin/reply/KinReplyBridge.ts`) reads the lead thread's assistant text, from the live orchestration stream (the Claude adapter streams `text_delta`s as they are written, so a draft grows live) and, when the run ends, from its projection, and posts it through `KinLevelGate.post` with the server's own identity for the running wake-up (`KinIdentity.agentForWakeup`), so membership, mute, the floor, notice limits and L0 shadowing apply exactly as to `kin_chat_post`. Routing comes from stored rows: a wake-up's text goes to the chat of its highest-priority claimed human message or card tap, else to `ownerChatId` as a notice, where `NO_REPLY` posts nothing. Plain code classifies each segment: long or structured text posts; a short single-paragraph segment followed by a tool call is a status note, kept for the journal and the owed-reply fallback, never shown; the same text at the run's end is the reply. Later text joins the reply's message, except a segment that only repeats it word for word (`repeats`), which is dropped. A message steered in mid-turn gets a reply of its own. Each segment posts once by `clientMessageId` `reply:<turnItemId>`. Presence and drafts are live only.

The presence line says what the lead is doing from the moment a message is accepted; there is no `seen` for a lead. Its words come only from `PHASE_LABELS` and the tool table in `kin/reply/classify.ts`, never from tool arguments, model text or user text, and the server sends an update only when the state or label changes. `ChatWake` shows a `starting` line as soon as a human message, card tap or waking reaction is queued, unless a wake-up already shows one in that chat: "Finishing something else" while the lead runs a wake-up, else "Catching up". The claim (`KinReplyBridge.preparing`) takes the lane's line for its wake-up as "Catching up" and relabels lines in other chats "Finishing something else"; then "Thinking" once the provider turn runs ("Looking at what you sent" when the messages brought files) and after each tool call ends; a tool's own label while it runs, in words a colleague would use and never a tool name or Kin's own vocabulary ("Checking my notes", "Setting a reminder", "Passing this on", "Checking pull requests", "Working" for an unknown tool; `kin_react` and `kin_journal` leave the line as it was); "Writing" while text streams. A stall shows no output and returns to the interrupted label when output resumes. Once the run's reply is settled, its line clears, so the memory commit after it never reads as work on the owner's message, and work after a posted reply restarts the line's timer; a late event never brings it back. Whenever queued chat events leave or a wake-up ends (a withdrawn reaction, a resume that expires them, a wake-up that never began), a queue line stays only in chats where a ready one still waits. Clients show `seen` from older servers as no line. A message steered into a notice wake-up makes it owe a reply in the same chat.

Create deferrals only with `kin_defer`, and cancel one with `kin_cancel`. Use `memory_write` update/invalidate on a stored deferral to change only `status` (`done`/`cancelled`) and `invalid_at`. The server preserves `chat`, `source_event`, `what` and `on_due`; attempts to change them are refused. Closing or cancelling disarms the deferral.

A `memory_write` refusal the lead can fix says what to change: the front-matter key the writer rejected, an id already written differently in this wake-up, a stray field, an existing item to update or supersede instead, or a busy writer to retry. Refusals about who is calling stay unexplained.

### Doing the work: the shell and delegated tasks

There are no Kin workers. A turn only the owner reads, that has read nothing from outside, gets the provider's own built-in tools (Claude Code's shell, edits and web; Codex's shell, patches, cached web search and image viewing) and the T3 tools above (`fullSessionRefusal` in `AgentSession.ts`). Its shell runs as the Kin server's OS user with the owner's GitHub login, so the lead does GitHub work itself with `gh`; what it posts is signed (`ghSign.ts`). Building a change goes to T3's `delegate_task`: the task runs in a worktree, opens the PR, and keeps the asking turn's rights, no more, for as long as that turn would (`governingTurn`). A shared turn, or one that has read outside text, gets none of this: Kin tools only, each checked against who started the turn. The one exception is Claude Code's own web search in a shared turn: it runs at Anthropic and opens nothing from this machine, and Kin marks the turn as having read outside text before its results arrive (`webSearchRefusal`). Codex's and ACP agents' shared turns get no web search.

A delegated task gets a card in the chat the request came from (`DelegatedTasks.ts`), and its usage counts against the owner's daily limit for tasks. When it ends, T3 tells the lead's thread; Kin turns that notice into a `task.finished` event, so the reply runs as a Kin wake-up and lands in the chat the work was asked from (`TaskWake.ts`).

### The Memory interface and git writer (DESIGN 4)

**New** `apps/server/src/kin/memory/Memory.ts`. A vector index can be added later behind the same interface.

```ts
export const MemoryItemKind = Schema.Literals([
  "objective",
  "commitment",
  "deferral",
  "decision",
  "person",
  "claim",
]);
export const MemoryTrust = Schema.Literals(["owner", "member", "external", "agent"]);
export const MemoryItemFrontMatter = Schema.Struct({
  id: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  status: Schema.Literals(["open", "done", "cancelled", "superseded"]),
  due: Schema.NullOr(Schema.String),
  on_due: Schema.optional(Schema.Literals(["remind", "start", "ask", "chase"])),
  owner: Schema.optional(TrimmedNonEmptyString),
  recorded_at: Schema.String,
  valid_from: Schema.String,
  invalid_at: Schema.NullOr(Schema.String),
  superseded_by: Schema.NullOr(KinMemoryItemId),
  review_by: Schema.NullOr(Schema.String),
  source: Schema.String,
  said_by: TrimmedNonEmptyString,
  trust: MemoryTrust,
  links: Schema.Array(Schema.String),
});

// Server-side cache record, not written to YAML.
export const MemoryItemHead = Schema.Struct({
  ...MemoryItemFrontMatter.fields,
  orgId: KinOrgId,
  path: TrimmedNonEmptyString,
});

export class Memory extends Context.Service<
  Memory,
  {
    ensureCheckouts(orgId: KinOrgId): Effect<MemoryPaths, MemoryError>;
    prepareWakeup(orgId: KinOrgId): Effect<{ head: string; indexAsOf: DateTime.Utc }, MemoryError>;
    readPromptSnapshot(
      orgId: KinOrgId,
      expectedHead: string,
    ): Effect<{ rules: string; index: string }, MemoryError>;
    readIndex(orgId: KinOrgId): Effect<string, MemoryError>;
    readRules(orgId: KinOrgId): Effect<string, MemoryError>;
    readItem(
      orgId: KinOrgId,
      id: string,
    ): Effect<MemoryItem, MemoryError | MemoryNotFound | MemoryDuplicateId>;
    query(
      orgId: KinOrgId,
      q: MemoryQuery,
    ): Effect<ReadonlyArray<MemoryItemHead & { readonly duplicate: boolean }>, MemoryError>;
    stage(ctx: WakeupContext, change: MemoryChange): Effect<MemoryStaged, MemoryWriteRejected>;
    appendJournal(ctx: WakeupContext, lines: JournalLines): Effect<void>;
    commitWakeup(
      ctx: WakeupContext,
      outcome: "completed" | "failed",
    ): Effect<{ commit: string | null }, MemoryError>;
    rebuildIndex(orgId: KinOrgId): Effect<void, MemoryError>;
    rebuildCache(orgId: KinOrgId): Effect<void, MemoryError>;
  }
>()("t3/kin/memory/Memory") {}
```

Writer rules, enforced in code on `stage`:

- Paths: only `objectives/`, `commitments/`, `deferrals/`, `decisions/`, `people/`, `claims/` and `journal/`. `rules.md` is refused. `INDEX.md` is generated from validated memory heads, never staged by a lead. `README.md` is never touched.
- No deletes. `invalidate` sets `invalid_at`; `supersede` sets the old item's `superseded_by` and `status: superseded` and creates the new one.
- Provenance comes from the event, not the model. The writer looks up `sourceEventId` in the current batch and sets `said_by`, `source` and `trust` from the event's `provenance`. Owner → `owner`, member → `member`, GitHub or outside text → `external`, an agent → `agent`. The lead may lower trust but never raise it. A member's statement that reads like a rule is stored under `claims/`.
- `review_by` defaults by kind: person 90 days, commitment and deferral at `due`, decision `null`, claim 30 days; objective at the next milestone date (falling back to `due`, then +30 days from `recorded_at`). Explicit `review_by: null` is preserved.
- Contradictions: if an open item of the same kind shares a link or id and says something different, and `supersedes` was not passed, `stage` fails with `MemoryConflict { existingId }`. The lead then supersedes (same source, newer) or posts a question to the owner.
- Secret scan: before commit, the staged diff goes through `KinSecretScan.scan({ orgId, files })` (triggers spec). A hit refuses the whole commit, discards staged content and emits a typed `MemorySecretBlocked` notification. The runner records the refusal in its next safe journal entry and tells the owner.

Staged bytes live only in server memory. Discard requires no checkout validation and works after restart. Completed commits contain only validated bytes, a journal appended to the recorded tree, and an optional generated index. Failed wake-ups discard item changes and commit the failure journal. A private index and `hash-object --no-filters`, `read-tree`, `update-index`, `write-tree`, `commit-tree`, and compare-and-swap `update-ref` build commits on the SQLite-recorded parent, never HEAD. Author and committer identity come from server configuration (default Kin Memory Bot <kin-memory@localhost>), never repository configuration.

Branches: in chats the owner placed the lead in, the writer commits to the default branch, through a pull request (below). A wake-up from any other chat commits to `kin/shadow/<agentId>` (see Permissions). Dreaming (triggers spec) commits to `dream/<date>` branches and takes the same per-organization semaphore while it writes, so it never runs during a wake-up.

Pushes and fetches use the configured URL explicitly, never a local remote name or pushurl. A retry of an already recorded wake-up returns that commit (with `KIN_MEMORY_DIRECT_PUSH`, after pushing it again). Synchronization uses verified ancestry and plumbing-only fast-forwards. Divergent trees merge disjoint edits and append-only journals in process, then use `commit-tree` with both parents. The merge base is git's unique merge base, except while GitHub's newest squash of this server's commits isn't merged in here: git's ancestry doesn't link a squash to the commits it carries, so the base is then the local commit whose tree that squash holds, read from `refs/kin/landed` (below). Local commits after it are changes on top of what landed, not a second writer. Content conflicts keep the local head, which may hold commits the remote never got, and tell the owner once per pair of heads; the lander then can't land until the two are reconciled. Sync never pushes the default branch. Missing or ambiguous merge bases preserve and notify, then fail closed without resetting; the organization stays blocked until an operator runs `Memory.recover`, and repeated attempts reuse the conflict branch already holding that head. Failed fetches retain the SQLite anchor. Existing writers with mismatched or missing anchors fail closed as `MemoryCheckoutInvalid`.

**Writes to the default branch commit here and land on GitHub in the background (TRIG-15).** A wake-up's memory is done once `commitWakeup` (or the owner's Undo) commits it to the local default branch and moves the anchor; the writer then signals `MemoryLander` and returns, so nothing in a wake-up waits on GitHub and the writer lock covers only local git work. The memory repo's `main` takes no direct push, so the lander, one per organization and one batch at a time, takes everything the local branch holds that the remote's lacks as one PR: it fetches GitHub's head with no lock held, merges it in under the writer lock (the sync below, without `fsck`), then outside the lock builds one commit on the remote head with the local tree and pushes it to `kin/write/land/<commit>` (a fresh commit and branch on every attempt, since the branch check refuses a branch that ever had another PR). Commits made while a batch waits on CI ride in the next batch. `MemoryPullRequests` opens the PR with a `server` App token (`contents` and `pull_requests` write, `checks` and `actions` read). Before merging, Kin checks that the PR head is exactly the commit it pushed and that `memory-check` passed in a run it can trace: a `pull_request` run of `.github/workflows/memory-check.yml` on that commit and branch, from the memory repo itself rather than a fork, whose `memory-check` jobs all succeeded. A run's `pull_requests` comes from the PRs open with that head now, not from the PR that triggered it, so it can't tie the run to this PR and base. Instead, before reading runs and again just before merging, Kin requires that the branch has only ever had this PR (`pulls?state=all&head=`) and that the PR's issue events hold no `base_ref_changed`; otherwise an agent could run its own `memory-check.yml` through a second PR from the branch, or by moving this PR's base and back. Any workflow can post a `memory-check` check run, even into that run's check suite, so every `memory-check` check run on the commit (`filter=all`) must have the id of one of those jobs, an Actions job's id being its check run's id. Any of these lists running past one page (a full page or a `next` link) fails the check. Then Kin squash-merges through REST with `sha` pinned to that commit; when the merge parent is the remote head the batch was built on, the squash's tree must match it. GitHub's auto-merge is not used: it trusts any Actions workflow's `memory-check`. Once the merge is confirmed the lander points `refs/kin/landed` in the writer at one commit whose parents are GitHub's squash and the local commit whose tree the batch carried, so both halves of the record move together. The memory repo allows only squash merges, so the next sync folds the squash commit back in with a local merge commit whose parents are GitHub's head and the local one, using the recorded local commit's tree as the merge base. A commit made while the batch waited on CI, even to the same item, is then a change on top of what landed and rides the next batch; only an edit on GitHub to the same item is a conflict. Local history, and with it each wake-up's own commit, is never rewritten, and the local head descends from GitHub's, which a dream branch cut from it needs. The record is stale once its squash is merged in, when git's own merge base is at least as new, and is ignored unless its two commits are in local and GitHub history. If the server stops between GitHub's merge and writing the record, the squash still names its local commit (`Kin-Local:`); the sync accepts that only when the two trees are identical, so redoing it is safe. A writer with no record merges from git's merge base, which is a no-op merge when the trees already match. Each landed batch logs its commit count and PR number, and a start with nothing to land logs that too. Every path a writer writes is one the memory repo's `CODEOWNERS` leaves to Kin, so no batch waits on a review. A server from before that kept such changes under `refs/kin/review/` or in an open `…-review` PR; at start the lander puts their items on the local default branch (only commits this server made, and never over a later local write to the same item), closes each such PR with a comment, and lands them with the next batch. When GitHub's guard-rail files differ from what the server ships, the lander first opens the one guard-rails PR (`MemoryLander.upgradeGuardRails`) and tries to merge it on every landing run and every sweep. A failed or foreign check, a moved head, another PR from the branch, a changed base, a check still running after 15 minutes, a refused merge or an unreachable GitHub closes the batch PR with a comment and undoes nothing: the local commits stay, leads keep reading and writing them, and the owner's direct chat gets one "Memory write not merged" notice with the reason and link, saying memory is still saved on this server. Any other failure while landing (git, the filesystem, the local database) is reported through the same notice, once per distinct cause, and held against the local head that attempt read, so a commit made meanwhile is still tried. Landing for that organization then waits until a later local commit changes the batch, or the server restarts; a retry that fails the same way posts nothing new. A merge GitHub refuses for want of a review, which only the owner can clear, is held against GitHub's guard-rail files instead: no later commit retries it, only a change to those files (the guard-rails PR merging) or a restart, so it never opens a PR per change, and the owner's chat gets one plain notice, unless the guard-rails PR's own request to approve it already covers it. Memory writes post nothing else to the chat. Without the owner's GitHub login, writes to the default branch are refused and the owner is told; `KIN_MEMORY_DIRECT_PUSH=true` restores direct pushes, inside `commitWakeup`, for a memory repo without the TRIG-15 ruleset. At startup the lander first folds in what an older server held for review, then sweeps, then lands what the last run left. The sweep, at startup and every 5 minutes on the Kin scheduler, takes the landing lock rather than the writer lock and closes, with a comment, every open `kin/write/*` PR no landing waits on (so a batch PR a crash left open is closed, never duplicated), except the guard-rails PR whose head is the commit recorded under `refs/kin/guard-rails`; while that PR waits, each sweep also wakes the lander, so the owner's approval is acted on within minutes. Orphans are found on one page of open PRs, newest first, so a flood delays them to a later sweep. Each GitHub call times out after 30 seconds. The landing lock is taken before the writer lock and never inside it, and history rewrites take it too, so no batch is mid-landing while a purge rewrites the remote. Dream branch pushes and deletes also run under the landing lock rather than the writer lock.

Front matter matches the kin-memory README, including snake_case keys. Date-only values mean UTC midnight; date-times require an explicit UTC offset, and invalid dates make an item malformed. `links` values containing `#` must be quoted. `owner` and `said_by` hold handles; `orgId` and `path` belong only to the server-side `MemoryItemHead`.

LEAD-2: the front matter parser must use YAML’s core or JSON schema; YAML 1.1 turns `review_by: 2026-11-13` into a Date.

The production `MemoryConfig` layer derives its server-owned base from `ServerConfig.stateDir`, using `${stateDir}/kin/<orgId>/memory` and the `memory-read-<agentId>` checkouts beside it (organization ids are path-encoded). Tests may supply an isolated base and relative paths. Paths must not overlap or escape that base. `ensureCheckouts` bootstraps a missing writer from a fresh fetch of the configured URL and configured default branch (`main` by default). K011 stores `(org_id, branch, head)` in `kin_memory_heads`; no writable file or local remote ref can bootstrap an existing checkout. Before committing or pushing, each local branch tip must match its anchor. Compare-and-swap branch updates and SQLite recording happen together in the writer operation; a crash between them is rolled back to the recorded anchor with a compare-and-swap and an operator notice. Prepare and commit share a per-org lock. Pinned reads and writer operations skip re-bootstrap; writer operations still validate the writer checkout every time, and reads validate when they set a new pin. Read clones are replaced from scratch on prepare: git is never run in an existing lead read clone. Every git invocation uses a private git directory excluding repository config, hooks and grafts; merge plumbing uses verified bytes and a private index, never git merge-tree or a writer work tree, with system/global config disabled and hooks/fsmonitor disabled.

**Threat model.** Leads currently run full-access as the same OS user (`kin`) as the server. Assume leads can modify everything under `${stateDir}/kin/*/memory*`, including `.git` and file anchors. Code trusts only SQLite and server configuration, checks recorded branch tips, and builds commits from server-validated bytes rather than ambient working-tree/index content. These are not an OS sandbox: a same-user lead can still attack server processes or SQLite itself. Separating leads into an OS user unable to write `${stateDir}/kin` remains Nishchay's operations decision and is required before production use.

The read side pins the SQLite-anchored default-branch head at wake-up (or first read), never the lead’s read-checkout HEAD or working-tree edits. Snapshots reload only on a new wake-up pin or explicit `rebuildCache`; blob contents and parse failures are cached by SHA. Symlinks are skipped; oversized blobs (over 256 KiB), malformed items and kind/folder mismatches are logged and skipped. Queries return duplicate ids with `duplicate: true` on each copy and mark them in the index; ambiguous `readItem` calls fail with `MemoryDuplicateId`. Queries include invalid items unless `excludeInvalid` is set; `invalid_at` remains on each returned `MemoryItemHead`. Date bounds are inclusive and compare instants; date-only strings mean midnight UTC. Missing or unparsable dates do not match a bounded date query. Overdue review means strictly before the current clock.

`readItem` best-effort records integer-millisecond last-read times in Kin’s `kin_memory_reads` table, keyed by organization and item id so moves preserve history. Failed history writes are logged without failing the read. Never-read items use `recorded_at` as the baseline; index generation and queries do not count as reading an item. At eight weeks unread, items leave only the index, not search or git. Rebuilds use original heads, cap the index at 200 physical lines including the `As of <ISO>` first line, and flag invalid and overdue items. TRIG-12 extends this builder with sections, ordering and freshness defaults; no writer methods or automatic defaults are part of LEAD-2.

The generated index is derived from HEAD, not read-checkout files; LEAD-3 commits it; TRIG-12 only builds it, without a git write.

### The journal

`journal/YYYY/MM-DD.md` in the owner's timezone, one section per wake-up. The runner writes the header and the facts. The lead adds its lines with `kin_journal`. A wake-up that never calls `kin_journal` still gets an entry.

```md
## 09:02 · wake-up 01JC… · tech-lead · L0 · claude-opus-4-6 · 14.2k tokens (9.8k cached)

Events: owner message (#direct), 20 × github push GLDRoger/t3code

- Saw: Nishchay asked to defer rate limiting to Friday.
- Did: posted a deferral card; wrote def-0143.
- Skipped: 20 push events, no open items linked.
  Tools: kin_chat_post ×1, memory_write ×1
```

### Permissions (DESIGN 10)

The owner never sees levels. A lead works where its owner put it: in its direct chat with its owner (`kin_leads.owner_chat_id`, a `direct` chat whose `direct_key` is `<lead owner's person id>:<agentId>`) and in any group whose active `owner` member is the lead's owner while the lead is an active member, it posts, pings, reacts, starts workers and asks for draft-PR work. Merges and every other privileged action still need the owner's signed grant (section 9); asking for a merge isn't open to a lead at all, so it says the PR is ready and the owner merges.

Inside, the server keeps the levels as the gate (`KinLevels.ts`, `LevelGate.ts`). Leads are stored at L0. For a call that targets a chat the effective level is `min(base, cap)`: `base` is the lead's level, raised to L2 in a chat its owner placed it in (`OWNER_PLACED_LEVEL`, computed from stored membership on every call, never from tool input), and `cap` is that chat's `kin_chat_levels` row if there is one. Calls without a chat use the lead's own level. A wake-up works at no more than where it came from (`KinLevels.wakeupLevel`): its lane's level, capped for due work (deferrals, reminders and scheduled runs) by the chat it was asked from, and for a request another lead passed on by the chat the owner wrote it in. The server derives that `origin` when the work comes due from the item's `source_event`, the event its `kin_defer` or `kin_schedule` call was made from (that event's chat, or the origin of the due wake-up it came from), never from tool input, and carries it on the `deferral.due` event; it is left off when it is the running lead's owner chat, so owner-asked deferrals run as before. An item whose source event isn't stored falls back to its own `chat`. Posts, cards, questions and reactions use the lower of the wake-up's level and the target chat's. Below L1 a post, card, question or reaction is refused with `not_allowed`, except in the owner's direct chat; below L2 `kin_delegate` and Work requests are refused; below L3 merge requests are refused before GitHub is read. A refusal is plain words and acts on nothing, so chats someone else owns, and every member context in wave 5, stay closed until the owner signs a raise. L3 is never a default.

Memory follows the running wake-up's level (`KinLevels.wakeupLevel`). A wake-up at L2 writes to the default branch through the writer's PR. A wake-up at L0, one a chat the owner didn't place it in woke, writes and reads `kin/shadow/<agentId>`, so text from a chat the owner didn't vouch for never reaches the default branch. `Memory` resolves the view from the running wake-up's level, or the lead's own level when nothing runs, never from tool input.

`set_level` is the only way a level changes. `kin.levels.raise` (owner only, `settings:write`) creates a `KinPendingAction { kind: "set_level" }` with the reserved requester `kin-promotion`; `KinPendingActions.create` refuses `set_level` from any other requester, and no agent tool creates a pending action, so nothing a lead writes changes its own permission. It applies only when the executor claims it under the owner's signed grant (`approvals/handlers/setLevel.ts`, `KinLevels.raiseByGrant`). `kin.levels.lower` applies at once and withdraws the raises it overtook; `kin.levels.get` (`orchestration:read`) reads the lead's level, caps and open raises. No client screen calls these. This replaces the earlier promotion ladder and the owner's "shadow week in groups only" (owner, 10 Nov 2026).

### Budget (gap 2)

T3 runs on the owner's subscriptions, so budget is counted in tokens, not money. Per organization, in `kin_budget` (**new**: `org_id, day, lead_units, worker_units, exhausted_notified_at`):

- `units = (inputTokens − cachedInputTokens) + 0.1 × cachedInputTokens + 4 × outputTokens`, summed over the run's provider turns' cumulative `turnTokenUsage`, including `otherUsage` at input/output weights. Incomplete or missing field counts fall back to `usedTokens` at weight 1 and are logged; absent usage is recorded and logged.
- `day` is the owner-local `YYYY-MM-DD`. Units are finite non-negative real numbers because cached input has fractional weight; limits are non-negative integers. Lasting limits live in `kin_budget_limits (org_id PRIMARY KEY, limits_json)`, where `limits_json` is `{ leadUnits, workerUnits }`; day rows hold counters only. `exhausted_notified_at` records the once-per-day exhaustion notice.
- Defaults: 2,000,000 lead units and 6,000,000 task units (`worker_units`) per day, reset at 00:00 in the owner's timezone from `KinTriggerSettings.timeZone` (triggers spec). The owner sets them in settings.
- `admit(orgId, priority)` by share of the lead budget left: above 40% everything runs; 20–40% defers P3 to tomorrow; under 20% only P0–P1; at 0 only P0, still on the lead's model, and the owner is told once. Dreaming (P4) runs only above 30%. Admission does not reserve units, so N leads waking at once can overshoot the daily limit by up to N wake-ups before the first charge lands.
- Deferred P2/P3 events wait until the next owner-local reset unless limits change.
- A wake-up spanning midnight bills the owner-local day on which the charge is made.
- `admitTask(orgId)` refuses at 0 task units left (`worker_units`, the older name). Delegated tasks are charged when they end (`KinBudget.chargeTask`); that must not also count the lead turn's Claude `otherUsage`, which is already lead units.
- Kin targets Claude Code and Codex. Other providers need only a safe fallback: without a per-turn `turnTokenUsage` ledger, use `usedTokens` at weight 1 conservatively; no ledger integration for those providers is required.
- Deferred events stay queued with `not_before` and show in the morning brief ("3 checks postponed for budget").

`UsageLimitSources` (`apps/server/src/usage/UsageLimitSources.ts`) only reads cliproxy accounts, so plan headroom is not generally known. Kin uses its own counters. See open questions.

Budget RPC payloads (wiring in LEAD-10 through `kinRpcs.ts`): `kin.budget.get` uses `KinBudgetGetInput { orgId }` and `kin.budget.set` uses `KinBudgetSetInput { orgId, limits: KinBudgetLimits }`; both return `KinBudget { orgId, day, leadUnits, workerUnits, limits, leads? }`, where `leads` lists each lead's units today, largest first. The figure and the limits stay per organization, and the exhaustion notice names each lead's share. Setting limits is owner-only.

### The stop switch (gap 3)

`kin_org_state` (**new**): `org_id, paused, paused_at, paused_by, reason`. `paused_by` is the server-resolved `KinPersonId`, never a client-supplied author. Resume clears all three nullable pause fields.

`KinStop.pause(orgId, by)`:

1. Sets `paused` first, so nothing new starts: the runner claims nothing and dreams wait.
2. Interrupts the active run on every lead thread and on the current thread of every running dream, plus `stopDelegatedTasks` on each. Routines (step 3) and lead runs stop side by side. Each thread is stopped independently; one failure does not skip the others, and the fan-out fails once all have run. A wake-up whose run ends this way returns its events with `release({ countAttempt: false, notBefore: now + pause poll interval })`, so no attempt is spent. A pause that lands while the runner is launching is caught by a recheck right after the launch or send. A dream that sees the pause after any turn or after its push fails and deletes its branch, so nothing it wrote is merged.
3. Tells the triggers spec (`KinRoutines.pauseAll(orgId)`) and the approvals spec (the executor checks `KinStop.isPaused` before every run and refuses).
4. Posts "Kin is paused. Nothing runs until you resume." to the owner's direct chat.

Pause with steps 2 and 3, and resume with `resumeAll`, hold a per-org lock, so a resume during a slow fan-out runs after it and routines end unpaused.

`KinStop` lives with the chat and budget services the WebSocket handlers use; those are built outside the orchestration runtime, so the lead runtime attaches steps 2 and 3 to it (`KinStop.attach`). At startup it replays them for orgs still paused and calls `resumeAll` for orgs resumed since, which heals a resume that ran before the attach or whose `resumeAll` failed. Replayed interrupts carry a per-boot nonce in their command ids: recovery keeps run ids, and a pre-crash receipt must not swallow the replay. Pausing a paused org keeps the original `paused_at`, `paused_by` and reason and posts nothing, but runs steps 2 and 3 again, so a retry reaches work a failed fan-out missed. A fan-out failure returns `unavailable` with the org still paused.

While paused, `enqueue` still records events, so nothing is lost. `KinStop.resume(orgId)` clears the flag, calls `KinRoutines.resumeAll(orgId)` and enqueues one `resume` event per active lead (dedupe key `resume:<pausedAtMs>:<agentId>`). It posts "Kin resumed." to the owner's direct chat, adding how many queued events expired. That wake-up sees what arrived during the pause. Events queued (`queued_at`, server receipt) more than 24 hours before the resume are marked `expired` in the same transaction and listed in the resume event, not acted on. Resuming an org that is not paused changes nothing. A deferral that came due during the pause is treated as `on_due: ask`, never `start`.

Payloads: `KinOrgGetInput { orgId }`, `KinOrgPauseInput { orgId, reason? }`, `KinOrgResumeInput { orgId }`; all return `KinOrgState { orgId, paused, pausedAt, pausedBy, reason }`.

RPC (**new**, through the chat spec's `kinRpcs.ts`): `kin.org.get` for any person in the organization (`orchestration:read`), and `kin.org.pause` and `kin.org.resume`, owner role only (`orchestration:operate`, then the same owner check as `kin.budget.set`). Pausing needs no signature because it only stops things. Resuming needs an owner session. No MCP tool pauses or resumes. The mobile spec draws the switch in settings and as a lock screen and notification action that calls `kin.org.pause`.

### Morning and evening routines: content

Scheduling is the triggers spec's. Each fires a `routine` event through the queue, so stop, budget admission and retries apply as to any event. The server gathers the facts and the lead writes the morning brief and evening summary from them: after budget admission the runner gathers the facts below in code (memory cache, chat waiting items, workers, budget, wake-ups and dreams, and GitHub through the routine reader, as the owner) and renders them with the templates in `routines.ts`. The rendered text goes to the lead, quoted as server-gathered data, and the lead's reply in the owner's direct chat (`ownerChatId`) gets the native `routine` card (`KinRoutineCard`), at every level. When the budget refuses, or the lead posts nothing within 20 minutes, Kin posts the rendered text itself as one system message with the card and says it did. In that text, memory, chat and GitHub text is Markdown-escaped so it renders as plain data, and the card's fields are plain text. The 12-line cap is enforced in code: overflow ends in "+N more lines in the card", and the card keeps every row. The message and card ids derive from the event id, so a retry never posts twice; a failed brief is released with a counted attempt while the rest of the batch runs. A request carries its original due time, lateness and any folded routine dates; the header names lateness over 15 minutes and every folded routine. The owner check selects memory-review items in code and posts its native card after budget admission; its taps use owner-authored writer sources, not model authority.

Card rows carry the memory item id and link. A due deferral's row names its existing deferral card (`widgetId`), whose buttons act on it; the card has no buttons of its own. Keep, Update and Drop for items past `review_by` stay on the weekly owner-check card, so the brief lists those items without buttons. Without the owner's GitHub connected, the brief says PRs and CI were not checked. It says, in one line, when the GitHub read was partial: a repo could not be read, a repo has more than the 50 latest-updated open PRs it checks, or the owner has no GitHub login. Review requests count only when they name the owner directly, not a team. The repos read are the deployment-wide `KIN_GITHUB_REPOS`, not a per-org scope.

Morning brief, gathered live (TRIG-13 has no prepared brief yet):

- Due today: deferrals and commitments (with person and link), each with buttons from the deferral card.
- On owner-local Mondays, due this week: deferrals and commitments due in the next six days.
- Overdue: commitments past their date, and whether a ping went out.
- Waiting on you: count, plus the oldest item.
- PRs waiting on the owner's review, and CI red on the default branch.
- Objectives at risk, one line each with the reason.
- Delegated tasks running or stuck.
- How many events were held over to stay within the day's budget, only when some were. Spend itself is not the owner's morning reading.
- Items past `review_by` are rows on the card only (their Keep, Update and Drop are on the owner-check card). Memory upkeep stays out of the message: the owner's first brief listed two reminders that had already fired as "past review date".

Evening summary:

- Done today: delegated tasks that finished, each with its first PR, commit or CI run.
- Slipped or changed: items superseded today with a new date, and items due earlier today still open.
- Promises made today, by whom.
- Open questions: the owner's unresolved waiting items, count and oldest.
- Due tomorrow.
- Replies that failed today, only when some did, because a failed turn may have cost the owner an answer. Units, the cache hit rate and failed dreams are gathered for the facts but not written into the message: they are Kin's telemetry, and the owner's first summaries were nothing else.

### Failure cases

| Case                                            | Handling                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server restarts mid wake-up                     | On start, for each `kin_wakeups` row in `running`, read the lead thread's run. If it ended, finish it (step 9). If it is still running after recovery, wait. Its events stay `claimed` until then.                                                                                                                                                                                                                        |
| Provider fails or rate-limits                   | Run ends `failed`. Commit the journal only. If nothing visible happened, requeue the events after 15 s, then 60 s, at most 3 tries: the person waiting sees "<lead> couldn't start. Trying again in a moment." with Retry at once, a new message from them brings the retry forward, and the last try ends with "<lead> couldn't start. It won't try again on its own." Otherwise post "stopped partway" and don't retry. |
| Owed reply missing                              | The run's last status note is posted; if there is none, one rescue turn asks for the reply; if that is silent too, a system notice says the lead didn't reply. A chart, visual or file card alone is no reply: the rescue asks for its line, and with none the card stands without the notice. Only completed runs are rescued.                                                                                           |
| Lead loops or runs long                         | 15 min timeout, plus 5 min per steer up to 30 min, then interrupt.                                                                                                                                                                                                                                                                                                                                                        |
| Memory push fails                               | Retry; local commits stay; the next wake-up rebases.                                                                                                                                                                                                                                                                                                                                                                      |
| Memory PR not merged                            | Kin closes it with a comment and tells the owner; the default branch stays as it was and the wake-up fails with `MemorySyncConflict`.                                                                                                                                                                                                                                                                                     |
| Owner edited memory on GitHub                   | `pull --rebase` at wake-up start picks it up. A conflict aborts the rebase and fails the wake-up; an unavailable remote falls back to local HEAD.                                                                                                                                                                                                                                                                         |
| Duplicate event (re-read trigger, double timer) | Dropped by the `(org_id, dedupe_key)` index.                                                                                                                                                                                                                                                                                                                                                                              |

## Files

New:

- `packages/contracts/src/kinLead.ts`: `KinLevel`, `KinLead`, `KinEvent`, `MemoryItemFrontMatter`, budget and stop RPC payloads.
- `apps/server/src/kin/lead/KinEventQueue.ts`, `WakeupRunner.ts`, `LeadPrompt.ts`, `KinLeadRegistry.ts`, `DelegatedTasks.ts`, `TaskWake.ts`, `KinBudget.ts`, `KinStop.ts`, `KinLevels.ts`, `layer.ts`.
- `apps/server/src/kin/lead/instructions.ts` (instruction text), `apps/server/src/kin/lead/routines.ts` (brief and summary templates and the line cap; the only source of truth) and `RoutineContent.ts` (gathering and posting).
- `apps/server/src/kin/lead/mcp/tools.ts`, `handlers.ts`.
- `apps/server/src/kin/memory/Memory.ts`, `MemoryWriter.ts`, `MemoryCache.ts`, `frontMatter.ts`, `journal.ts`.
- `apps/server/src/kin/persistence/migrations/K002_Lead.ts` creates `kin_events`, `kin_wakeups`, `kin_workers`, `kin_cursor`, `kin_shadow_entries`, `kin_budget_limits`, `kin_budget`, `kin_org_state`, `kin_leads`, registered as `2_Lead` using the Kin migration list from CHAT-2 (its own `kin_sql_migrations` table), so upstream's numbered list in `apps/server/src/persistence/Migrations.ts` is never touched.
- Tests next to each file.

Upstream files touched, one line each:

- No hook of its own: the lead tools join the `/kin/mcp` endpoint that CHAT-7 adds.
- `apps/server/src/server.ts`: add `KinLead.layer` to `layerMakeRoutes` (or to the shared `apps/server/src/kin/layer.ts` if the chat spec created it, which then needs no extra upstream line).
- `packages/contracts/src/index.ts`: `export * from "./kinLead.ts";`.

## Interfaces to other specs

| This spec provides                                                            | Used by                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `KinEventQueue.enqueue(event)`                                                | chat, triggers, approvals                                          |
| `KinStop.isPaused(orgId)`, `kin.org.get` / `kin.org.pause` / `kin.org.resume` | approvals (executor), triggers (routines, dreams), mobile (switch) |
| `KinBudget.admit(orgId, priority)`                                            | triggers (dreaming at P4)                                          |
| `Memory.query`, cache change stream, per-org write semaphore                  | triggers (watchdogs, deferral scheduling, dreaming, secret scan)   |
| `KinLevels.effectiveLevel(orgId, agentId, chatId?)`                           | approvals and tools (refuse what the chat doesn't allow)           |

| This spec needs                                                                                         | From      |
| ------------------------------------------------------------------------------------------------------- | --------- |
| `KinChatService.postAgentMessage`, owner direct chat id, widget update in place, `widget.action` events | chat      |
| `KinPendingAction`, `set_level` grant                                                                   | approvals |
| `MemorySecretScan.check`, `KinRoutines.pauseAll`, routine and deferral fires routed into `enqueue`      | triggers  |
| Pause switch UI and lock screen action                                                                  | mobile    |

## Security notes

- The lead's authority is its Kin tools. Tools resolve organization and lead from the calling thread, never from input.
- Trust and `said_by` are set from server-verified provenance, never by the model.
- `rules.md` cannot be written by any lead or dream.
- Only an owner-only turn that has read no outside text gets a shell, and with it the owner's `gh` login; so do the tasks it delegates, for as long as it would. A shared turn or one that read outside text has Kin tools only. The Kin server on the Kin host runs as a dedicated `kin` user, never the owner's account, so the shell reaches only what `kin` holds: the owner's GitHub login connected from the phone and the memory repo deploy key (triggers spec, "Running on the Kin host"). Branch protection on the memory repo's `main` (pull request and `memory-check`, no deploy-key bypass) stays as a second wall around that key (`ops/kin/host/README.md`).
- Events carry references, so GitHub text and message text don't sit in the queue.
- Stopping is open to the owner at any time without a signature. Widening what a lead may do needs a signed grant.

## Tests and acceptance criteria

- Coalescing: 20 relevant `github` events within the two-minute notice window produce one `kin_wakeups` row holding 20 event ids; memory-repository and untracked traffic never enter that queue.
- One writer: two events 1 s apart in different lanes while a wake-up runs give two serial wake-ups, never overlapping (assert on `started_at` and `ended_at`); a human message in the running lane is steered into it instead.
- Fresh session: the second wake-up's run has a different provider thread id from the first, and its prompt holds no text from the first run (`DeterministicRuntime`).
- Fresh sessions: back-to-back wake-ups in one direct chat, at one level and model, each start a new provider conversation with the full prompt and each commit memory.
- Prompt prefix: two prompts at the same memory commit are byte-identical above the divider.
- Tool visibility: a non-lead thread's tool list has no `kin_*` or `memory_*` tools; `AgentContextBudget.test.ts` passes unchanged.
- Cross-organization: a lead thread registered for org A cannot read or write org B memory, whatever ids it passes.
- Provenance: a `memory_write` sourced from a member message stores `trust: member` even if the input says `owner`.
- `rules.md`: any write to it is rejected.
- Failed wake-up: staged items are discarded; the journal records the failure.
- Permissions: a new lead (stored at L0) posts in its owner's direct chat and in a group its owner owns; in a group someone else owns `kin_chat_post` is refused in plain words and nothing is posted. No refusal names a level.
- Raising: `kin.levels.raise` leaves the level unchanged until the executor claims the owner-granted `set_level` action; `raiseByGrant` without that claim is refused. A member or a read-only session gets a permission error from every level method that changes something, and no Kin MCP tool reaches the level writers.
- Stop: `kin.org.pause` interrupts a running lead and its delegated tasks within 5 s; new events stay queued; `resume` produces one `resume` wake-up; a member calling `kin.org.pause` gets a permission error.
- Budget: with 15% left, a P3 event is deferred and a P0 event runs.
- Restart: killing the server mid wake-up and restarting finishes the wake-up once, with no duplicate commit.

## Tasks

LEAD-1. **Contracts and tables.** `kinLead.ts` schemas; Kin migrations for all lead tables. Files: `packages/contracts/src/kinLead.ts`, `apps/server/src/kin/persistence/*`. Depends on: CHAT-1 (for `KinOrgId`, `KinAuthor`). Done when: `vp run typecheck` passes and a migration test creates and reads each table. Owner: backend.

LEAD-2. **Memory read side.** `ensureCheckouts`, `prepareWakeup`, front matter parser, cache, `query`, `readItem`, `rebuildIndex` (200-line cap, "As of" line, fading after 8 weeks unread). Files: `apps/server/src/kin/memory/{Memory,MemoryCache,frontMatter}.ts`. Depends on: LEAD-1. Done when: tests create a temporary git repo from invented fixtures matching the kin-memory README; kind/date/review queries, malformed-item isolation, organization isolation, cache invalidation, index cap/As-of and TestClock fading all pass. Never use real organization memory as a fixture. Owner: backend.

LEAD-3. **Memory git writer.** `stage` with every writer rule, `commitWakeup`, push and rebase, shadow branch, the secret scan hook (TRIG-16 supplies the scanner layer). Files: `MemoryWriter.ts`, `journal.ts`. Depends on: LEAD-2, TRIG-16 (stub allowed). Done when: tests show provenance override, `rules.md` refusal, conflict error, one commit per wake-up, discard on failure. Owner: backend.

LEAD-4. **Event queue and coalescer.** `enqueue`, dedupe, priorities, quiet window, claim, restart requeue, per-org semaphore. Files: `KinEventQueue.ts`. Depends on: LEAD-1. Done when: coalescing and one-writer tests pass with `TestClock`. Owner: backend.

LEAD-5. **Wake-up runner.** Lead project and thread, launch or fresh send, registry, wait, timeout, finish, restart recovery, usage capture. Files: `WakeupRunner.ts`, `KinLeadRegistry.ts`, `layer.ts`, `server.ts` hook. Depends on: LEAD-2, LEAD-4. Done when: a `DeterministicRuntime` test runs two wake-ups on one thread with distinct provider threads and the restart test passes. Owner: backend.

LEAD-6. **Instructions and prompt builder.** `instructions.ts`, `routines.ts`, `LeadPrompt.ts`, quoting of non-owner text. Depends on: LEAD-2. Done when: the prefix-stability test passes and a member message containing "ignore previous instructions" appears only inside a labelled quote. Owner: backend.

LEAD-7. **Lead toolkit: memory and journal.** `memory_search`, `memory_read`, `memory_write`, `kin_defer`, `kin_journal`, lead-only visibility on `/kin/mcp`. Depends on: LEAD-3, LEAD-5, CHAT-7 (endpoint). Done when: tool visibility and cross-organization tests pass. Owner: backend.

Reads through the lead’s file tools do not count as memory reads; LEAD-7’s `memory_read` must call the history-recording path.

LEAD-8. **Lead toolkit: post and permission gating.** `kin_chat_post`, `KinLevels.effectiveLevel` with the owner-placed rule. Depends on: LEAD-7, CHAT-7. Done when: the owner-placed and refusal tests pass. Owner: backend.

LEAD-9. **Delegated tasks.** A card for each task a lead's turn delegates, usage charged to the owner's task limit, and the finished-task notice turned into a `task.finished` wake-up. Files: `DelegatedTasks.ts`, `TaskWake.ts`. Depends on: LEAD-5, LEAD-7. Done when: a finished task's reply lands once in the chat it was asked from. Owner: backend.

LEAD-10. **Budget.** Units from turn usage, daily reset in the owner's timezone, `admit`, `admitTask`, model choice by priority, settings fields. Depends on: LEAD-5. Done when: the budget test passes and `kin_wakeups.tokens_json` matches the run's turn usage. Owner: backend.

LEAD-11. **Stop switch.** `KinStop`, RPC methods with owner-only authorization, interrupt fan-out, resume event, expiry of old events. Depends on: LEAD-5, LEAD-9, CHAT-6. Done when: the stop tests pass. Owner: backend.

LEAD-12. **Permission changes.** The owner-only `kin.levels` get, lower and raise methods, the signed `set_level` pending action and its handler. Depends on: LEAD-8, APPR-4. Done when: the level-control tests pass. Owner: backend.

LEAD-13. **Routine content.** Morning and evening templates, data gathering (cache, open PRs, CI state, tasks, budget), and an end-to-end test that a `routine` event yields one message of at most 12 lines with its widgets. Depends on: LEAD-6, LEAD-8, LEAD-10. Done when: that test passes against fixture memory. Owner: backend.

LEAD-14. Withdrawn (owner, 10 Nov 2026): there is no shadow week to rehearse.

## Design corrections

1. **A delegated task's completion wakes its parent thread.** `delegate_task` needs an active parent run, and its completion wakes the parent (`completionWake` has no "never"). On a lead's thread that wake would start a turn outside Kin's queue, so Kin turns T3's notice into a `task.finished` event and the wake-up takes over the run T3 started (`TaskWake.ts`).
2. **Prompt caching is not something Kin can configure.** Claude Code and Codex control their own requests. Kin can only keep the start of its message stable and measure `cachedInputTokens`.
3. **"Daily budget" can't be measured against plan headroom yet.** T3 reads limits only from cliproxy (`UsageLimitSources`). Kin counts tokens from turn usage.
4. **A lead woken from a chat the owner didn't place it in still needs memory.** Those wake-ups write to a shadow branch, so the lead keeps working memory while the default branch stays clean.
5. **Threads inherit their server user's credentials.** T3 has no network allowlist or credential stripping for threads (DESIGN 9.4 assumed one). So Kin runs as a dedicated `kin` user, and only owner-only turns that have read no outside text get a shell at all.
6. **Scheduled tasks launch threads themselves.** A routine done as a plain `schedule_task` would start a lead session outside the queue. The triggers spec must route fires into `KinEventQueue.enqueue`.

## Open questions

- Should the lead instructions be written as `AGENTS.md` and `CLAUDE.md` into the read checkout (excluded through `.git/info/exclude`) so the CLIs load it into their system context, which caches better than the first message? It works for Claude Code and Codex but not every provider.
- The unit weights (0.1 cached, 4 output) and the default limits are guesses. Set them after one pilot week.
- Which privileged kinds besides merge should a lead ever be able to ask for (deploy, release)? Today a lead can't ask for a merge; it tells the owner the PR is ready.
- Task ids for dependencies in the chat, approvals and triggers specs are named by subject here. Swap in the real ids once those specs are written.
- The lead's thread shows in T3's thread list under its "Kin · <org> · <lead>" project. Hide it, or leave it as the lead's readable log?

### LEAD-3 integration boundaries

`MemoryWriterAuthority.resolve` is runner-only: resolve organization, wake-up, active lead, level, timestamps, timezone and event provenance from same-organization rows inside the runner's transaction. Never expose this context as tool input. Owner-confirmed sources must be verified there; absent a source, provenance is the lead's agent id. `MemoryWriterHooks.notify` consumes checkout, conflict and secret-block notices without chat transport coupling.

`KinSecretScan` is deliberately supplied separately. `secretScan.layer` supplies the TRIG-16 scanner and reads the owner-signed allowlist; there is no no-findings production stub. Any finding or scanner failure blocks the whole commit. TRIG-16 must preserve this fail-closed interface: `scan({ orgId, files: ReadonlyArray<{ path: string; content: Uint8Array }> })` returns `{ path, ruleId, line }[]`, with typed `KinSecretScanError`.

`commitWakeup` builds TRIG-12's sectioned `INDEX.md` from the hash-verified recorded tree plus staged files, read history, the server clock and the owner's time zone, in the same wake-up commit. The read-side rebuild is display-only; no read-checkout text is trusted. K011 adds the SQLite branch anchors required by the writer. Prepare, stage and commit hold the per-organization writer lock one call at a time, so leads' wake-ups interleave between calls. A staged change keeps the branch head it was validated at; when another commit landed since, `commitWakeup` validates every change again at the new head, supersession and duplicate ids included, and refuses with `MemorySyncConflict` rather than overwrite. Retries and recovery find the wake-up's existing commit by its subject (`kin(<agentId>): wake-up <wakeupId>`) in history since the wake-up started, not at the branch head, which another lead may have moved; failed pushes retain local commits, and failures discard uncommitted files. Journal additions use `appendJournal`, never replacement through `stage`.

### Memory writer operations

**Run leads as a separate OS user before production.** Same-user residual attacks include direct SQLite edits (including `kin_memory_heads`), deleting the writer and losing never-pushed commits, object/pack/ref races between check and use (for example a crafted pack fooling git ancestry commands), `~/.ssh/config` and credential-input tampering, read-clone races, reading other orgs' directories, and attacking the server process. Hash-verifying reads and SQLite anchors are defense in depth, not a same-user sandbox. This writer now walks verified commit parents itself rather than trusting `merge-base`; races at other git check/use boundaries still require OS-user separation.

`syncCheckout` checks git integrity once per run (`fsck --full --strict` from the anchored head). Every application object read independently checks its hash. Three-way merging walks verified commit parents to find a common ancestor (or takes the landed record's local commit, see Memory writes), then reads base, local and remote bytes with hash verification. Paths changed on both sides conflict except append-only journals and the regenerated INDEX.md. Journal append conflicts retain remote bytes followed by the local entries the remote copy lacks, in order: what the two copies share is kept once, cut at the first line that differs, so a landed entry is never repeated even when the base predates it. Original modes, symlinks and gitlinks are preserved; writer changes create only regular files. Paths both sides changed the same way, as when the remote squash-merged a batch of local commits, merge cleanly, journals included, and a journal one side extends keeps the longer copy. Other conflicts keep the local head and notify via `MemoryRecoveryHooks`; the next wake-up proceeds on it. Missing or ambiguous merge bases preserve the tip under `kin/conflict/<orgId>/<wakeupId>-<unique-suffix>` (or a server-generated recovery id when no wake-up id is supplied); existing conflict branches are never intentionally overwritten.

Operators or owners can call server-only `Memory.recover(orgId)` after losing a writer or to reconcile its anchors. It fetches remote main and shadow heads, keeps an anchored default-branch head whose objects survive and that shares a merge base with the remote's (the lander lands it), keeps and pushes an anchored shadow head the remote lacks or that fast-forwards the remote's (a refused push leaves the lead's only copy here), preserves other surviving unpushed anchored work on a conflict branch, recreates a missing writer, records remote anchors and notifies. This method must never be registered as an agent tool. For writers predating K011 anchors, stop the runner and delete only that organization's writer directory, then bootstrap again. Do not delete anchored writers to recover unpushed work; call `recover` first. Recovery cannot restore commits lost with a deleted writer before they reached any remote.

Each prepare swaps in a new read checkout, so no provider process outlives it in its cwd. Every wake-up starts fresh context in a new process.

**Running on the Kin host.** System, global and repository git config are excluded, so memory git never sees the host's credentials. `MemoryConfig.layer` reads `KIN_MEMORY_CREDENTIAL_HELPER` (a helper name or absolute path, for HTTPS) and `KIN_MEMORY_SSH_COMMAND` (an ssh command naming its key file, for SSH) and every memory clone, fetch and push uses them; a value that fails `purgePush.ts`'s reference checks fails Kin startup, naming the variable but not the value. They go to memory git only, as `-c credential.helper` and `GIT_SSH_COMMAND`; a server-wide `GIT_SSH_COMMAND` would reach every agent's git. Repository credential helpers cannot override them. Configure the Kin host's dedicated server user and credentials before enabling writes; never put credentials in memory, repository config, or lead instructions. See also “Running on the Kin host” in `triggers.md`.

The `kin lead` CLI builds only the services lead provisioning needs, not the memory repository configuration, so recovery stays out of the CLI. The operator entry point remains the typed `Memory.recover(orgId)`, never RPC or MCP. Stop the runner first. From `apps/server`, run `node --input-type=module < /absolute/path/to/operator-recover.mjs` with this operator-owned script, substituting explicit database, repository and directory values (no default live-state path):

```js
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinOrgId } from "@t3tools/contracts";
import * as Memory from "./src/kin/memory/Memory.ts";
import { MemoryConfig } from "./src/kin/memory/MemoryConfig.ts";
import * as Sqlite from "./src/persistence/Sqlite.ts";
import * as KinPersistence from "./src/kin/persistence/KinPersistence.ts";
import * as Vcs from "./src/vcs/VcsProcess.ts";
const orgId = KinOrgId.make("fixture-org");
const database = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerFromPath("/absolute/operator-selected/statev2.sqlite")),
);
const config = Layer.succeed(MemoryConfig, {
  baseDirectory: "/absolute/operator-selected/kin",
  repositories: [{ orgId, path: "fixture-org", repoUrl: "/absolute/fixture.git" }],
});
await Effect.runPromise(
  Effect.scoped(
    Effect.flatMap(Memory.Memory, (memory) => memory.recover(orgId)).pipe(
      Effect.provide(
        Memory.layer.pipe(
          Layer.provide(config),
          Layer.provide(
            Layer.succeed(Memory.MemoryRecoveryHooks, {
              notify: (notice) => Effect.logWarning("Memory recovery", notice),
            }),
          ),
        ),
      ),
      Effect.provide(database),
      Effect.provide(Vcs.layer),
      Effect.provide(NodeServices.layer),
    ),
  ),
);
```

Recovery takes target names and SHAs only from the configured URL's `ls-remote` advertisement, fetches exact SHAs and hash-verifies their contents. Local shadow-ref enumeration is deletion-only; local `rev-parse` reads are used solely as compare-and-swap expectations, never as anchors or remote targets. Bootstrap also fetches an advertised exact SHA. There is no writer `symbolic-ref` lookup. An anchored shadow head joins the target set only when its objects hash-verify locally; one whose objects are gone resets to the default branch with a notice. Recovery removes local shadow branches not in its target set. A replaced non-descendant tip is reset to its SQLite anchor with a notice: any unpushed work at that tampered tip is already lost.
