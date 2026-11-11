import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "./layer.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinMemoryItemId,
  KinChatId,
  KinWakeupId,
  KinOrgId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import * as Kin from "../layer.ts";
import * as Memory from "../memory/Memory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import { MemoryConfig } from "../memory/MemoryConfig.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Scan from "../memory/secretScan.ts";
import { authorise, fingerprint, storedLabels, visibility } from "../memory/sensitivity.ts";
import * as TriggerService from "../triggers/KinTriggerService.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { KinHandoff } from "./Handoff.ts";
import { SHARED_REFUSAL } from "./Audience.ts";
import * as Lead from "./LeadMemory.ts";
import { KinWorkers } from "./Workers.ts";
import * as KinRepoReads from "../github/KinRepoReads.ts";
import * as Registry from "./KinLeadRegistry.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { handlers } from "./mcp/handlers.ts";

const threadId = ThreadId.make("fixture-lead-thread");
const agentId = KinAgentId.make("fixture-lead");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: { threadId, providerSessionId: "fixture", providerInstanceId },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "fixture", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const registration = McpHttpServer.toolkitRegistration(KinLeadToolkit, handlers).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(Layer.mock(KinWorkers)({})),
  Layer.provide(Layer.mock(KinHandoff)({})),
  Layer.provide(KinRepoReads.notConnectedLayer),
  Layer.provide(
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
    }),
  ),
);
const runtime = Kin.layer.pipe(
  Layer.provide(kinSecretsTest),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(environment),
  Layer.provideMerge(authorityLayer),
);
const decodeWrite = Schema.decodeUnknownEffect(Lead.WriteInput);
/** A read from a turn only the owner reads: the whole item. */
const whole = (read: typeof Lead.ReadResult.Type) => {
  if (!("head" in read)) throw new Error("Expected the whole item");
  return read;
};
const decodeDefer = Schema.decodeUnknownEffect(Lead.DeferInput);

it.live(
  "lead tools isolate organizations, record reads, enforce retries and journal through the git writer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* Vcs.VcsProcess;
      const root = yield* fs.makeTempDirectoryScoped();
      const seed = `${root}/seed`;
      const remote = `${root}/fixture.git`;
      yield* fs.makeDirectory(seed);
      const git = Effect.fn("LeadMemoryTest.git")(
        (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
          vcs
            .run({
              operation: "test.lead",
              command: "git",
              cwd,
              args: cwd.endsWith(".git") ? [`--git-dir=${cwd}`, ...args] : args,
              allowNonZeroExit: true,
              ...(env ? { env } : {}),
            })
            .pipe(
              Effect.map((r) => {
                assert.strictEqual(r.exitCode, 0, r.stderr);
                return r.stdout.trim();
              }),
            ),
      );
      yield* git(seed, ["init", "-b", "main"]);
      yield* fs.writeFileString(`${seed}/rules.md`, "Invented fixture rules\n");
      yield* fs.writeFileString(`${seed}/INDEX.md`, "As of 2026-11-08T00:00:00.000Z\n");
      yield* fs.makeDirectory(`${seed}/claims`);
      yield* fs.writeFileString(
        `${seed}/claims/a.md`,
        fixtureItem({
          id: "a-item",
          kind: "claim",
          due: null,
          review_by: "2000-01-01",
          invalid_at: "2000-01-01",
        }),
      );
      // One thing the team can know and one for the owner alone; `a-item` was never labelled.
      yield* fs.writeFileString(
        `${seed}/claims/team.md`,
        fixtureItem({ id: "team-item", kind: "claim", due: null, sensitive: false }),
      );
      yield* fs.writeFileString(
        `${seed}/claims/private.md`,
        fixtureItem({ id: "private-item", kind: "claim", due: null, sensitive: true }),
      );
      yield* fs.writeFileString(
        `${seed}/claims/spare.md`,
        fixtureItem({ id: "spare-item", kind: "claim", due: null, links: ["spare"] }),
      );
      yield* fs.makeDirectory(`${seed}/deferrals`);
      for (const id of ["close-me", "cancel-me", "invalidate-me", "foreign-me"]) {
        yield* fs.writeFileString(
          `${seed}/deferrals/${id}.md`,
          fixtureItem({
            id,
            chat: "stored-chat",
            what: "Original task",
            source_event: "original-event",
          }),
        );
      }
      yield* git(seed, ["add", "--", "."]);
      // Saved before the owner's message below, so his word in chat may let the team know them.
      const before = "2020-01-01T00:00:00Z";
      yield* git(
        seed,
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "fixture",
        ],
        { GIT_COMMITTER_DATE: before, GIT_AUTHOR_DATE: before },
      );
      yield* git(root, ["clone", "--bare", seed, remote]);
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      yield* pairSession(AuthSessionId.make("owner"));
      const [person] = yield* identity.resolve({
        sessionId: AuthSessionId.make("owner"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      });
      assert.isDefined(person);
      const orgId = person!.orgId;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agentId}, ${orgId}, 'Fixture Lead', 'lead', ${person!.personId}, '2026-11-08T00:00:00.000Z')`;
      const chat = yield* chats.createDirect(person!, { orgId, agentId });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id) VALUES (${agentId}, ${orgId}, 'Fixture Lead', 'L1', 0, ${threadId}, '{}', '[]', ${chat.chatId})`;
      yield* identity.registerAgentThread({ orgId, agentId, threadId });
      const message = yield* chats.send(person!, {
        chatId: chat.chatId,
        body: "Invented request",
        clientMessageId: "fixture",
      });
      const run = yield* startWakeupRun(threadId, "fixture-wakeup");
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience) VALUES ('fixture-wakeup', ${orgId}, ${agentId}, ${threadId}, ${run.id}, 'fixture', 1794096000000, 'running', '["fixture-event"]', 'owner_only')`;
      const event = {
        _tag: "chat.message",
        orgId,
        agentId,
        eventId: "fixture-event",
        receivedAt: "2026-11-08T00:00:00.000Z",
        dedupeKey: null,
        provenance: message.author,
        chatId: chat.chatId,
        messageId: message.messageId,
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id) VALUES ('fixture-event', ${orgId}, ${agentId}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0, 'claimed', 'fixture-wakeup')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('fixture-member', ${orgId}, 'fixture-member', 'Member', '2026-11-08T00:00:00.000Z')`;
      // Gone from the chat until the shared turn below brings them back.
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, left_at) VALUES ('fixture-member-membership', ${orgId}, ${chat.chatId}, 'person', 'fixture-member', 'member', '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
          author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('member-message', ${orgId}, ${chat.chatId}, 99, 'human', 'fixture-member',
          'fixture-member-membership', 'member', 'text', 'Invented teammate note', '[]', 'posted',
          '2026-11-08T00:00:00.000Z')`;
      const memberEvent = {
        ...event,
        eventId: "member-event",
        messageId: "member-message",
        provenance: {
          _tag: "human",
          personId: "fixture-member",
          memberId: "fixture-member-membership",
        },
      };
      // Something other than the owner's message in the same turn, which stays the owner's alone.
      const routineEvent = {
        _tag: "routine",
        orgId,
        agentId,
        eventId: "routine-event",
        receivedAt: "2026-11-08T00:00:00.000Z",
        dedupeKey: null,
        provenance: { _tag: "system" },
        routine: "morning_brief",
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id) VALUES ('routine-event', ${orgId}, ${agentId}, 'routine', 'P2', ${JSON.stringify(routineEvent)}, 0, 0, 'claimed', 'fixture-wakeup')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state) VALUES ('member-event', ${orgId}, ${agentId}, 'chat.message', 'P0', ${JSON.stringify(memberEvent)}, 0, 0, 'queued')`;
      const other = KinOrgId.make("fixture-other");
      yield* sql`INSERT INTO kin_orgs VALUES (${other}, 'Other', '2026-11-08T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('other-chat', ${other}, 'team_group', 0, '2026-11-08T00:00:00.000Z')`;
      // The second repository has a different item, so searches cannot pass by returning an empty set.
      const remoteB = `${root}/other.git`;
      yield* fs.writeFileString(
        `${seed}/claims/a.md`,
        fixtureItem({ id: "b-item", kind: "claim", due: null }),
      );
      yield* git(seed, ["add", "--", "."]);
      yield* git(seed, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "other",
      ]);
      yield* git(root, ["clone", "--bare", seed, remoteB]);
      const notices: string[] = [];
      const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
        notify: (notice) =>
          Effect.sync(() => {
            notices.push(notice.reason);
          }),
      });
      const memoryLayer = Memory.layer.pipe(
        Layer.provide(recovery),
        Layer.provide(
          TriggerService.syncHooksLayer.pipe(
            Layer.provide(TriggerService.layer),
            Layer.provide(KinChatRepository.layer),
          ),
        ),
      );
      // Runs before the lead's cancel reads the item: between its gate and its transaction.
      const beforeRead = { effect: Effect.void as Effect.Effect<void> };
      const hookedMemory = Layer.effect(
        Memory.Memory,
        Effect.gen(function* () {
          const memory = yield* Memory.Memory;
          return Memory.Memory.of({
            ...memory,
            readItemQuietly: (...args) =>
              Effect.suspend(() => beforeRead.effect).pipe(
                Effect.andThen(memory.readItemQuietly(...args)),
              ),
          });
        }),
      ).pipe(Layer.provideMerge(memoryLayer));
      const writer = Writer.layer.pipe(
        Layer.provideMerge(Lead.authority),
        Layer.provide(Cache.layer),
        Layer.provide(Scan.layer),
        Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
        Layer.provide(recovery),
      );
      const toolkit = registration.pipe(
        Layer.provideMerge(Lead.layer),
        Layer.provideMerge(writer),
        Layer.provideMerge(hookedMemory),
        Layer.provideMerge(Registry.layer),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(
          Layer.succeed(MemoryConfig, {
            baseDirectory: `${root}/state`,
            directMainPush: true,
            repositories: [
              { orgId, path: "a", repoUrl: remote },
              { orgId: other, path: "b", repoUrl: remoteB },
            ],
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Lead.LeadMemory;
        const registry = yield* Registry.KinLeadRegistry;
        yield* registry.register(threadId, {
          orgId,
          agentId,
          wakeupId: KinWakeupId.make("fixture-wakeup"),
          level: "L1",
        });
        const server = yield* McpServer.McpServer;
        // Replace the fiber context with only what the /kin/mcp endpoint provides when tools/list runs.
        const visible = (invocation: McpInvocationScope) =>
          Effect.sync(() =>
            server.tools
              .filter(({ annotations }) =>
                Context.getOrUndefined(
                  annotations,
                  McpSchema.EnabledWhen,
                )?.(client.initializePayload),
              )
              .map(({ tool }) => tool.name),
          ).pipe(
            Effect.updateContext((_: Context.Context<never>) =>
              Context.make(McpInvocationContext, invocation).pipe(
                Context.add(KinIdentity, identity),
              ),
            ),
          );
        assert.sameMembers(yield* visible(scope), [
          "kin_delegate",
          "kin_follow_up",
          "kin_worker_stop",
          "kin_leads",
          "kin_hand_off",
          "kin_ask",
          "kin_react",
          "memory_search",
          "memory_read",
          "memory_write",
          "memory_label",
          "kin_defer",
          "kin_schedule",
          "kin_cancel",
          "kin_journal",
          "kin_github_repos",
          "kin_github_prs",
          "kin_github_pr",
          "kin_github_runs",
          "kin_end",
        ]);
        for (const thread of [
          undefined,
          { ...scope.thread!, subagent: true },
          { ...scope.thread!, threadId: ThreadId.make("ordinary") },
        ]) {
          assert.deepStrictEqual(yield* visible({ ...scope, thread }), []);
          assert.strictEqual(
            (yield* service.search({ ...scope, thread }, {}).pipe(Effect.flip)).reason,
            "not_allowed",
          );
        }
        const workerThread = ThreadId.make("registered-worker");
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('worker', ${orgId}, 'Worker', 'builder', ${person!.personId}, '2026-11-08T00:00:00.000Z')`;
        yield* identity.registerAgentThread({
          orgId,
          agentId: KinAgentId.make("worker"),
          threadId: workerThread,
        });
        assert.deepStrictEqual(
          yield* visible({ ...scope, thread: { ...scope.thread!, threadId: workerThread } }),
          [],
        );
        const memory = yield* Memory.Memory;
        yield* memory.prepareWakeup(orgId, "fixture-wakeup");
        yield* memory.prepareWakeup(other, "other-wakeup");
        // The owner let the team know `team-item` before this test, so a stored row says so.
        const teamItem = yield* memory.readItemQuietly(orgId, KinMemoryItemId.make("team-item"));
        yield* authorise(orgId, "team-item", fingerprint(teamItem), "owner_setting");
        const claims = service
          .search(scope, { kind: "claim" })
          .pipe(Effect.map((items) => items.map((item) => item.id).toSorted()));
        assert.deepStrictEqual(yield* claims, [
          "a-item",
          "private-item",
          "spare-item",
          "team-item",
        ]);
        assert.strictEqual(
          (yield* service.read(scope, { id: KinMemoryItemId.make("b-item") }).pipe(Effect.flip))
            .reason,
          "not_found",
        );
        const toolRead = yield* server
          .callTool({ name: "memory_read", arguments: { id: "a-item" } })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(KinIdentity, identity),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        assert.isFalse(toolRead.isError);
        assert.include(JSON.stringify(toolRead), "a-item");
        const opened = yield* service.read(scope, { id: KinMemoryItemId.make("a-item") });
        assert.isTrue("head" in opened && opened.reviewOverdue);
        assert.isTrue("head" in opened && opened.misleading);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_memory_reads WHERE org_id = ${orgId} AND item_id = 'a-item'`,
          1,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_memory_reads WHERE org_id = ${orgId} AND item_id = 'b-item'`,
          0,
        );
        const closable = whole(
          yield* service.read(scope, { id: KinMemoryItemId.make("close-me") }),
        );
        const closeInput = yield* decodeWrite({
          op: "update",
          sourceEventId: "fixture-event",
          item: { ...closable.head, body: closable.body, status: "done", sensitive: true },
        });
        for (const changed of [
          { what: "Forged task" },
          { on_due: "ask" as const },
          { chat: KinChatId.make("foreign-chat") },
        ]) {
          assert.strictEqual(
            (yield* service
              .write(scope, {
                ...closeInput,
                item: { ...closeInput.item, ...changed },
              })
              .pipe(Effect.flip)).reason,
            "not_allowed",
          );
        }
        yield* service.write(scope, closeInput);
        for (const [id, op, status, invalid_at] of [
          ["cancel-me", "update", "cancelled", null],
          ["invalidate-me", "invalidate", "open", "2026-11-08T00:00:00.000Z"],
        ] as const) {
          const item = whole(yield* service.read(scope, { id: KinMemoryItemId.make(id) }));
          yield* service.write(
            scope,
            yield* decodeWrite({
              op,
              sourceEventId: "fixture-event",
              item: { ...item.head, body: item.body, status, invalid_at, sensitive: true },
            }),
          );
        }
        const input = yield* decodeWrite({
          op: "create",
          item: {
            id: "new-claim",
            kind: "claim",
            title: "Invented claim",
            body: "Invented body",
            status: "open",
            due: null,
            recorded_at: "2026-11-08T00:00:00.000Z",
            valid_from: "2026-11-08T00:00:00.000Z",
            invalid_at: null,
            superseded_by: null,
            source: "forged",
            said_by: "forged",
            trust: "owner",
            links: [],
            sensitive: false,
          },
          sourceEventId: "fixture-event",
        });
        const forged = yield* decodeWrite({
          ...input,
          item: { ...input.item, chat: "other-chat", source_event: "forged-event" },
        });
        assert.strictEqual(
          (yield* service.write(scope, forged).pipe(Effect.flip)).message,
          "Only deferrals carry `chat`. Leave it out.",
        );
        assert.notProperty(forged.item, "source_event");
        assert.strictEqual(
          (yield* service
            .write(scope, {
              ...input,
              item: {
                ...input.item,
                id: KinMemoryItemId.make("forged-deferral"),
                kind: "deferral",
              },
            })
            .pipe(Effect.flip)).message,
          "Use kin_defer to write deferrals.",
        );
        assert.deepStrictEqual(yield* service.write(scope, input), { itemId: "new-claim" });
        assert.deepStrictEqual(yield* service.write(scope, input), { itemId: "new-claim" });
        assert.strictEqual(
          (yield* service
            .write(scope, { ...input, item: { ...input.item, body: "Different" } })
            .pipe(Effect.flip)).message,
          "Memory item new-claim was already written differently in this wake-up. Repeat the same call, or use a new id.",
        );
        assert.strictEqual(
          (yield* service
            .write(scope, {
              ...input,
              op: "update",
              item: { ...input.item, id: KinMemoryItemId.make("b-item") },
            })
            .pipe(Effect.flip)).reason,
          "not_found",
        );
        assert.strictEqual(
          (yield* service
            .write(scope, { ...input, sourceEventId: "foreign-event" })
            .pipe(Effect.flip)).reason,
          "not_found",
        );
        assert.strictEqual(
          (yield* service.write(scope, { ...input, op: "update" }).pipe(Effect.flip)).reason,
          "not_found",
        );
        const { body, ...fields } = input.item;
        assert.deepStrictEqual(
          yield* service.write(scope, {
            sourceEventId: input.sourceEventId,
            item: { body, ...fields },
            op: input.op,
          }),
          { itemId: "new-claim" },
        );
        const deferred = yield* decodeDefer({
          what: "Invented maintenance",
          due: "2026-11-13T09:00:00+05:30",
          onDue: "ask",
          chatId: chat.chatId,
          sourceEventId: "fixture-event",
        });
        const first = yield* service.defer(scope, deferred);
        assert.deepStrictEqual(yield* service.defer(scope, deferred), first);
        assert.deepStrictEqual(
          yield* service.defer(scope, { ...deferred, itemId: first.itemId }),
          first,
        );
        const second = yield* service.defer(scope, { ...deferred, what: "Another invented task" });
        assert.notStrictEqual(second.itemId, first.itemId);
        assert.strictEqual(
          (yield* service
            .defer(scope, { ...deferred, itemId: first.itemId, what: "Different" })
            .pipe(Effect.flip)).reason,
          "not_allowed",
        );
        assert.strictEqual(
          (yield* service
            .defer(scope, { ...deferred, chatId: KinChatId.make("other-chat") })
            .pipe(Effect.flip)).reason,
          "not_found",
        );
        for (const due of ["bad", "2026-02-30", "2026-11-13T09:00:00", "1969-12-31", "0000-01-01"])
          assert.strictEqual(
            (yield* decodeDefer({ ...deferred, due }).pipe(Effect.result))._tag,
            "Failure",
          );
        const scheduleInput = {
          what: "Summarise the open PRs",
          at: "08:00",
          days: [5, 1, 1],
          chatId: chat.chatId,
          sourceEventId: "fixture-event",
        } as const;
        // A teammate's message in the batch makes the turn shared: no notes, reminders or
        // scheduled tasks, even cited from the owner's own message in the same batch.
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'fixture-member-membership'`;
        yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'fixture-wakeup' WHERE event_id = 'member-event'`;
        const ownersRefused = Effect.gen(function* () {
          for (const refused of [
            service.defer(scope, { ...deferred, what: "Member maintenance" }),
            service.defer(scope, {
              ...deferred,
              what: "Member maintenance",
              sourceEventId: "member-event",
            }),
            service.schedule(scope, scheduleInput),
            service.cancel(scope, { itemId: first.itemId, sourceEventId: "fixture-event" }),
            service
              .label(scope, {
                itemIds: [KinMemoryItemId.make("private-item")],
                sensitive: false,
                sourceEventId: "fixture-event",
              })
              .pipe(Effect.asVoid),
            service
              .label(scope, {
                itemIds: [KinMemoryItemId.make("team-item")],
                sensitive: true,
                sourceEventId: "fixture-event",
              })
              .pipe(Effect.asVoid),
          ])
            assert.strictEqual((yield* refused.pipe(Effect.flip)).message, SHARED_REFUSAL);
        });
        // Of memory it sees only what the team can know: what is the owner's alone, and what
        // nobody has labelled, is not in the results, not counted, and reads as not found.
        const teamReads = Effect.gen(function* () {
          yield* ownersRefused;
          assert.deepStrictEqual(yield* claims, ["team-item"]);
          assert.lengthOf(yield* service.search(scope, { kind: "claim", limit: 1 }), 1);
          for (const id of ["private-item", "a-item"])
            assert.strictEqual(
              (yield* service.read(scope, { id: KinMemoryItemId.make(id) }).pipe(Effect.flip))
                .reason,
              "not_found",
            );
          // Only its shared projection: no path, provenance or other front matter.
          const teamRead = yield* service.read(scope, { id: KinMemoryItemId.make("team-item") });
          assert.isFalse("head" in teamRead);
          assert.strictEqual("item" in teamRead ? teamRead.item.id : undefined, "team-item");
          assert.notInclude(JSON.stringify(teamRead), "claims/team.md");
        });
        yield* teamReads;
        const sharedRead = yield* server
          .callTool({ name: "memory_read", arguments: { id: "a-item" } })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(KinIdentity, identity),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        assert.isTrue(sharedRead.isError);
        assert.notInclude(JSON.stringify(sharedRead), "Invented");
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_memory_reads WHERE org_id = ${orgId} AND item_id = 'private-item'`,
          0,
        );
        // The teammate leaving, and its message leaving the batch, doesn't make it owner-only.
        yield* sql`UPDATE kin_chat_members SET left_at = '2026-11-08T00:00:00.000Z' WHERE member_id = 'fixture-member-membership'`;
        yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL WHERE event_id = 'member-event'`;
        yield* teamReads;
        // A turn a join aborted reads and writes nothing at all.
        yield* sql`UPDATE kin_wakeups SET shared_since = NULL, aborted_at = 1 WHERE wakeup_id = 'fixture-wakeup'`;
        yield* ownersRefused;
        for (const refused of [
          service.search(scope, { kind: "claim" }),
          service.read(scope, { id: KinMemoryItemId.make("team-item") }),
          service.write(scope, input),
          service.journal(scope, { saw: ["Invented teammate request"], did: [] }),
        ])
          assert.strictEqual((yield* refused.pipe(Effect.flip)).message, SHARED_REFUSAL);
        // Go on as a turn the owner alone reads from the start.
        yield* sql`UPDATE kin_wakeups SET aborted_at = NULL WHERE wakeup_id = 'fixture-wakeup'`;
        assert.deepStrictEqual(yield* claims, [
          "a-item",
          "private-item",
          "spare-item",
          "team-item",
        ]);
        // The server labels money and access sensitive whatever the lead said, and never stores
        // an actual secret.
        const noted = (id: string, body: string) => ({
          ...input,
          item: { ...input.item, id: KinMemoryItemId.make(id), title: `Invented ${id}`, body },
        });
        yield* service.write(scope, noted("amount-claim", "Invented retainer is $4,000 a month"));
        yield* service.write(
          scope,
          noted("vault-claim", "The deploy key is in the vault under invented/deploy"),
        );
        yield* service.write(scope, noted("status-claim", "Invented launch is on track"));
        // Not the owner's word: written from a routine, "the team can know it" is only a
        // suggestion the owner is asked about, and the team doesn't know it meanwhile.
        yield* service.write(scope, {
          ...noted("routine-claim", "Invented routine finding"),
          sourceEventId: "routine-event",
        });

        const secret = yield* service
          .write(scope, noted("secret-claim", `The deploy token is ghp_${"a1B2".repeat(9)}`))
          .pipe(Effect.flip);
        assert.include(secret.message, "Save where it is kept instead");
        // Letting the team know something is the owner's call: only their own message does it.
        const share = {
          itemIds: [KinMemoryItemId.make("private-item")],
          sensitive: false,
          sourceEventId: "routine-event",
        };
        assert.include(
          (yield* service.label(scope, share).pipe(Effect.flip)).message,
          "Only the owner's own message",
        );
        assert.strictEqual(
          (yield* service
            .label(scope, {
              ...share,
              itemIds: [KinMemoryItemId.make("spare-item"), KinMemoryItemId.make("no-such-item")],
              sourceEventId: "fixture-event",
            })
            .pipe(Effect.flip)).reason,
          "not_found",
        );
        // "Yes, the team can know those": several at once, by the owner's own message, each
        // waiting for his yes in Memory.
        assert.deepStrictEqual(
          yield* service.label(scope, {
            ...share,
            itemIds: [KinMemoryItemId.make("private-item"), KinMemoryItemId.make("spare-item")],
            sourceEventId: "fixture-event",
          }),
          {
            itemIds: [KinMemoryItemId.make("private-item"), KinMemoryItemId.make("spare-item")],
            note: Lead.AWAITING_OWNER,
          },
        );
        assert.deepStrictEqual(
          yield* sql`SELECT item_id, shared_content IS NULL AS unshared,
              suggested_content IS NOT NULL AS suggested
            FROM kin_memory_labels WHERE org_id = ${orgId}
              AND item_id IN ('private-item', 'spare-item') ORDER BY item_id`,
          [
            { item_id: "private-item", unshared: 1, suggested: 1 },
            { item_id: "spare-item", unshared: 1, suggested: 1 },
          ],
        );
        // Keeping something back needs no such message, and holds before the turn commits.
        yield* service.label(scope, {
          itemIds: [KinMemoryItemId.make("team-item")],
          sensitive: true,
          sourceEventId: "routine-event",
        });
        assert.deepStrictEqual(
          yield* sql`SELECT item_id FROM kin_memory_labels WHERE org_id = ${orgId} AND held_at IS NOT NULL`,
          [{ item_id: "team-item" }],
        );
        const scheduled = yield* service.schedule(scope, scheduleInput);
        yield* service.journal(scope, {
          saw: ["Invented request"],
          did: ["Wrote memory"],
          skipped: ["No external work"],
        });
        // The reply bridge owns owed replies now, so ending before any post is allowed.
        yield* service.end(scope, { summary: "Finished fixture" });
        yield* service.end(scope, { summary: "Finished fixture" });
        assert.strictEqual(
          (yield* service.end(scope, { summary: "Changed" }).pipe(Effect.flip)).reason,
          "not_allowed",
        );
        // After kin_end the refusal is about authority, so it stays unexplained.
        assert.strictEqual(
          (yield* service.write(scope, input).pipe(Effect.flip)).message,
          "Lead operation is not allowed.",
        );
        const committed = yield* (yield* Writer.MemoryWriter).commitWakeup(
          orgId,
          "fixture-wakeup",
          "completed",
        );
        const closed = yield* git(remote, ["show", `${committed.commit}:deferrals/close-me.md`]);
        assert.include(closed, "status: done");
        assert.include(closed, "source_event: original-event");
        assert.include(closed, "chat: stored-chat");
        assert.include(closed, "what: Original task");
        assert.include(
          yield* git(remote, ["show", `${committed.commit}:deferrals/cancel-me.md`]),
          "status: cancelled",
        );
        assert.include(
          yield* git(remote, ["show", `${committed.commit}:deferrals/invalidate-me.md`]),
          "invalid_at: 2026-11-08T00:00:00.000Z",
        );
        const files = yield* git(remote, ["ls-tree", "-r", "--name-only", committed.commit]);
        assert.include(files, `deferrals/${first.itemId}.md`);
        const content = yield* git(remote, [
          "show",
          `${committed.commit}:deferrals/${first.itemId}.md`,
        ]);
        assert.include(content, "what: Invented maintenance");
        assert.include(content, "trust: owner");
        assert.include(content, `chat: ${chat.chatId}`);
        assert.include(content, "source_event: fixture-event");
        const task = yield* git(remote, [
          "show",
          `${committed.commit}:deferrals/${scheduled.itemId}.md`,
        ]);
        assert.include(task, "what: Summarise the open PRs");
        assert.match(task, /every:\n\s+at: "?08:00"?\n\s+days:\n\s+- 1\n\s+- 5\n/);
        assert.include(task, "trust: owner");
        assert.include(task, "source_event: fixture-event");
        assert.isTrue(task.trimEnd().endsWith("Invented request"));
        const saved = (id: string) => git(remote, ["show", `${committed.commit}:claims/${id}.md`]);
        assert.include(yield* saved("amount-claim"), "sensitive: true");
        assert.include(yield* saved("vault-claim"), "sensitive: true");
        assert.include(yield* saved("status-claim"), "sensitive: false");
        assert.notInclude(files, "claims/secret-claim.md");
        assert.include(
          yield* git(remote, ["show", `${committed.commit}:claims/team.md`]),
          "sensitive: true",
        );
        const shared = yield* git(remote, ["show", `${committed.commit}:claims/private.md`]);
        assert.include(shared, "sensitive: false");
        assert.match(shared, new RegExp(`shared_by:\\n\\s+person: ${person!.personId}\\n\\s+at: `));
        const journal = yield* git(remote, ["show", `${committed.commit}:journal/2026/11-08.md`]);
        assert.include(journal, "Saw: Invented request");
        assert.include(journal, "Summary: Finished fixture");
        assert.strictEqual(journal.split("Summary: Finished fixture").length, 2);
        const writerService = yield* Writer.MemoryWriter;
        yield* writerService.discard(orgId, "fixture-wakeup");
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience) SELECT 'restart-wakeup', org_id, agent_id, thread_id, run_id, model, started_at, 'running', event_ids, audience FROM kin_wakeups WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`UPDATE kin_events SET wakeup_id = 'restart-wakeup' WHERE wakeup_id = 'fixture-wakeup'`;
        yield* writerService.stage(orgId, "restart-wakeup", {
          path: "claims/lost-claim.md",
          content: fixtureItem({ id: "lost-claim", kind: "claim", due: null }),
          sourceEventId: "fixture-event",
        });
        yield* writerService.appendJournal(orgId, "restart-wakeup", ["Summary: Lost summary"]);
        yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES (${orgId}, 'restart-wakeup', 'end', 'fixture-hash')`;
        yield* writerService.discard(orgId, "restart-wakeup");
        const recovered = yield* writerService.commitWakeup(orgId, "restart-wakeup", "failed");
        assert.notInclude(
          yield* git(remote, ["ls-tree", "-r", "--name-only", recovered.commit]),
          "lost-claim",
        );
        assert.isTrue(notices.some((notice) => notice.includes("lost on restart")));
        assert.include(
          yield* git(remote, ["show", `${recovered.commit}:journal/2026/11-08.md`]),
          "lost on restart",
        );
        assert.notInclude(
          yield* git(remoteB, ["ls-tree", "-r", "--name-only", "main"]),
          "new-claim",
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`ALTER TABLE kin_events RENAME TO kin_events_saved`;
            const unavailable = yield* (yield* Writer.MemoryWriterAuthority)
              .resolve(orgId, "restart-wakeup")
              .pipe(Effect.flip);
            assert.strictEqual(unavailable._tag, "PersistenceSqlError");
            yield* sql`ALTER TABLE kin_events_saved RENAME TO kin_events`;
          }),
        );

        // In a chat at L0 the lead writes and reads its shadow branch, and its deferral arms from
        // there. The owner's DM works at L2 from creation, so the owner lowered it here.
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'restart-wakeup'`;
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt:fixture-wakeup"),
          threadId,
          runId: run.id,
        });
        const shadowRun = yield* startWakeupRun(threadId, "shadow-wakeup");
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience) SELECT 'shadow-wakeup', org_id, agent_id, thread_id, ${shadowRun.id}, model, started_at, 'running', event_ids, audience FROM kin_wakeups WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`UPDATE kin_events SET wakeup_id = 'shadow-wakeup' WHERE wakeup_id = 'restart-wakeup'`;
        yield* sql`UPDATE kin_leads SET level = 'L0' WHERE agent_id = ${agentId}`;
        yield* sql`INSERT INTO kin_chat_levels (org_id, agent_id, chat_id, level, level_since) VALUES (${orgId}, ${agentId}, ${chat.chatId}, 'L0', 0)`;
        const reminder = yield* service.defer(scope, {
          ...deferred,
          what: "Invented stretch",
          due: "2026-11-09T21:39:12+05:30",
          onDue: "remind",
        });
        const shadowCommit = yield* writerService.commitWakeup(orgId, "shadow-wakeup", "completed");
        const shadow = `kin/shadow/${agentId}`;
        assert.strictEqual(yield* git(remote, ["rev-parse", shadow]), shadowCommit.commit);
        assert.notInclude(
          yield* git(remote, ["ls-tree", "-r", "--name-only", "main"]),
          reminder.itemId,
        );
        const openDeferrals = (status: "open" | "done") =>
          service
            .search(scope, { kind: "deferral", status })
            .pipe(Effect.map((items) => items.map((item) => item.id)));
        assert.include(yield* openDeferrals("open"), reminder.itemId);
        assert.strictEqual(
          whole(yield* service.read(scope, { id: reminder.itemId })).head.title,
          "Invented stretch",
        );
        const armed = () =>
          sql<{ nextRunAt: number | null }>`SELECT next_run_at AS "nextRunAt" FROM kin_triggers
            WHERE org_id = ${orgId} AND trigger_id = ${`deferral:${reminder.itemId}:due`}`;
        assert.deepStrictEqual(yield* armed(), [{ nextRunAt: Date.parse("2026-11-09T16:09:12Z") }]);
        // Back at the DM's L2 the same L0 lead reads the default branch; the reminder stays armed
        // until Keep or Start clean.
        yield* sql`DELETE FROM kin_chat_levels WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
        assert.notInclude(yield* openDeferrals("open"), reminder.itemId);
        assert.deepStrictEqual(yield* armed(), [{ nextRunAt: Date.parse("2026-11-09T16:09:12Z") }]);

        // The lead that set a reminder replaces it at once; another lead's item is refused.
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'shadow-wakeup'`;
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt:shadow-wakeup"),
          threadId,
          runId: shadowRun.id,
        });
        const cancelRun = yield* startWakeupRun(threadId, "cancel-wakeup");
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience) SELECT 'cancel-wakeup', org_id, agent_id, thread_id, ${cancelRun.id}, model, started_at, 'running', event_ids, audience FROM kin_wakeups WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`UPDATE kin_events SET wakeup_id = 'cancel-wakeup' WHERE wakeup_id = 'shadow-wakeup'`;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('other-lead', ${orgId}, 'Other Lead', 'lead', ${person!.personId}, '2026-11-08T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id) VALUES ('other-lead', ${orgId}, 'Other Lead', 'L2', 0, 'other-lead-thread', '{}', '[]', ${chat.chatId})`;
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state) VALUES ('original-event', ${orgId}, 'other-lead', 'chat.message', 'P0', ${JSON.stringify({ ...event, eventId: "original-event", agentId: "other-lead" })}, 0, 0, 'done')`;
        const foreign = yield* service
          .cancel(scope, {
            itemId: KinMemoryItemId.make("foreign-me"),
            sourceEventId: "fixture-event",
          })
          .pipe(Effect.flip);
        assert.strictEqual(foreign.reason, "not_allowed");
        assert.include(foreign.message, "Only the lead that set it up");
        const foreignTrigger = yield* sql<{ enabled: number }>`SELECT enabled FROM kin_triggers
          WHERE org_id = ${orgId} AND trigger_id = 'deferral:foreign-me:due'`;
        assert.deepStrictEqual(foreignTrigger, [{ enabled: 1 }]);
        const corrected = yield* decodeDefer({
          ...deferred,
          what: "Invented stretch, corrected",
          due: "2026-11-09T21:40:12+05:30",
          onDue: "remind",
          replaces: reminder.itemId,
        });
        // A join that aborts the turn after its gate still stops the replace inside its write.
        beforeRead.effect = sql`UPDATE kin_wakeups SET aborted_at = 1, shared_since = 1
          WHERE wakeup_id = 'cancel-wakeup'`.pipe(Effect.orDie, Effect.asVoid);
        assert.strictEqual(
          (yield* service.defer(scope, corrected).pipe(Effect.flip)).message,
          SHARED_REFUSAL,
        );
        assert.deepStrictEqual(yield* armed(), [{ nextRunAt: Date.parse("2026-11-09T16:09:12Z") }]);
        beforeRead.effect = Effect.void;
        yield* sql`UPDATE kin_wakeups SET aborted_at = NULL, shared_since = NULL
          WHERE wakeup_id = 'cancel-wakeup'`;
        const replacement = yield* service.defer(scope, corrected);
        assert.deepStrictEqual(yield* service.defer(scope, corrected), replacement);
        // Stopped before the commit, so the wrong time can't fire meanwhile.
        assert.deepStrictEqual(yield* armed(), [{ nextRunAt: null }]);
        const stopped = yield* sql<{ state: string }>`SELECT state FROM kin_deferral_runs
          WHERE org_id = ${orgId} AND item_id = ${reminder.itemId}`;
        assert.deepStrictEqual(stopped, [{ state: "undone" }]);
        // Cancelling it again is the same staged change, not a conflict.
        yield* service.cancel(scope, { itemId: reminder.itemId, sourceEventId: "fixture-event" });
        const cancelCommit = yield* writerService.commitWakeup(orgId, "cancel-wakeup", "completed");
        assert.include(
          yield* git(remote, ["show", `${cancelCommit.commit}:deferrals/${reminder.itemId}.md`]),
          "status: cancelled",
        );
        assert.deepStrictEqual(yield* armed(), [{ nextRunAt: null }]);
        const next = yield* sql<{ nextRunAt: number | null }>`SELECT next_run_at AS "nextRunAt"
          FROM kin_triggers WHERE org_id = ${orgId}
            AND trigger_id = ${`deferral:${replacement.itemId}:due`}`;
        assert.deepStrictEqual(next, [{ nextRunAt: Date.parse("2026-11-09T16:10:12Z") }]);

        // A turn a teammate reads from its start: what someone says there is saved as their
        // claim for the team, and nothing of the owner's is its to change.
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'cancel-wakeup'`;
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt:cancel-wakeup"),
          threadId,
          runId: cancelRun.id,
        });
        const teamRun = yield* startWakeupRun(threadId, "team-wakeup");
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience) SELECT 'team-wakeup', org_id, agent_id, thread_id, ${teamRun.id}, model, started_at, 'running', event_ids, 'shared' FROM kin_wakeups WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`UPDATE kin_events SET wakeup_id = 'team-wakeup' WHERE wakeup_id = 'cancel-wakeup'`;
        yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'team-wakeup' WHERE event_id = 'member-event'`;
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'fixture-member-membership'`;
        // The owner kept one back in the turn above; what he said the team could know in chat,
        // and the routine's suggestion, wait for his yes in Memory.
        assert.deepStrictEqual(yield* claims, ["new-claim", "status-claim"]);
        for (const id of ["routine-claim", "private-item", "spare-item"])
          assert.strictEqual(
            visibility(
              yield* memory.readItemQuietly(orgId, KinMemoryItemId.make(id)),
              yield* storedLabels(orgId),
            ),
            "suggested",
          );
        const said = {
          ...input,
          sourceEventId: "member-event",
          item: {
            ...input.item,
            id: KinMemoryItemId.make("member-claim"),
            title: "Invented launch date",
            body: "Invented: the launch moved a week",
          },
        };
        const refusal = (attempt: ReturnType<typeof service.write>) =>
          attempt.pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        for (const [attempt, why] of [
          // Nothing for the owner alone is saved from here, by the lead's word or the server's.
          [{ ...said, item: { ...said.item, sensitive: true } }, "for the owner alone"],
          [
            { ...said, item: { ...said.item, body: "Invented client pays ₹40,000 a month" } },
            "for the owner alone",
          ],
          // Only a claim, attributed to the person whose message it cites.
          [{ ...said, item: { ...said.item, kind: "decision" } }, "as a claim"],
          [{ ...said, sourceEventId: "routine-event" }, "the person who said it"],
          // An owner-turn item it can see is not its to change.
          [
            {
              ...said,
              op: "update",
              item: { ...said.item, id: KinMemoryItemId.make("new-claim") },
            },
            "saved from this same chat",
          ],
        ] as const)
          assert.include(yield* refusal(service.write(scope, attempt)), why);
        // What it can't see, by id or by a link it shares, refuses exactly like a missing item
        // or anything else not saved from here: no id, title or count of what is there.
        const ordinary = yield* refusal(
          service.write(scope, { ...said, item: { ...said.item, sensitive: true } }),
        );
        for (const attempt of [
          {
            ...said,
            op: "invalidate",
            item: { ...said.item, id: KinMemoryItemId.make("team-item") },
          },
          {
            ...said,
            op: "update",
            item: { ...said.item, id: KinMemoryItemId.make("no-such-claim") },
          },
          { ...said, item: { ...said.item, id: KinMemoryItemId.make("a-item") } },
          {
            ...said,
            item: { ...said.item, id: KinMemoryItemId.make("linked-claim"), links: ["issue #12"] },
          },
        ] as const) {
          const message = yield* refusal(service.write(scope, attempt));
          assert.strictEqual(message, ordinary);
          for (const hidden of ["a-item", "team-item", "Invented service maintenance"])
            assert.notInclude(message, hidden);
        }
        // A teammate's messages cause at most so much to be saved a day, counted from stored rows.
        const now = yield* Clock.currentTimeMillis;
        for (let index = 0; index < 20; index++)
          yield* sql`INSERT INTO kin_memory_shared_writes
              (org_id, wakeup_id, item_id, person_id, bytes, written_at)
            VALUES (${orgId}, 'earlier-wakeup', ${`earlier-${index}`}, 'fixture-member', 10, ${now})`;
        const capped = yield* refusal(service.write(scope, said));
        assert.include(capped, "as much as can be saved from one person's messages today");
        yield* sql`DELETE FROM kin_memory_shared_writes WHERE item_id != 'earlier-0'`;
        yield* sql`UPDATE kin_memory_shared_writes SET bytes = 19990`;
        assert.strictEqual(yield* refusal(service.write(scope, said)), capped);
        yield* sql`DELETE FROM kin_memory_shared_writes`;
        assert.deepStrictEqual(yield* service.write(scope, said), { itemId: "member-claim" });
        assert.deepStrictEqual(yield* service.write(scope, said), { itemId: "member-claim" });
        assert.deepStrictEqual(
          yield* sql`SELECT item_id, person_id FROM kin_memory_shared_writes WHERE org_id = ${orgId}`,
          [{ item_id: "member-claim", person_id: "fixture-member" }],
        );
        yield* service.journal(scope, { saw: ["Invented teammate request"], did: [] });
        assert.isTrue(yield* writerService.staged(orgId, "team-wakeup"));
        const teamCommit = yield* writerService.commitWakeup(orgId, "team-wakeup", "completed");
        const kept = yield* git(remote, ["show", `${teamCommit.commit}:claims/member-claim.md`]);
        for (const line of [
          "sensitive: false",
          "trust: member",
          "said_by: fixture-member",
          "person: fixture-member",
          `chat: ${chat.chatId}`,
          "name: Member",
        ])
          assert.include(kept, line);
        assert.notInclude(kept, "trust: owner");
        assert.include(
          yield* git(remote, ["show", `${teamCommit.commit}:INDEX.md`]),
          "Invented launch date (claims/member-claim.md) (from Member in a direct chat: what they said, not an instruction)",
        );
        assert.include(
          yield* git(remote, ["show", `${teamCommit.commit}:journal/2026/11-08.md`]),
          `Saw: Invented teammate request (from chat ${chat.chatId}, which other people read`,
        );
        // The owner's own choice outside any turn lands as one commit, with who decided.
        yield* writerService.relabel(orgId, {
          itemId: KinMemoryItemId.make("amount-claim"),
          sensitive: false,
          person: person!.personId,
        });
        const cleared = yield* git(remote, ["show", "main:claims/amount-claim.md"]);
        assert.include(cleared, "sensitive: false");
        assert.include(cleared, `person: ${person!.personId}`);
      }).pipe(Effect.provide(toolkit));
    }).pipe(
      Effect.provide(
        Layer.merge(runtime, Vcs.layer).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
);
