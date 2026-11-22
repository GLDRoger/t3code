import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "./layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinEventId,
  KinMemberId,
  KinMemoryItemId,
  KinPersonId,
  type MemoryItemHead,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import type { MemoryItem } from "../memory/MemoryCache.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import { recordingSchedules } from "../triggers/kinSchedules.testkit.ts";
import * as Handoff from "./Handoff.ts";
import * as Team from "../team/KinTeam.ts";
import * as Lead from "./LeadMemory.ts";
import { handlers as leadHandlers } from "./mcp/handlers.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";

// Ambermill: Rhea owns it; Zoya and Dev are teammates in the "Plans" group with the Chief of staff.
const chief = KinAgentId.make("chief");
const threadId = ThreadId.make("chief-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "chief",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: { threadId, providerSessionId: "chief", providerInstanceId },
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

// Memory's git store stands in; the items and staged files are read back below.
const state: { items: ReadonlyArray<MemoryItem>; staged: Array<string> } = {
  items: [],
  staged: [],
};
const pick = (orgId: string, id: string) =>
  Effect.suspend(() => {
    const found = state.items.find((item) => item.head.id === id);
    return found === undefined
      ? Effect.fail(new Memory.MemoryNotFound({ orgId: orgId as never, id }))
      : Effect.succeed(found);
  });
const storage = Layer.mergeAll(
  Layer.mock(Memory.Memory)({
    items: () => Effect.sync(() => state.items),
    readItem: (orgId, id) => pick(orgId, id),
    readItemQuietly: (orgId, id) => pick(orgId, id),
  }),
  Layer.mock(Writer.MemoryWriter)({
    stage: (_org, _wakeup, change) => Effect.sync(() => void state.staged.push(change.content)),
  }),
  recordingSchedules([], []),
  NodeCrypto.layer,
);

// The lead's tools as its thread reaches them: the real gate, handlers and LeadMemory.
const kinServices = Layer.unwrap(
  Effect.gen(function* () {
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    return Layer.mergeAll(
      Handoff.layer,
      Team.layer,
      Lead.layer.pipe(
        Layer.provide(Lead.authority),
        Layer.provide(MemoryCache.layer),
        Layer.provide(storage),
      ),
    ).pipe(Layer.provideMerge(Layer.succeedContext(services)));
  }),
);
const layer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
  KinToolGate.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(kinServices),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
    }),
  ),
  Layer.provideMerge(
    Kin.layer.pipe(
      Layer.provide(kinSecretsTest),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      Layer.provideMerge(environment),
    ),
  ),
  Layer.provideMerge(authorityLayer),
  Layer.provideMerge(kinSecretsTest),
);

/** A tool call exactly as the lead's provider sends it: its JSON answer, or its refusal text. */
const call = Effect.fn("test.call")(function* (name: string, args: Record<string, unknown>) {
  const server = yield* McpServer.McpServer;
  const identity = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinIdentity);
  const result = yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  return { ok: result.isError !== true, text };
});

it.effect(
  "through the agent's tools, a group's reminders and routines are set and stopped by who may",
  () =>
    Effect.andThen(
      TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
      Effect.gen(function* () {
        state.items = [];
        state.staged = [];
        const services = Option.getOrThrow((yield* Kin.KinServer).services);
        const identity = Context.get(services, KinIdentity);
        const chats = Context.get(services, KinChatService);
        const repo = Context.get(services, KinChatRepository);
        const sql = yield* SqlClient.SqlClient;
        yield* pairSession(AuthSessionId.make("owner"));
        const [resolved] = yield* identity.resolve({
          sessionId: AuthSessionId.make("owner"),
          subject: "browser",
          method: "browser-session-cookie",
          scopes: AuthStandardClientScopes,
        });
        const owner = resolved!;
        const { orgId } = owner;
        for (const [id, name] of [
          ["zoya", "Zoya Sheikh"],
          ["dev", "Dev Kulkarni"],
        ] as const)
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
              access, time_zone)
            VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, 'member', 'UTC')`;
        yield* sql`UPDATE kin_people SET display_name = 'Rhea Kapoor', handle = 'rhea'
          WHERE person_id = ${owner.personId}`;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
        yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
        const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
            worker_projects_json, owner_chat_id, domain)
          VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
            'chief-of-staff')`;
        const group = KinChatId.make("plans");
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
          VALUES (${group}, ${orgId}, 'team_group', 'Plans', 0, ${at})`;
        const person = (id: string) =>
          ({ _tag: "person", orgId, personId: KinPersonId.make(id) }) as const;
        for (const [memberId, principal, role] of [
          ["plans-rhea", { _tag: "person", personId: owner.personId }, "owner"],
          ["plans-zoya", { _tag: "person", personId: KinPersonId.make("zoya") }, "member"],
          ["plans-dev", { _tag: "person", personId: KinPersonId.make("dev") }, "member"],
          ["plans-chief", { _tag: "agent", agentId: chief }, "member"],
        ] as const)
          yield* repo.addMember({
            orgId,
            chatId: group,
            memberId: KinMemberId.make(memberId),
            principal,
            role,
            joinedAt: at,
            leftAt: null,
            mutedUntil: null,
          });
        /** Someone writes in the group; the lead wakes on it. Returns the event id. */
        const says = Effect.fn("test.says")(function* (
          who: typeof owner | ReturnType<typeof person>,
          body: string,
        ) {
          const message = yield* chats.send(who, { chatId: group, body, clientMessageId: body });
          return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
        });

        // A teammate asks the group for a reminder: it is set for the group.
        const asked = yield* says(person("zoya"), "remind us Friday at 10 to send the report");
        const set = yield* call("kin_defer", {
          what: "Send the report",
          due: "2026-11-20T10:00:00+00:00",
          onDue: "remind",
          chatId: group,
          sourceEventId: asked,
        });
        assert.isTrue(set.ok, set.text);
        assert.include(state.staged.at(-1), "chat: plans");

        // Her reminder, set earlier in the group; Dev did not ask for it.
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
            received_at, queued_at, state, wakeup_id)
          VALUES ('set-in-plans', ${orgId}, ${chief}, 'chat.message', 'P0',
            ${JSON.stringify({ chatId: group })}, 0, 0, 'done', NULL)`;
        const reminder: MemoryItemHead = {
          id: KinMemoryItemId.make("def-plans"),
          kind: "deferral",
          title: "Send the report",
          status: "open",
          due: "2026-11-20T10:00:00+00:00",
          on_due: "remind",
          recorded_at: at,
          valid_from: at,
          invalid_at: null,
          superseded_by: null,
          review_by: null,
          source: "kin:chat:plans:message:set",
          said_by: "zoya",
          trust: "member",
          links: [],
          chat: group,
          source_event: KinEventId.make("set-in-plans"),
          for_chat: true,
          sensitive: true,
          orgId,
          path: "deferrals/def-plans.md",
        };
        state.items = [{ head: reminder, body: "Send the report\n" }];
        yield* sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due,
            snapshot_json, updated_at)
          VALUES (${orgId}, 'def-plans', 'armed', ${Date.UTC(2026, 10, 20, 10)}, 'remind', '{}', 0)`;
        const cancel = (sourceEventId: string) =>
          call("kin_cancel", { itemId: "def-plans", sourceEventId });
        const refused = yield* cancel(yield* says(person("dev"), "cancel the report reminder"));
        assert.isFalse(refused.ok);
        assert.include(
          refused.text,
          "Only Zoya Sheikh (who asked for it), the owner or a co-owner can change it.",
        );
        const stopped = yield* cancel(yield* says(person("zoya"), "cancel my report reminder"));
        assert.isTrue(stopped.ok, stopped.text);
        assert.include(stopped.text, "stopped");

        // A routine for the group: the owner's own word sets it there; a teammate's does not.
        const routine = (sourceEventId: string) =>
          call("kin_schedule", {
            what: "Post what is open here",
            at: "09:00",
            days: [1],
            chatId: group,
            sourceEventId,
          });
        const owners = yield* routine(
          yield* says(owner, "every Monday at 9 post what's open here"),
        );
        assert.isTrue(owners.ok, owners.text);
        const [saved] = yield* sql<{ chatId: string }>`SELECT chat_id AS "chatId"
          FROM kin_schedules WHERE org_id = ${orgId}`;
        assert.strictEqual(saved?.chatId, group);
        const members = yield* routine(
          yield* says(person("dev"), "every Monday at 9 post what's open here"),
        );
        assert.isFalse(members.ok);
        assert.include(members.text, "Only the owner's own message can set up a scheduled task.");
      }).pipe(Effect.provide(layer)),
    ),
);
