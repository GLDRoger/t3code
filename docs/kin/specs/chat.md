# Kin spec: chats

Status: draft, 7 Nov 2026. Covers DESIGN.md sections 5, 7 (widget envelope only), 8 and the `orgId` rule in 10a. Prefix: CHAT.

## Goal

People and agents talk in chats. A chat holds messages whose author the server sets, never the client. Messages may carry a widget. A task card in a chat opens the T3 thread doing the work. Each person sees which chats are unread and one **Waiting on you** list.

Phase 1 ships direct chats only: the owner and one lead. The schema already has orgs, members, roles and group kinds, so phase 2 adds rows and code, not migrations of existing rows.

## What exists in T3

All paths are on `kin` as of 7 Nov 2026 (merged with upstream `main`).

| Piece                                                                                                                                                   | Where                                                                                                                                                                                                                                                                                                        | What it means for chats                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite client and startup migrations                                                                                                                    | `apps/server/src/persistence/Sqlite.ts` (`layerSetup` runs `runMigrations()`, `layerConfig`, `layerMemory`)                                                                                                                                                                                                  | Kin tables live in the same database file. `layerMemory` serves tests.                                                                  |
| Migration list                                                                                                                                          | `apps/server/src/persistence/Migrations.ts` (`migrationEntries`, 80 entries, `assertV2MigrationsCanRun`)                                                                                                                                                                                                     | One numbered sequence; the migrator skips every id up to the highest recorded one. Kin can't add entries here (see Design corrections). |
| Separate migration track                                                                                                                                | `effect/sql/Migrator` `MigratorOptions.table` (`apps/server/node_modules/effect/src/sql/Migrator.ts`, default `"effect_sql_migrations"`)                                                                                                                                                                     | Kin runs its own migrator with `table: "kin_sql_migrations"`.                                                                           |
| Repository pattern                                                                                                                                      | `apps/server/src/persistence/PullRequestFilesViewed.ts` (`Context.Service`, `SqlSchema.findAll`, `PersistenceSqlError`/`PersistenceDecodeError` from `Errors.ts`)                                                                                                                                            | Kin repositories copy this shape.                                                                                                       |
| RPC definitions                                                                                                                                         | `packages/contracts/src/rpc.ts`: `WS_METHODS`, `Rpc.make(...)`, `WsRpcGroup = RpcGroup.make(...).middleware(RpcScopeAuthorization)`                                                                                                                                                                          | Kin RPCs join `WsRpcGroup` before `.middleware`, so the same scope check covers them.                                                   |
| Stream RPCs                                                                                                                                             | `rpc.ts` `WsScheduledTasksSubscribeRpc` (`stream: true`); handler in `ws.ts` returns a `Stream`                                                                                                                                                                                                              | The chat list and chat streams follow it.                                                                                               |
| Scope check                                                                                                                                             | `packages/contracts/src/clientRpcPermissions.ts`                                                                                                                                                                                                                                                             | import; `...KIN_RPC_SCOPES,` in `CLIENT_GUARDED_RPC_SCOPES`                                                                             |
| `apps/server/src/observability/RpcInstrumentation.ts`                                                                                                   | import; `...KIN_RPC_AGGREGATES,` in the exhaustive aggregate map                                                                                                                                                                                                                                             |
| `apps/server/src/auth/RpcAuthorization.ts`: `RPC_REQUIRED_SCOPES ... satisfies Record<WsRpcMethod, AuthEnvironmentScope>`, `layer(session.scopes, ...)` | Every Kin method needs an entry or typecheck fails.                                                                                                                                                                                                                                                          |
| Handlers and session                                                                                                                                    | `apps/server/src/ws.ts`: `layerWsRpc(currentSession: EnvironmentAuth.AuthenticatedSession, ...)`, `ServerWsRpcGroup.of({...})`, split into `SplitWsRpcGroup` / `OtherWsRpcGroup`                                                                                                                             | Kin handlers are built here because only here is the caller's session known. `kin.*` falls in `OtherWsRpcGroup`.                        |
| Session identity                                                                                                                                        | `apps/server/src/auth/EnvironmentAuth.ts` `AuthenticatedSession { sessionId, subject, method, scopes, proofKeyThumbprint?, expiresAt? }`                                                                                                                                                                     | No person or role. `subject` is a credential label such as `"browser"` or `"one-time-token"`.                                           |
| Scopes                                                                                                                                                  | `packages/contracts/src/auth.ts` `AuthEnvironmentScope`, `AuthStandardClientScopes` (includes terminal, filesystem write, settings)                                                                                                                                                                          | Every paired device is the environment owner.                                                                                           |
| Agent caller identity                                                                                                                                   | `apps/server/src/mcp/McpInvocationContext.ts` `McpInvocationScope.thread: McpThreadCaller { threadId, providerSessionId, providerInstanceId, subagent? }`                                                                                                                                                    | The server knows which thread is calling an MCP tool. This is the agent author.                                                         |
| MCP tool registration                                                                                                                                   | `apps/server/src/mcp/McpHttpServer.ts` `toolkitRegistration(...)`, `layerTools = Layer.mergeAll(...)`; budget test `apps/server/src/provider/AgentContextBudget.test.ts` with `agentContextBudget.json`                                                                                                      | Kin reuses toolkitRegistration on a separate /kin/mcp transport; upstream layerTools and the ordinary context budget stay unchanged.    |
| Delegated tasks                                                                                                                                         | `delegate_task` in `apps/server/src/mcp/toolkits/orchestrator/tools.ts`; result `OrchestratorMcpDelegateTaskResult { taskId: NodeId, childThreadId, remoteChild?, link?, status, ... }` in `packages/contracts/src/orchestratorMcp.ts`                                                                       | A task card stores `taskId` and `childThreadId`.                                                                                        |
| Thread state                                                                                                                                            | `apps/server/src/orchestration-v2/Orchestrator.ts` `OrchestratorV2Shape.getThreadShell(threadId)`, `streamDomainEvents`; `OrchestrationV2ThreadShell` (`status`, `activityRunStatus`, `pullRequests`, `pendingRuntimeRequest`, `lastError`) in `packages/contracts/src/orchestrationV2.ts`                   | The task card updater reads these.                                                                                                      |
| Thread links                                                                                                                                            | `packages/shared/src/threadLinks.ts` `formatThreadLink`, `hostedThreadLink`, `THREAD_LINK_PROTOCOL = "t3-thread"`                                                                                                                                                                                            | A task card opens its thread with these.                                                                                                |
| Guest sharing                                                                                                                                           | `packages/contracts/src/guestShare.ts` (`ThreadGuestShare`, `GUEST_MESSAGE_MAX_LENGTH`, `GUEST_PENDING_MESSAGE_LIMIT`, `NAME_BREAKING_CHARACTER` not exported), `apps/server/src/guest/GuestShareService.ts` (invite and session tokens signed with `auth/PayloadSigner.ts`, gated by `guestSharingEnabled`) | Bound to one thread and one browser guest. Kin reuses the suggest-only model, the limits and the signer, not the record.                |
| MCP App bridge                                                                                                                                          | `apps/mobile/src/features/threads/McpAppWebView.tsx` `ThreadMcpApp({ environmentId, threadId, conversationThreadId, itemId, app: McpAppReference, ... })`; `packages/contracts/src/mcpApps.ts` `McpAppTarget = { threadId, itemId }`; `McpAppReference` in `packages/shared/src/mcpApp.ts`                   | Generated widgets are bound to the thread turn item that made them.                                                                     |

## Design

### Organizations and identity

Every row carries `orgId`. Phase 1 has one org, created on first start. Bootstrap creates reserved server ids `kin-default` and `kin-default-owner` in one repository transaction, only when no org exists. The org primary key and guarded insert make simultaneous starts idempotent. Restart preserves the stored identity, even if configuration changes. Existing data without that reserved org and owner disables Kin and logs the actionable initialization cause once, without stopping T3, rather than guessing ownership from a person's handle or row order.

`KinIdentityConfig.layer` reads `KIN_ORG_NAME`, `KIN_OWNER_HANDLE` and `KIN_OWNER_DISPLAY_NAME`, defaulting to `Kin`, `owner` and `Owner`. CHAT-6 composes that configuration and `KinIdentity.layer` with the repository in the shared `kin/layer.ts` root. `KIN_ENABLED=true` opts in; an unset or false value creates no Kin tables, does not bootstrap identity, and passes scheduled launches and management calls through without Kin sink queries or logging. The shared `KinEnabled` layer reads this flag once per server runtime. `KIN_MEMORY_REPOSITORIES` only configures memory runners; it does not enable Kin. CHAT-4 does not change server startup.

- **`KinOrg`**: `orgId`, `name`, `createdAt`.
- **`KinPerson`**: a human inside one org. `personId`, `orgId`, `handle` (slug used as `said_by` in kin-memory), `displayName`, `githubLogin` (nullable). The same human in two orgs is two persons. That keeps the walls in 10a: nothing joins across orgs except the session binding.
- **`KinAgent`**: an agent identity inside one org. `agentId`, `orgId`, `displayName`, `role` (`lead | architect | builder | qa | release | router | specialist`), `ownerPersonId` (every agent has a human owner, section 9.8). The lead spec owns the agent's config (model, level, budget) in its own table keyed by `agentId`.
- **Session to person** (`KinIdentity.resolve(session)`):
  - Phase 1: after the RPC scope check, a `/ws` session holding every scope in `AuthStandardClientScopes` resolves to the default org owner. A narrower session resolves to an empty list, never to a person inferred from `subject`. The result is a list of `{ orgId, personId }` entries so phase-2 bindings do not change callers. Only the owner may pair devices before CHAT-11.
  - Phase 2: a row in `kin_session_bindings (session_id, org_id, person_id)` decides. A session without a binding is the owner only if it holds `AuthStandardClientScopes`. Members get sessions with the new `kin:chat` scope only (CHAT-11), so their device never gets the owner's terminal or files.
- **Agent thread to agent** (`KinIdentity.resolveAgent(mcpScope)`): the lead spec registers each lead's durable thread with `registerAgentThread({ orgId, agentId, threadId })`. Kin MCP tools look up `McpInvocationScope.thread.threadId`. An absent caller thread, no registry row, an ended row, or `subagent: true` means `not_allowed`. Resolution also requires a persisted `kin_wakeups` row with `status = running` and the same org, agent and thread. The thread's active run must belong to the wake-up, including restart and usage-limit continuations and the late-steer and rescue runs the wake-up adopts (lead spec). Durable registration alone grants no authority between wake-ups; `insertMessage` rechecks the running row inside its write transaction. Resolution reads the database, not the tool-visibility cache, and derives `{ orgId, agentId, ownerPersonId, threadId }` only from stored rows. Retired agents are refused with `not_allowed` by both resolution and registration. Workers never post; they report to their lead. The lead calls `endAgentThread({ orgId, threadId })` on retirement, not between fresh provider sessions on the same T3 thread; an ended thread cannot be registered again. Retiring an agent ends its threads through `KinIdentity`; active-thread discovery also excludes retired agents.

### Chats, members, roles

```ts
// packages/contracts/src/kinChat.ts (new). Ids are TrimmedNonEmptyString.pipe(Schema.brand(...)),
// because baseSchemas' makeEntityId is not exported.
export const KinOrgId = brandedId("KinOrgId");
export const KinPersonId = brandedId("KinPersonId");
export const KinAgentId = brandedId("KinAgentId");
export const KinChatId = brandedId("KinChatId");
export const KinMemberId = brandedId("KinMemberId");
export const KinMessageId = brandedId("KinMessageId");
export const KinWidgetId = brandedId("KinWidgetId");

export const KinChatKind = Schema.Literals(["direct", "team_group", "project_group", "router"]);
export const KinRole = Schema.Literals(["owner", "member", "guest"]);
export const KinAgentRole = Schema.Literals([
  "lead",
  "architect",
  "builder",
  "qa",
  "release",
  "router",
  "specialist",
]);

export const KinChat = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  kind: KinChatKind,
  title: Schema.NullOr(TrimmedNonEmptyString), // null: direct chats show the agent's name
  teamId: Schema.NullOr(TrimmedNonEmptyString), // team_group: the team; owned by the lead spec
  lastSeq: NonNegativeInt,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});

export const KinPrincipal = Schema.Union([
  Schema.TaggedStruct("person", { personId: KinPersonId }),
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
]);

export const KinChatMember = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  memberId: KinMemberId,
  principal: KinPrincipal,
  role: KinRole, // agents are always "member"
  joinedAt: IsoDateTime,
  leftAt: Schema.NullOr(IsoDateTime), // a specialist that left keeps its row
  mutedUntil: Schema.NullOr(IsoDateTime),
});
```

Rules:

- **direct:** exactly one person with role `owner` and one agent. Unique on `(org_id, direct_key)` where `direct_key = personId + ":" + agentId`, so a second create returns the existing chat.
- **team_group / project_group:** any number of people and agents. Exactly one `owner` person per chat (the org owner in phases 1 to 4).
- **router:** one per owner person; its agent has role `router`. Created by the router task in phase 3. The kind exists now so no row changes later.
- **guest:** a person with role `guest` reads the chat and posts **suggestions** only. A suggestion reaches nobody but the guest and the owner until the owner sends or dismisses it, the same model as `ThreadGuestMessage.status` (`pending | sent | dismissed`) in `guestShare.ts`. Kin keeps `GUEST_MESSAGE_MAX_LENGTH` (4,000) and `GUEST_PENDING_MESSAGE_LIMIT` (3 waiting per guest per chat) and copies the name check regex.
- System messages store `authorRole: "member"`; approval ceilings use `author._tag`, never that role alone.
- A role change never rewrites old messages. Each message stores the author's role at the time it was posted (`authorRole`), because provenance ceilings (approvals spec) use it.

### Messages and authors

```ts
export const KinAuthor = Schema.Union([
  Schema.TaggedStruct("human", { personId: KinPersonId, memberId: KinMemberId }),
  Schema.TaggedStruct("agent", {
    agentId: KinAgentId,
    memberId: KinMemberId,
    ownerPersonId: KinPersonId,
    threadId: ThreadId, // the lead session that posted it
  }),
  Schema.TaggedStruct("system", {}), // "Ravi joined", fold lines
]);

export const KinAgentIntent = Schema.Literals([
  "answer",
  "evidence",
  "objection",
  "decision",
  "question",
]);
export const KinMessageKind = Schema.Literals(["text", "widget_action", "system"]);
export const KinMessageStatus = Schema.Literals(["posted", "suggested", "dismissed", "deleted"]);

export const KinMessage = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  messageId: KinMessageId,
  seq: PositiveInt, // per chat, gapless, set in the insert transaction
  author: KinAuthor, // set by the server only
  authorRole: KinRole,
  kind: KinMessageKind,
  body: Schema.String, // Markdown, max 16,000 chars; empty when deleted
  intent: Schema.NullOr(KinAgentIntent), // required for agents, null for people
  mentions: Schema.Array(KinMemberId),
  replyTo: Schema.NullOr(KinMessageId),
  widgetId: Schema.NullOr(KinWidgetId),
  floorRunId: Schema.NullOr(TrimmedNonEmptyString), // groups agent turns for folding
  status: KinMessageStatus,
  sentBy: Schema.NullOr(KinPersonId), // the owner who sent a guest's suggestion
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
});
```

- **The send input has no author field.** `kin.messages.send` takes `{ chatId, clientMessageId, body, mentions?, replyTo? }`. Effect Schema drops unknown keys on decode, so an `author` sent by a client never reaches the service.
- **Mentions:** each mentioned member must still be active in the same org and chat, checked inside the send transaction; mentions of members who have left are refused.
- **Idempotency:** unique `(chat_id, author_member_id, client_message_id)`. An identical retry returns the first insert; a changed retry (body, mentions, replyTo, or intent) fails `not_allowed`.
- **Agent posts** come through `KinChatService.send`, called by the reply bridge (a lead's plain text; lead spec, "Replies") or the Kin MCP tool `kin_chat_post` (CHAT-7). The author is built from `KinIdentity.resolveAgent`. Agent text is never trusted as a claim about authority (section 9.3); that rule lives in the approvals spec, but the chat never offers a way to make agent text look human.
- **System-authored notices:** server-only code templates, not model-authored instructions. Untrusted item text appears only as a single quoted line per item: remove newlines and control characters, strip bidi and zero-width characters, truncate by code point, and quote in a padded inline code span with a backtick fence longer than any backtick run in the text. Never interpolate untrusted text into the template instructions.
- **Citable link:** `kinMessageLink({ orgId, chatId, messageId })` returns `kin-chat://<orgId>/<chatId>/<messageId>`. kin-memory items use it as `source`.
- **Deletion** sets `status: "deleted"` and clears `body`. Purge and retention are phase 5 (org policy).

### Widget envelope (section 7, envelope only)

A widget lives in its own row, so agents update it in place and a group sees one state. A message points at it.

```ts
export const KinWidgetClass = Schema.Literals(["native", "generated", "live"]);
export const KinNativeCardType = Schema.Literals([
  "approval",
  "decision",
  "task",
  "deferral",
  "poll",
  "checklist",
  "form",
  "date",
]);

export const KinWidget = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  widgetId: KinWidgetId,
  messageId: KinMessageId, // the message that first showed it
  widgetClass: KinWidgetClass,
  type: TrimmedNonEmptyString, // a KinNativeCardType for native cards
  revision: PositiveInt, // bumped on every update; acts check it
  state: Schema.Unknown, // validated by the type's own schema, below
  source: Schema.NullOr(Schema.Struct({ threadId: ThreadId, itemId: TurnItemId })), // generated only
  feed: Schema.NullOr(Schema.Struct({ kind: TrimmedNonEmptyString, key: TrimmedNonEmptyString })), // live only
  awaiting: Schema.Array(KinPersonId), // who it waits on; drives Waiting on you
  pinnedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
```

- **State schemas** are registered per type in `apps/server/src/kin/widgets/registry.ts` (**new**). Owners: `task` (this spec, registered in CHAT-5; updater in CHAT-8), `approval` (approvals spec, drawn from `KinPendingAction`), `deferral` (lead spec), `decision`, `poll`, `checklist`, `form`, `date` (this spec, phase 2, CHAT-13). An unknown type, or state that fails its schema, is refused at upsert. CHAT-5 registers only `task`; other owners add their schemas with their features.
- **Acting:** `kin.widgets.act({ widgetId, revision, actionId, value?, clientActionId })` posts a `widget_action` message authored by the session's person, with `{ widgetId, revision, actionId, value }` as its structured body. A widget action is a human turn: it opens a new floor run and revokes the lead's unused grant from the previous run. The lead acts on it under its own permissions. A stale `revision` fails with `widget_changed`.
- **Approval cards never go through `act`.** `act` refuses `type: "approval"` with `use_approvals`. Approving is the approvals spec's signed-grant RPC (section 9.2). Approval widgets are created only by the approvals spec's server code; the MCP upsert tool refuses that type too, so an agent can't draw one.
- **Generated widgets** carry `source`, the lead thread's turn item that produced the MCP App resource. The client renders it with the existing `ThreadMcpApp`, which already calls `mcpApps.*` RPCs scoped to `{ threadId, itemId }`. This works for the owner only, since those RPCs need `orchestration:*` scopes. Members seeing generated widgets is an open question.
- **Live widgets** (phase 3) carry `feed`; a server feeder updates `state` in place.

### Task cards link to threads

The `task` card is the native card for delegated work.

```ts
export const KinTaskCardState = Schema.Struct({
  taskId: NodeId, // from OrchestratorMcpDelegateTaskResult
  environmentId: EnvironmentId,
  threadId: Schema.NullOr(ThreadId), // childThreadId, or remoteChild.threadId
  remoteEnvironmentId: Schema.NullOr(EnvironmentId),
  title: TrimmedNonEmptyString,
  model: Schema.NullOr(Schema.String), // shown small (interface rule 6)
  status: Schema.Literals([
    "working",
    "waiting",
    "needs_decision",
    "blocked",
    "done",
    "failed",
    "cancelled",
  ]),
  pullRequests: Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Int })),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
```

Flow:

1. Kin's worker launcher (LEAD-9) calls the server-only `KinChatService.createTaskCard` after launching a worker with `ThreadLaunchService.launch`; the lead never creates task cards. The method derives the environment, checks the local thread, lead and chat inside the write transaction, and creates a message authored by the lead's member in `kin-default`. It is not exposed through RPC or MCP. Agent and client task-card creation is refused with `not_allowed`.
2. **`KinTaskCardUpdater`** (**new**, `apps/server/src/kin/chat/TaskCardUpdater.ts`) follows `OrchestratorV2.streamDomainEvents`. For a thread linked to an open task card it re-reads `getThreadShell` (throttled per thread, leading and trailing at most once per second) and maps `status`, `activityRunStatus`, `pendingRuntimeRequest` (gives `needs_decision`), `lastError` and `pullRequests` onto the card. Only a real state change, ignoring `updatedAt`, bumps `revision` and publishes `widget.updated`. No new message is posted (interface rule 2).
3. On start and every stream reconnect it queues a throttled recheck of every open task card, since events during downtime are not replayed to it. Invalid stored task state is left unchanged for the client to show as a placeholder, with a server warning; other cards keep updating.
4. Tapping the card opens the thread: the app routes `formatThreadLink({ environmentId, threadId })` the way thread chips do. Remote tasks use `remoteEnvironmentId`. Members without thread access see the card without the open action.
5. The lead closes the card (`closedAt`) when it posts the result with evidence. Closed cards are removed from the live index and stop updating; reopening resumes updates.

Task-card authority: only the server creates local cards, deriving status, pullRequests, lastError and updatedAt from the shell. Identical creation retries return the stored card; conflicting retries fail `not_allowed`. After creation these four fields belong to the updater; agent and human upserts preserve their stored values, while title, model, awaiting and closed remain editable. Task and thread identity fields are immutable. An identical retry at the previous revision returns the stored row; a different stale write fails `widget_changed` inside the transaction. The published `KinTaskCardState` contract is unchanged for lane B.

Status follows the thread's current state, not a terminal latch: done or cancelled can return to working on a later run. Reopening queues a throttled recheck of the thread.

Remote-task rule: CHAT-8 creates local task cards only. Existing remote cards are never resolved against same-named local threads; their last stored state is retained. Remote creation belongs to the future trusted worker launcher integration.

Mapping precedence: archived/deleted gives cancelled with "Thread no longer available"; a missing local shell does the same while retaining other stored fields. Otherwise pendingRuntimeRequest gives needs_decision unless blocking is false; blockedOnThreadWait gives blocked; activityRunStatus gives working (or waiting); otherwise completed gives done, failed gives failed, interrupted/cancelled/rolled_back give cancelled, idle/waiting give waiting, and preparing/queued/starting/running give working. Errors and PR links come only from the shell. PR links are the thread's visible links (not `stack-dismissed`), or else its branch-detected `branchPullRequest`, the same fallback the thread's PR chip uses.

The phase-1 updater rebuilds its open-card index for the reserved default org and tracks subsequent committed card creates/closes. Unlinked events do no SQL. Each linked thread has a sliding single-entry queue with a leading/trailing one-second Effect Clock throttle; closing its last card releases its worker. A bounded coalesced index-change signal reconciles workers without retaining closed thread ids. The credential registry is constructed before orchestration, so the shared Kin root owns the index and the gated MCP transport starts the updater after orchestration is available.

### Read state and Waiting on you

- **Read state:** `kin_read_state (org_id, chat_id, member_id, last_read_seq)`. `kin.messages.markRead({ chatId, seq })` only moves forward. Unread count is the posted messages with `seq > last_read_seq` not authored by the member.
- **Waiting on you:** `kin_waiting (org_id, waiting_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution)`. `reason` is `approval | decision | question | suggestion | mention`. Rows come from:
  - a widget upsert with `awaiting` (one row per person; removed people resolve as `superseded`),
  - an agent message with `intent: "question"` that mentions a person, or any agent question in a direct chat,
  - a guest suggestion (for the owner),
  - the approvals spec calling the server-only repository `addApprovalWaiting` inside its transaction for its approval cards, then publishing `waiting.updated` after commit.
- Public `KinChatService.addWaiting` refuses `reason: "approval"` and any row anchored on an approval widget (including through its message) with `not_allowed`; only the approvals spec creates these rows through the server-only repository entry point, which requires an approval widget, never a transport.
- Agents may resolve only `question` rows on their own messages, never approval rows or approval-widget anchors, even with an owner role. Persons may resolve their own rows; chat owners may resolve any row. Nobody resolves approval rows or approval-widget anchors through the public service; only the approvals spec's signed-grant flow does. Guests cannot resolve rows. Refusals use `not_allowed`.
- When a person leaves a chat, their open waiting rows in that chat resolve as `cancelled` in the same transaction; rejoining applies the requested role and does not reopen cancelled rows.
- New waiting rows must be unresolved; a caller-supplied resolution is refused.
- A row resolves when the widget closes, the person acts on it, the person replies in the chat after the question (for `question`), or the source calls `resolveWaiting`.
- The list streams with the chat list. Without an `orgId` the stream merges every org the session is bound to, each item labelled with `orgId` (10a, "one switcher"). Only this list is highlighted in the UI (interface rule 1); push and lock-screen buttons are the mobile and approvals specs' work.

### Persistence

Kin runs its own migration track in the T3 database file.

- **`apps/server/src/kin/persistence/KinMigrations.ts`** (**new**) builds `Migrator.make({})` and passes `table: "kin_sql_migrations"` when running it, with a `Migrator.fromRecord` loader over `apps/server/src/kin/persistence/migrations/K001_ChatCore.ts` and later files. The loader key `"1_ChatCore"` records `migration_id = 1` and `name = "ChatCore"` (together, `1_ChatCore`). Ids are Kin's own sequence and never touch `effect_sql_migrations`.
- It runs from `KinPersistence.layer`, a `Layer.effectDiscard` that needs `SqlClient`. `SqlClient` comes from `Sqlite.layerConfig`, whose `layerSetup` has already run upstream migrations, so production migrates Kin second. Kin's migration history is independent of upstream's, so either can run first, but production must keep Kin second: `Sqlite.ts` sets `auto_vacuum` only on a database with no tables. CHAT-2 exposes the layer for tests only, without wiring server startup yet.
- Kin tables never use foreign keys into upstream tables (upstream drops and renames its own: `063_DropUnusedV1Projections.ts`). Thread and task ids are plain text. Foreign keys between Kin tables are fine (`PRAGMA foreign_keys = ON` is set in `Sqlite.ts`).
- An upstream build opening a Kin database ignores the `kin_*` tables.

K001 (phase 1, includes everything phase 2 needs for existing rows):

| Table                  | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kin_orgs`             | `org_id` PK, `name`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                            |
| `kin_people`           | `person_id` PK, `org_id`, `handle` (unique per org), `display_name`, `github_login`, `created_at`                                                                                                                                                                                                                                                                                                                            |
| `kin_agents`           | `agent_id` PK, `org_id`, `display_name`, `role`, `owner_person_id`, `created_at`, `retired_at`                                                                                                                                                                                                                                                                                                                               |
| `kin_agent_threads`    | `thread_id` PK, `org_id`, `agent_id`, `started_at`, `ended_at`                                                                                                                                                                                                                                                                                                                                                               |
| `kin_session_bindings` | (`session_id`, `org_id`) PK, `person_id`, `bound_at`, `revoked_at` (empty in phase 1)                                                                                                                                                                                                                                                                                                                                        |
| `kin_chats`            | `chat_id` PK, `org_id`, `kind`, `title`, `team_id`, `direct_key` (unique with `org_id`, null for groups), `last_seq`, `last_message_at`, `created_at`, `archived_at`; index on (`org_id`, `chat_id`) (added by K002)                                                                                                                                                                                                         |
| `kin_chat_members`     | `member_id` PK, `org_id`, `chat_id`, `principal_kind`, `person_id`, `agent_id`, `role`, `joined_at`, `left_at`, `muted_until`; unique (`chat_id`, `person_id`), (`chat_id`, `agent_id`); indexes on (`org_id`, `person_id`), (`org_id`, `agent_id`)                                                                                                                                                                          |
| `kin_messages`         | `message_id` PK, `org_id`, `chat_id`, `seq`, `author_kind`, `author_person_id`, `author_agent_id`, `author_owner_person_id`, `author_thread_id`, `author_member_id`, `author_role`, `kind`, `body`, `intent`, `mentions_json`, `reply_to`, `widget_id`, `floor_run_id`, `status`, `sent_by`, `client_message_id`, `created_at`, `edited_at`; unique (`chat_id`, `seq`), (`chat_id`, `author_member_id`, `client_message_id`) |
| `kin_widgets`          | `widget_id` PK, `org_id`, `chat_id`, `message_id`, `widget_class`, `type`, `revision`, `state_json`, `source_thread_id`, `source_item_id`, `feed_kind`, `feed_key`, `awaiting_json`, `pinned_at`, `closed_at`, `updated_at`; indexes on (`type`, `closed_at`), (`org_id`, `chat_id`, `message_id`)                                                                                                                           |
| `kin_read_state`       | (`chat_id`, `member_id`) PK, `org_id`, `last_read_seq`, `updated_at`                                                                                                                                                                                                                                                                                                                                                         |
| `kin_waiting`          | `waiting_id` PK, `org_id`, `person_id`, `chat_id`, `message_id`, `widget_id`, `reason`, `created_at`, `resolved_at`, `resolution`; index on (`person_id`, `resolved_at`); unique (`widget_id`, `person_id`) where `resolved_at IS NULL AND widget_id IS NOT NULL`                                                                                                                                                            |

K001 uses `TEXT` for ids, ISO timestamps and JSON, and `INTEGER` for sequences and revisions. Optional or nullable schema fields are nullable; system-author identity fields and `client_message_id` for non-client posts are nullable. `author_owner_person_id` snapshots the agent author's required `ownerPersonId`. Waiting `message_id` and `widget_id` are nullable references; `resolution` is nullable free text because resolution values are not a closed set. Message `widget_id` has no foreign key to avoid a message/widget insert cycle. Org foreign keys and other Kin-only references are enforced; org-consistent relationships and chat ownership cardinality are checked by the service.

K008 stores floor runs, grants and notice accounting. Phase 2 adds `kin_floor_bids` and `kin_judge_log` at the next free migration numbers. New tables only.

**Seq allocation:** in one `sql.withTransaction`: `UPDATE kin_chats SET last_seq = last_seq + 1, last_message_at = ? WHERE chat_id = ? AND org_id = ? RETURNING last_seq`, then insert the message with that seq. Look up an existing `(chat_id, author_member_id, client_message_id)` inside the transaction before allocating a seq. Store sends as `send:<clientMessageId>` and widget actions as `act:<clientActionId>` so the namespaces cannot collide. History returns the newest page before `beforeSeq` in ascending seq order, with `hasMore` from one extra row. Message and widget ids are server-generated; widget revisions start at 1 and are server-owned. Publish to the in-process hub only after commit.

### RPC surface

Method names live in `KIN_CHAT_WS_METHODS` in `kinChat.ts`. `kinChat.ts` must not import `rpc.ts`, since `rpc.ts` imports it.

| Method                                               | Payload                                                    | Success                                         | Phase | Scope (phase 1)         |
| ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ----- | ----------------------- |
| `kin.orgs.list`                                      | `{}`                                                       | `{ orgs: KinOrg[], me: { orgId, personId }[] }` | 1     | `orchestration:read`    |
| `kin.chats.subscribe` (stream)                       | `{ orgId?: KinOrgId }`                                     | `KinChatListEvent`                              | 1     | `orchestration:read`    |
| `kin.chats.createDirect`                             | `{ orgId, agentId }`                                       | `KinChat`                                       | 1     | `orchestration:operate` |
| `kin.chat.subscribe` (stream)                        | `{ chatId, afterSeq?: number, afterChangeSeq?: number }`   | `KinChatStreamEvent`                            | 1     | `orchestration:read`    |
| `kin.chat.history`                                   | `{ chatId, beforeSeq, limit ≤ 100 }`                       | `{ messages, widgets, hasMore }`                | 1     | `orchestration:read`    |
| `kin.messages.send`                                  | `{ chatId, clientMessageId, body, mentions?, replyTo? }`   | `KinMessage`                                    | 1     | `orchestration:operate` |
| `kin.messages.markRead`                              | `{ chatId, seq }`                                          | `{}`                                            | 1     | `orchestration:read`    |
| `kin.widgets.act`                                    | `{ widgetId, revision, actionId, value?, clientActionId }` | `KinMessage`                                    | 1     | `orchestration:operate` |
| `kin.messages.react`                                 | `{ messageId, emoji, on }`                                 | `KinReaction`                                   | 1     | `orchestration:operate` |
| `kin.widgets.setPinned`                              | `{ widgetId, pinned }`                                     | `KinWidget`                                     | 2     | `orchestration:operate` |
| `kin.chats.createGroup`                              | `{ orgId, kind, title, teamId?, members }`                 | `KinChat`                                       | 2     | `orchestration:operate` |
| `kin.members.add` / `.remove` / `.setRole` / `.mute` | `{ chatId, ... }`                                          | `KinChatMember`                                 | 2     | `orchestration:operate` |
| `kin.suggestions.resolve`                            | `{ messageId, action: "send" \| "dismiss" }`               | `KinMessage`                                    | 2     | `orchestration:operate` |

Errors: one `KinChatError` tagged error with `reason`: `not_found` (also used for chats in other orgs or not joined, so existence never leaks), `not_allowed` (role), `widget_changed`, `use_approvals`, `invalid_state`, `limit`, `floor_not_granted`, `floor_closed`. Every RPC also unions `EnvironmentAuthorizationError`, as upstream RPCs do.

Stream events:

```ts
export const KinChatListEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    chats: Schema.Array(KinChatSummary),
    waiting: Schema.Array(KinWaitingItem),
  }),
  Schema.TaggedStruct("chat", { chat: KinChatSummary }), // new message, rename, unread change
  Schema.TaggedStruct("waiting", { item: KinWaitingItem }), // added or resolved
]);
// KinChatSummary = KinChat + { members, lastMessage: KinMessage | null, unread: number }

export const KinChatStreamEvent = Schema.Union([
  Schema.TaggedStruct("backlog", {
    messages: Schema.Array(KinMessage),
    widgets: Schema.Array(KinWidget),
    lastSeq: NonNegativeInt,
    lastChangeSeq: Schema.optional(NonNegativeInt),
  }),
  Schema.TaggedStruct("reset", {
    lastSeq: NonNegativeInt,
    lastChangeSeq: Schema.optional(NonNegativeInt),
  }), // gap too big: refetch with history
  Schema.TaggedStruct("message", { message: KinMessage }), // new or changed (edit, delete, send of a suggestion)
  Schema.TaggedStruct("widget", { widget: KinWidget }),
  Schema.TaggedStruct("member", { member: KinChatMember }),
  Schema.TaggedStruct("read", { memberId: KinMemberId, seq: NonNegativeInt }),
  // Live only, never persisted: a reply streaming in, an agent's status line.
  Schema.TaggedStruct("draft", { draftId, agentId, offset, text, end?: { messageId | null } }),
  Schema.TaggedStruct("presence", { agentId, presence: KinPresence | null }),
  Schema.TaggedStruct("reaction", { reaction: KinReaction }), // added, or withdrawn (removedAt set)
]);
```

- **Reactions** (K026 `kin_reactions`) are one of six emoji per member and message, toggled on and off. A `backlog` carries the chat's live reactions in full, so a client replaces its set; `kin.chat.history` carries those on its page. What a reaction means is decided in code, never by the model: an owner's yes/no emoji on an open choice card with one `yes` and one `no` option answers it through the same compare-and-set as a tap (`via: "reaction"`); an owner's yes/no emoji on the lead's latest message in their direct chat, within a day, wakes the lead as a P0 `chat.reaction` event (or steers into its running wake-up), at most once per chat per 30 s, and opens a floor run so it can answer; anything else is stored, shown, and quoted to the lead as context. Approval, level, review, deferral and owner-check cards refuse reactions, so a reaction can never stand in for a signed grant. A lead reacts only through `kin_react`, in its wake-up's chat, behind the same level gate as a post; it counts as the reply only when every message the wake-up owed was the owner's text without a `?`.

- **Live state:** `backlog` also carries the chat's current `presence` lines and open `drafts`, so a reconnect shows them at once. A draft delta appends `text` at `offset`, at most one per 250 ms per chat; a client whose draft length differs ignores deltas until `end`, the durable message, or the next backlog. Presence is sent only on change, never as a tick. `contracts/src/kinChat.ts` holds the shapes.

- **Resume:** `kin.chat.subscribe` subscribes to the hub first, then reads one SQLite snapshot. `seq` remains the message's immutable ordering key. K010 adds a per-chat integer `change_seq`: message inserts/updates and widget writes advance it transactionally; widget writes mark their parent message changed. The indexed backlog selects the union of new messages (`seq > afterSeq`) and changed messages (`change_seq > afterChangeSeq`), once per message, with current associated widgets and normal viewer filtering. More than 200 affected visible messages sends `reset` instead. Both `backlog` and `reset` include `lastSeq` and `lastChangeSeq` from that snapshot. The migration marks all existing messages changed beyond `lastSeq`, so a client offline across the upgrade cannot miss an earlier edit.
- **Client resume contract:** upsert messages by `messageId` (do not discard an older `seq`) and widgets by `widgetId`/`revision`. Persist `backlog.lastChangeSeq` only after applying the whole backlog; send it as optional `afterChangeSeq` with the last message `afterSeq` on reconnect. Keep this snapshot cursor unchanged while receiving live events: their delivery order need not match commit order, so taking the maximum live `changeSeq` could skip another committed event. Because inserts also advance `change_seq`, a frozen cursor would grow the replay until a long live session reset on reconnect; every 100 live messages the stream re-reads from its last cursor and sends another `backlog` that carries the fresh cursors and only the rows and widgets the stream has not already delivered. Apply it like any backlog. Replaying already-held rows across reconnects is intentional and idempotent. `reset` invalidates the entire cached chat, not just the latest page; refetch with history and resume from the reset cursors. Clients omitting `afterChangeSeq` get only new messages (`seq > afterSeq`), the pre-K010 behaviour, and can miss offline edits. Clients must treat a backlog as upserts, not append-only. Live message events carry optional `changeSeq`; the server drops buffered changes already represented by the snapshot and repeated versions. These optional fields preserve older payload decoding. `clientMessageId` is an optional unprefixed send id, present only for the message's author in send replies, history, backlogs, live events and chat summaries; owning the chat does not reveal another author's id.
- **List resume:** `kin.chats.subscribe` has no `afterSeq`: message sequences are per chat, not an org-wide event cursor. It subscribes first, buffers while reading one fresh chat/waiting snapshot, then emits changed summaries and personal waiting rows, dropping state already in that snapshot. Reconnection replaces the list with a new snapshot. A durable list-event cursor needs a separate journal and is not CHAT-6.
- **Removal:** a removed member receives their own resolved waiting rows even after membership ends. Their chat stream emits a final typed `member` event with non-null `leftAt`, then ends. The chat-list stream stays open; an event whose summary or waiting read fails is dropped and logged at debug level, not allowed to terminate the subscription.
- **Agent discovery:** `kin.orgs.list` includes each org's `agents: [{ agentId, displayName, retired }]`, filtered by org and ordered by display name then agent id. Use a non-retired agent id with `createDirect`.
- **Filtering per viewer:** suggestions go only to their author and the chat owner. Agent subscribers do not exist on `/ws`; agents read through `kin_chat_read`.
- **Availability:** when Kin is off on the host (disabled, misconfigured, or failed to initialize), Kin RPCs return `KinChatError.reason = "disabled"`; don't retry until the host changes. Transient infrastructure failures and defects return `"unavailable"`, which clients may retry. Both are distinct from a role refusal.
- **Hub:** `KinChatHub` (**new**), a `PubSub` keyed by `orgId`. The lead spec subscribes to `message.posted` from it to fill its per-org event queue.

### Authorisation, in two layers

1. **Scope (coarse):** `KIN_CHAT_RPC_SCOPES` in `kinChat.ts` maps each method to a scope; `clientRpcPermissions.ts` spreads the combined `KIN_RPC_SCOPES` into `CLIENT_GUARDED_RPC_SCOPES`, which already feeds `RPC_REQUIRED_SCOPES`. Phase 1 uses existing scopes (table above). Phase 2 adds `kin:chat` and moves every `kin.*` method to it (CHAT-11).
2. **Membership (fine):** inside `KinChatService`, every call resolves the person, loads the chat by id, and checks an active member row in the same org. A client-sent `orgId` must match the chat's. Role checks: only `owner` adds or removes members, sets roles, resolves suggestions, pins. `guest` can only `send` (stored as `suggested`), `markRead` and subscribe. Until CHAT-12 supplies the suggestion flow, CHAT-5 refuses guest writes rather than posting them as normal messages. Muted agents can't post.

### Agent tools (MCP)

`KinChatToolkit` (**new**, `apps/server/src/kin/mcp/KinChatToolkit.ts`):

- `kin_chat_post({ chatId, body, intent, mentions?, replyTo?, clientMessageId? })`
- `kin_chat_read({ chatId, afterSeq?, limit? })`: messages as data. Text from anyone but the owner is wrapped in quoted blocks labelled with the author's role (section 9.4) by the lead spec's brief builder, not here; this tool returns `authorRole` so it can.
- `kin_widget_upsert({ chatId, widgetId, revision, type, state, awaiting?, closed? })`: updates an existing task card anchored by the agent's own member. Server-owned state is preserved. Agents never create task cards; creation returns `not_allowed`. Refuses `approval`.
- `kin_floor_bid({ chatId, runId, reason, intent })` (phase 2).

Kin serves these tools at **`/kin/mcp`**, alongside the existing T3 tools, never in upstream `layerTools`. Two one-line hooks in `server.ts` wrap transport construction and credential issuance; the registry wrapper is the sole Kin construction root for both WS and MCP. The credential wrapper uses the environment's shared `KinIdentity` instance to give only registered agent threads this endpoint; ordinary threads and subagents retain `/mcp`. The Kin transport is mounted only when Kin is enabled and has an isolated MCP registry, authenticates only server-issued provider credentials, and calls `resolveAgent` on every HTTP request. It does not accept OAuth client identities. Credentials become unresolvable when registration changes their required endpoint, and only a new provider session reissues them: an attached live session keeps its dead token and loses every tool. So LEAD-5 registers a lead thread before its first provider session opens and ends it only after its session stops.

`EnabledWhen` is a second visibility guard inside the Kin toolkit, reading the server-resolved `McpInvocationContext` and that same identity's in-memory set. Registration and ending change the set only after the outer transaction commits, serialized and interruption-safe; startup rebuilds it from active rows. Visibility is not authority: each tool calls `resolveAgent` again, and `KinChatService` checks membership, retirement, ended threads, and write muting. Ordinary MCP, the unchanged context budget test and `agentContextBudget.json` do not gain tools. A separate Kin context-budget test measures the combined agent-thread list (T3 plus three Kin tools) without changing the ordinary-thread budget.

`kin_chat_post` accepts an optional `clientMessageId` retry key. Reusing it with identical content returns the stored row; changed content fails `not_allowed`. Omission creates a fresh post on each call. Bodies are nonblank, at most 16,000 characters, and contain no NUL; mentions are capped at 100. Reads are per-call, ascending after a non-negative safe-integer `afterSeq`, with a default limit of 50 and a maximum of 100, and preserve the viewer's suggestion visibility. No agent stream is exposed.

Task-card creation is server-only and unavailable through this toolkit. Updates require `widgetId` plus the expected `revision`; missing revision is refused and stale revision fails `widget_changed`. The anchor is immutable, and an agent can update only cards anchored by its own member. Neither trusted waiting APIs nor hub subscriptions are exposed. `approval` is refused by the service. `kin_floor_bid` is phase 2 and absent from the phase-1 toolkit. CHAT-9 keeps group grant tokens internal; direct-chat grants are implicit. CHAT-11 and the phase-2 floor-bid work must deliver group grants through the agent wake-up before exposing `floorGrant` in `kin_chat_post`. Until then, a mentioned agent in a group cannot reply. Grants expire after five minutes. The first post consumes the grant and records its wake-up; that wake-up's later posts in the same floor run reuse it while no other agent has spoken, share its `floorRunId`, and count as one agent turn. One wake-up posts at most 8 messages and 32,000 characters per chat, reply-bridge text and `kin_chat_post` together. When a wake-up carrying the message that opened a direct-chat run starts, the runner extends the lead's unused grant on that run to the wake-up's deadline (lead spec, `KinFloor.renew`); it never issues one. Trusted server notices (`KinChatService.notice`) bypass the floor and agent-notice quota; agent notices are classified from the running wake-up's stored events, never from a model-provided flag. Notice classification applies to the entire wake-up across all of the agent's chats, not only the destination chat. A batch containing chat events is treated as replies.

### Floor manager (plain code)

`apps/server/src/kin/floor/FloorManager.ts` (**new**) is a pure module: state in, decision out, no Effect services. `KinChatService` stores state in `kin_floor_runs` and calls it.

```ts
interface FloorRun {
  runId: string;
  chatId: KinChatId;
  openedBy: KinMessageId; // the human message that opened it
  mentionQueue: KinAgentId[]; // @mentioned agents, in order
  agentTurns: number; // since the last human message
  lastSpeaker: KinAgentId | null;
  spoken: KinAgentId[];
  grant: { agentId: KinAgentId; token: string; expiresAt: number } | null;
  state: "open" | "closed";
}
interface FloorBid {
  agentId: KinAgentId;
  role: KinAgentRole;
  reason: string;
  intent: KinAgentIntent;
  at: number;
}
type FloorDecision =
  | { _tag: "grant"; agentId: KinAgentId }
  | { _tag: "wait" } // bid window still open
  | { _tag: "close"; reason: "turn_budget" | "no_bids" | "nothing_to_add" };

export const FLOOR_MAX_AGENT_TURNS = 6; // rule 4
export const FLOOR_BID_WINDOW_MS = 2_000;
```

- **Rule 1:** a human message opens a new run and closes the old one. Its @mentioned agents fill `mentionQueue`. The first queued agent that may speak (rule 3) gets the grant without bidding.
- **Rule 2:** otherwise bids collected in the window compete. Role fit is a static table in code: the chat's lead wins ties for a plain question; `qa` for test or bug words; `release` for deploy or release words. While the judge is in shadow mode its `role` answer is logged, not used. Ties go to the earliest bid.
- **Rule 3:** a bid or mention from `lastSpeaker` is skipped. Only a human message clears `lastSpeaker`.
- **Rule 4:** at `agentTurns === 6` the run closes with `turn_budget`. Later agent posts get `floor_closed` until a human speaks.
- **Rule 5:** the first agent turn after a human may be `answer` or `question`. Later turns must be `evidence`, `objection` or `decision`; others are refused.
- **Enforcement (phase 2):** `kin_chat_post` in a group needs `floorGrant`, the grant token. A post without a valid token fails with `floor_not_granted`. A wake-up run uses the grant: its first post adds one to `agentTurns` and sets `lastSpeaker`, and all its posts share one `floorRunId`. Intent order is guidance only for natural text, which declares no intent.
- **Replies vs notices:** posts woken by a `KinEvent` that is not a chat message (routine, webhook, deferral, worker report) are notices. They need no grant, don't open or count in a run, and must use `evidence`, `decision` or `question` (interface rule 2). They are limited to 10 per agent per chat per hour; status belongs in widget updates.
- **Direct chats** (phase 1): one agent, so rules 1 and 2 always pick it and no bids are needed. Rules 3, 4 and 5 still apply to replies: the server opens a run on each owner message and grants the lead implicitly.
- **Who bids:** waking an agent costs a lead session (lead spec, budget). The floor manager names who to wake: mentioned agents, else the chat's lead. Other agents in the chat get a `floor.offer` KinEvent only when the lead spec's budget allows; they may bid with `kin_floor_bid` or ignore it.
- **Folding (interface rule 3):** clients fold two or more consecutive agent messages with one `floorRunId` into one line showing the last `decision` message. When a run closes with an `objection` and no later `decision`, the server posts a `decision` card (CHAT-13) awaiting the owner.

### Judge (interface only, shadow mode)

`apps/server/src/kin/floor/Judge.ts` (**new**):

```ts
export interface JudgeInput {
  orgId: KinOrgId;
  chatId: KinChatId;
  messageId: KinMessageId;
  text: string;
  authorRole: KinRole;
  recent: ReadonlyArray<{ authorKind: "human" | "agent"; role: string; text: string }>; // last 10
  agentRoles: ReadonlyArray<KinAgentRole>;
}
export interface Scored<A> {
  value: A;
  confidence: number;
} // 0..1
export interface JudgeVerdict {
  needsResponse: Scored<boolean>;
  role: Scored<KinAgentRole | null>;
  urgency: Scored<"low" | "normal" | "high">;
  needsHumanDecision: Scored<boolean>;
  commitment: Scored<{ kind: "none" | "defer" | "promise"; text: string | null }>;
}
export class Judge extends Context.Service<
  Judge,
  {
    readonly name: string;
    readonly judge: (input: JudgeInput) => Effect.Effect<JudgeVerdict, JudgeError>;
  }
>()("kin/Judge") {}
export const JUDGE_MODE: "off" | "shadow" | "live" = "shadow";
export const JUDGE_THRESHOLDS = { act: 0.8, ask: 0.5 } as const; // below ask: ask an LLM or the user
```

- **Shadow runner:** after the floor manager decides, `JudgeShadow` calls the judge in a forked fiber with one 3 s deadline covering context reads, the model call and the log write, and writes `kin_judge_log (org_id, id, chat_id, message_id, judge, verdict_json, floor_decision_json, latency_ms, error, created_at)`. It never changes the decision. Errors and timeouts are logged and dropped; a timeout does not attempt a second log-table write. Before storage, an explicit allowlist rejects unknown verdict fields, out-of-range confidence, invalid verdict values, commitment text over 1,000 characters, judge names outside 1–100 characters, message ids outside the same org/chat, and grant agent ids outside its active membership. Rejected records are logged without payloads and never stored. `JudgeShadow` is a required chat dependency supplied by the Kin layer; `off` mode supplies a no-op.
- **Implementations:** `NoopJudge` (always low confidence) ships first. Jev and the cheap-LLM fallback are later tasks outside this spec.
- **It never authorises an action.** `JudgeVerdict` has no field any approvals code reads. A test asserts that nothing under `apps/server/src/kin/approvals/` imports `kin/floor/Judge.ts`.
- The lead spec may read `commitment` from the log to propose deferrals, as a suggestion only.

### Failure cases

- **Sending while offline:** the client keeps `clientMessageId` and retries; an identical retry returns the first insert; a changed retry fails `not_allowed`.
- **Two sends in one chat at once:** the seq update serialises them; SQLite has one writer, and `busy_timeout = 5000` in `Sqlite.ts` covers contention with the CLI process.
- **Hub publish lost** (crash after commit): resubscribing reads the backlog from SQLite, so nothing is lost.
- **Agent thread ends mid-post:** the registry row has `ended_at`; `resolveAgent` refuses it with `not_allowed`. The repository rechecks that row inside the post transaction, so an identity resolved before the end cannot post afterwards.
- **Task thread deleted or archived:** the card shows `cancelled` with "Thread no longer available" and keeps its last state.
- **Widget state fails its schema** after an upgrade: the server sends it with `invalid_state` replaced by a placeholder card, never raw state.
- **Kin initialization fails:** `Layer.catchCause` disables Kin on identity or migration failures, including defects, and logs one bounded message when configured. Ordinary T3 RPCs remain available. Each Kin migration still runs in a transaction; upstream migration failures retain upstream behavior.

## Files

New (all Kin-owned):

- `packages/contracts/src/kinChat.ts`: ids, schemas, `KIN_CHAT_WS_METHODS`, `KinChatRpcs` (array of `Rpc.make`), `KIN_CHAT_RPC_SCOPES`, `KinChatError`, `kinMessageLink`, plus `KinWaitingId` for waiting rows. Test: `kinChat.test.ts`.
- `apps/server/src/kin/persistence/KinMigrations.ts`, `migrations/K001_ChatCore.ts`, `migrations/KNNN_Floor.ts` (next free number), `KinPersistence.ts`.
- `apps/server/src/kin/chat/KinChatRepository.ts`, `KinIdentity.ts`, `KinChatService.ts`, `KinChatHub.ts`, `TaskCardUpdater.ts`, `rpcHandlers.ts` (`makeKinChatHandlers(session)`), `layer.ts` (`KinChat.layer`).
- `apps/server/src/kin/widgets/registry.ts`, `taskCard.ts`.
- `apps/server/src/kin/mcp/KinChatToolkit.ts` (`makeKinChatToolkitLayer(register)`), `handlers.ts`.
- `apps/server/src/kin/floor/FloorManager.ts`, `Judge.ts`, `JudgeShadow.ts`, `NoopJudge.ts`.
- Tests next to each file (`*.test.ts`).

Upstream files touched, hooks only:

| File                                                | Hook                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                   | `export * from "./kinChat.ts";`                                                                                                                    |
| `packages/contracts/src/rpc.ts`                     | import `KinRpcs` from `kinRpcs.ts`; `...KinRpcs,` as the last argument of `RpcGroup.make(` in `WsRpcGroup`                                         |
| `apps/server/src/ws.ts`                             | import; `const kinChatHandlers = yield* makeKinChatHandlers(currentSession);` in `layerWsRpc`; `...kinChatHandlers,` in `ServerWsRpcGroup.of({`    |
| `apps/server/src/server.ts`                         | import; `Kin.mcpLayer(McpHttpServer.layer)` and `Kin.mcpRegistryLayer(McpSessionRegistry.layer)` share one Kin root (including request middleware) |
| `packages/contracts/src/auth.ts` (phase 2, CHAT-11) | `export const AuthKinChatScope = "kin:chat" as const;` and add it to `AuthEnvironmentScope` and `AuthStandardClientScopes`                         |

## Interfaces to other specs

- **Lead spec:** calls `KinIdentity.registerAgentThread` before the first lead session and `endAgentThread` on retirement. Subscribes to `KinChatHub` for `message.posted` and `widget_action` to build `KinEvent`s. Uses the Kin MCP tools to post. Owns `KinAgent` config beyond identity, the `deferral` card state, levels per chat (its own table keyed by `chatId`), and the brief builder that quotes non-owner text. Receives `floor.offer` wake requests from the floor manager.
- **Approvals spec:** creates `approval` widgets server-side from `KinPendingAction` and creates approval waiting rows through the server-only repository `addApprovalWaiting` in its transaction, never the public chat service or a transport. It resolves rows through its signed-grant flow; agents cannot create or resolve them. Reads `KinMessage.author` and `authorRole` as provenance for ceilings. Its signed-grant RPC is the only way to approve; `kin.widgets.act` refuses approvals. Shows "Waiting on Nishchay" to members from `KinWidget.awaiting`.
- **Triggers spec:** deferral and routine posts arrive as lead notices; nothing here. Its upstream contract tests should cover what this spec depends on: `Migrator` `table` option, `WsRpcGroup` and `RPC_REQUIRED_SCOPES` shapes, `layerWsRpc` session argument, `McpInvocationScope.thread`, `toolkitRegistration`, `getThreadShell` and `streamDomainEvents`, `OrchestratorMcpDelegateTaskResult`.
- **Mobile spec:** consumes `kin.*` RPCs and both streams through the normal WS client; draws native cards from `KinWidget.type` and `state`; renders generated widgets with `ThreadMcpApp`; opens task threads with `formatThreadLink`; folds runs by `floorRunId`; avatars from `KinAuthor._tag` (rule 7).

## Security notes

- **Task cards:** the environment id must match this server. Only trusted server code (`KinChatService.createTaskCard`, called by LEAD-9's worker launcher) creates task cards; agents and clients get `not_allowed`. Missing or foreign threads return `not_found`.
- **Authors are server-made.** People: from the `/ws` session through `KinIdentity`. Agents: from the MCP caller thread through the registry. No input schema has an author field.
- **No cross-org reads.** Every chat-content query filters by `org_id` from resolved identity or chat membership, never from the client. Trusted bootstrap and MCP caller-thread discovery may find an org; subsequent identity lookups stay in that stored org.
- **Not-found over forbidden** for chats outside the caller's membership.
- **Guests are suggest-only** and their text reaches agents only after the owner sends it, still labelled `authorRole: "guest"`.
- **Approval cards** can't be made or acted on through chat paths.
- **Members' devices** (phase 2) hold `kin:chat` only. Before CHAT-11 ships, no non-owner may be paired.
- **Generated widgets** keep T3's sandbox in `McpAppWebView.tsx` and add Kin's own real-tap gate on actions in the host callbacks (mobile spec, Design correction 9); Kin adds no bridge.

## Tests and acceptance criteria

Run with `cd apps/server && vp test run src/kin` and `cd packages/contracts && vp test run src/kinChat.test.ts`, plus `vp run typecheck` at the root.

- Migrations: on `Sqlite.layerMemory`, Kin migrations create every K001 table; `effect_sql_migrations` has no Kin rows; `kin_sql_migrations` has `1_ChatCore`. Running twice is a no-op.
- Phase-2 readiness: on the K001 schema, a test creates a `team_group` with two people, two agents and a guest, posts from each, and reads it back, with no schema change.
- Authors: a `kin.messages.send` payload with an extra `author` field yields a message authored by the session's person.
- Agent posts: from an unregistered thread, a subagent thread, or an ended thread, `kin_chat_post` fails; from a registered lead thread it succeeds with `author._tag === "agent"` and the right `threadId`.
- Isolation: a person in org A gets `not_found` for a chat in org B, on every method.
- Widgets: `act` with a stale revision fails `widget_changed`; on an approval widget fails `use_approvals`; `kin_widget_upsert` with `type: "approval"` fails.
- Task card: a fake orchestrator emitting thread status changes moves the card through `working → needs_decision → done` with rising revisions and no new messages.
- Stream: subscribe with `afterSeq` and `afterChangeSeq` gets the missed messages plus messages and widgets changed while away, then live ones, with no duplicates across a concurrent send; more than 200 missed gives `reset`.
- Read state: `markRead` never moves back; unread counts exclude the reader's own messages.
- Waiting: an agent question in a direct chat adds a row; the owner's reply resolves it; the list stream shows both changes.
- Floor manager: table tests for rules 1 to 5, including a mention of the last speaker, the 6-turn cap, `answer` refused on a second turn, and notices outside runs.
- Judge: shadow mode never changes a decision (property test with a judge that returns random verdicts); timeouts are logged; the import-boundary test passes.
- Budget: `AgentContextBudget.test.ts` passes unchanged.

## Tasks

**CHAT-1. Chat contracts.** What: `kinChat.ts` with ids, `KinOrg`, `KinPerson`, `KinAgent`, `KinChat`, `KinChatMember`, `KinAuthor`, `KinMessage`, `KinWidget`, `KinTaskCardState`, `KinWaitingItem`, stream events, inputs, `KinChatError`, `KIN_CHAT_WS_METHODS`, `KinChatRpcs`, `KIN_CHAT_RPC_SCOPES`, `kinMessageLink`. Hook in `index.ts`. Files: `packages/contracts/src/kinChat.ts`, test. Depends on: none. Done when: `vp run typecheck` passes and `kinChat.test.ts` round-trips every schema. Owner: backend.

**CHAT-2. Kin migration track and K001.** What: `KinMigrations.ts`, `K001_ChatCore.ts`, `KinPersistence.layer`. Files: `apps/server/src/kin/persistence/*`. Depends on: none. Done when: the migration tests above pass on `layerMemory`. Owner: backend.

**CHAT-3. Repository.** What: `KinChatRepository` for orgs, people, agents, chats, members, messages (seq allocation in a transaction), widgets, read state, waiting. Files: `apps/server/src/kin/chat/KinChatRepository.ts`, test. Depends on: CHAT-1, CHAT-2. Done when: repository tests cover insert, idempotent send, seq under concurrent sends, history paging, and org filtering. Owner: backend.

**CHAT-4. Identity and bootstrap.** What: `KinIdentity` with the phase-1 session rule, default org and owner person created on first start, agent thread registry with an in-memory set for `EnabledWhen`. Files: `apps/server/src/kin/chat/KinIdentity.ts`, test. Depends on: CHAT-3. Done when: first start creates exactly one org and owner; restart keeps them; register, resolve and end of agent threads pass tests. Owner: backend.

**CHAT-5. Chat service and hub.** What: `KinChatService` (createDirect, send, history, markRead, widget upsert and act, addWaiting and resolveWaiting, membership and role checks) and `KinChatHub`. Files: `KinChatService.ts`, `KinChatHub.ts`, `widgets/registry.ts`, tests. Depends on: CHAT-4. Done when: author, isolation, widget, read state and waiting tests pass. Owner: backend.

**CHAT-6. WS RPCs and streams.** Both streams must use `KinChatHub.subscribeForViewer(identity)`, which checks current membership at delivery except for the viewer's own resolved waiting rows and terminal removal event and hides suggestions from everyone except their author and the chat owner; the unfiltered org subscription is module-private; trusted server consumers use viewer-bound subscriptions too. What: `makeKinChatHandlers(session)`, both stream handlers with resume, `KinChat.layer`; `packages/contracts/src/kinRpcs.ts` exporting `KinRpcs` and `KIN_RPC_SCOPES`, which combine every Kin spec's RPCs and scopes (`KinChatRpcs` first; other specs add theirs here, never to upstream files); hooks in `rpc.ts`, `ws.ts`, `clientRpcPermissions.ts`, `RpcInstrumentation.ts`, `server.ts`. Files: `kinRpcs.ts`, `apps/server/src/kin/chat/rpcHandlers.ts`, `layer.ts`. Depends on: CHAT-5. Done when: a `ws.test.ts`-style test over a real socket sends, subscribes, resumes with `afterSeq`, and gets `not_found` across orgs; `vp run typecheck` shows no `any` in the handler layer requirements (see Design corrections 6). Owner: backend. Provide one shared `KinIdentity` instance for WS handlers and the `/kin/mcp` toolkit and test that it is shared. A Kin identity failure must disable Kin without stopping T3 startup.

**CHAT-7. Agent MCP tools.** What: `KinChatToolkit` with `kin_chat_post`, `kin_chat_read`, `kin_widget_upsert`; `EnabledWhen` from the shared identity; separate `/kin/mcp` transport and credential wrapper with two `server.ts` hooks. Files: `apps/server/src/kin/mcp/*`. Depends on: CHAT-5. Done when: agent-post tests pass and `AgentContextBudget.test.ts` passes unchanged. Owner: backend. Use the same shared `KinIdentity` instance as WS handlers and test that it is shared.

**CHAT-8. Task cards.** What: `TaskCardUpdater` following `streamDomainEvents` and `getThreadShell`, startup recheck. Files: `apps/server/src/kin/chat/TaskCardUpdater.ts`, `widgets/taskCard.ts`, tests. Depends on: CHAT-5, CHAT-7. Done when: the task card test passes, and a real `delegate_task` integration test with a server-created card shows the card change state in `kin.chat.subscribe` output. Owner: backend.

**CHAT-9. Floor manager.** What: pure `FloorManager.ts` (rules 1 to 5, replies vs notices), floor tables at K008, internal group grant tokens pending phase-2 wake-up delivery, implicit grants in direct chats, notice rate limit. Files: `apps/server/src/kin/floor/FloorManager.ts`, `migrations/KNNN_Floor.ts` (next free number), tests. Depends on: CHAT-7. Done when: floor table tests pass and a direct-chat test shows a second unprompted reply refused with `floor_not_granted` while a notice passes. Owner: backend.

**CHAT-10. Judge in shadow.** What: `Judge` service, `NoopJudge`, `JudgeShadow`, `kin_judge_log`, thresholds, import-boundary test. Files: `apps/server/src/kin/floor/Judge.ts`, `JudgeShadow.ts`, `NoopJudge.ts`, tests. Depends on: CHAT-9. Done when: the judge tests pass and `kin_judge_log` gets one row per human message in a group test. Owner: backend.

**CHAT-11. Groups, members and the `kin:chat` scope** (phase 2). What: `createGroup`, members add, remove, setRole, mute; session bindings; `kin:chat` scope hook in `auth.ts`; move `KIN_CHAT_RPC_SCOPES` to it; owner-only role checks; deliver group floor grants through agent wake-ups. Files: `KinChatService.ts`, `KinIdentity.ts`, `kinChat.ts`, `auth.ts` hook. Depends on: CHAT-6, and the member sign-in work for DESIGN gap 8 (unowned; see Open questions). Done when: a session holding only `kin:chat` can use every `kin.*` method for its chats and gets `EnvironmentAuthorizationError` on `orchestration.subscribeShell` and `terminal.open`. Owner: backend.

**CHAT-12. Guests, suggest-only** (phase 2). What: guest role, `suggested` status, `kin.suggestions.resolve`, limits and name check copied from `guestShare.ts`, viewer filtering in streams, waiting rows for the owner. Files: `KinChatService.ts`, `rpcHandlers.ts`, tests. Depends on: CHAT-11. Done when: a guest's message is not visible to agents (`kin_chat_read`) or members until the owner sends it, and a fourth waiting suggestion fails `limit`. Owner: backend.

**CHAT-13. Group cards and folding** (phase 2). What: state schemas for `decision`, `poll`, `checklist`, `form`, `date`; server-side tally for polls; decision card on a run that ends in an unresolved objection; `kin.widgets.setPinned`. Files: `apps/server/src/kin/widgets/*`, `KinChatService.ts`, tests. Depends on: CHAT-9. Done when: two members voting in one poll see one shared tally in both streams, and a run closing on an objection posts one decision card awaiting the owner. Owner: backend.

## Design corrections

1. **T3 has no people.** `AuthenticatedSession.subject` is a credential label (`"browser"`, `"one-time-token"`), and every paired device holds environment-wide scopes (`AuthStandardClientScopes` includes terminal and filesystem write). "Server-verified human author" works in phase 1 only because every session is the owner. Members need Kin's own people, session bindings and a narrow `kin:chat` scope. Without that, pairing a member's phone gives them the owner's machine.
2. **Kin can't append to upstream's migration list.** `Migrations.ts` is one numbered sequence, and the migrator skips every id up to the highest recorded one (`assertV2MigrationsCanRun` says so). A Kin migration 81 would collide with upstream's next migration on the next sync. Kin uses its own `kin_sql_migrations` table through `MigratorOptions.table`.
3. **The MCP App bridge is bound to a thread turn item,** not a chat message (`McpAppTarget = { threadId, itemId }`; `ThreadMcpApp` needs `itemId`). Generated widgets in chat must point at the lead thread's tool call, and they work only for the owner's sessions. Showing them to members needs a Kin bridge, decided in phase 2.
4. **Guest sharing can't be reused as chat guests.** It is one browser guest per thread over T3 Connect, for 24 hours, behind the `guestSharingEnabled` beta flag. Kin reuses its suggest-only model, its limits and `PayloadSigner`. `NAME_BREAKING_CHARACTER` isn't exported, so Kin copies it.
5. **Kin imports `toolkitRegistration` without an upstream cycle.** `McpHttpServer.ts` does not import Kin; `server.ts` wraps the existing transport and credential layer. The Kin transport isolates its MCP registry with `Layer.fresh` so Kin registrations cannot leak into the ordinary endpoint.
6. **`ws.ts` is near a TypeScript limit.** Its comment says that near 200 methods the handler layer's requirements degrade to `any`, which is why it splits into two groups. Kin's phase-1 methods land in `OtherWsRpcGroup`. If typecheck shows the degradation, Kin needs a third group: three more lines in `ws.ts`.
7. **"Each agent may ask to speak" has a cost** the design doesn't mention. Agents only act inside a woken lead session, so every bid is a session. The floor manager decides who is woken; others are offered the floor only within budget.
8. **Rules 3 and 4 would block scheduled posts** in a direct chat (a morning brief after an unanswered deferral notice). The spec splits agent posts into replies, which the rules govern, and notices, which are rate-limited instead.
9. **"Jev from TypeSafe"** could not be checked from this repo. The spec stubs the `Judge` interface only.

## Open questions

- Who owns member sign-in (DESIGN gap 8: invites, accounts, devices, GitHub handles)? CHAT-11 needs it. Proposal: a small `kin-identity` addition to this spec in phase 2.
- Should members see generated widgets in phase 2, and through what bridge?
- Should a member's `kin:chat`-only device open task threads read-only? That needs a narrow thread-read path, or a guest share per thread.
- Mobile connects and subscribes to many upstream streams at start (server config, shell). A `kin:chat`-only session will be refused on those; the mobile spec needs a "chat-only" connection mode.
- Retention and export (10a) for messages: phase 5. Until then nothing is deleted except by the owner.
