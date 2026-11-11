// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import { deletePendingAttachment } from "../../assets/AttachmentUpload.ts";
import {
  recordTestUploadOwner,
  TEST_UPLOAD_OWNER,
  testUploadOwner,
  withoutOwnerRecords,
} from "../../assets/AttachmentUpload.testkit.ts";
import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as AttachmentStore from "./KinAttachmentStore.ts";
import { authorizeAttachmentRead } from "./attachmentAccess.ts";
import { environment } from "./TaskCard.testkit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { CommandId } from "@t3tools/contracts";
import { startWakeupRun, authorityLayer, startAgentWakeup } from "./WakeupAuthority.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthKinChatScope,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinMessagesSendInput,
  KinOrgId,
  KinPersonId,
  type KinReactionEmoji,
  KinTaskCardState,
  KinWaitingId,
  KinWakeupId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Hub from "./KinChatHub.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Identity from "./KinIdentity.ts";
import * as Service from "./KinChatService.ts";
import * as Presence from "../reply/KinPresence.ts";

const decodeKinOrgId = Schema.decodeSync(KinOrgId);
const decodeKinPersonId = Schema.decodeSync(KinPersonId);
const decodeKinWaitingId = Schema.decodeSync(KinWaitingId);
const decodeKinChatId = Schema.decodeSync(KinChatId);
const decodeKinMemberId = Schema.decodeSync(KinMemberId);
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeTask = Schema.decodeUnknownEffect(KinTaskCardState);
const decodeSend = Schema.decodeUnknownEffect(KinMessagesSendInput);
const database = authorityLayer;
const repositories = Layer.provideMerge(Repository.layer, database);
const dependencies = Layer.provideMerge(Hub.layer, repositories);
const layer = Layer.provideMerge(Service.layer, dependencies).pipe(Layer.provideMerge(environment));
const attachmentLayer = Layer.provideMerge(
  Service.layer,
  Layer.provideMerge(
    AttachmentStore.layer.pipe(
      Layer.provideMerge(DocumentText.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-kin-attachments-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    dependencies,
  ),
).pipe(Layer.provideMerge(environment));
// Two claims of one upload both reach its size check before either goes on, as racing sends can.
const pendingStatsMeet = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const arrived = yield* Ref.make(0);
    const both = yield* Deferred.make<void>();
    return {
      ...fileSystem,
      stat: (path: string) =>
        NodePath.basename(path).startsWith("pending-")
          ? Ref.updateAndGet(arrived, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 2 ? Deferred.succeed(both, undefined) : Effect.void,
              ),
              Effect.andThen(Deferred.await(both)),
              Effect.andThen(fileSystem.stat(path)),
            )
          : fileSystem.stat(path),
    };
  }),
);
const racingAttachmentLayer = Layer.provideMerge(
  Service.layer,
  Layer.provideMerge(
    AttachmentStore.layer.pipe(
      Layer.provide(pendingStatsMeet),
      Layer.provideMerge(DocumentText.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-kin-race-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    dependencies,
  ),
).pipe(Layer.provideMerge(environment));
// A one-pixel PNG is not needed: the store checks size and name, never pixels.
const PHOTO_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const uploadPhoto = Effect.fn("test.uploadPhoto")(function* (
  name: string,
  owner = TEST_UPLOAD_OWNER,
) {
  const config = yield* ServerConfig.ServerConfig;
  const id = createPendingAttachmentId();
  NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${id}.png`), PHOTO_BYTES);
  recordTestUploadOwner(config.attachmentsDir, id, owner);
  return {
    type: "image" as const,
    id,
    name,
    mimeType: "image/png",
    sizeBytes: PHOTO_BYTES.byteLength,
  };
});
const storedFiles = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return withoutOwnerRecords(NodeFS.readdirSync(config.attachmentsDir)).toSorted();
});
const presenceLayer = Layer.provideMerge(
  Service.layer,
  Layer.provideMerge(Presence.layer, dependencies),
).pipe(Layer.provideMerge(environment));
const clearLayer = Layer.provideMerge(
  Service.layer,
  Layer.provideMerge(
    AttachmentStore.layer.pipe(
      Layer.provideMerge(DocumentText.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-kin-clear-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.provideMerge(Presence.layer, dependencies),
  ),
).pipe(Layer.provideMerge(environment));
/** Row counts of every Kin table, to show what an operation touched and what it left alone. */
const kinRowCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'kin_%' ORDER BY name`;
  const counts: Record<string, number> = {};
  for (const { name } of tables)
    counts[name] = (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(name)}`)[0]!.n;
  return counts;
});
const identityLayer = Identity.KinIdentity.layer.pipe(
  Layer.provide(
    Layer.succeed(Identity.KinIdentityConfig, {
      orgName: "Kin",
      ownerHandle: "owner",
      ownerDisplayName: "Owner",
    }),
  ),
);
const session: AuthenticatedSession = {
  sessionId: Schema.decodeSync(AuthSessionId)("session"),
  subject: "browser",
  method: "browser-session-cookie",
  scopes: AuthStandardClientScopes,
};
const agentId = Schema.decodeSync(KinAgentId)("lead");
const threadId = decodeThreadId("lead-thread");
const caller: McpInvocationScope = {
  environmentId: Schema.decodeSync(EnvironmentId)("environment"),
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: Schema.decodeSync(ProviderInstanceId)("provider"),
  },
};
const timestamp = "1970-01-01T00:00:00.000Z";
const state = Schema.decodeSync(KinTaskCardState)({
  taskId: "worker",
  environmentId: "environment",
  threadId: decodeThreadId("worker"),
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: timestamp,
});
const seed = Effect.fn("test.seed")(function* (notice = false) {
  const repo = yield* Repository.KinChatRepository;
  const service = yield* Service.KinChatService;
  const identity = yield* Identity.KinIdentity.pipe(Effect.provide(identityLayer));
  yield* pairSession(session.sessionId);
  const [person] = yield* identity.resolve(session);
  assert.isDefined(person);
  yield* repo.insertAgent({
    orgId: person.orgId,
    agentId,
    ownerPersonId: person.personId,
    displayName: "Lead",
    role: "lead",
    createdAt: timestamp,
  });
  yield* identity.registerAgentThread({ orgId: person.orgId, agentId, threadId });
  const chat = yield* service.createDirect(person, { orgId: person.orgId, agentId });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${person.orgId}, 'Lead', 0, '{}', '[]', ${chat.chatId})`;
  const prompt = notice
    ? undefined
    : yield* service.send(person, {
        chatId: chat.chatId,
        body: "Owner question",
        clientMessageId: "seed-human",
      });
  yield* startAgentWakeup({
    orgId: person.orgId,
    agentId,
    threadId,
    ...(prompt === undefined ? {} : { message: prompt }),
  });
  yield* startWakeupRun(state.threadId!, "worker");
  const agent = yield* identity.resolveAgent(caller);
  return { repo, service, identity, person, agent, chat };
});

describe("KinChatService", () => {
  it.effect("keeps a person's uploads with the message and takes them from nobody else", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const photo = yield* uploadPhoto("whiteboard.png");
      const send = {
        chatId: chat.chatId,
        body: "",
        clientMessageId: "photo",
        attachments: [photo],
        uploader: TEST_UPLOAD_OWNER,
      };
      const message = yield* service.send(person, send);
      const [stored] = message.attachments ?? [];
      assert.deepStrictEqual(message.attachments, [{ ...photo, id: stored!.id }]);
      assert.match(stored!.id, /^kin-chat-/);
      assert.deepStrictEqual(yield* storedFiles, [`${stored!.id}.png`]);
      assert.deepStrictEqual(
        yield* sql`SELECT chat_id, message_id FROM kin_message_attachments WHERE attachment_id = ${stored!.id}`,
        [{ chat_id: chat.chatId, message_id: message.messageId }],
      );
      // A resend after a lost reply finds the message; the upload it named is already gone.
      assert.deepStrictEqual(yield* service.send(person, send), message);
      assert.deepStrictEqual(
        (yield* service.history(person, {
          chatId: chat.chatId,
          beforeSeq: message.seq + 1,
          limit: 1,
        })).messages[0]?.attachments,
        message.attachments,
      );

      const refusals = [
        // A file some message already holds is never attached again, here or in another chat.
        [person, { ...send, clientMessageId: "again", attachments: [stored!] }, "invalid_state"],
        [agent, { ...send, clientMessageId: "agent", intent: "answer" as const }, "invalid_state"],
        [person, { ...send, clientMessageId: "empty", attachments: [] }, "invalid_state"],
      ] as const;
      for (const [sender, input, reason] of refusals)
        assert.include(yield* service.send(sender, input).pipe(Effect.flip), { reason });

      const outsider = { ...person, personId: decodeKinPersonId("outsider") };
      yield* repo.insertPerson({
        ...outsider,
        handle: "outsider",
        displayName: "Outsider",
        githubLogin: null,
        createdAt: timestamp,
      });
      const theirs = yield* uploadPhoto("theirs.png");
      assert.include(
        yield* service
          .send(outsider, { ...send, clientMessageId: "outsider", attachments: [theirs] })
          .pipe(Effect.flip),
        { reason: "not_found" },
      );
      // Nothing of the outsider's was copied into the chat's keeping.
      assert.deepStrictEqual(
        yield* storedFiles,
        [`${theirs.id}.png`, `${stored!.id}.png`].toSorted(),
      );
    }).pipe(Effect.provide(attachmentLayer)),
  );

  it.effect("claims and deletes only the sender's own uploads", () =>
    Effect.gen(function* () {
      const { repo, service, identity, person, chat } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const memberId = KinPersonId.make("suraj");
      const memberSession = {
        ...session,
        sessionId: AuthSessionId.make("member-session"),
        scopes: [AuthKinChatScope],
      };
      yield* repo.insertPerson({
        orgId: person.orgId,
        personId: memberId,
        handle: "suraj",
        displayName: "Suraj",
        githubLogin: null,
        createdAt: timestamp,
      });
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at) VALUES (${memberSession.sessionId}, ${person.orgId}, ${memberId}, 0)`;
      const members = yield* identity.resolve(memberSession);
      yield* repo.insertAgent({
        orgId: person.orgId,
        agentId: KinAgentId.make("suraj-lead"),
        ownerPersonId: memberId,
        displayName: "Suraj lead",
        role: "lead",
        createdAt: timestamp,
      });
      const own = yield* service.createDirect(members, {
        orgId: person.orgId,
        agentId: KinAgentId.make("suraj-lead"),
      });
      const ownersUpload = yield* uploadPhoto("owner.png", testUploadOwner(session.sessionId));
      const membersOwner = testUploadOwner(memberSession.sessionId);
      assert.include(
        yield* service
          .send(members, {
            chatId: own.chatId,
            body: "",
            clientMessageId: "taken",
            attachments: [ownersUpload],
            uploader: membersOwner,
          })
          .pipe(Effect.flip),
        { reason: "invalid_state" },
      );
      yield* deletePendingAttachment(ownersUpload.id, membersOwner);
      assert.deepStrictEqual(yield* storedFiles, [`${ownersUpload.id}.png`]);
      const kept = yield* service.send(person, {
        chatId: chat.chatId,
        body: "",
        clientMessageId: "kept",
        attachments: [ownersUpload],
        uploader: testUploadOwner(session.sessionId),
      });
      assert.match(kept.attachments![0]!.id, /^kin-chat-/);
    }).pipe(Effect.provide(attachmentLayer)),
  );

  it.effect("lands one upload in at most one message when two sends race for it", () =>
    Effect.gen(function* () {
      const { service, person, chat } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const upload = yield* uploadPhoto("race.png");
      const send = (clientMessageId: string) =>
        service.send(person, {
          chatId: chat.chatId,
          body: "",
          clientMessageId,
          attachments: [upload],
          uploader: TEST_UPLOAD_OWNER,
        });
      const results = yield* Effect.forEach(
        ["first", "second"],
        (clientMessageId) => Effect.result(send(clientMessageId)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
      const rows = yield* sql<{
        attachment_id: string;
      }>`SELECT attachment_id FROM kin_message_attachments`;
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(yield* storedFiles, [`${rows[0]!.attachment_id}.png`]);
    }).pipe(Effect.provide(racingAttachmentLayer)),
  );

  it.effect("hands a stored file only to people in its chat", () =>
    Effect.gen(function* () {
      const { repo, service, identity, person, chat } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const memberId = KinPersonId.make("suraj");
      const memberSession = {
        ...session,
        sessionId: AuthSessionId.make("member-session"),
        scopes: [AuthKinChatScope],
      };
      yield* repo.insertPerson({
        orgId: person.orgId,
        personId: memberId,
        handle: "suraj",
        displayName: "Suraj",
        githubLogin: null,
        createdAt: timestamp,
      });
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at) VALUES (${memberSession.sessionId}, ${person.orgId}, ${memberId}, 0)`;
      const members = yield* identity.resolve(memberSession);
      const ownAgent = KinAgentId.make("suraj-lead");
      yield* repo.insertAgent({
        orgId: person.orgId,
        agentId: ownAgent,
        ownerPersonId: memberId,
        displayName: "Suraj lead",
        role: "lead",
        createdAt: timestamp,
      });
      const own = yield* service.createDirect(members, { orgId: person.orgId, agentId: ownAgent });
      const send = { body: "", clientMessageId: "photo", uploader: TEST_UPLOAD_OWNER };
      const ownersFile = (yield* service.send(person, {
        ...send,
        chatId: chat.chatId,
        attachments: [yield* uploadPhoto("owner.png")],
      })).attachments![0]!.id;
      const membersMessage = yield* service.send(members, {
        ...send,
        chatId: own.chatId,
        attachments: [yield* uploadPhoto("member.png")],
      });
      const membersFile = membersMessage.attachments![0]!.id;
      const pending = (yield* uploadPhoto("pending.png")).id;

      const kin = Option.some(
        Context.make(Identity.KinIdentity, identity).pipe(
          Context.add(Service.KinChatService, service),
        ),
      );
      const read = (reader: AuthenticatedSession, attachmentId: string, host = kin) =>
        authorizeAttachmentRead(reader, { _tag: "attachment", attachmentId }, host).pipe(
          Effect.as("served"),
          Effect.catchTags({ AssetAttachmentNotFoundError: () => Effect.succeed("refused") }),
        );
      // The same file under the names a path or a case-blind disk would still resolve.
      const aliases = (id: string) => [
        id,
        id.toUpperCase(),
        `./${id}`,
        `/${id}`,
        `x/../${id}`,
        id.replace("kin", "\u212Ain"),
      ];
      const cases = [
        [session, [ownersFile], "served"],
        [memberSession, [membersFile], "served"],
        // The teammate reaches nothing of the owner's chat, by any name for it.
        [memberSession, aliases(ownersFile), "refused"],
        // Holding every other scope does not put the owner in the teammate's chat.
        [session, aliases(membersFile), "refused"],
        // A Kin id no message holds, and an upload no message has claimed.
        [session, ["kin-chat-00000000-0000-4000-8000-000000000000"], "refused"],
        [memberSession, ["kin-chat-00000000-0000-4000-8000-000000000000", pending], "refused"],
        // Thread attachments stay with sessions that may read threads.
        [session, [pending], "served"],
      ] as const;
      for (const [reader, ids, expected] of cases)
        for (const id of ids) assert.strictEqual(yield* read(reader, id), expected, id);
      assert.strictEqual(yield* read(session, ownersFile, Option.none()), "refused");

      yield* sql`UPDATE kin_chat_members SET left_at = ${timestamp} WHERE chat_id = ${own.chatId} AND person_id = ${memberId}`;
      assert.strictEqual(yield* read(memberSession, membersFile), "refused");

      // Added to a group later, they get its files from their join on, never one from before.
      const group = KinChatId.make("files-group");
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
        VALUES (${group}, ${person.orgId}, 'team_group', 'Files', 0, ${timestamp})`;
      const joinGroup = (id: string, personId: KinPersonId, role: "owner" | "member") =>
        repo.addMember({
          orgId: person.orgId,
          chatId: group,
          memberId: KinMemberId.make(id),
          principal: { _tag: "person", personId },
          role,
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
      yield* joinGroup("files-owner", person.personId, "owner");
      const groupFile = (name: string) =>
        Effect.gen(function* () {
          const sent = yield* service.send(person, {
            ...send,
            clientMessageId: name,
            chatId: group,
            attachments: [yield* uploadPhoto(name)],
          });
          return sent.attachments![0]!.id;
        });
      const before = yield* groupFile("before.png");
      yield* joinGroup("files-suraj", memberId, "member");
      const after = yield* groupFile("after.png");
      assert.strictEqual(yield* read(memberSession, before), "refused");
      assert.strictEqual(yield* read(memberSession, after), "served");
      assert.strictEqual(yield* read(session, before), "served");
    }).pipe(Effect.provide(attachmentLayer)),
  );

  it.effect("a lead reads another person's direct chat only on a turn that person woke", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const mateId = KinPersonId.make("mate");
      yield* repo.insertPerson({
        orgId: person.orgId,
        personId: mateId,
        handle: "mate",
        displayName: "Mate",
        githubLogin: null,
        createdAt: timestamp,
      });
      const mate = { _tag: "person", orgId: person.orgId, personId: mateId } as const;
      const lead = { orgId: person.orgId, agentId };
      // Not hers to start until the owner allows it.
      assert.include(yield* service.createDirect(mate, lead).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
        VALUES (${person.orgId}, ${agentId}, ${mateId}, ${person.personId}, 0)`;
      const theirs = yield* service.createDirect(mate, lead);
      // Someone besides the owner reads it from the start, so it is shared from its first seq.
      assert.deepStrictEqual(
        yield* sql`SELECT chat_id, shared_at IS NOT NULL AS shared, shared_from_seq FROM kin_chats
          WHERE chat_id IN (${theirs.chatId}, ${chat.chatId}) ORDER BY chat_id = ${chat.chatId}`,
        [
          { chat_id: theirs.chatId, shared: 1, shared_from_seq: 1 },
          { chat_id: chat.chatId, shared: 0, shared_from_seq: null },
        ],
      );
      const said = yield* service.send(mate, {
        chatId: theirs.chatId,
        body: "Between us",
        clientMessageId: "mate-1",
      });
      // The running turn answers the owner, who is not in that chat: it reads its own, not hers.
      assert.lengthOf(yield* service.read(agent, { chatId: chat.chatId }), 1);
      assert.include(yield* service.read(agent, { chatId: theirs.chatId }).pipe(Effect.flip), {
        reason: "not_found",
      });
      assert.include(
        yield* service
          .history(person, { chatId: theirs.chatId, beforeSeq: 99, limit: 10 })
          .pipe(Effect.flip),
        { reason: "not_found" },
      );
      // Her message wakes the lead: that turn reads her chat.
      yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId, message: said });
      assert.deepStrictEqual(
        (yield* service.read(agent, { chatId: theirs.chatId })).map((message) => message.body),
        ["Between us"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bound chat-only members can use their own chats but not the owner's chat", () =>
    Effect.gen(function* () {
      const { repo, service, identity, person, chat } = yield* seed();
      const memberId = KinPersonId.make("suraj");
      const memberSession = {
        ...session,
        sessionId: AuthSessionId.make("member-session"),
        scopes: [AuthKinChatScope],
      };
      yield* repo.insertPerson({
        orgId: person.orgId,
        personId: memberId,
        handle: "suraj",
        displayName: "Suraj",
        githubLogin: null,
        createdAt: timestamp,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at) VALUES (${memberSession.sessionId}, ${person.orgId}, ${memberId}, 0)`;
      const members = yield* identity.resolve(memberSession);
      const me = members[0]!;
      const ownAgent = KinAgentId.make("suraj-lead");
      yield* repo.insertAgent({
        orgId: person.orgId,
        agentId: ownAgent,
        ownerPersonId: memberId,
        displayName: "Suraj lead",
        role: "lead",
        createdAt: timestamp,
      });
      const own = yield* service.createDirect(members, { orgId: person.orgId, agentId: ownAgent });
      const sent = yield* service.send(members, {
        chatId: own.chatId,
        body: "Hello",
        clientMessageId: "member-send",
      });
      assert.equal(sent.author._tag, "human");
      yield* service.history(members, { chatId: own.chatId, beforeSeq: 100, limit: 50 });
      yield* service.markRead(members, { chatId: own.chatId, seq: sent.seq });
      yield* service.mute(members, { chatId: own.chatId, muted: true });
      yield* service
        .subscribe(members, { chatId: own.chatId })
        .pipe(Stream.take(1), Stream.runDrain);
      yield* service.subscribeChats(members, {}).pipe(Stream.take(1), Stream.runDrain);
      assert.equal((yield* service.orgs(members)).me[0]!.personId, me.personId);
      // A teammate sees only the agents they own, may message, or share a chat with.
      const seen = Effect.map(service.orgs(members), (result) =>
        result.orgs[0]!.agents.map((agent) => agent.agentId),
      );
      assert.deepStrictEqual(yield* seen, [ownAgent]);
      yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
        VALUES (${person.orgId}, ${agentId}, ${memberId}, ${person.personId}, 0)`;
      assert.deepStrictEqual(yield* seen, [agentId, ownAgent]);
      yield* sql`UPDATE kin_lead_access SET revoked_at = 1 WHERE person_id = ${memberId}`;
      assert.deepStrictEqual(yield* seen, [ownAgent]);
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('shared-group', ${person.orgId}, 'team_group', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES ('suraj-in-group', ${person.orgId}, 'shared-group', 'person', ${memberId}, NULL, 'member', ${timestamp}),
          ('lead-in-group', ${person.orgId}, 'shared-group', 'agent', NULL, ${agentId}, 'member', ${timestamp})`;
      assert.deepStrictEqual(yield* seen, [agentId, ownAgent]);
      assert.include(
        yield* service
          .history(members, { chatId: chat.chatId, beforeSeq: 100, limit: 50 })
          .pipe(Effect.flip),
        {
          reason: "not_found",
        },
      );
      assert.include(
        yield* service
          .send(members, { chatId: chat.chatId, body: "Hostile", clientMessageId: "hostile" })
          .pipe(Effect.flip),
        { reason: "not_found" },
      );
      assert.include(
        yield* service
          .subscribe(members, { chatId: chat.chatId })
          .pipe(Stream.runDrain, Effect.flip),
        { reason: "not_found" },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "creates exactly two members, derives authors from identity, and deduplicates sends",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const retries = yield* Effect.all(
          Array.from({ length: 5 }, () =>
            service.createDirect(person, { orgId: person.orgId, agentId }),
          ),
          { concurrency: "unbounded" },
        );
        assert.isTrue(retries.every((row) => row.chatId === chat.chatId));
        const members = yield* repo.listMembers(chat);
        assert.strictEqual(members.length, 2);
        assert.deepStrictEqual(members.map((row) => row.role).sort(), ["member", "owner"]);
        const forged = yield* decodeSend({
          chatId: chat.chatId,
          clientMessageId: "first",
          body: "Hello",
          author: { _tag: "system" },
          authorRole: "owner",
          status: "posted",
        });
        const mixedPerson = { ...person, agentId };
        const first = yield* service.send(mixedPerson, forged);
        assert.strictEqual(first.author._tag, "human");
        assert.include(first.author, { personId: person.personId });
        assert.strictEqual(first.authorRole, "owner");
        assert.strictEqual(first.intent, null);
        assert.deepStrictEqual(yield* service.send(person, forged), first);
        for (const changed of [
          { body: "Changed retry" },
          { mentions: members.map((row) => row.memberId) },
          { replyTo: first.messageId },
        ])
          assert.include(yield* Effect.flip(service.send(person, { ...forged, ...changed })), {
            reason: "not_allowed",
          });
        const agentMember = members.find((row) => row.principal._tag === "agent");
        assert.isDefined(agentMember);
        const mixedAgent = { ...agent, personId: person.personId };
        const posted = yield* service.send(mixedAgent, {
          chatId: chat.chatId,
          clientMessageId: "first",
          body: "Evidence",
          intent: "answer",
        });
        assert.deepStrictEqual(posted.author, {
          _tag: "agent",
          agentId,
          ownerPersonId: person.personId,
          threadId,
          memberId: agentMember.memberId,
        });
        assert.include(
          yield* Effect.flip(
            service.send(agent, {
              chatId: chat.chatId,
              clientMessageId: "first",
              body: "Evidence",
              intent: "evidence",
            }),
          ),
          { reason: "not_allowed" },
        );
        assert.strictEqual(posted.authorRole, "member");
        assert.strictEqual(posted.seq, 3);
        const resumed = decodeThreadId("new-thread");
        yield* repo.registerAgentThread({
          orgId: agent.orgId,
          agentId,
          threadId: resumed,
          startedAt: timestamp,
          endedAt: null,
        });
        assert.include(
          yield* Effect.flip(
            service.send(
              { ...agent, threadId: resumed },
              { chatId: chat.chatId, clientMessageId: "first", body: "Retry", intent: "evidence" },
            ),
          ),
          { reason: "not_allowed" },
        );
        for (const operation of [
          service.send(agent, { chatId: chat.chatId, clientMessageId: "no-intent", body: "Hello" }),
          service.send(person, {
            chatId: chat.chatId,
            clientMessageId: "human-intent",
            body: "Hello",
            intent: "decision",
          }),
          service.send(person, { chatId: chat.chatId, clientMessageId: "blank", body: " " }),
        ])
          assert.include(yield* Effect.flip(operation), { reason: "invalid_state" });
        const { clientMessageId: _postedId, ...postedForPerson } = posted;
        assert.deepStrictEqual(
          (yield* service.history(person, { chatId: chat.chatId, beforeSeq: 4, limit: 1 }))
            .messages,
          [postedForPerson],
        );
        const widget = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("end-service-wakeup"),
          threadId,
          runId: run.id,
        });
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              type: "task",
              state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              revision: widget.revision,
              type: "task",
              state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "settles a choice card on its first tap and refuses stale, foreign and expired taps",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const ask = {
          chatId: chat.chatId,
          clientMessageId: "ask-1",
          question: "Ship today?",
          options: [
            { label: "Ship it", kind: "yes" as const },
            { label: "Wait", kind: "no" as const },
          ],
        };
        const card = yield* service.ask(agent, ask);
        assert.deepStrictEqual(card.awaiting, [person.personId]);
        assert.deepStrictEqual(yield* service.ask(agent, ask), card);
        const later = yield* service.ask(agent, { ...ask, clientMessageId: "ask-2" });
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: card.widgetId,
              revision: 1,
              type: "choice",
              state: card.state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        const tap = (clientActionId: string, revision = 1, widgetId = card.widgetId) => ({
          widgetId,
          revision,
          actionId: "choose",
          value: "option-1",
          clientActionId,
        });
        const outsider = { ...person, personId: decodeKinPersonId("outsider") };
        yield* repo.insertPerson({
          ...outsider,
          handle: "outsider",
          displayName: "Outsider",
          githubLogin: null,
          createdAt: timestamp,
        });
        assert.include(yield* service.act(outsider, tap("outsider")).pipe(Effect.flip), {
          reason: "not_found",
        });
        yield* repo.addMember({
          ...chat,
          memberId: decodeKinMemberId("late-member"),
          principal: { _tag: "person", personId: outsider.personId },
          role: "member",
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
        // Joined after the card was posted: it is not theirs to read, let alone answer.
        assert.include(yield* service.act(outsider, tap("member")).pipe(Effect.flip), {
          reason: "not_found",
        });
        assert.include(
          yield* service.act(person, { ...tap("bad"), value: "option-9" }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );

        const message = yield* service.act(person, tap("tap-1"));
        assert.include(JSON.parse(message.body), { text: 'Chose "Ship it" on "Ship today?"' });
        assert.deepStrictEqual(yield* service.act(person, tap("tap-1")), message);
        const answered = Option.getOrThrow(yield* repo.getWidget(card));
        assert.strictEqual(answered.revision, 2);
        assert.deepStrictEqual(answered.awaiting, []);
        assert.include((answered.state as { answer: object }).answer, {
          optionId: "option-1",
          personId: person.personId,
          via: "tap",
        });
        assert.notInclude(
          (yield* repo.listOpenWaiting(person)).map((item) => item.widgetId),
          card.widgetId,
        );
        for (const stale of [tap("tap-2"), tap("tap-3", 2)])
          assert.include(yield* service.act(person, stale).pipe(Effect.flip), {
            reason: "widget_changed",
          });

        yield* TestClock.adjust("24 hours");
        assert.include(
          yield* service.act(person, tap("late", 1, later.widgetId)).pipe(Effect.flip),
          { reason: "invalid_state", message: "This question expired." },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "takes reactions as replies: 👍 answers a yes/no card once, wakes on a yes/no to the lead's latest message or a 👎, one per person per message, refuses privileged cards",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const react = (messageId: KinMessageId, emoji: KinReactionEmoji, on = true) =>
          service.react(person, { messageId, emoji, on });
        const card = yield* service.ask(agent, {
          chatId: chat.chatId,
          clientMessageId: "ask-react",
          question: "Ship today?",
          options: [
            { label: "Ship it", kind: "yes" },
            { label: "Wait", kind: "no" },
          ],
        });
        const first = yield* react(card.messageId, "👍");
        // A retried reaction changes nothing.
        assert.deepStrictEqual(yield* react(card.messageId, "👍"), first);
        const answered = Option.getOrThrow(yield* repo.getWidget(card));
        assert.include((answered.state as { answer: object }).answer, {
          optionId: "option-1",
          via: "reaction",
          emoji: "👍",
        });
        assert.include(yield* react(card.messageId, "✅").pipe(Effect.flip), {
          reason: "widget_changed",
        });
        const tap = {
          widgetId: card.widgetId,
          revision: answered.revision,
          actionId: "choose",
          value: "option-2",
          clientActionId: "tap-after-reaction",
        };
        assert.include(yield* service.act(person, tap).pipe(Effect.flip), {
          reason: "widget_changed",
        });
        // A card tap wakes the lead through its widget_action message, so the reaction doesn't.
        const woke = () =>
          sql<{ messageId: string; emoji: string }>`SELECT message_id AS "messageId", emoji
            FROM kin_reactions WHERE org_id = ${person.orgId} AND woke_at IS NOT NULL
            ORDER BY woke_at, message_id`;
        assert.deepStrictEqual(yield* woke(), []);

        const older = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-older",
          body: "Shall I merge it?",
          intent: "answer",
        });
        const latest = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-latest",
          body: "Merged. I can tag the release too if you want.",
          intent: "answer",
        });
        const mine = (messageId: KinMessageId, kind: "person" | "agent" = "person") =>
          sql<{ emoji: string }>`SELECT r.emoji FROM kin_reactions r
            JOIN kin_chat_members m ON m.org_id = r.org_id AND m.chat_id = r.chat_id
              AND m.member_id = r.member_id AND m.principal_kind = ${kind}
            WHERE r.org_id = ${person.orgId} AND r.message_id = ${messageId}
              AND r.removed_at IS NULL ORDER BY r.emoji`;
        // Feedback: a 👍 on an older message, and a 🎉 or ❤️ on the latest question, wake nothing.
        yield* react(older.messageId, "👍");
        yield* react(latest.messageId, "🎉");
        yield* react(latest.messageId, "❤️");
        assert.deepStrictEqual(yield* woke(), []);
        // A yes on the latest message answers it, question mark or not, replacing the ❤️.
        yield* react(latest.messageId, "👍");
        assert.deepStrictEqual(yield* mine(latest.messageId), [{ emoji: "👍" }]);
        assert.deepStrictEqual(yield* woke(), [{ messageId: latest.messageId, emoji: "👍" }]);
        assert.deepStrictEqual(
          yield* sql`SELECT 1 AS opened FROM kin_floor_runs
            WHERE org_id = ${person.orgId} AND opened_by = ${latest.messageId} AND state = 'open'`,
          [{ opened: 1 }],
        );
        // The same answer again, or a feeling in its place, wakes nothing more.
        const wakes = (messageId: KinMessageId) =>
          sql<{ emoji: string; answer: string | null; wakes: number }>`SELECT emoji, answer, wakes
            FROM kin_reaction_wakes WHERE org_id = ${person.orgId} AND message_id = ${messageId}
            ORDER BY message_id`;
        yield* react(latest.messageId, "✅");
        assert.deepStrictEqual(yield* mine(latest.messageId), [{ emoji: "✅" }]);
        yield* react(latest.messageId, "❤️");
        yield* react(latest.messageId, "👍");
        assert.deepStrictEqual(yield* wakes(latest.messageId), [
          { emoji: "👍", answer: "yes", wakes: 1 },
        ]);
        // Changing the answer wakes it again inside the cooldown: no, then yes, then the cap.
        yield* react(latest.messageId, "👎");
        assert.deepStrictEqual(yield* wakes(latest.messageId), [
          { emoji: "👎", answer: "no", wakes: 2 },
        ]);
        yield* react(latest.messageId, "👍");
        yield* react(latest.messageId, "👎");
        assert.deepStrictEqual(yield* wakes(latest.messageId), [
          { emoji: "👍", answer: "yes", wakes: 3 },
        ]);
        assert.deepStrictEqual(yield* woke(), [
          { messageId: latest.messageId, emoji: "👍" },
          { messageId: latest.messageId, emoji: "👎" },
        ]);
        yield* react(latest.messageId, "✅");
        yield* react(latest.messageId, "✅", false);
        assert.deepStrictEqual(yield* mine(latest.messageId), []);
        // Past the cap, a yes is feedback.
        yield* react(latest.messageId, "✅");
        assert.strictEqual((yield* wakes(latest.messageId))[0]!.wakes, 3);
        yield* TestClock.adjust("30 seconds");
        // A 👎 on an ordinary lead message asks what was wrong, once.
        const plain = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-plain",
          body: "Release notes are posted.",
          intent: "answer",
        });
        yield* react(plain.messageId, "❤️");
        assert.lengthOf(yield* woke(), 2);
        yield* react(plain.messageId, "👎");
        assert.deepStrictEqual(yield* mine(plain.messageId), [{ emoji: "👎" }]);
        assert.deepStrictEqual((yield* woke()).at(-1), { messageId: plain.messageId, emoji: "👎" });
        yield* TestClock.adjust("30 seconds");
        yield* react(plain.messageId, "👎", false);
        yield* react(plain.messageId, "👎");
        assert.lengthOf(yield* woke(), 3);
        // The lead's own kin_react follows the same rule.
        yield* service.react(agent, { messageId: older.messageId, emoji: "👍", on: true });
        yield* service.react(agent, { messageId: older.messageId, emoji: "🎉", on: true });
        assert.deepStrictEqual(yield* mine(older.messageId, "agent"), [{ emoji: "🎉" }]);
        assert.deepStrictEqual(yield* mine(older.messageId), [{ emoji: "👍" }]);
        // A 👎 on an older message still asks what was wrong.
        yield* TestClock.adjust("30 seconds");
        yield* react(older.messageId, "👎");
        assert.deepStrictEqual((yield* woke()).at(-1), { messageId: older.messageId, emoji: "👎" });
        const history = yield* service.history(person, {
          chatId: chat.chatId,
          beforeSeq: plain.seq + 1,
          limit: 10,
        });
        assert.deepStrictEqual(
          history.reactions
            ?.filter((reaction) => reaction.messageId === latest.messageId)
            .map((reaction) => reaction.emoji),
          ["✅"],
        );

        // Approval and other privileged cards refuse; so do non-members and unknown emoji.
        const notice = yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("approval-anchor"),
          body: "Approve the merge?",
        });
        yield* repo.insertWidget({
          ...card,
          widgetId: KinWidgetId.make("approval-card"),
          messageId: notice.message.messageId,
          type: "approval",
          state: {},
        });
        assert.include(yield* react(notice.message.messageId, "👍").pipe(Effect.flip), {
          reason: "not_allowed",
        });
        const outsider = { ...person, personId: decodeKinPersonId("reaction-outsider") };
        yield* repo.insertPerson({
          ...outsider,
          handle: "reaction-outsider",
          displayName: "Outsider",
          githubLogin: null,
          createdAt: timestamp,
        });
        assert.include(
          yield* service
            .react(outsider, { messageId: latest.messageId, emoji: "👍", on: true })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
        assert.include(
          yield* service
            .react(person, {
              messageId: latest.messageId,
              emoji: "🦄" as "👍",
              on: true,
            })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        // kin_react pins the message to its wake-up's chat.
        assert.include(
          yield* service
            .react(agent, {
              messageId: latest.messageId,
              emoji: "👍",
              on: true,
              chatId: decodeKinChatId("other-chat"),
            })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "takes a withdrawn yes as a changed answer, once, and only on the message a reaction last woke the lead for",
    () =>
      Effect.gen(function* () {
        const { service, person, agent, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const react = (messageId: KinMessageId, emoji: KinReactionEmoji, on = true) =>
          service.react(person, { messageId, emoji, on });
        const wakes = () =>
          sql<{ messageId: string; emoji: string; answer: string | null; wakes: number }>`
            SELECT message_id AS "messageId", emoji, answer, wakes FROM kin_reaction_wakes
            WHERE org_id = ${person.orgId} ORDER BY woke_at, message_id`;
        const offer = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-offer",
          body: "I can tag the release too if you want.",
          intent: "answer",
        });
        yield* react(offer.messageId, "👍");
        yield* react(offer.messageId, "👍", false);
        assert.deepStrictEqual(yield* wakes(), [
          { messageId: offer.messageId, emoji: "👍", answer: null, wakes: 2 },
        ]);
        // Nothing is left to withdraw, so a 👍 back is a yes again; removing a feeling is nothing.
        yield* react(offer.messageId, "❤️");
        yield* react(offer.messageId, "❤️", false);
        assert.lengthOf(yield* wakes(), 1);
        assert.strictEqual((yield* wakes())[0]!.wakes, 2);
        // Once another message woke the lead, the first one's reactions are feedback again.
        const next = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-next",
          body: "Release notes are posted.",
          intent: "answer",
        });
        yield* TestClock.adjust("30 seconds");
        yield* react(next.messageId, "👎");
        yield* react(offer.messageId, "👍");
        assert.deepStrictEqual(yield* wakes(), [
          { messageId: offer.messageId, emoji: "👍", answer: null, wakes: 2 },
          { messageId: next.messageId, emoji: "👎", answer: "no", wakes: 1 },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides foreign org ids on every method and checks active membership and roles", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      const widget = yield* service.createTaskCard({
        orgId: person.orgId,
        chatId: chat.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
      });
      yield* service.addWaiting(agent, {
        chatId: chat.chatId,
        personId: person.personId,
        messageId: widget.messageId,
        widgetId: widget.widgetId,
        reason: "question",
      });
      const [waiting] = yield* repo.listOpenWaiting(person);
      assert.isDefined(waiting);
      const foreign = {
        _tag: "person",
        orgId: decodeKinOrgId("other-org"),
        personId: decodeKinPersonId("other-person"),
      } as const;
      yield* repo.insertOrg({ orgId: foreign.orgId, name: "Other", createdAt: timestamp });
      yield* repo.insertPerson({
        ...foreign,
        handle: "other",
        displayName: "Other",
        githubLogin: null,
        createdAt: timestamp,
      });
      for (const operation of [
        service.createDirect(foreign, { orgId: person.orgId, agentId }),
        service.send(foreign, { chatId: chat.chatId, body: "Hidden", clientMessageId: "foreign" }),
        service.history(foreign, { chatId: chat.chatId, beforeSeq: 99, limit: 100 }),
        service.markRead(foreign, { chatId: chat.chatId, seq: 1 }),
        service.mute(foreign, { chatId: chat.chatId, muted: true }),
        service.upsertWidget(foreign, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: 1,
          type: "task",
          state,
        }),
        service.act(foreign, {
          widgetId: widget.widgetId,
          revision: 1,
          actionId: "done",
          clientActionId: "foreign",
        }),
        service.addWaiting(foreign, {
          chatId: chat.chatId,
          personId: person.personId,
          messageId: null,
          widgetId: null,
          reason: "question",
        }),
        service.resolveWaiting(foreign, { waitingId: waiting.waitingId, resolution: "answered" }),
      ])
        assert.include(yield* Effect.flip(operation), { reason: "not_found" });
      const outsider = { ...person, personId: decodeKinPersonId("outsider") };
      yield* repo.insertPerson({
        ...outsider,
        handle: "outsider",
        displayName: "Outsider",
        githubLogin: null,
        createdAt: timestamp,
      });
      assert.include(
        yield* Effect.flip(
          service.history(outsider, { chatId: chat.chatId, beforeSeq: 99, limit: 100 }),
        ),
        { reason: "not_found" },
      );
      const guest = yield* repo.addMember({
        ...chat,
        memberId: decodeKinMemberId("guest-member"),
        principal: { _tag: "person", personId: outsider.personId },
        role: "guest",
        joinedAt: timestamp,
        leftAt: null,
        mutedUntil: null,
      });
      for (const operation of [
        service
          .send(outsider, { chatId: chat.chatId, body: "Guest", clientMessageId: "guest" })
          .pipe(Effect.asVoid),
        service
          .act(outsider, {
            widgetId: widget.widgetId,
            revision: 1,
            actionId: "done",
            clientActionId: "guest",
          })
          .pipe(Effect.asVoid),
        service
          .upsertWidget(outsider, { chatId: chat.chatId, type: "task", state })
          .pipe(Effect.asVoid),
      ])
        assert.include(yield* Effect.flip(operation), { reason: "not_allowed" });
      const guestWaiting = yield* service.addWaiting(person, {
        chatId: chat.chatId,
        personId: outsider.personId,
        messageId: null,
        widgetId: null,
        reason: "mention",
      });
      assert.include(
        yield* Effect.flip(
          service.resolveWaiting(outsider, {
            waitingId: guestWaiting.waitingId,
            resolution: "done",
          }),
        ),
        { reason: "not_allowed" },
      );
      yield* service.markRead(outsider, { chatId: chat.chatId, seq: 1 });
      yield* repo.leaveChat({ ...guest, leftAt: timestamp });
      assert.include(
        yield* Effect.flip(service.markRead(outsider, { chatId: chat.chatId, seq: 1 })),
        { reason: "not_found" },
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repo.getWaiting(guestWaiting)).resolution,
        "cancelled",
      );
      const rejoined = yield* repo.addMember({ ...guest, role: "member" });
      assert.strictEqual(rejoined.role, "member");
      yield* service.send(outsider, {
        chatId: chat.chatId,
        body: "Rejoined",
        clientMessageId: "rejoined",
      });
      yield* service.markRead(outsider, { chatId: chat.chatId, seq: 1 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_chat_members SET muted_until = '2099-01-01T00:00:00.000Z' WHERE org_id = ${person.orgId} AND agent_id = ${agentId}`;
      assert.include(
        yield* Effect.flip(
          service.send(agent, {
            chatId: chat.chatId,
            body: "Muted",
            clientMessageId: "muted",
            intent: "answer",
          }),
        ),
        { reason: "not_allowed" },
      );
      yield* sql`UPDATE kin_chat_members SET muted_until = NULL WHERE org_id = ${person.orgId} AND agent_id = ${agentId}`;
      yield* repo.endAgentThread({ orgId: agent.orgId, threadId, endedAt: timestamp });
      assert.include(
        yield* Effect.flip(
          service.send(agent, {
            chatId: chat.chatId,
            body: "Ended",
            clientMessageId: "ended",
            intent: "answer",
          }),
        ),
        { reason: "not_allowed" },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates trusted cards idempotently and enforces ownership and server fields", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      for (const caller of [agent, person])
        assert.include(
          yield* service
            .upsertWidget(caller, { chatId: chat.chatId, type: "task", state })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      const input = {
        orgId: person.orgId,
        chatId: chat.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
      };
      for (const patch of [
        { orgId: KinOrgId.make("foreign") },
        { threadId: ThreadId.make("missing") },
        { chatId: KinChatId.make("missing") },
        { authorAgentId: KinAgentId.make("missing") },
      ])
        assert.include(yield* service.createTaskCard({ ...input, ...patch }).pipe(Effect.flip), {
          reason: "not_found",
        });
      const widget = yield* service.createTaskCard(input);
      assert.deepStrictEqual(yield* service.createTaskCard(input), widget);
      assert.include(
        yield* service.createTaskCard({ ...input, title: "Changed" }).pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.strictEqual(
        (yield* repo.history({ ...chat, beforeSeq: 99, limit: 100 })).messages.length,
        2,
      );
      const anchor = Option.getOrThrow(yield* repo.getMessage(widget));
      assert.include(anchor.author, { _tag: "agent", agentId: agent.agentId });
      for (const input of [
        { type: "approval", state },
        { type: "unknown", state },
        { type: "task", state: {}, widgetId: widget.widgetId, revision: 1 },
      ])
        assert.include(
          yield* service.upsertWidget(agent, { chatId: chat.chatId, ...input }).pipe(Effect.flip),
          { reason: input.type === "approval" ? "use_approvals" : "invalid_state" },
        );
      const otherId = KinAgentId.make("other");
      const otherThread = ThreadId.make("other-thread");
      yield* repo.insertAgent({
        ...person,
        agentId: otherId,
        ownerPersonId: person.personId,
        displayName: "Other",
        role: "lead",
        createdAt: timestamp,
      });
      const identity = yield* Identity.KinIdentity.pipe(Effect.provide(identityLayer));
      yield* identity.registerAgentThread({ ...person, agentId: otherId, threadId: otherThread });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES (${otherId}, ${person.orgId}, 'Other', 0, '{}', '[]', ${chat.chatId})`;
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const otherRun = yield* startWakeupRun(otherThread, "other-wakeup");
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids) VALUES ('other-wakeup', ${person.orgId}, ${otherId}, ${otherThread}, ${otherRun.id}, 'test', 0, 'running', '[]')`;
      const other = yield* identity.resolveAgent({
        ...caller,
        thread: { ...caller.thread!, threadId: otherThread },
      });
      yield* repo.addMember({
        ...chat,
        memberId: KinMemberId.make("other-member"),
        principal: { _tag: "agent", agentId: otherId },
        role: "member",
        joinedAt: timestamp,
        leftAt: null,
        mutedUntil: null,
      });
      assert.include(
        yield* service
          .upsertWidget(other, {
            chatId: chat.chatId,
            widgetId: widget.widgetId,
            revision: widget.revision,
            type: "task",
            state: widget.state,
            closed: true,
          })
          .pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'other-wakeup'`;
      yield* sql`UPDATE kin_wakeups SET status = 'running' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const updated = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: 1,
        type: "task",
        state: { ...state, status: "done", lastError: "invented" },
        awaiting: [person.personId],
      });
      assert.strictEqual(
        (yield* decodeTask(updated.state)).status,
        (yield* decodeTask(widget.state)).status,
      );
      assert.isNull((yield* decodeTask(updated.state)).lastError);
      const actionInput = {
        widgetId: widget.widgetId,
        revision: updated.revision,
        actionId: "done",
        clientActionId: "action",
        value: { checked: true },
      };
      assert.include(
        yield* service.act(person, { ...actionInput, revision: 99 }).pipe(Effect.flip),
        { reason: "widget_changed" },
      );
      const action = yield* service.act(person, actionInput);
      assert.strictEqual(action.kind, "widget_action");
      assert.deepStrictEqual(yield* service.act(person, actionInput), action);
      assert.include(
        yield* service.act(person, { ...actionInput, actionId: "changed" }).pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
      for (const patch of [
        {},
        { revision: updated.revision, replyTo: anchor.messageId },
        { revision: updated.revision, state: { ...state, threadId: "foreign" } },
      ])
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              type: "task",
              state,
              ...patch,
            })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
      const closed = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: updated.revision,
        type: "task",
        state,
        closed: true,
      });
      assert.isNotNull(closed.closedAt);
      assert.deepStrictEqual(yield* service.createTaskCard(input), closed);
      const reopened = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: closed.revision,
        type: "task",
        state: { ...state, title: "Edited" },
        closed: false,
      });
      assert.isNull(reopened.closedAt);
      assert.deepStrictEqual(yield* service.createTaskCard(input), reopened);
      assert.include(
        yield* service
          .upsertWidget(agent, {
            chatId: chat.chatId,
            widgetId: widget.widgetId,
            revision: closed.revision,
            type: "task",
            state,
          })
          .pipe(Effect.flip),
        { reason: "widget_changed" },
      );
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const serverThread = ThreadId.make("server-only");
      yield* startWakeupRun(serverThread, "server-only");
      assert.strictEqual(
        (yield* service.createTaskCard({ ...input, threadId: serverThread })).revision,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "publishes question waiting and reply resolution, rolls back atomically, and keeps read state monotonic",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed(true);
        const hub = yield* Hub.KinChatHub;
        const events = yield* Stream.toQueue(yield* hub.subscribeForViewer(person), {
          capacity: "unbounded",
        });
        const sql = yield* SqlClient.SqlClient;
        const input = {
          chatId: chat.chatId,
          body: "Ready?",
          intent: "question",
          clientMessageId: "question",
        } as const;
        yield* sql
          .withTransaction(service.send(agent, input).pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.flip);
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const question = yield* service.send(agent, input);
        assert.strictEqual(question.seq, 1);
        assert.strictEqual((yield* Queue.take(events)).type, "message.posted");
        assert.strictEqual((yield* Queue.take(events)).type, "waiting.updated");
        assert.strictEqual((yield* repo.listOpenWaiting(person)).length, 1);
        assert.deepStrictEqual(yield* service.send(agent, input), question);
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        yield* service.send(person, { chatId: chat.chatId, body: "Yes", clientMessageId: "reply" });
        assert.strictEqual((yield* Queue.take(events)).type, "message.posted");
        const resolved = yield* Queue.take(events);
        assert.strictEqual(resolved.type, "waiting.updated");
        if (resolved.type === "waiting.updated")
          assert.strictEqual(resolved.item.resolution, "answered");
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const member = (yield* repo.listMembersByPerson(person))[0];
        assert.isDefined(member);
        assert.strictEqual(yield* repo.unreadCount(member), 1);
        yield* service.markRead(person, { chatId: chat.chatId, seq: 999 });
        yield* service.markRead(person, { chatId: chat.chatId, seq: 0 });
        assert.strictEqual(Option.getOrThrow(yield* repo.getReadState(member)).lastReadSeq, 2);
        assert.strictEqual(yield* repo.unreadCount(member), 0);
        const read = yield* Queue.take(events);
        assert.include(read, { type: "read.updated", seq: 2 });
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        const approvalWidget = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        yield* sql`UPDATE kin_widgets SET type = 'approval' WHERE org_id = ${person.orgId} AND widget_id = ${approvalWidget.widgetId}`;
        const approval = {
          orgId: person.orgId,
          chatId: chat.chatId,
          waitingId: decodeKinWaitingId("server-approval"),
          personId: person.personId,
          messageId: approvalWidget.messageId,
          widgetId: approvalWidget.widgetId,
          reason: "approval",
          createdAt: timestamp,
          resolvedAt: null,
          resolution: null,
        } as const;
        assert.include(yield* Effect.flip(repo.addWaiting(approval)), { reason: "not_allowed" });
        yield* repo.addApprovalWaiting(approval);
        const humanQuestion = yield* service.send(person, {
          chatId: chat.chatId,
          body: "Another question",
          clientMessageId: "human-question",
        });
        const anotherQuestion = yield* service.addWaiting(person, {
          ...approval,
          reason: "question",
          messageId: humanQuestion.messageId,
          widgetId: null,
        });
        const ownQuestion = yield* service.addWaiting(agent, {
          ...approval,
          messageId: question.messageId,
          widgetId: null,
          reason: "question",
        });
        for (const operation of [
          service.addWaiting(agent, { ...approval }),
          service.resolveWaiting(agent, { waitingId: approval.waitingId, resolution: "approved" }),
          service.resolveWaiting(person, { waitingId: approval.waitingId, resolution: "approved" }),
          service.resolveWaiting(agent, {
            waitingId: anotherQuestion.waitingId,
            resolution: "answered",
          }),
        ])
          assert.include(yield* Effect.flip(operation), { reason: "not_allowed" });
        const secondaryThread = ThreadId.make("secondary");
        yield* startWakeupRun(secondaryThread, "secondary");
        const secondaryAnchor = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: secondaryThread,
          title: state.title,
          model: state.model,
        });
        yield* repo.insertWidget({
          ...secondaryAnchor,
          widgetId: KinWidgetId.make("secondary-approval"),
          type: "approval",
        });
        const secondaryWaiting = {
          ...approval,
          waitingId: KinWaitingId.make("secondary-waiting"),
          reason: "question" as const,
          messageId: secondaryAnchor.messageId,
          widgetId: secondaryAnchor.widgetId,
        };
        for (const attempt of [
          repo.addWaiting(secondaryWaiting).pipe(Effect.asVoid),
          service.addWaiting(person, secondaryWaiting).pipe(Effect.asVoid),
          repo.addWaiting({ ...secondaryWaiting, messageId: null }).pipe(Effect.asVoid),
          service.addWaiting(person, { ...secondaryWaiting, messageId: null }).pipe(Effect.asVoid),
        ])
          assert.include(yield* Effect.flip(attempt), { reason: "not_allowed" });
        for (const identity of [person, agent])
          for (const widgetId of [null, approvalWidget.widgetId])
            assert.include(
              yield* Effect.flip(
                service.addWaiting(identity, {
                  ...approval,
                  reason: "question",
                  widgetId,
                  messageId: approvalWidget.messageId,
                }),
              ),
              { reason: "not_allowed" },
            );
        assert.strictEqual(
          (yield* service.resolveWaiting(agent, {
            waitingId: ownQuestion.waitingId,
            resolution: "answered",
          })).resolution,
          "answered",
        );
        const waiting = yield* service.addWaiting(agent, {
          chatId: chat.chatId,
          personId: person.personId,
          messageId: question.messageId,
          widgetId: null,
          reason: "mention",
        });
        const done = yield* service.resolveWaiting(person, {
          waitingId: waiting.waitingId,
          resolution: "done",
        });
        assert.strictEqual(done.resolution, "done");
        assert.deepStrictEqual(
          yield* service.resolveWaiting(person, {
            waitingId: waiting.waitingId,
            resolution: "again",
          }),
          done,
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("filters every hub event against current viewer membership at delivery", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed(true);
      const hub = yield* Hub.KinChatHub;
      const viewer = yield* hub.subscribeForViewer(person);
      const other = yield* repo.createChat({
        ...chat,
        chatId: decodeKinChatId("other-chat"),
        kind: "project_group",
        directKey: null,
      });
      const agentMember = (yield* repo.listMembers(chat)).find(
        (row) => row.principal._tag === "agent",
      );
      const personMember = (yield* repo.listMembers(chat)).find(
        (row) => row.principal._tag === "person",
      );
      assert.isDefined(agentMember);
      assert.isDefined(personMember);
      yield* repo.addMember({
        ...agentMember,
        chatId: other.chatId,
        memberId: decodeKinMemberId("other-agent"),
      });
      const message = yield* service.send(agent, {
        chatId: other.chatId,
        body: "Private",
        clientMessageId: "private",
        intent: "evidence",
      });
      const widget = yield* service.createTaskCard({
        orgId: person.orgId,
        chatId: other.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
      });
      const events: ReadonlyArray<Hub.KinChatHubEvent> = [
        { type: "chat.created", orgId: person.orgId, chat: other },
        { type: "message.posted", orgId: person.orgId, message },
        {
          type: "message.posted",
          orgId: person.orgId,
          message: { ...message, status: "suggested" },
        },
        { type: "widget.updated", orgId: person.orgId, widget },
        {
          type: "waiting.updated",
          orgId: person.orgId,
          item: {
            orgId: person.orgId,
            chatId: other.chatId,
            waitingId: decodeKinWaitingId("private-waiting"),
            personId: person.personId,
            messageId: message.messageId,
            widgetId: null,
            reason: "suggestion",
            createdAt: timestamp,
            resolvedAt: null,
            resolution: null,
          },
        },
        {
          type: "read.updated",
          orgId: person.orgId,
          chatId: other.chatId,
          memberId: agentMember.memberId,
          seq: 1,
        },
      ];
      for (const event of events) yield* hub.publish(event);
      const marker: Hub.KinChatHubEvent = {
        type: "read.updated",
        orgId: person.orgId,
        chatId: chat.chatId,
        memberId: personMember.memberId,
        seq: 0,
      };
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
      const joined = yield* repo.addMember({
        ...personMember,
        chatId: other.chatId,
        memberId: decodeKinMemberId("other-person"),
      });
      for (const event of events) yield* hub.publish(event);
      yield* repo.leaveChat({ ...joined, leftAt: timestamp });
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
      yield* repo.addMember(joined);
      for (const event of events) yield* hub.publish(event);
      assert.deepStrictEqual(
        yield* Stream.runCollect(viewer.pipe(Stream.take(events.length))),
        events.map((event) => {
          if (event.type !== "message.posted") return event;
          const { clientMessageId: _id, ...visible } = event.message;
          return { ...event, message: visible };
        }),
      );
      const agentViewer = yield* hub.subscribeForViewer(agent);
      const suggestion: Hub.KinChatHubEvent = {
        type: "message.posted",
        orgId: person.orgId,
        message: {
          ...message,
          chatId: chat.chatId,
          status: "suggested",
          author: { _tag: "human", personId: person.personId, memberId: personMember.memberId },
        },
      };
      yield* hub.publish(suggestion);
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(agentViewer)), marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), suggestion);
      const waitingEvent = events.find((event) => event.type === "waiting.updated");
      assert.isDefined(waitingEvent);
      if (waitingEvent.type === "waiting.updated")
        yield* hub.publish({
          ...waitingEvent,
          item: { ...waitingEvent.item, personId: KinPersonId.make("someone-else") },
        });
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "requires an owner to remove members and publishes cancelled waiting only after commit",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, chat } = yield* seed();
        const hub = yield* Hub.KinChatHub;
        const sql = yield* SqlClient.SqlClient;
        const other = { ...person, personId: KinPersonId.make("other-person") };
        yield* repo.insertPerson({
          ...other,
          handle: "other",
          displayName: "Other",
          githubLogin: null,
          createdAt: timestamp,
        });
        const member = yield* repo.addMember({
          orgId: person.orgId,
          chatId: chat.chatId,
          memberId: KinMemberId.make("other-member"),
          principal: other,
          role: "member",
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
        const waiting = yield* service.addWaiting(person, {
          chatId: chat.chatId,
          personId: other.personId,
          messageId: null,
          widgetId: null,
          reason: "mention",
        });
        const published: Array<Hub.KinChatHubEvent> = [];
        const monitored = yield* Service.KinChatService.pipe(
          Effect.provide(
            Layer.fresh(Service.layer).pipe(
              Layer.provide(
                Layer.succeed(Hub.KinChatHub, {
                  ...hub,
                  publish: (event) =>
                    hub.publish(event).pipe(
                      Effect.andThen(
                        sql.afterCommit(
                          Effect.sync(() => {
                            published.push(event);
                          }),
                        ),
                      ),
                    ),
                }),
              ),
            ),
          ),
        );
        assert.include(yield* Effect.flip(monitored.leaveChat(other, member)), {
          reason: "not_allowed",
        });
        yield* sql
          .withTransaction(
            monitored.leaveChat(person, member).pipe(Effect.andThen(Effect.fail("rollback"))),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(published, []);
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), [waiting]);
        const chatEvents = yield* Stream.toQueue(
          service.subscribe(other, { chatId: chat.chatId }),
          { capacity: "unbounded" },
        );
        assert.strictEqual((yield* Queue.take(chatEvents))._tag, "backlog");
        const updates = yield* Stream.toQueue(service.subscribeChats([other], {}), {
          capacity: "unbounded",
        });
        assert.strictEqual((yield* Queue.take(updates))._tag, "snapshot");
        yield* monitored.leaveChat(person, member);
        const cancelled = Option.getOrThrow(yield* repo.getWaiting(waiting));
        assert.strictEqual(cancelled.resolution, "cancelled");
        const markerChat = yield* repo.createChat({
          ...chat,
          chatId: KinChatId.make("marker-chat"),
          kind: "project_group",
          directKey: null,
        });
        yield* repo.addMember({
          ...member,
          memberId: KinMemberId.make("marker-member"),
          chatId: markerChat.chatId,
        });
        yield* hub.publish({ type: "chat.created", orgId: other.orgId, chat: markerChat });
        assert.deepStrictEqual(yield* Queue.take(updates), { _tag: "waiting", item: cancelled });
        assert.strictEqual(published.length, 2);
        assert.strictEqual((yield* Queue.take(updates))._tag, "chat");
        assert.deepStrictEqual(yield* Queue.take(chatEvents), {
          _tag: "member",
          member: Option.getOrThrow(yield* repo.getMember(member)),
        });
        assert.isTrue(Cause.isDone(yield* Queue.take(chatEvents).pipe(Effect.flip)));
        assert.deepStrictEqual(published[0], {
          type: "waiting.updated",
          orgId: person.orgId,
          item: cancelled,
        });
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), []);
        yield* repo.addMember(member);
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), []);
      }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "previews a chat by its latest message the feed still shows, never a dismissed one",
    () =>
      Effect.gen(function* () {
        const { service, person, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const hello = yield* service.send(person, {
          chatId: chat.chatId,
          body: "Hello",
          clientMessageId: "hello",
        });
        const notice = yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("retired-notice"),
          body: "A retired notice",
        });
        yield* sql`UPDATE kin_messages SET status = 'dismissed'
        WHERE message_id = ${notice.message.messageId}`;
        // Kin's own notes from earlier versions: a plain row, and a card about a memory change.
        yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("old-note"),
          body: "Forgot: the old office address",
        });
        const saved = yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("old-card"),
          body: "Memory: 1 change",
        });
        const repo = yield* Repository.KinChatRepository;
        yield* repo.insertWidget({
          orgId: person.orgId,
          chatId: chat.chatId,
          widgetId: KinWidgetId.make("memory-changes:lead:1"),
          messageId: saved.message.messageId,
          widgetClass: "native",
          type: "memory_changes",
          state: { items: [], more: 0 },
          source: null,
          feed: null,
          awaiting: [],
          pinnedAt: null,
          closedAt: null,
          updatedAt: saved.message.createdAt,
        });
        const list = Option.getOrThrow(yield* Stream.runHead(service.subscribeChats([person], {})));
        if (list._tag !== "snapshot") return assert.fail("Expected snapshot");
        const row = list.chats.find((candidate) => candidate.chatId === chat.chatId);
        assert.strictEqual(row?.lastMessage?.messageId, hello.messageId);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("mutes and unmutes a chat for the caller only, live in their list", () =>
    Effect.gen(function* () {
      const { service, person, chat } = yield* seed();
      const updates = yield* Stream.toQueue(service.subscribeChats([person], {}), {
        capacity: "unbounded",
      });
      assert.strictEqual((yield* Queue.take(updates))._tag, "snapshot");
      const mine = Effect.map(Queue.take(updates), (event) =>
        event._tag === "chat"
          ? Object.fromEntries(
              event.chat.members.map((member) => [member.principal._tag, member.mutedUntil]),
            )
          : event._tag,
      );
      const muted = yield* service.mute(person, { chatId: chat.chatId, muted: true });
      assert.isAbove(Date.parse(muted.mutedUntil ?? ""), Date.parse("9999-01-01T00:00:00Z"));
      // The agent's own mute is separate and stays off.
      assert.deepStrictEqual(yield* mine, { person: muted.mutedUntil, agent: null });
      // Muting twice changes nothing, so the list sends nothing.
      yield* service.mute(person, { chatId: chat.chatId, muted: true });
      assert.isNull(
        (yield* service.mute(person, { chatId: chat.chatId, muted: false })).mutedUntil,
      );
      assert.deepStrictEqual(yield* mine, { person: null, agent: null });
    }).pipe(Effect.provide(presenceLayer)),
  );
  it.effect("marks a chat working in the list while its agent's run is live", () =>
    Effect.gen(function* () {
      const { service, person, chat } = yield* seed();
      const presence = yield* Presence.KinPresence;
      const updates = yield* Stream.toQueue(service.subscribeChats([person], {}), {
        capacity: "unbounded",
      });
      const initial = yield* Queue.take(updates);
      assert.strictEqual(initial._tag, "snapshot");
      if (initial._tag !== "snapshot") return;
      assert.isFalse(initial.chats.find((row) => row.chatId === chat.chatId)?.working);
      const line = { agentId, wakeupId: null, label: null, startedAt: timestamp, since: timestamp };
      const working = Effect.map(Queue.take(updates), (event) =>
        event._tag === "chat" ? event.chat.working : event._tag,
      );
      // "paused" leaves the row as it was, so the list sends nothing for it.
      yield* presence.set(person.orgId, chat.chatId, { ...line, state: "paused" });
      yield* presence.set(person.orgId, chat.chatId, { ...line, state: "thinking" });
      assert.strictEqual(yield* working, true);
      yield* presence.clear(person.orgId, chat.chatId, agentId);
      assert.strictEqual(yield* working, false);
    }).pipe(Effect.provide(presenceLayer)),
  );
  it.effect(
    "clears a chat for good: messages, cards, reactions and files go; the chat, its members, memory and seq stay",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const presence = yield* Presence.KinPresence;
        const [turn] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId"
          FROM kin_wakeups WHERE org_id = ${person.orgId} AND status = 'running'`;
        const photo = yield* service.send(person, {
          chatId: chat.chatId,
          body: "The launch code is tangerine",
          clientMessageId: "photo",
          attachments: [yield* uploadPhoto("whiteboard.png")],
          uploader: TEST_UPLOAD_OWNER,
        });
        const answer = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-answer",
          body: "Noted. Shall I ship it?",
          intent: "question",
        });
        yield* service.react(person, { messageId: answer.messageId, emoji: "👍", on: true });
        const card = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("needs-owner"),
          body: "A run failed",
          waitingFor: person.personId,
        });
        yield* service.markRead(person, { chatId: chat.chatId, seq: answer.seq });
        const muted = yield* service.mute(person, { chatId: chat.chatId, muted: true });
        // What a clear must leave alone: what the lead remembers and what it is due to do.
        yield* sql`INSERT INTO kin_memory_heads (org_id, branch, head) VALUES (${person.orgId}, 'main', 'head')`;
        yield* sql`INSERT INTO kin_scheduled_tasks (org_id, item_id, chat_id, state, paused, recorded_at, updated_at)
          VALUES (${person.orgId}, 'weekly-digest', ${chat.chatId}, 'active', 0, ${timestamp}, 0)`;
        // The lead is mid-reply to the owner's first message, its draft already on screen.
        yield* presence.draft(person.orgId, chat.chatId, {
          draftId: "draft",
          agentId,
          wakeupId: KinWakeupId.make(turn!.wakeupId),
          text: "Half a reply",
        });
        assert.lengthOf((yield* presence.snapshot(person.orgId, chat.chatId)).drafts, 1);
        const before = yield* kinRowCounts;
        const held = yield* repo.getChat(chat);
        assert.isTrue(Option.isSome(held));
        if (Option.isNone(held)) return;
        const feed = yield* Stream.toQueue(service.subscribe(person, { chatId: chat.chatId }), {
          capacity: "unbounded",
        });
        const opened = yield* Queue.take(feed);
        assert.strictEqual(opened._tag, "backlog");
        if (opened._tag !== "backlog") return;
        const list = yield* Stream.toQueue(service.subscribeChats([person], {}), {
          capacity: "unbounded",
        });
        assert.strictEqual((yield* Queue.take(list))._tag, "snapshot");

        yield* service.clear(person, { chatId: chat.chatId });

        const after = yield* kinRowCounts;
        assert.deepStrictEqual(
          Object.keys(before).filter((table) => before[table] !== after[table]),
          [
            "kin_floor_grants",
            "kin_floor_runs",
            "kin_message_attachments",
            "kin_messages",
            "kin_reaction_wakes",
            "kin_reactions",
            "kin_widgets",
          ],
        );
        for (const table of ["kin_messages", "kin_widgets", "kin_reactions"])
          assert.strictEqual(after[table], 0, table);
        assert.deepStrictEqual(yield* storedFiles, []);
        assert.isFalse(yield* service.attachmentReadable(person, photo.attachments![0]!.id));
        // The chat is as empty as a new one, and still the same chat.
        const cleared = yield* repo.getChat(chat);
        assert.deepInclude(Option.getOrThrow(cleared), {
          lastSeq: held.value.lastSeq,
          lastMessageAt: null,
        });
        assert.deepStrictEqual(
          yield* service.history(person, {
            chatId: chat.chatId,
            beforeSeq: held.value.lastSeq + 1,
            limit: 50,
          }),
          { messages: [], widgets: [], hasMore: false, reactions: [] },
        );
        // The list hears each closed waiting item (the lead's question, the notice), then the row.
        for (const _ of [1, 2]) {
          const closed = yield* Queue.take(list);
          assert.strictEqual(closed._tag, "waiting");
          if (closed._tag !== "waiting") return;
          assert.deepInclude(closed.item, { messageId: null, widgetId: null });
          assert.isNotNull(closed.item.resolvedAt);
        }
        const row = yield* Queue.take(list);
        assert.strictEqual(row._tag, "chat");
        if (row._tag !== "chat") return;
        assert.deepInclude(row.chat, { lastMessage: null, unread: 0 });
        assert.strictEqual(
          row.chat.members.find((member) => member.principal._tag === "person")?.mutedUntil,
          muted.mutedUntil,
        );
        // The open feed empties at once; a client that was away learns it from its old cursor.
        const reset = yield* Queue.take(feed);
        // `clearedSeq` tells clients nothing older is left to page in, since seqs keep counting.
        assert.deepInclude(reset, {
          _tag: "reset",
          cleared: true,
          lastSeq: held.value.lastSeq,
          clearedSeq: held.value.lastSeq,
        });
        if (reset._tag !== "reset") return;
        const resume = (afterChangeSeq: number | undefined) =>
          service
            .subscribe(person, { chatId: chat.chatId, afterSeq: opened.lastSeq, afterChangeSeq })
            .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow));
        assert.deepInclude(yield* resume(opened.lastChangeSeq), { _tag: "reset", cleared: true });
        assert.deepInclude(yield* resume(reset.lastChangeSeq), {
          _tag: "backlog",
          messages: [],
          clearedSeq: held.value.lastSeq,
        });
        // Nothing waits on the owner, and the turn that was answering a deleted message is over:
        // marked aborted, its draft withheld, its message never handed to a later wake-up.
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        assert.deepStrictEqual(
          yield* sql`SELECT w.aborted_at IS NOT NULL AS aborted, e.state FROM kin_wakeups w
            JOIN kin_events e ON e.org_id = w.org_id AND e.wakeup_id = w.wakeup_id
            WHERE w.org_id = ${person.orgId} AND w.wakeup_id = ${turn!.wakeupId}`,
          [{ aborted: 1, state: "expired" }],
        );
        assert.deepStrictEqual((yield* presence.snapshot(person.orgId, chat.chatId)).drafts, []);
        // Seqs keep counting, and a worker still running gets its card back when it next reports.
        const next = yield* service.send(person, {
          chatId: chat.chatId,
          body: "Fresh start",
          clientMessageId: "fresh",
        });
        assert.strictEqual(next.seq, held.value.lastSeq + 1);
        const again = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        assert.strictEqual(again.widgetId, card.widgetId);
        assert.notStrictEqual(again.messageId, card.messageId);
      }).pipe(Effect.provide(clearLayer)),
  );

  it.effect(
    "lets the owner clear a group and their own chat with a lead, and a teammate only their own chat with a lead",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const teammate = (id: string) =>
          Effect.gen(function* () {
            const identity = { ...person, personId: decodeKinPersonId(id) };
            yield* repo.insertPerson({
              ...identity,
              handle: id,
              displayName: id,
              githubLogin: null,
              createdAt: timestamp,
            });
            return identity;
          });
        const join = (
          chatId: KinChatId,
          principal:
            | { _tag: "person"; personId: KinPersonId }
            | { _tag: "agent"; agentId: KinAgentId },
          role: "owner" | "member" | "guest",
        ) =>
          repo.addMember({
            orgId: person.orgId,
            chatId,
            memberId: decodeKinMemberId(
              `${chatId}:${principal._tag === "person" ? principal.personId : principal.agentId}`,
            ),
            principal,
            role,
            joinedAt: timestamp,
            leftAt: null,
            mutedUntil: null,
          });
        // A teammate's own chat with the owner's lead: the teammate and the lead, nobody else.
        const directWith = Effect.fn("test.directWith")(function* (identity: typeof person) {
          const direct = yield* repo.createChat({
            orgId: person.orgId,
            chatId: decodeKinChatId(`direct-${identity.personId}`),
            kind: "direct",
            directKey: `${identity.personId}:${agentId}`,
            title: null,
            teamId: null,
            lastMessageAt: null,
            createdAt: timestamp,
            archivedAt: null,
          });
          yield* join(direct.chatId, { _tag: "person", personId: identity.personId }, "member");
          yield* join(direct.chatId, { _tag: "agent", agentId }, "member");
          return direct;
        });
        const suraj = yield* teammate("suraj");
        const mira = yield* teammate("mira");
        const surajs = yield* directWith(suraj);
        const miras = yield* directWith(mira);
        const group = yield* repo.createChat({
          orgId: person.orgId,
          chatId: decodeKinChatId("group"),
          kind: "team_group",
          directKey: null,
          title: "Launch",
          teamId: null,
          lastMessageAt: null,
          createdAt: timestamp,
          archivedAt: null,
        });
        yield* join(group.chatId, { _tag: "person", personId: person.personId }, "owner");
        yield* join(group.chatId, { _tag: "agent", agentId }, "member");
        yield* join(group.chatId, { _tag: "person", personId: suraj.personId }, "member");
        const say = (who: typeof person, chatId: KinChatId) =>
          service.send(who, { chatId, body: "Junk", clientMessageId: `${who.personId}:${chatId}` });
        yield* say(suraj, surajs.chatId);
        yield* say(mira, miras.chatId);
        yield* say(suraj, group.chatId);
        yield* sql`INSERT INTO kin_memory_heads (org_id, branch, head) VALUES (${person.orgId}, 'main', 'head')`;
        const messages = () =>
          sql<{ chatId: string; n: number }>`SELECT chat_id AS "chatId", COUNT(*) AS n
            FROM kin_messages WHERE org_id = ${person.orgId} GROUP BY chat_id ORDER BY chat_id`;
        const full = yield* messages();
        const refused = [
          // Being in a group is not owning it.
          [suraj, group.chatId, "not_allowed"],
          // A chat the caller is not in does not exist for them, whoever they are.
          [suraj, chat.chatId, "not_found"],
          [suraj, miras.chatId, "not_found"],
          [person, surajs.chatId, "not_found"],
        ] as const;
        for (const [who, chatId, reason] of refused)
          assert.include(yield* service.clear([who], { chatId }).pipe(Effect.flip), { reason });
        assert.deepStrictEqual(yield* messages(), full);

        // Their own conversation stays theirs to clear after they may no longer write in it.
        yield* sql`UPDATE kin_chat_members SET role = 'guest'
          WHERE chat_id = ${surajs.chatId} AND person_id = ${suraj.personId}`;
        const before = yield* kinRowCounts;
        yield* service.clear([suraj], { chatId: surajs.chatId });
        const after = yield* kinRowCounts;
        assert.deepStrictEqual(
          Object.keys(before).filter((table) => before[table] !== after[table]),
          ["kin_floor_grants", "kin_floor_runs", "kin_messages"],
        );
        assert.strictEqual(after.kin_memory_heads, 1);
        yield* service.clear([person], { chatId: group.chatId });
        yield* service.clear([person], { chatId: chat.chatId });
        assert.deepStrictEqual(yield* messages(), [{ chatId: miras.chatId, n: 1 }]);
      }).pipe(Effect.provide(layer)),
  );
});
