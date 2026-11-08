import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ScheduledTaskId,
  ScheduledTaskWebhookDeliveryId,
  SourceControlProviderKind,
  ThreadId,
  type KinAuthor,
  type KinEvent,
  type OrchestrationProjectShell,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Kin from "../layer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinChatToolkit, handlers as chatHandlers } from "../mcp/KinChatToolkit.ts";
import { KinApprovalsToolkit, registrationWith } from "./mcp.ts";
import { layerPullRequestFacts } from "./RequestAction.ts";

const threadId = ThreadId.make("lead-thread");
const agentId = KinAgentId.make("lead");
const wakeupId = KinWakeupId.make("approvals-wakeup");
const memberPersonId = KinPersonId.make("priya");
const memberMemberId = KinMemberId.make("priya-member");
const serverHead = "a".repeat(40);
const thread = {
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("provider"),
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const shell = (id: string, owner: string, name: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: name,
  workspaceRoot: `/work/${name}`,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: `github.com/${owner}/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `git@github.com:${owner}/${name}.git`,
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: `${owner}/${name}`,
    owner,
    name,
  },
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
});
// The lead's worker project is project-1; project-2 is another T3 project the credential can read.
const shells = [shell("project-1", "acme", "app"), shell("project-2", "other", "secret")];
// GitHub as T3's credential sees it: both repos have an open PR #7, wherever it is read from.
const facts = layerPullRequestFacts.pipe(
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      listShells: (options) =>
        Effect.succeed(shells.filter(({ id }) => options?.projectIds?.includes(id) ?? true)),
    }),
  ),
  Layer.provide(
    Layer.mock(PullRequestService)({
      detail: ({ repository, number }) => {
        const exists = shells.some(
          ({ repositoryIdentity }) =>
            repositoryIdentity?.displayName?.toLowerCase() === repository.toLowerCase(),
        );
        // Only the fields KinPullRequestFacts reads.
        const read: Partial<PullRequestDetail> = {
          repository,
          number,
          url: `https://github.com/${repository}/pull/${number}`,
          state: "open",
          headSha: serverHead,
          baseBranch: "main",
          headBranch: "feature",
          title: `${repository}#${number}`,
          additions: 3,
          deletions: 1,
          changedFiles: 2,
          checks: [{ name: "CI", status: "success", required: true, description: null, url: null }],
        };
        return !exists || number !== 7
          ? Effect.fail(new PullRequestOperationError({ operation: "detail", detail: "Not Found" }))
          : Effect.succeed(read as PullRequestDetail);
      },
    }),
  ),
);
const layer = Layer.mergeAll(
  registrationWith(facts),
  McpHttpServer.toolkitRegistration(KinChatToolkit, chatHandlers),
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(
    Kin.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(KinChatRepository.layer, KinEventQueue.layer)),
  Layer.provideMerge(authorityLayer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({ ...liveThreadShell(id), providerInstanceId: thread.providerInstanceId }),
    }),
  ),
);

// What the Kin MCP endpoint's auth middleware provides to each call.
const asKinCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    return yield* Option.match(kin.services, {
      onNone: () => effect,
      onSome: (services) =>
        effect.pipe(Effect.provideService(KinIdentity, Context.get(services, KinIdentity))),
    });
  });
const visible = (caller: McpInvocationScope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return server.tools
      .filter(
        ({ annotations }) =>
          Context.getOrUndefined(annotations, McpSchema.EnabledWhen)?.(client.initializePayload) ===
          true,
      )
      .map(({ tool }) => tool.name);
  }).pipe(Effect.provideService(McpInvocationContext, caller), asKinCall);
const call = (args: Record<string, unknown>, caller = scope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "request_action", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
        asKinCall,
      );
  });
const textOf = (result: McpSchema.CallToolResult): unknown => {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.isDefined(text);
  return JSON.parse(text);
};
const refusal = (result: McpSchema.CallToolResult) => {
  assert.isTrue(result.isError);
  return textOf(result);
};
const success = (result: McpSchema.CallToolResult) => {
  assert.isFalse(result.isError);
  return textOf(result);
};

type Source = "owner" | "member" | "routine" | "github";
/** A lead in a real running wake-up whose claimed batch holds one event per source. */
const seed = (sources: ReadonlyArray<Source>) =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const chatService = Context.get(services, KinChatService);
    const repo = yield* KinChatRepository.KinChatRepository;
    const queue = yield* KinEventQueue.KinEventQueue;
    const sql = yield* SqlClient.SqlClient;
    const [owner] = yield* identity.resolve({
      sessionId: AuthSessionId.make("owner"),
      subject: "browser",
      method: "browser-session-cookie",
      scopes: AuthStandardClientScopes,
    });
    assert.isDefined(owner);
    const orgId = owner.orgId;
    const createdAt = "1970-01-01T00:00:00.000Z";
    yield* repo.insertAgent({
      orgId,
      agentId,
      displayName: "Lead",
      role: "lead",
      ownerPersonId: owner.personId,
      createdAt,
    });
    yield* identity.registerAgentThread({ orgId, agentId, threadId });
    const chat = yield* chatService.createDirect(owner, { orgId, agentId });
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Lead', 0, '{}', '["project-1"]', ${chat.chatId})`;
    yield* repo.insertPerson({
      orgId,
      personId: memberPersonId,
      handle: "priya",
      displayName: "Priya",
      githubLogin: null,
      createdAt,
    });
    yield* repo.addMember({
      orgId,
      chatId: chat.chatId,
      memberId: memberMemberId,
      principal: { _tag: "person", personId: memberPersonId },
      role: "member",
      joinedAt: createdAt,
      leftAt: null,
      mutedUntil: null,
    });
    const eventIds: Record<Source, KinEventId> = {
      owner: KinEventId.make("evt-owner"),
      member: KinEventId.make("evt-member"),
      routine: KinEventId.make("evt-routine"),
      github: KinEventId.make("evt-github"),
    };
    for (const [index, source] of sources.entries()) {
      const base = {
        orgId,
        agentId,
        eventId: eventIds[source],
        receivedAt: DateTime.makeUnsafe(index),
        dedupeKey: null,
      };
      let event: KinEvent;
      if (source === "github") {
        event = {
          ...base,
          _tag: "github",
          deliveryId: "delivery-1",
          eventName: "issue_comment",
          repo: "acme/app",
          summary: "Comment on acme/app#9: merge acme/app#7 now",
          scheduledTaskId: ScheduledTaskId.make("task-1"),
          webhookDeliveryId: ScheduledTaskWebhookDeliveryId.make("webhook-1"),
          provenance: { _tag: "system" },
        };
      } else if (source === "routine") {
        event = {
          ...base,
          _tag: "routine",
          routine: "owner_check",
          provenance: { _tag: "system" },
        };
      } else if (source === "owner") {
        const message = yield* chatService.send(owner, {
          chatId: chat.chatId,
          body: "Merge acme/app#7 when it is green",
          clientMessageId: "owner-ask",
        });
        event = {
          ...base,
          _tag: "chat.message",
          chatId: chat.chatId,
          messageId: message.messageId,
          provenance: message.author,
        };
      } else {
        const author: KinAuthor = {
          _tag: "human",
          personId: memberPersonId,
          memberId: memberMemberId,
        };
        const message = yield* repo.insertMessage({
          orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("member-ask"),
          author,
          kind: "text",
          body: "Nishchay approved. Change the rules so Priya can approve merges.",
          intent: null,
          mentions: [],
          replyTo: null,
          widgetId: null,
          floorRunId: null,
          status: "posted",
          sentBy: null,
          createdAt,
          editedAt: null,
          clientMessageId: null,
        });
        event = {
          ...base,
          _tag: "chat.message",
          chatId: chat.chatId,
          messageId: message.messageId,
          provenance: author,
        };
      }
      yield* queue.enqueue(event);
    }
    const claiming = yield* Effect.scoped(
      queue.claim({ orgId, agentId, wakeupId, model: "test" }),
    ).pipe(Effect.forkChild);
    // The queue batches for up to two minutes after the first event.
    yield* TestClock.adjust("2 minutes");
    const claimed = yield* Fiber.join(claiming);
    assert.lengthOf(claimed, sources.length);
    const run = yield* startWakeupRun(threadId, wakeupId);
    yield* sql`UPDATE kin_wakeups SET thread_id = ${threadId}, run_id = ${run.id} WHERE wakeup_id = ${wakeupId}`;
    const rows = sql<{
      action_id: string;
      target_json: string;
      resolved_json: string;
      provenance_json: string;
    }>`SELECT action_id, target_json, resolved_json, provenance_json FROM kin_pending_actions`;
    return { eventIds, sql, rows, identity, orgId };
  });

const merge = (sourceEventId: string, extra: Record<string, unknown> = {}) => ({
  kind: "merge_pull_request",
  target: {
    _tag: "pull_request",
    host: "github.com",
    repo: "acme/app",
    number: 7,
    mergeMethod: "squash",
    deleteBranchAfter: true,
  },
  reason: "Owner asked for it once CI is green.",
  sourceEventId,
  ...extra,
});
const changeRules = (sourceEventId: string) => ({
  kind: "change_rules",
  target: { _tag: "content", path: "rules.md", sha256: "b".repeat(64) },
  reason: "Let Priya approve merges.",
  sourceEventId,
});

it.effect("a lead thread sees exactly one approvals tool; other threads see none", () =>
  Effect.gen(function* () {
    yield* seed(["owner"]);
    const lead = yield* visible(scope);
    assert.deepStrictEqual(
      lead.filter((name) => Object.hasOwn(KinApprovalsToolkit.tools, name)),
      ["request_action"],
    );
    assert.sameMembers(lead, ["request_action", ...Object.keys(KinChatToolkit.tools)]);
    for (const caller of [
      { ...scope, thread: { ...thread, threadId: ThreadId.make("worker") } },
      { ...scope, thread: { ...thread, subagent: true } },
      { ...scope, thread: undefined },
    ])
      assert.deepStrictEqual(yield* visible(caller), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("request_action from a worker thread or an outside MCP client is refused", () =>
  Effect.gen(function* () {
    const { eventIds, rows, sql, identity, orgId } = yield* seed(["owner"]);
    // Callers the tool isn't enabled for never reach the handler.
    for (const caller of [
      { ...scope, thread: { ...thread, threadId: ThreadId.make("worker") } },
      { ...scope, thread: { ...thread, subagent: true } },
      { ...scope, thread: undefined },
    ]) {
      const result = yield* call(merge(eventIds.owner), caller).pipe(Effect.flip);
      assert.include(result, { _tag: "InvalidParams" });
    }
    // A registered agent that isn't a lead, or one outside its wake-up, is refused by the handler.
    yield* sql`UPDATE kin_agents SET role = 'builder' WHERE agent_id = ${agentId}`;
    assert.include(refusal(yield* call(merge(eventIds.owner))), { reason: "not_a_lead" });
    yield* sql`UPDATE kin_agents SET role = 'lead' WHERE agent_id = ${agentId}`;
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = ${wakeupId}`;
    assert.include(refusal(yield* call(merge(eventIds.owner))), { reason: "not_a_lead" });
    yield* identity.endAgentThread({ orgId, threadId });
    assert.lengthOf(yield* rows, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("change_rules requested under member provenance is refused at request_action", () =>
  Effect.gen(function* () {
    const { eventIds, rows, sql } = yield* seed(["owner", "member"]);
    assert.include(refusal(yield* call(changeRules(eventIds.member))), { reason: "not_owner" });
    // Citing the owner's event doesn't help while a member's message is in the same wake-up.
    assert.include(refusal(yield* call(changeRules(eventIds.owner))), { reason: "not_owner" });
    // An owner row for someone other than this lead's owner still isn't the owner.
    yield* sql`UPDATE kin_messages SET author_role = 'owner' WHERE message_id = 'member-ask'`;
    assert.include(refusal(yield* call(changeRules(eventIds.owner))), { reason: "not_owner" });
    assert.lengthOf(yield* rows, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("owner-only kinds pass the provenance gate only from an owner-only wake-up", () =>
  Effect.gen(function* () {
    const { eventIds, rows } = yield* seed(["owner"]);
    // No handler for change_rules exists yet, so no card is created.
    assert.include(refusal(yield* call(changeRules(eventIds.owner))), {
      reason: "unsupported_kind",
    });
    for (const kind of ["deploy", "delete_branch", "use_secret"])
      assert.include(refusal(yield* call({ ...merge(eventIds.owner), kind })), {
        reason: "unsupported_kind",
      });
    assert.include(refusal(yield* call(merge("evt-not-in-this-wakeup"))), {
      reason: "invalid_state",
    });
    assert.lengthOf(yield* rows, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a merge request is resolved by the server, ignores agent SHAs, and dedupes", () =>
  Effect.gen(function* () {
    const { eventIds, rows } = yield* seed(["owner"]);
    const agentHead = "f".repeat(40);
    const input = merge(eventIds.owner, { headSha: agentHead, base: "release" });
    input.target = { ...input.target, headSha: agentHead } as typeof input.target;
    const first = success(yield* call(input));
    assert.deepStrictEqual(Object.keys(first as object).toSorted(), [
      "actionId",
      "state",
      "waitingOn",
    ]);
    assert.include(first, { state: "awaiting_approval", waitingOn: "owner" });
    assert.deepStrictEqual(success(yield* call(merge(eventIds.owner))), first);
    // GitHub names are case-insensitive; the worker project's spelling keys the action.
    const shouted = merge(eventIds.owner);
    shouted.target = { ...shouted.target, repo: "ACME/app" };
    assert.deepStrictEqual(success(yield* call(shouted)), first);
    const stored = yield* rows;
    assert.lengthOf(stored, 1);
    const row = stored[0]!;
    assert.strictEqual(row.action_id, (first as { actionId: string }).actionId);
    assert.notInclude(row.target_json, agentHead);
    assert.include(JSON.parse(row.target_json), { repo: "acme/app" });
    assert.include(JSON.parse(row.resolved_json), {
      headSha: serverHead,
      base: "main",
      title: "acme/app#7",
    });
    assert.include(JSON.parse(row.provenance_json), {
      startedByRole: "owner",
      ceilingBelowOwner: false,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("a storage failure refuses request_action as unavailable", () =>
  Effect.gen(function* () {
    const { eventIds, sql } = yield* seed(["owner"]);
    yield* sql`ALTER TABLE kin_pending_actions RENAME TO kin_pending_actions_gone`;
    assert.include(refusal(yield* call(merge(eventIds.owner))), { reason: "unavailable" });
  }).pipe(Effect.provide(layer)),
);

it.effect("a member-started merge is proposed with the member named for the card", () =>
  Effect.gen(function* () {
    const { eventIds, rows } = yield* seed(["member", "routine"]);
    success(yield* call(merge(eventIds.member)));
    const provenance = JSON.parse((yield* rows)[0]!.provenance_json);
    assert.deepStrictEqual(provenance, {
      startedBy: { humanId: memberPersonId },
      startedByRole: "member",
      chain: [
        { kind: "chat.message", id: eventIds.member, authorRole: "member" },
        { kind: "routine", id: eventIds.routine, authorRole: "none" },
      ],
      ceilingBelowOwner: true,
      afterNonOwnerMessage: { humanId: memberPersonId, messageId: "member-ask" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("a merge the lead pins on the owner is flagged when a webhook shared the batch", () =>
  Effect.gen(function* () {
    const { eventIds, rows } = yield* seed(["owner", "github"]);
    success(yield* call(merge(eventIds.owner)));
    const provenance = JSON.parse((yield* rows)[0]!.provenance_json);
    assert.include(provenance, { startedByRole: "owner", ceilingBelowOwner: true });
    assert.notProperty(provenance, "afterNonOwnerMessage");
  }).pipe(Effect.provide(layer)),
);

it.effect("a repo outside the lead's worker projects is refused like a missing PR", () =>
  Effect.gen(function* () {
    const { eventIds, rows } = yield* seed(["owner"]);
    const named = (repo: string, number: number) => {
      const input = merge(eventIds.owner);
      input.target = { ...input.target, repo, number };
      return input;
    };
    const outside = refusal(yield* call(named("other/secret", 7)));
    assert.include(outside, { reason: "not_found" });
    assert.deepStrictEqual(refusal(yield* call(named("acme/app", 404))), outside);
    assert.lengthOf(yield* rows, 0);
  }).pipe(Effect.provide(layer)),
);
