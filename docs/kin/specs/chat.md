# Kin spec: chats

Status: draft, 7 Nov 2026. Covers DESIGN.md sections 5, 7 (widget envelope only), 8 and the `orgId` rule in 10a. Prefix: CHAT.

## Goal

People and agents talk in chats. A chat holds messages whose author the server sets, never the client. Messages may carry a widget. A task card in a chat opens the T3 thread doing the work. Each person sees which chats are unread and one **Waiting on you** list.

Phase 1 ships direct chats only: the owner and one lead. The schema already has orgs, members, roles and group kinds, so phase 2 adds rows and code, not migrations of existing rows.

## What exists in T3

All paths are on `kin` as of 7 Nov 2026 (merged with upstream `main`).

| Piece                                | Where                                                                                                                                                                                                                                                                                                        | What it means for chats                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite client and startup migrations | `apps/server/src/persistence/Sqlite.ts` (`layerSetup` runs `runMigrations()`, `layerConfig`, `layerMemory`)                                                                                                                                                                                                  | Kin tables live in the same database file. `layerMemory` serves tests.                                                                  |
| Migration list                       | `apps/server/src/persistence/Migrations.ts` (`migrationEntries`, 80 entries, `assertV2MigrationsCanRun`)                                                                                                                                                                                                     | One numbered sequence; the migrator skips every id up to the highest recorded one. Kin can't add entries here (see Design corrections). |
| Separate migration track             | `effect/sql/Migrator` `MigratorOptions.table` (`apps/server/node_modules/effect/src/sql/Migrator.ts`, default `"effect_sql_migrations"`)                                                                                                                                                                     | Kin runs its own migrator with `table: "kin_sql_migrations"`.                                                                           |
| Repository pattern                   | `apps/server/src/persistence/PullRequestFilesViewed.ts` (`Context.Service`, `SqlSchema.findAll`, `PersistenceSqlError`/`PersistenceDecodeError` from `Errors.ts`)                                                                                                                                            | Kin repositories copy this shape.                                                                                                       |
| RPC definitions                      | `packages/contracts/src/rpc.ts`: `WS_METHODS`, `Rpc.make(...)`, `WsRpcGroup = RpcGroup.make(...).middleware(RpcScopeAuthorization)`                                                                                                                                                                          | Kin RPCs join `WsRpcGroup` before `.middleware`, so the same scope check covers them.                                                   |
| Stream RPCs                          | `rpc.ts` `WsScheduledTasksSubscribeRpc` (`stream: true`); handler in `ws.ts` returns a `Stream`                                                                                                                                                                                                              | The chat list and chat streams follow it.                                                                                               |
| Scope check                          | `apps/server/src/auth/RpcAuthorization.ts`: `RPC_REQUIRED_SCOPES ... satisfies Record<WsRpcMethod, AuthEnvironmentScope>`, `layer(session.scopes, ...)`                                                                                                                                                      | Every Kin method needs an entry or typecheck fails.                                                                                     |
| Handlers and session                 | `apps/server/src/ws.ts`: `layerWsRpc(currentSession: EnvironmentAuth.AuthenticatedSession, ...)`, `ServerWsRpcGroup.of({...})`, split into `SplitWsRpcGroup` / `OtherWsRpcGroup`                                                                                                                             | Kin handlers are built here because only here is the caller's session known. `kin.*` falls in `OtherWsRpcGroup`.                        |
| Session identity                     | `apps/server/src/auth/EnvironmentAuth.ts` `AuthenticatedSession { sessionId, subject, method, scopes, proofKeyThumbprint?, expiresAt? }`                                                                                                                                                                     | No person or role. `subject` is a credential label such as `"browser"` or `"one-time-token"`.                                           |
| Scopes                               | `packages/contracts/src/auth.ts` `AuthEnvironmentScope`, `AuthStandardClientScopes` (includes terminal, filesystem write, settings)                                                                                                                                                                          | Every paired device is the environment owner.                                                                                           |
| Agent caller identity                | `apps/server/src/mcp/McpInvocationContext.ts` `McpInvocationScope.thread: McpThreadCaller { threadId, providerSessionId, providerInstanceId, subagent? }`                                                                                                                                                    | The server knows which thread is calling an MCP tool. This is the agent author.                                                         |
| MCP tool registration                | `apps/server/src/mcp/McpHttpServer.ts` `toolkitRegistration(...)`, `layerTools = Layer.mergeAll(...)`; budget test `apps/server/src/provider/AgentContextBudget.test.ts` with `agentContextBudget.json`                                                                                                      | Kin's agent tools register here. Every advertised tool counts against the committed budget.                                             |
| Delegated tasks                      | `delegate_task` in `apps/server/src/mcp/toolkits/orchestrator/tools.ts`; result `OrchestratorMcpDelegateTaskResult { taskId: NodeId, childThreadId, remoteChild?, link?, status, ... }` in `packages/contracts/src/orchestratorMcp.ts`                                                                       | A task card stores `taskId` and `childThreadId`.                                                                                        |
| Thread state                         | `apps/server/src/orchestration-v2/Orchestrator.ts` `OrchestratorV2Shape.getThreadShell(threadId)`, `streamDomainEvents`; `OrchestrationV2ThreadShell` (`status`, `activityRunStatus`, `pullRequests`, `pendingRuntimeRequest`, `lastError`) in `packages/contracts/src/orchestrationV2.ts`                   | The task card updater reads these.                                                                                                      |
| Thread links                         | `packages/shared/src/threadLinks.ts` `formatThreadLink`, `hostedThreadLink`, `THREAD_LINK_PROTOCOL = "t3-thread"`                                                                                                                                                                                            | A task card opens its thread with these.                                                                                                |
| Guest sharing                        | `packages/contracts/src/guestShare.ts` (`ThreadGuestShare`, `GUEST_MESSAGE_MAX_LENGTH`, `GUEST_PENDING_MESSAGE_LIMIT`, `NAME_BREAKING_CHARACTER` not exported), `apps/server/src/guest/GuestShareService.ts` (invite and session tokens signed with `auth/PayloadSigner.ts`, gated by `guestSharingEnabled`) | Bound to one thread and one browser guest. Kin reuses the suggest-only model, the limits and the signer, not the record.                |
| MCP App bridge                       | `apps/mobile/src/features/threads/McpAppWebView.tsx` `ThreadMcpApp({ environmentId, threadId, conversationThreadId, itemId, app: McpAppReference, ... })`; `packages/contracts/src/mcpApps.ts` `McpAppTarget = { threadId, itemId }`; `McpAppReference` in `packages/shared/src/mcpApp.ts`                   | Generated widgets are bound to the thread turn item that made them.                                                                     |

## Design

### Organizations and identity

Every row carries `orgId`. Phase 1 has one org, created on first start.

- **`KinOrg`**: `orgId`, `name`, `createdAt`.
- **`KinPerson`**: a human inside one org. `personId`, `orgId`, `handle` (slug used as `said_by` in kin-memory), `displayName`, `githubLogin?`. The same human in two orgs is two persons. That keeps the walls in 10a: nothing joins across orgs except the session binding.
- **`KinAgent`**: an agent identity inside one org. `agentId`, `orgId`, `displayName`, `role` (`lead | architect | builder | qa | release | router | specialist`), `ownerPersonId` (every agent has a human owner, section 9.8). The lead spec owns the agent's config (model, level, budget) in its own table keyed by `agentId`.
- **Session to person** (`KinIdentity.resolve(session)`):
  - Phase 1: any `/ws` session that passes the RPC scope check is the org owner. This is true today: only the owner can pair devices.
  - Phase 2: a row in `kin_session_bindings (session_id, org_id, person_id)` decides. A session without a binding is the owner only if it holds `AuthStandardClientScopes`. Members get sessions with the new `kin:chat` scope only (CHAT-11), so their device never gets the owner's terminal or files.
- **Agent thread to agent** (`KinIdentity.resolveAgent(mcpScope)`): the lead spec registers each lead session's thread with `registerAgentThread({ orgId, agentId, threadId })`. Kin MCP tools look up `McpInvocationScope.thread.threadId`. No row, or `subagent: true`, means refusal. Workers never post; they report to their lead.

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
- **Idempotency:** unique `(chat_id, author_key, client_message_id)`. A retried send returns the first message.
- **Agent posts** come only through the Kin MCP tool `kin_chat_post` (CHAT-7). The author is built from `KinIdentity.resolveAgent`. Agent text is never trusted as a claim about authority (section 9.3); that rule lives in the approvals spec, but the chat never offers a way to make agent text look human.
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

- **State schemas** are registered per type in `apps/server/src/kin/widgets/registry.ts` (**new**). Owners: `task` (this spec), `approval` (approvals spec, drawn from `KinPendingAction`), `deferral` (lead spec), `decision`, `poll`, `checklist`, `form`, `date` (this spec, phase 2, CHAT-13). An unknown type, or state that fails its schema, is refused at upsert.
- **Acting:** `kin.widgets.act({ widgetId, revision, actionId, value?, clientActionId })` posts a `widget_action` message authored by the session's person, with `{ widgetId, revision, actionId, value }` as its structured body. The lead acts on it under its own permissions. A stale `revision` fails with `widget_changed`.
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

1. The lead calls `delegate_task`, then `kin_widget_upsert({ chatId, type: "task", state })` with the ids from the result. The server checks that the thread exists with `OrchestratorV2.getThreadShell`.
2. **`KinTaskCardUpdater`** (**new**, `apps/server/src/kin/chat/TaskCardUpdater.ts`) follows `OrchestratorV2.streamDomainEvents`. For a thread linked to an open task card it re-reads `getThreadShell` (debounced 1 s per thread) and maps `status`, `activityRunStatus`, `pendingRuntimeRequest` (gives `needs_decision`), `lastError` and `pullRequests` onto the card. It bumps `revision` and publishes `widget.updated`. No new message is posted (interface rule 2).
3. On start it rechecks every open task card once, since events during downtime are not replayed to it.
4. Tapping the card opens the thread: the app routes `formatThreadLink({ environmentId, threadId })` the way thread chips do. Remote tasks use `remoteEnvironmentId`. Members without thread access see the card without the open action.
5. The lead closes the card (`closedAt`) when it posts the result with evidence.

### Read state and Waiting on you

- **Read state:** `kin_read_state (org_id, chat_id, member_id, last_read_seq)`. `kin.messages.markRead({ chatId, seq })` only moves forward. Unread count is the posted messages with `seq > last_read_seq` not authored by the member.
- **Waiting on you:** `kin_waiting (org_id, waiting_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution)`. `reason` is `approval | decision | question | suggestion | mention`. Rows come from:
  - a widget upsert with `awaiting` (one row per person; removed people resolve as `superseded`),
  - an agent message with `intent: "question"` that mentions a person, or any agent question in a direct chat,
  - a guest suggestion (for the owner),
  - the approvals spec calling `addWaiting` for its approval cards.
- A row resolves when the widget closes, the person acts on it, the person replies in the chat after the question (for `question`), or the source calls `resolveWaiting`.
- The list streams with the chat list. Without an `orgId` the stream merges every org the session is bound to, each item labelled with `orgId` (10a, "one switcher"). Only this list is highlighted in the UI (interface rule 1); push and lock-screen buttons are the mobile and approvals specs' work.

### Persistence

Kin runs its own migration track in the T3 database file.

- **`apps/server/src/kin/persistence/KinMigrations.ts`** (**new**) builds `Migrator.make({ table: "kin_sql_migrations" })` with a `Migrator.fromRecord` loader over `apps/server/src/kin/persistence/migrations/K001_ChatCore.ts` and later files. Ids are Kin's own sequence and never touch `effect_sql_migrations`.
- It runs from `KinPersistence.layer`, a `Layer.effectDiscard` that needs `SqlClient`. `SqlClient` comes from `Sqlite.layerConfig`, whose `layerSetup` has already run upstream migrations, so Kin always migrates second.
- Kin tables never use foreign keys into upstream tables (upstream drops and renames its own: `063_DropUnusedV1Projections.ts`). Thread and task ids are plain text. Foreign keys between Kin tables are fine (`PRAGMA foreign_keys = ON` is set in `Sqlite.ts`).
- An upstream build opening a Kin database ignores the `kin_*` tables.

K001 (phase 1, includes everything phase 2 needs for existing rows):

| Table                  | Key columns                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kin_orgs`             | `org_id` PK, `name`, `created_at`                                                                                                                                                                                                                                                                                                                                                                  |
| `kin_people`           | `person_id` PK, `org_id`, `handle` (unique per org), `display_name`, `github_login`, `created_at`                                                                                                                                                                                                                                                                                                  |
| `kin_agents`           | `agent_id` PK, `org_id`, `display_name`, `role`, `owner_person_id`, `created_at`, `retired_at`                                                                                                                                                                                                                                                                                                     |
| `kin_agent_threads`    | `thread_id` PK, `org_id`, `agent_id`, `started_at`, `ended_at`                                                                                                                                                                                                                                                                                                                                     |
| `kin_session_bindings` | (`session_id`, `org_id`) PK, `person_id`, `bound_at`, `revoked_at` (empty in phase 1)                                                                                                                                                                                                                                                                                                              |
| `kin_chats`            | `chat_id` PK, `org_id`, `kind`, `title`, `team_id`, `direct_key` (unique with `org_id`, null for groups), `last_seq`, `last_message_at`, `created_at`, `archived_at`                                                                                                                                                                                                                               |
| `kin_chat_members`     | `member_id` PK, `org_id`, `chat_id`, `principal_kind`, `person_id`, `agent_id`, `role`, `joined_at`, `left_at`, `muted_until`; unique (`chat_id`, `person_id`), (`chat_id`, `agent_id`)                                                                                                                                                                                                            |
| `kin_messages`         | `message_id` PK, `org_id`, `chat_id`, `seq`, `author_kind`, `author_person_id`, `author_agent_id`, `author_thread_id`, `author_member_id`, `author_role`, `kind`, `body`, `intent`, `mentions_json`, `reply_to`, `widget_id`, `floor_run_id`, `status`, `sent_by`, `client_message_id`, `created_at`, `edited_at`; unique (`chat_id`, `seq`), (`chat_id`, `author_member_id`, `client_message_id`) |
| `kin_widgets`          | `widget_id` PK, `org_id`, `chat_id`, `message_id`, `widget_class`, `type`, `revision`, `state_json`, `source_thread_id`, `source_item_id`, `feed_kind`, `feed_key`, `awaiting_json`, `pinned_at`, `closed_at`, `updated_at`; index on (`type`, `closed_at`)                                                                                                                                        |
| `kin_read_state`       | (`chat_id`, `member_id`) PK, `org_id`, `last_read_seq`, `updated_at`                                                                                                                                                                                                                                                                                                                               |
| `kin_waiting`          | `waiting_id` PK, `org_id`, `person_id`, `chat_id`, `message_id`, `widget_id`, `reason`, `created_at`, `resolved_at`, `resolution`; index on (`person_id`, `resolved_at`)                                                                                                                                                                                                                           |

K002 (phase 2): `kin_floor_runs`, `kin_floor_bids`, `kin_judge_log` (below). New tables only.

**Seq allocation:** in one `sql.withTransaction`: `UPDATE kin_chats SET last_seq = last_seq + 1, last_message_at = ? WHERE chat_id = ? RETURNING last_seq`, then insert the message with that seq. Publish to the in-process hub only after commit.

### RPC surface

Method names live in `KIN_CHAT_WS_METHODS` in `kinChat.ts`. `kinChat.ts` must not import `rpc.ts`, since `rpc.ts` imports it.

| Method                                               | Payload                                                    | Success                                         | Phase | Scope (phase 1)         |
| ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ----- | ----------------------- |
| `kin.orgs.list`                                      | `{}`                                                       | `{ orgs: KinOrg[], me: { orgId, personId }[] }` | 1     | `orchestration:read`    |
| `kin.chats.subscribe` (stream)                       | `{ orgId?: KinOrgId }`                                     | `KinChatListEvent`                              | 1     | `orchestration:read`    |
| `kin.chats.createDirect`                             | `{ orgId, agentId }`                                       | `KinChat`                                       | 1     | `orchestration:operate` |
| `kin.chat.subscribe` (stream)                        | `{ chatId, afterSeq?: number }`                            | `KinChatStreamEvent`                            | 1     | `orchestration:read`    |
| `kin.chat.history`                                   | `{ chatId, beforeSeq, limit ≤ 100 }`                       | `{ messages, widgets, hasMore }`                | 1     | `orchestration:read`    |
| `kin.messages.send`                                  | `{ chatId, clientMessageId, body, mentions?, replyTo? }`   | `KinMessage`                                    | 1     | `orchestration:operate` |
| `kin.messages.markRead`                              | `{ chatId, seq }`                                          | `{}`                                            | 1     | `orchestration:read`    |
| `kin.widgets.act`                                    | `{ widgetId, revision, actionId, value?, clientActionId }` | `KinMessage`                                    | 1     | `orchestration:operate` |
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
  }),
  Schema.TaggedStruct("reset", { lastSeq: NonNegativeInt }), // gap too big: refetch with history
  Schema.TaggedStruct("message", { message: KinMessage }), // new or changed (edit, delete, send of a suggestion)
  Schema.TaggedStruct("widget", { widget: KinWidget }),
  Schema.TaggedStruct("member", { member: KinChatMember }),
  Schema.TaggedStruct("read", { memberId: KinMemberId, seq: NonNegativeInt }),
]);
```

- **Resume:** `kin.chat.subscribe` subscribes to the hub first, then reads messages after `afterSeq` (up to 200; more sends `reset`), sends `backlog`, then live events with `seq > backlog.lastSeq`. Clients drop duplicates by `seq`. Reconnecting means subscribing again with the last seq held.
- **Filtering per viewer:** suggestions go only to their author and the chat owner. Agent subscribers do not exist on `/ws`; agents read through `kin_chat_read`.
- **Hub:** `KinChatHub` (**new**), a `PubSub` keyed by `orgId`. The lead spec subscribes to `message.posted` from it to fill its per-org event queue.

### Authorisation, in two layers

1. **Scope (coarse):** `KIN_CHAT_RPC_SCOPES` in `kinChat.ts` maps each method to a scope; `RpcAuthorization.ts` spreads it into `RPC_REQUIRED_SCOPES`. Phase 1 uses existing scopes (table above). Phase 2 adds `kin:chat` and moves every `kin.*` method to it (CHAT-11).
2. **Membership (fine):** inside `KinChatService`, every call resolves the person, loads the chat by id, and checks an active member row in the same org. A client-sent `orgId` must match the chat's. Role checks: only `owner` adds or removes members, sets roles, resolves suggestions, pins. `guest` can only `send` (stored as `suggested`), `markRead` and subscribe. Muted agents can't post.

### Agent tools (MCP)

`KinChatToolkit` (**new**, `apps/server/src/kin/mcp/KinChatToolkit.ts`):

- `kin_chat_post({ chatId, body, intent, mentions?, replyTo?, floorGrant? })`
- `kin_chat_read({ chatId, afterSeq?, limit? })`: messages as data. Text from anyone but the owner is wrapped in quoted blocks labelled with the author's role (section 9.4) by the lead spec's brief builder, not here; this tool returns `authorRole` so it can.
- `kin_widget_upsert({ chatId, widgetId?, type, state, awaiting?, replyTo? })`: creates (with a message) or updates in place. Refuses `approval`.
- `kin_floor_bid({ chatId, runId, reason, intent })` (phase 2).

Every tool is hidden unless the calling thread is a registered agent thread. The `EnabledWhen` check reads `McpInvocationContext` from the fiber, as `hiddenFromSubagents` does, against an in-memory set kept by `KinIdentity`. So ordinary T3 threads, the context budget test and `agentContextBudget.json` see no change.

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
- **Enforcement:** `kin_chat_post` in a group needs `floorGrant`, the grant token. A post without a valid token fails with `floor_not_granted`. A post uses the grant up, adds one to `agentTurns`, sets `lastSpeaker`, and stores `floorRunId` on the message.
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

- **Shadow runner:** after the floor manager decides, `JudgeShadow` calls the judge in a forked fiber with a 3 s timeout and writes `kin_judge_log (org_id, id, chat_id, message_id, judge, verdict_json, floor_decision_json, latency_ms, error, created_at)`. It never changes the decision. Errors and timeouts are logged and dropped.
- **Implementations:** `NoopJudge` (always low confidence) ships first. Jev and the cheap-LLM fallback are later tasks outside this spec.
- **It never authorises an action.** `JudgeVerdict` has no field any approvals code reads. A test asserts that nothing under `apps/server/src/kin/approvals/` imports `kin/floor/Judge.ts`.
- The lead spec may read `commitment` from the log to propose deferrals, as a suggestion only.

### Failure cases

- **Sending while offline:** the client keeps `clientMessageId` and retries; the server returns the first insert.
- **Two sends in one chat at once:** the seq update serialises them; SQLite has one writer, and `busy_timeout = 5000` in `Sqlite.ts` covers contention with the CLI process.
- **Hub publish lost** (crash after commit): resubscribing reads the backlog from SQLite, so nothing is lost.
- **Agent thread ends mid-post:** the registry row has `ended_at`; posts from it fail `not_allowed`.
- **Task thread deleted or archived:** the card shows `cancelled` with "Thread no longer available" and keeps its last state.
- **Widget state fails its schema** after an upgrade: the server sends it with `invalid_state` replaced by a placeholder card, never raw state.
- **Kin migration fails:** server start fails with the migrator's error, the same as an upstream migration failure. Nothing is half-applied, because each migration runs in a transaction.

## Files

New (all Kin-owned):

- `packages/contracts/src/kinChat.ts`: ids, schemas, `KIN_CHAT_WS_METHODS`, `KinChatRpcs` (array of `Rpc.make`), `KIN_CHAT_RPC_SCOPES`, `KinChatError`, `kinMessageLink`. Test: `kinChat.test.ts`.
- `apps/server/src/kin/persistence/KinMigrations.ts`, `migrations/K001_ChatCore.ts`, `migrations/K002_Floor.ts`, `KinPersistence.ts`.
- `apps/server/src/kin/chat/KinChatRepository.ts`, `KinIdentity.ts`, `KinChatService.ts`, `KinChatHub.ts`, `TaskCardUpdater.ts`, `rpcHandlers.ts` (`makeKinChatHandlers(session)`), `layer.ts` (`KinChat.layer`).
- `apps/server/src/kin/widgets/registry.ts`, `taskCard.ts`.
- `apps/server/src/kin/mcp/KinChatToolkit.ts` (`makeKinChatToolkitLayer(register)`), `handlers.ts`.
- `apps/server/src/kin/floor/FloorManager.ts`, `Judge.ts`, `JudgeShadow.ts`, `NoopJudge.ts`.
- Tests next to each file (`*.test.ts`).

Upstream files touched, hooks only:

| File                                                | Hook                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                   | `export * from "./kinChat.ts";`                                                                                                                                                    |
| `packages/contracts/src/rpc.ts`                     | import `KinChatRpcs`; `...KinChatRpcs,` as the last argument of `RpcGroup.make(` in `WsRpcGroup`                                                                                   |
| `apps/server/src/auth/RpcAuthorization.ts`          | import; `...KIN_CHAT_RPC_SCOPES,` in `RPC_REQUIRED_SCOPES`                                                                                                                         |
| `apps/server/src/ws.ts`                             | import; `const kinChatHandlers = yield* makeKinChatHandlers(currentSession);` in `layerWsRpc`; `...kinChatHandlers,` in `ServerWsRpcGroup.of({`                                    |
| `apps/server/src/server.ts`                         | import; `Layer.provide(KinChat.layer),` in the pipe after the routes `Layer.mergeAll` (the one with `PeerLinkRequests.layer`), so `Ws.layer` and `McpHttpServer.layer` both see it |
| `apps/server/src/mcp/McpHttpServer.ts`              | import; `makeKinChatToolkitLayer(toolkitRegistration),` in `layerTools`                                                                                                            |
| `packages/contracts/src/auth.ts` (phase 2, CHAT-11) | `export const AuthKinChatScope = "kin:chat" as const;` and add it to `AuthEnvironmentScope` and `AuthStandardClientScopes`                                                         |

## Interfaces to other specs

- **Lead spec:** calls `KinIdentity.registerAgentThread` / `endAgentThread` around each lead session. Subscribes to `KinChatHub` for `message.posted` and `widget_action` to build `KinEvent`s. Uses the Kin MCP tools to post. Owns `KinAgent` config beyond identity, the `deferral` card state, levels per chat (its own table keyed by `chatId`), and the brief builder that quotes non-owner text. Receives `floor.offer` wake requests from the floor manager.
- **Approvals spec:** creates `approval` widgets server-side from `KinPendingAction` and calls `addWaiting` / `resolveWaiting`. Reads `KinMessage.author` and `authorRole` as provenance for ceilings. Its signed-grant RPC is the only way to approve; `kin.widgets.act` refuses approvals. Shows "Waiting on Nishchay" to members from `KinWidget.awaiting`.
- **Triggers spec:** deferral and routine posts arrive as lead notices; nothing here. Its upstream contract tests should cover what this spec depends on: `Migrator` `table` option, `WsRpcGroup` and `RPC_REQUIRED_SCOPES` shapes, `layerWsRpc` session argument, `McpInvocationScope.thread`, `toolkitRegistration`, `getThreadShell` and `streamDomainEvents`, `OrchestratorMcpDelegateTaskResult`.
- **Mobile spec:** consumes `kin.*` RPCs and both streams through the normal WS client; draws native cards from `KinWidget.type` and `state`; renders generated widgets with `ThreadMcpApp`; opens task threads with `formatThreadLink`; folds runs by `floorRunId`; avatars from `KinAuthor._tag` (rule 7).

## Security notes

- **Authors are server-made.** People: from the `/ws` session through `KinIdentity`. Agents: from the MCP caller thread through the registry. No input schema has an author field.
- **No cross-org reads.** Every repository query filters by `org_id` from the resolved chat, never from the client.
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
- Stream: subscribe with `afterSeq` gets exactly the missed messages, then live ones, with no duplicates across a concurrent send; more than 200 missed gives `reset`.
- Read state: `markRead` never moves back; unread counts exclude the reader's own messages.
- Waiting: an agent question in a direct chat adds a row; the owner's reply resolves it; the list stream shows both changes.
- Floor manager: table tests for rules 1 to 5, including a mention of the last speaker, the 6-turn cap, `answer` refused on a second turn, and notices outside runs.
- Judge: shadow mode never changes a decision (property test with a judge that returns random verdicts); timeouts are logged; the import-boundary test passes.
- Budget: `AgentContextBudget.test.ts` passes unchanged.

## Tasks

**CHAT-1. Chat contracts.** What: `kinChat.ts` with ids, `KinOrg`, `KinPerson`, `KinAgent`, `KinChat`, `KinChatMember`, `KinAuthor`, `KinMessage`, `KinWidget`, `KinTaskCardState`, `KinWaitingItem`, stream events, inputs, `KinChatError`, `KIN_CHAT_WS_METHODS`, `KinChatRpcs`, `KIN_CHAT_RPC_SCOPES`, `kinMessageLink`. Hooks in `index.ts` and `rpc.ts`. Files: `packages/contracts/src/kinChat.ts`, test. Depends on: none. Done when: `vp run typecheck` passes and `kinChat.test.ts` round-trips every schema. Owner: backend.

**CHAT-2. Kin migration track and K001.** What: `KinMigrations.ts`, `K001_ChatCore.ts`, `KinPersistence.layer`. Files: `apps/server/src/kin/persistence/*`. Depends on: none. Done when: the migration tests above pass on `layerMemory`. Owner: backend.

**CHAT-3. Repository.** What: `KinChatRepository` for orgs, people, agents, chats, members, messages (seq allocation in a transaction), widgets, read state, waiting. Files: `apps/server/src/kin/chat/KinChatRepository.ts`, test. Depends on: CHAT-1, CHAT-2. Done when: repository tests cover insert, idempotent send, seq under concurrent sends, history paging, and org filtering. Owner: backend.

**CHAT-4. Identity and bootstrap.** What: `KinIdentity` with the phase-1 session rule, default org and owner person created on first start, agent thread registry with an in-memory set for `EnabledWhen`. Files: `apps/server/src/kin/chat/KinIdentity.ts`, test. Depends on: CHAT-3. Done when: first start creates exactly one org and owner; restart keeps them; register, resolve and end of agent threads pass tests. Owner: backend.

**CHAT-5. Chat service and hub.** What: `KinChatService` (createDirect, send, history, markRead, widget upsert and act, addWaiting and resolveWaiting, membership and role checks) and `KinChatHub`. Files: `KinChatService.ts`, `KinChatHub.ts`, `widgets/registry.ts`, tests. Depends on: CHAT-4. Done when: author, isolation, widget, read state and waiting tests pass. Owner: backend.

**CHAT-6. WS RPCs and streams.** What: `makeKinChatHandlers(session)`, both stream handlers with resume, `KinChat.layer`; hooks in `ws.ts`, `RpcAuthorization.ts`, `server.ts`. Files: `apps/server/src/kin/chat/rpcHandlers.ts`, `layer.ts`. Depends on: CHAT-5. Done when: a `ws.test.ts`-style test over a real socket sends, subscribes, resumes with `afterSeq`, and gets `not_found` across orgs; `vp run typecheck` shows no `any` in the handler layer requirements (see Design corrections 6). Owner: backend.

**CHAT-7. Agent MCP tools.** What: `KinChatToolkit` with `kin_chat_post`, `kin_chat_read`, `kin_widget_upsert`; `EnabledWhen` from the registry; hook in `McpHttpServer.ts`. Files: `apps/server/src/kin/mcp/*`. Depends on: CHAT-5. Done when: agent-post tests pass and `AgentContextBudget.test.ts` passes unchanged. Owner: backend.

**CHAT-8. Task cards.** What: `task` state schema, `TaskCardUpdater` following `streamDomainEvents` and `getThreadShell`, startup recheck. Files: `apps/server/src/kin/chat/TaskCardUpdater.ts`, `widgets/taskCard.ts`, tests. Depends on: CHAT-5, CHAT-7. Done when: the task card test passes, and a manual run of `delegate_task` from a lead thread shows the card change state in `kin.chat.subscribe` output. Owner: backend.

**CHAT-9. Floor manager.** What: pure `FloorManager.ts` (rules 1 to 5, replies vs notices), K002 floor tables, grant tokens in `kin_chat_post`, implicit grants in direct chats, notice rate limit. Files: `apps/server/src/kin/floor/FloorManager.ts`, `migrations/K002_Floor.ts`, tests. Depends on: CHAT-7. Done when: floor table tests pass and a direct-chat test shows a second unprompted reply refused with `floor_not_granted` while a notice passes. Owner: backend.

**CHAT-10. Judge in shadow.** What: `Judge` service, `NoopJudge`, `JudgeShadow`, `kin_judge_log`, thresholds, import-boundary test. Files: `apps/server/src/kin/floor/Judge.ts`, `JudgeShadow.ts`, `NoopJudge.ts`, tests. Depends on: CHAT-9. Done when: the judge tests pass and `kin_judge_log` gets one row per human message in a group test. Owner: backend.

**CHAT-11. Groups, members and the `kin:chat` scope** (phase 2). What: `createGroup`, members add, remove, setRole, mute; session bindings; `kin:chat` scope hook in `auth.ts`; move `KIN_CHAT_RPC_SCOPES` to it; owner-only role checks. Files: `KinChatService.ts`, `KinIdentity.ts`, `kinChat.ts`, `auth.ts` hook. Depends on: CHAT-6, and the member sign-in work for DESIGN gap 8 (unowned; see Open questions). Done when: a session holding only `kin:chat` can use every `kin.*` method for its chats and gets `EnvironmentAuthorizationError` on `orchestration.subscribeShell` and `terminal.open`. Owner: backend.

**CHAT-12. Guests, suggest-only** (phase 2). What: guest role, `suggested` status, `kin.suggestions.resolve`, limits and name check copied from `guestShare.ts`, viewer filtering in streams, waiting rows for the owner. Files: `KinChatService.ts`, `rpcHandlers.ts`, tests. Depends on: CHAT-11. Done when: a guest's message is not visible to agents (`kin_chat_read`) or members until the owner sends it, and a fourth waiting suggestion fails `limit`. Owner: backend.

**CHAT-13. Group cards and folding** (phase 2). What: state schemas for `decision`, `poll`, `checklist`, `form`, `date`; server-side tally for polls; decision card on a run that ends in an unresolved objection; `kin.widgets.setPinned`. Files: `apps/server/src/kin/widgets/*`, `KinChatService.ts`, tests. Depends on: CHAT-9. Done when: two members voting in one poll see one shared tally in both streams, and a run closing on an objection posts one decision card awaiting the owner. Owner: backend.

## Design corrections

1. **T3 has no people.** `AuthenticatedSession.subject` is a credential label (`"browser"`, `"one-time-token"`), and every paired device holds environment-wide scopes (`AuthStandardClientScopes` includes terminal and filesystem write). "Server-verified human author" works in phase 1 only because every session is the owner. Members need Kin's own people, session bindings and a narrow `kin:chat` scope. Without that, pairing a member's phone gives them the owner's machine.
2. **Kin can't append to upstream's migration list.** `Migrations.ts` is one numbered sequence, and the migrator skips every id up to the highest recorded one (`assertV2MigrationsCanRun` says so). A Kin migration 81 would collide with upstream's next migration on the next sync. Kin uses its own `kin_sql_migrations` table through `MigratorOptions.table`.
3. **The MCP App bridge is bound to a thread turn item,** not a chat message (`McpAppTarget = { threadId, itemId }`; `ThreadMcpApp` needs `itemId`). Generated widgets in chat must point at the lead thread's tool call, and they work only for the owner's sessions. Showing them to members needs a Kin bridge, decided in phase 2.
4. **Guest sharing can't be reused as chat guests.** It is one browser guest per thread over T3 Connect, for 24 hours, behind the `guestSharingEnabled` beta flag. Kin reuses its suggest-only model, its limits and `PayloadSigner`. `NAME_BREAKING_CHARACTER` isn't exported, so Kin copies it.
5. **Kin's MCP toolkit can't import `toolkitRegistration` from `McpHttpServer.ts`,** because `McpHttpServer.ts` would import it back and `layerTools` is built when the module loads. `McpHttpServer.ts` passes the function in instead.
6. **`ws.ts` is near a TypeScript limit.** Its comment says that near 200 methods the handler layer's requirements degrade to `any`, which is why it splits into two groups. Kin's 12 methods land in `OtherWsRpcGroup`. If typecheck shows the degradation, Kin needs a third group: three more lines in `ws.ts`.
7. **"Each agent may ask to speak" has a cost** the design doesn't mention. Agents only act inside a woken lead session, so every bid is a session. The floor manager decides who is woken; others are offered the floor only within budget.
8. **Rules 3 and 4 would block scheduled posts** in a direct chat (a morning brief after an unanswered deferral notice). The spec splits agent posts into replies, which the rules govern, and notices, which are rate-limited instead.
9. **"Jev from TypeSafe"** could not be checked from this repo. The spec stubs the `Judge` interface only.

## Open questions

- Who owns member sign-in (DESIGN gap 8: invites, accounts, devices, GitHub handles)? CHAT-11 needs it. Proposal: a small `kin-identity` addition to this spec in phase 2.
- Should members see generated widgets in phase 2, and through what bridge?
- Should a member's `kin:chat`-only device open task threads read-only? That needs a narrow thread-read path, or a guest share per thread.
- Mobile connects and subscribes to many upstream streams at start (server config, shell). A `kin:chat`-only session will be refused on those; the mobile spec needs a "chat-only" connection mode.
- Retention and export (10a) for messages: phase 5. Until then nothing is deleted except by the owner.
