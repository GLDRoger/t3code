import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
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
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import * as Kin from "../layer.ts";
import * as Memory from "../memory/Memory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import { MemoryConfig } from "../memory/MemoryConfig.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Scan from "../memory/secretScan.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import * as Lead from "./LeadMemory.ts";
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
  Layer.provide(
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
    }),
  ),
);
const runtime = Kin.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(environment),
  Layer.provideMerge(authorityLayer),
);
const decodeWrite = Schema.decodeUnknownEffect(Lead.WriteInput);
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
      const git = Effect.fn("LeadMemoryTest.git")((cwd: string, args: ReadonlyArray<string>) =>
        vcs
          .run({
            operation: "test.lead",
            command: "git",
            cwd,
            args: cwd.endsWith(".git") ? [`--git-dir=${cwd}`, ...args] : args,
            allowNonZeroExit: true,
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
      yield* fs.makeDirectory(`${seed}/deferrals`);
      for (const id of ["close-me", "cancel-me", "invalidate-me"]) {
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
      yield* git(seed, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      yield* git(root, ["clone", "--bare", seed, remote]);
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
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
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids) VALUES ('fixture-wakeup', ${orgId}, ${agentId}, ${threadId}, ${run.id}, 'fixture', 1794096000000, 'running', '["fixture-event"]')`;
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
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('fixture-member-membership', ${orgId}, ${chat.chatId}, 'person', 'fixture-member', 'member', '2026-11-08T00:00:00.000Z')`;
      const memberEvent = {
        ...event,
        eventId: "member-event",
        provenance: {
          _tag: "human",
          personId: "fixture-member",
          memberId: "fixture-member-membership",
        },
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id) VALUES ('member-event', ${orgId}, ${agentId}, 'chat.message', 'P0', ${JSON.stringify(memberEvent)}, 0, 0, 'claimed', 'fixture-wakeup')`;
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
      const memoryLayer = Memory.layer.pipe(Layer.provide(recovery));
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
        Layer.provideMerge(memoryLayer),
        Layer.provideMerge(Registry.layer),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(
          Layer.succeed(MemoryConfig, {
            baseDirectory: `${root}/state`,
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
        const visible = Effect.sync(() =>
          server.tools
            .filter(({ annotations }) =>
              Context.getOrUndefined(
                annotations,
                McpSchema.EnabledWhen,
              )?.(client.initializePayload),
            )
            .map(({ tool }) => tool.name),
        );
        assert.sameMembers(
          yield* visible.pipe(Effect.provideService(McpInvocationContext, scope)),
          ["memory_search", "memory_read", "memory_write", "kin_defer", "kin_journal", "kin_end"],
        );
        for (const thread of [
          undefined,
          { ...scope.thread!, subagent: true },
          { ...scope.thread!, threadId: ThreadId.make("ordinary") },
        ]) {
          assert.deepStrictEqual(
            yield* visible.pipe(Effect.provideService(McpInvocationContext, { ...scope, thread })),
            [],
          );
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
          yield* visible.pipe(
            Effect.provideService(McpInvocationContext, {
              ...scope,
              thread: { ...scope.thread!, threadId: workerThread },
            }),
          ),
          [],
        );
        const memory = yield* Memory.Memory;
        yield* memory.prepareWakeup(orgId, "fixture-wakeup");
        yield* memory.prepareWakeup(other, "other-wakeup");
        assert.deepStrictEqual(
          (yield* service.search(scope, { kind: "claim" })).map((item) => item.id),
          ["a-item"],
        );
        assert.strictEqual(
          (yield* service.read(scope, { id: KinMemoryItemId.make("b-item") }).pipe(Effect.flip))
            .reason,
          "not_found",
        );
        const toolRead = yield* server
          .callTool({ name: "memory_read", arguments: { id: "a-item" } })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        assert.isFalse(toolRead.isError);
        assert.include(JSON.stringify(toolRead), "a-item");
        const opened = yield* service.read(scope, { id: KinMemoryItemId.make("a-item") });
        assert.isTrue(opened.reviewOverdue);
        assert.isTrue(opened.misleading);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_memory_reads WHERE org_id = ${orgId} AND item_id = 'a-item'`,
          1,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_memory_reads WHERE org_id = ${orgId} AND item_id = 'b-item'`,
          0,
        );
        const closable = yield* service.read(scope, { id: KinMemoryItemId.make("close-me") });
        const closeInput = yield* decodeWrite({
          op: "update",
          sourceEventId: "fixture-event",
          item: { ...closable.head, body: closable.body, status: "done" },
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
          const item = yield* service.read(scope, { id: KinMemoryItemId.make(id) });
          yield* service.write(
            scope,
            yield* decodeWrite({
              op,
              sourceEventId: "fixture-event",
              item: { ...item.head, body: item.body, status, invalid_at },
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
          },
          sourceEventId: "fixture-event",
        });
        const forged = yield* decodeWrite({
          ...input,
          item: { ...input.item, chat: "other-chat", source_event: "forged-event" },
        });
        assert.strictEqual(
          (yield* service.write(scope, forged).pipe(Effect.flip)).reason,
          "not_allowed",
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
            .pipe(Effect.flip)).reason,
          "not_allowed",
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
        yield* service.write(scope, {
          ...input,
          sourceEventId: "member-event",
          item: { ...input.item, id: KinMemoryItemId.make("member-claim") },
        });
        const deferred = yield* decodeDefer({
          what: "Invented maintenance",
          due: "2026-11-13T09:00:00+05:30",
          onDue: "ask",
          chatId: chat.chatId,
          sourceEventId: "fixture-event",
        });
        const memberDeferral = yield* service.defer(scope, {
          ...deferred,
          what: "Member maintenance",
          sourceEventId: "member-event",
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
        for (const due of ["bad", "2026-02-30", "2026-11-13T09:00:00"])
          assert.strictEqual(
            (yield* decodeDefer({ ...deferred, due }).pipe(Effect.result))._tag,
            "Failure",
          );
        yield* service.journal(scope, {
          saw: ["Invented request"],
          did: ["Wrote memory"],
          skipped: ["No external work"],
        });
        yield* service.end(scope, { summary: "Finished fixture" });
        yield* service.end(scope, { summary: "Finished fixture" });
        assert.strictEqual(
          (yield* service.end(scope, { summary: "Changed" }).pipe(Effect.flip)).reason,
          "not_allowed",
        );
        assert.strictEqual(
          (yield* service.write(scope, input).pipe(Effect.flip)).reason,
          "not_allowed",
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
        assert.include(
          yield* git(remote, ["show", `${committed.commit}:deferrals/${memberDeferral.itemId}.md`]),
          "trust: member",
        );
        assert.include(content, "what: Invented maintenance");
        assert.include(content, "trust: owner");
        assert.include(content, `chat: ${chat.chatId}`);
        assert.include(content, "source_event: fixture-event");
        const memberClaim = yield* git(remote, [
          "show",
          `${committed.commit}:claims/member-claim.md`,
        ]);
        assert.include(memberClaim, "source_event: member-event");
        assert.include(memberClaim, "trust: member");
        assert.include(memberClaim, "said_by: fixture-member");
        assert.notInclude(memberClaim, "forged");
        const journal = yield* git(remote, ["show", `${committed.commit}:journal/2026/11-08.md`]);
        assert.include(journal, "Saw: Invented request");
        assert.include(journal, "Summary: Finished fixture");
        assert.strictEqual(journal.split("Summary: Finished fixture").length, 2);
        const writerService = yield* Writer.MemoryWriter;
        yield* writerService.discard(orgId, "fixture-wakeup");
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'fixture-wakeup'`;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids) SELECT 'restart-wakeup', org_id, agent_id, thread_id, run_id, model, started_at, 'running', event_ids FROM kin_wakeups WHERE wakeup_id = 'fixture-wakeup'`;
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
