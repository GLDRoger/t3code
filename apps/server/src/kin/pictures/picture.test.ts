// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the tool's own retry key, derived the same way.
import * as NodeCrypto from "node:crypto";

import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import * as AttachmentStore from "../chat/KinAttachmentStore.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { KinConnectionSecrets } from "../connections/ConnectionSecrets.ts";
import * as Render from "../gendocs/render.ts";
import { KinToolchain } from "../gendocs/toolchain.ts";
import * as Workspace from "../gendocs/workspace.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { SHARED_TOOLS, sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as Docs from "../work/docs.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as LeadDocs from "../work/leadDocs.ts";
import * as OwnerDocs from "../work/ownerDocs.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import { makeFakeImageVendor } from "./FakeImageVendor.ts";
import { GENERATE_SENTENCES, KinPictures, makeLayer as picturesLayer } from "./KinPictures.ts";
import {
  KEPT,
  makePicture,
  type PictureInput,
  TOO_MANY_INPUTS,
  UNASKED_AFTER_OUTSIDE,
} from "./picture.ts";
import { KinPictureRenderer, PICTURE_SENTENCES, type PictureDrawn } from "./renderer.ts";

// Ambermill and its people are invented; nothing here reads a real database or draws in a browser.
const orgId = KinOrgId.make("ambermill");
const ownerId = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const dev = KinPersonId.make("dev");
const lead = KinAgentId.make("lead");
const at = "2026-11-20T00:00:00.000Z";
const person = (personId: KinPersonId) => ({ _tag: "person" as const, orgId, personId });
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner: person(ownerId),
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: lead,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
    }),
});

// What each picture put on the turn's reply, posted here as the reply carrying its image;
// `KinChatService.test.ts` places it on the real reply.
const placed: Array<Parameters<KinLevelGate["Service"]["picture"]>[1]> = [];
/** How many more pictures the reply takes, and a placement made to fail, as the real gate may. */
const reply = { room: 4, failOn: undefined as string | undefined };
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      pictureRoom: (_agent, input) =>
        input.clientMessageIds.length <= reply.room
          ? Effect.void
          : Effect.fail(
              new KinChatError({
                reason: "limit",
                message: `This reply has room for ${reply.room}.`,
              }),
            ),
      picture: (_agent, input) =>
        Effect.gen(function* () {
          if (input.clientMessageId === reply.failOn)
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Nothing was posted: the chat changed.",
            });
          // A retry carries the image its first call staged, as `KinChatService.picture` answers.
          const earlier = placed.find((one) => one.clientMessageId === input.clientMessageId);
          if (earlier !== undefined)
            return { placed: "reply" as const, attachmentId: earlier.attachment.id };
          placed.push(input);
          const messageId = `reply-${placed.length}`;
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at)
            VALUES (${messageId}, ${orgId}, ${input.chatId}, ${100 + placed.length}, 'agent', ${lead},
              ${ownerId}, 'lead-thread', ${`${input.chatId}-lead`}, 'member', 'text', 'Here it is.',
              '[]', 'posted', ${at})`;
          yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
            VALUES (${input.attachment.id}, ${orgId}, ${input.chatId}, ${messageId})`;
          return { placed: "reply" as const, attachmentId: input.attachment.id };
        }).pipe(Effect.catchTags({ SqlError: Effect.die })),
    }),
  ),
);
// A 1x1 PNG stands in for the browser's drawing (`renderer.test.ts` draws for real).
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const drawing: { next: PictureDrawn | undefined; files: Array<ReadonlyArray<string>> } = {
  next: undefined,
  files: [],
};
const renderer = Layer.succeed(
  KinPictureRenderer,
  KinPictureRenderer.of({
    render: (request) =>
      Effect.map(request.inputs, (inputs) => {
        drawing.files.push(inputs.files.map((file) => file.id));
        return drawing.next ?? { _tag: "drawn" as const, png: PNG, width: 1080, height: 1080 };
      }),
  }),
);
const toolchain = Layer.succeed(KinToolchain, {
  ensure: () =>
    Effect.fail(new KinChatError({ reason: "unavailable", message: "no Typst in these tests" })),
  present: () => Effect.undefined,
  fonts: () => Effect.undefined,
});
// The picture service on a fake vendor in memory: no request leaves a test.
const fake = makeFakeImageVendor();
const keys = new Map<string, Redacted.Redacted<string>>();
const secrets = Layer.mock(KinConnectionSecrets)({
  getPicturesKey: (vendor) => Effect.succeed(Option.fromNullishOr(keys.get(vendor))),
  setPicturesKey: (vendor, key) => Effect.sync(() => void keys.set(vendor, key)),
  removePicturesKey: (vendor) => Effect.sync(() => void keys.delete(vendor)),
});
const noRequests = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, () =>
      Promise.reject(new Error("No request leaves a pictures test.")),
    ),
  ),
);
const layer = Layer.mergeAll(KinRecords.layer, gate, renderer).pipe(
  Layer.provideMerge(
    picturesLayer(fake.vendor).pipe(Layer.provide(Layer.merge(secrets, noRequests))),
  ),
  Layer.provideMerge(ChatService.layer),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(identity),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(environment),
  Layer.provideMerge(Render.layer),
  Layer.provideMerge(AttachmentStore.layer),
  Layer.provideMerge(DocumentText.layer),
  Layer.provideMerge(toolchain),
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(Vcs.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-pictures-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer)),
);

/** Rhea's lead with its direct chat, and two teammates who are in no chat yet. */
const seed = Effect.gen(function* () {
  placed.length = 0;
  reply.room = 4;
  reply.failOn = undefined;
  drawing.next = undefined;
  drawing.files.length = 0;
  keys.clear();
  fake.calls.length = 0;
  fake.control.mode = "ok";
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}), (${meera}, ${orgId}, 'meera', 'Meera', ${at}),
      (${dev}, ${orgId}, 'dev', 'Dev', ${at})`;
  for (const mate of [meera, dev])
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES (${`session-${mate}`}, ${orgId}, ${mate}, 0)`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${lead}, ${orgId}, 'Kin', 'lead', ${ownerId}, ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'rhea:lead', 1, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('lead-chat-rhea', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Kin', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
});

/** The team's group chat: Rhea, Meera and the lead. */
const group = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('team-chat', ${orgId}, 'team_group', 1, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('team-chat-rhea', ${orgId}, 'team-chat', 'person', ${ownerId}, 'owner', ${at}),
      ('team-chat-meera', ${orgId}, 'team-chat', 'person', ${meera}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('team-chat-lead', ${orgId}, 'team-chat', 'agent', ${lead}, 'member', ${at})`;
});

/**
 * A running turn woken by Rhea's (or Meera's) message `n` in the lead's chat, or `chat`; handed
 * on by another agent instead, no one asked in person.
 */
const turn = Effect.fn("KinPicturesTest.turn")(function* (
  n: number,
  from: "rhea" | "meera" = "rhea",
  audience: "owner_only" | "shared" = "owner_only",
  chat = "lead-chat",
  options: { readonly handedOn?: true; readonly outside?: true } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const author = from === "rhea" ? ownerId : meera;
  const member = `${chat}-${from}`;
  if (from === "meera" && chat === "lead-chat")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-meera', ${orgId}, 'lead-chat', 'person', ${meera}, 'member', ${at})
      ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES (${`ask-${n}`}, ${orgId}, ${chat}, ${n}, 'human', ${author}, ${member},
      ${from === "rhea" ? "owner" : "member"}, 'text', 'Make a launch post for the mill', '[]',
      'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
      ${JSON.stringify([`event-${n}`])}, ${audience})`;
  const event = {
    _tag: "chat.message",
    orgId,
    agentId: lead,
    eventId: `event-${n}`,
    receivedAt: at,
    dedupeKey: null,
    provenance: { _tag: "human", personId: author, memberId: member },
    chatId: chat,
    messageId: `ask-${n}`,
    ...(options.handedOn === true ? { origin: { agentId: "finance", chatId: chat } } : {}),
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', ${`wake-${n}`})`;
  if (options.outside === true)
    yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
      VALUES (${orgId}, ${`wake-${n}`}, 0, 'mail')`;
});

const post = (headline: string, more: Partial<PictureInput> = {}): PictureInput => ({
  title: "Ambermill launch",
  size: "square",
  html: `<h1 style="font-size:${headline}">Ambermill opens Monday</h1>`,
  ...more,
});
/** The call's own key, as the tool derives it: the hash of what it was given. */
const placeKey = (input: PictureInput) =>
  NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
const versions = (key: string) =>
  Effect.gen(function* () {
    const doc = yield* Docs.docRow(orgId, { key }, KIN_OWNER_LEVEL);
    return (yield* Docs.history(orgId, doc.recordId, { limit: 10 })).map(Docs.toVersion);
  });
const pictureFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  return (yield* fs.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".png"));
});

describe("kin_picture", () => {
  it.effect(
    "files the drawing as a doc and puts it on the reply; drawn again with doc, it is version 2 and version 1 stays",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* turn(1);
        const first = yield* makePicture(scope, post("48px"));
        assert.deepInclude(first, { doc: "D-1", version: 1 });
        assert.strictEqual(
          first.next,
          "The picture shows under your reply and is in Docs as D-1, version 1.",
        );
        assert.lengthOf(placed, 1);
        assert.deepStrictEqual(
          [placed[0]!.chatId, placed[0]!.intent, placed[0]!.doc],
          ["lead-chat", "answer", { key: "D-1", version: 1 }],
        );
        assert.deepInclude(placed[0]!.attachment, {
          type: "image",
          id: first.files[0]!,
          name: "ambermill-launch.png",
          mimeType: "image/png",
          sizeBytes: PNG.length,
        });
        // The same call again, as a retried tool call is, files nothing new.
        assert.deepStrictEqual(yield* makePicture(scope, post("48px")), first);
        assert.lengthOf(yield* versions("D-1"), 1);

        // "Make the headline bigger", in the next turn.
        yield* turn(2);
        const bigger = yield* makePicture(scope, post("72px", { doc: "D-1" }));
        assert.deepInclude(bigger, { doc: "D-1", version: 2 });
        const [two, one] = yield* versions("D-1");
        assert.deepStrictEqual(
          [two?.version, two?.file?.mimeType, one?.version, one?.file?.mimeType],
          [2, "image/png", 1, "image/png"],
        );
        assert.strictEqual(two?.summary, "Picture, 1080×1080");
        assert.notStrictEqual(two?.file?.attachmentId, undefined);
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        for (const version of [one, two])
          assert.isTrue(yield* fs.exists(`${attachmentsDir}/${version!.file!.attachmentId}.png`));
        assert.notStrictEqual(placed[1]!.attachment.id, first.files[0]);
        // Read back, each version gives the page it was drawn from, so a change starts there.
        const pageOf = (read: object) => ("page" in read ? read.page : undefined);
        const readBack = yield* LeadDocs.read(scope, { key: "D-1" });
        assert.strictEqual(pageOf(readBack), post("72px", { doc: "D-1" }).html);
        assert.strictEqual(
          readBack.note,
          "D-1 is a picture, and page is the page it was drawn from. To change it, call kin_picture with doc D-1 and that page, changed.",
        );
        assert.strictEqual(
          pageOf(yield* LeadDocs.read(scope, { key: "D-1", version: 1 })),
          post("48px").html,
        );
        assert.deepStrictEqual(placed.at(-1)!.doc, { key: "D-1", version: 2 });

        // Deleted from Docs, it isn't changed out of sight: the change is a new doc.
        yield* OwnerDocs.remove([person(ownerId)], { orgId, key: "D-1", deleted: true });
        yield* turn(3);
        const afterDelete = yield* makePicture(scope, post("60px", { doc: "D-1" }));
        assert.deepInclude(afterDelete, { doc: "D-2", version: 1 });
        assert.strictEqual(
          (yield* versions("D-2"))[0]?.summary,
          "Picture, 1080×1080, changed from D-1",
        );
        assert.lengthOf(yield* versions("D-1"), 2);

        // A doc that isn't a picture is not one to draw again.
        yield* Docs.create(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
          {},
          {
            title: "Mill hours",
            body: "# Mill hours\n\nOpen nine to five.\n",
            owner: { _tag: "agent", agentId: lead },
            summary: "Created",
            originKey: "test:hours",
          },
        );
        const notPicture = yield* Effect.flip(makePicture(scope, post("72px", { doc: "D-3" })));
        assert.strictEqual(
          notPicture.message,
          "D-3 isn't a picture, so nothing was made. Leave doc out to make a new picture.",
        );
        // A file the page names must be an image sent in this chat.
        const stranger = yield* Effect.flip(
          makePicture(scope, post("72px", { html: `<img src="kin-file:kin-chat-elsewhere">` })),
        );
        assert.match(
          stranger.message,
          /^kin-file:kin-chat-elsewhere is not an image sent in this chat/,
        );
        assert.lengthOf(yield* versions("D-1"), 2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("when the page can't be drawn, says so in one sentence and makes nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      const before = yield* pictureFiles;
      for (const [drawn, reason] of [
        [{ _tag: "cannotDraw", reason: PICTURE_SENTENCES.cannotDraw }, "unavailable"],
        [
          { _tag: "refused", reason: PICTURE_SENTENCES.outside("cdn.example.com") },
          "invalid_state",
        ],
      ] as const) {
        drawing.next = drawn;
        const refused = yield* Effect.flip(makePicture(scope, post("48px")));
        assert.include(refused, { reason, message: drawn.reason });
      }
      assert.strictEqual(
        PICTURE_SENTENCES.cannotDraw,
        "Kin can't draw pictures on this server right now, so nothing was made.",
      );
      assert.deepStrictEqual(placed, []);
      assert.deepStrictEqual(yield* pictureFiles, before);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT key FROM kin_records WHERE org_id = ${orgId} AND register_id = 'docs'`,
        [],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "serves a teammate in their turn: the doc opens for them, the owner and the chat's readers only",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* turn(1, "meera", "shared");
        assert.strictEqual(SHARED_TOOLS.kin_picture, "view");
        assert.isTrue(
          yield* sharedToolAllowed(
            { orgId, agentId: lead, wakeupId: "wake-1" },
            "kin_picture",
            post("48px"),
          ),
        );
        const made = yield* makePicture(scope, post("48px"));
        const [version] = yield* versions(made.doc);
        assert.strictEqual(version?.provenance.audience, "shared");
        // The shelf Docs opens on, which leaves recipe files to their records.
        const opens = (who: KinPersonId) =>
          OwnerDocs.list([person(who)], { orgId, archived: false, files: false }).pipe(
            Effect.map((page) => page.docs.some((doc) => doc.key === made.doc)),
            Effect.orElseSucceed(() => false),
          );
        // Meera asked without the Docs place, and still opens what was made for her.
        assert.deepStrictEqual(
          [yield* opens(ownerId), yield* opens(meera), yield* opens(dev)],
          [true, true, false],
        );
        yield* OwnerDocs.get([person(meera)], { orgId, key: made.doc });
        // Dev reads it once he reads the chat, and not after he leaves it.
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('lead-chat-dev', ${orgId}, 'lead-chat', 'person', ${dev}, 'member', ${at})`;
        assert.isTrue(yield* opens(dev));
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'lead-chat-dev'`;
        assert.isFalse(yield* opens(dev));
        // Redrawn where only Rhea reads, it is hers alone again.
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'lead-chat-meera'`;
        yield* turn(2);
        yield* makePicture(scope, post("72px", { doc: made.doc }));
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'lead-chat-meera'`;
        assert.deepStrictEqual([yield* opens(ownerId), yield* opens(meera)], [true, false]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps each picture's doc to its chat, and to who reads the reply it came on, its file and image included",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* group;
        const sql = yield* SqlClient.SqlClient;
        const chats = yield* ChatService.KinChatService;
        // The same picture asked for in Rhea's own chat and in the team's is two docs.
        yield* turn(1);
        const own = yield* makePicture(scope, post("48px"));
        yield* turn(2, "meera", "shared", "team-chat");
        const team = yield* makePicture(scope, post("48px"));
        assert.notStrictEqual(team.doc, own.doc);
        // A change to Rhea's own picture, asked for where Meera reads, finds no such doc.
        assert.include(yield* Effect.flip(makePicture(scope, post("72px", { doc: own.doc }))), {
          reason: "not_found",
          message: `No doc ${own.doc}.`,
        });
        // Asked for in Rhea's own chat, a change to the team's picture is a new doc of that chat.
        yield* turn(3);
        const copy = yield* makePicture(scope, post("72px", { doc: team.doc }));
        assert.deepInclude(copy, { version: 1 });
        assert.notInclude([own.doc, team.doc], copy.doc);
        assert.strictEqual(
          (yield* versions(copy.doc))[0]?.summary,
          `Picture, 1080×1080, changed from ${team.doc}`,
        );
        assert.lengthOf(yield* versions(team.doc), 1);

        const file = (yield* versions(team.doc))[0]!.file!.attachmentId;
        const image = team.files[0]!;
        const reads = (who: KinPersonId) =>
          Effect.gen(function* () {
            const doc = yield* OwnerDocs.get([person(who)], { orgId, key: team.doc }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            return [
              doc,
              yield* chats.attachmentReadable([person(who)], file),
              yield* chats.attachmentReadable([person(who)], image),
            ];
          });
        assert.deepStrictEqual(yield* reads(meera), [true, true, true]);
        assert.deepStrictEqual(yield* reads(dev), [false, false, false]);
        // Put into a company doc, the picture still opens only for who reads its reply.
        const shown = yield* Docs.create(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
          {},
          {
            title: "Launch one-pager",
            body: `# Launch\n\n![Launch post](kin-file:${file})\n`,
            owner: { _tag: "agent", agentId: lead },
            summary: "Created",
            originKey: "test:launch-one-pager",
          },
        );
        yield* sql`UPDATE kin_records SET team_shared = 1
          WHERE org_id = ${orgId} AND record_id = ${shown.row.recordId}`;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_doc_files WHERE org_id = ${orgId} AND attachment_id = ${file}`,
          1,
        );
        assert.deepStrictEqual(
          [
            yield* chats.attachmentReadable([person(ownerId)], file),
            yield* chats.attachmentReadable([person(meera)], file),
            yield* chats.attachmentReadable([person(dev)], file),
          ],
          [true, true, false],
        );
        // Rhea's own copy is hers: Meera reads neither it nor its file.
        const copied = (yield* versions(copy.doc))[0]!.file!.attachmentId;
        assert.isFalse(yield* chats.attachmentReadable([person(meera)], copy.files[0]!));
        assert.isTrue(yield* chats.attachmentReadable([person(ownerId)], copied));
        // The team changes it; Dev joins between the two replies, and reads only the second.
        yield* turn(4, "meera", "shared", "team-chat");
        // Other bytes, so another file: identical bytes are one file, as a document's are.
        drawing.next = { _tag: "drawn", png: Uint8Array.of(...PNG, 0), width: 1080, height: 1080 };
        const second = yield* makePicture(scope, post("72px", { doc: team.doc }));
        drawing.next = undefined;
        assert.deepInclude(second, { doc: team.doc, version: 2 });
        const [joined] = yield* sql<{ seq: number }>`SELECT m.seq FROM kin_messages m
          JOIN kin_message_attachments a ON a.org_id = m.org_id AND a.message_id = m.message_id
          WHERE a.attachment_id = ${second.files[0]!}`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, joined_seq)
          VALUES ('team-chat-dev', ${orgId}, 'team-chat', 'person', ${dev}, 'member', ${at}, ${joined!.seq})`;
        const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          );
        const asDev = [person(dev)];
        assert.deepStrictEqual(
          [
            yield* fails(OwnerDocs.get(asDev, { orgId, key: team.doc })),
            yield* fails(OwnerDocs.get(asDev, { orgId, key: team.doc, version: 1 })),
            yield* fails(OwnerDocs.diff(asDev, { orgId, key: team.doc, from: 1, to: 2 })),
            (yield* OwnerDocs.history(asDev, { orgId, key: team.doc })).versions.map(
              (one) => one.version,
            ),
          ],
          [false, true, true, [2]],
        );
        assert.deepStrictEqual(yield* reads(dev), [true, false, false]);
        assert.isTrue(yield* chats.attachmentReadable(asDev, second.files[0]!));
        // Marked sensitive, the doc hides its file and its image too, from all but the owner level.
        yield* sql`UPDATE kin_records SET sensitive = 1 WHERE org_id = ${orgId} AND key = ${team.doc}`;
        assert.deepStrictEqual(yield* reads(meera), [false, false, false]);
        assert.deepStrictEqual(yield* reads(ownerId), [true, true, true]);
        yield* sql`UPDATE kin_records SET sensitive = 0 WHERE org_id = ${orgId} AND key = ${team.doc}`;
        // Taken out of the chat, Meera reads none of it, a URL she kept included.
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'team-chat-meera'`;
        assert.deepStrictEqual(yield* reads(meera), [false, false, false]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "draws an earlier chat image only for who asked, if they read it, or for everyone when no one did",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* group;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        // Meera's photo in the team's chat, sent before Dev joins it.
        yield* fs.writeFile(`${attachmentsDir}/kin-chat-mill-photo.png`, PNG);
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
            author_member_id, author_role, kind, body, attachments_json, mentions_json, status, created_at)
          VALUES ('photo', ${orgId}, 'team-chat', 50, 'human', ${meera}, 'team-chat-meera', 'member',
            'text', 'The mill this morning',
            ${JSON.stringify([{ type: "image", id: "kin-chat-mill-photo", name: "mill.png", mimeType: "image/png", sizeBytes: PNG.length }])},
            '[]', 'posted', ${at})`;
        yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
          VALUES ('kin-chat-mill-photo', ${orgId}, 'team-chat', 'photo')`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, joined_seq)
          VALUES ('team-chat-dev', ${orgId}, 'team-chat', 'person', ${dev}, 'member', ${at}, 60)`;
        const withPhoto = post("48px", { html: `<img src="kin-file:kin-chat-mill-photo">` });
        // Meera asks, and she reads her photo: it goes in, Dev in the chat or not.
        yield* turn(61, "meera", "shared", "team-chat");
        yield* makePicture(scope, withPhoto);
        assert.deepStrictEqual(drawing.files, [["kin-chat-mill-photo"]]);
        // A turn no one asked for in person: Dev reads the reply, not the photo, so it stays out.
        yield* turn(62, "meera", "shared", "team-chat", { handedOn: true });
        assert.match(
          (yield* Effect.flip(makePicture(scope, withPhoto))).message,
          /^kin-file:kin-chat-mill-photo is not an image sent in this chat/,
        );
        assert.lengthOf(drawing.files, 1);
        // Once everyone reading the chat reads it, it goes in.
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'team-chat-dev'`;
        yield* turn(63, "meera", "shared", "team-chat", { handedOn: true });
        yield* makePicture(scope, withPhoto);
        assert.lengthOf(drawing.files, 2);
        // Past eight images, or 24 MB of them, nothing is read or drawn.
        yield* turn(64, "meera", "shared", "team-chat");
        const many = Array.from(
          { length: 9 },
          (_, index) => `<img src="kin-file:kin-chat-${index}">`,
        );
        assert.include(
          yield* Effect.flip(makePicture(scope, post("48px", { html: many.join("") }))),
          {
            message: TOO_MANY_INPUTS,
          },
        );
        yield* fs.truncate(`${attachmentsDir}/kin-chat-mill-photo.png`, 25 * 1024 * 1024);
        assert.include(yield* Effect.flip(makePicture(scope, withPhoto)), {
          message: TOO_MANY_INPUTS,
        });
        assert.lengthOf(drawing.files, 2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "after outside text, generates only when a person asked in their own message, and draws in any turn",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* KinPictures).set([person(ownerId)], {
          orgId,
          key: Redacted.make("sk-invented-ambermill"),
        });
        const ask = { title: "Mill", size: "square", prompt: "The mill at dawn" } as const;
        // Handed on from a turn that read mail: no one asked, so no prompt leaves Kin.
        yield* turn(1, "rhea", "owner_only", "lead-chat", { handedOn: true, outside: true });
        assert.include(yield* Effect.flip(makePicture(scope, ask)), {
          reason: "not_allowed",
          message: UNASKED_AFTER_OUTSIDE,
        });
        assert.lengthOf(fake.calls, 0);
        assert.deepStrictEqual(yield* sql`SELECT count_id FROM kin_picture_counts`, []);
        // A drawing stays on Kin's server: it is made.
        assert.deepInclude(yield* makePicture(scope, post("48px")), { version: 1 });
        // Rhea asked in her own message after the mail was read: it is generated.
        yield* turn(2, "rhea", "owner_only", "lead-chat", { outside: true });
        assert.lengthOf((yield* makePicture(scope, ask)).files, 1);
        assert.lengthOf(fake.calls, 1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "generates from a prompt: each picture is a doc like a drawn one, read by the same people, and a retried call makes and counts nothing again",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* KinPictures).set([person(ownerId)], {
          orgId,
          key: Redacted.make("sk-invented-ambermill"),
        });
        yield* turn(1, "meera", "shared");
        const ask = {
          title: "Mill at dawn",
          size: "portrait",
          prompt: "The Ambermill mill at dawn, mist on the river, warm light",
          count: 2,
        } as const;
        const made = yield* makePicture(scope, ask);
        assert.deepInclude(made, { doc: "D-1", version: 1 });
        assert.strictEqual(
          made.next,
          "The 2 pictures show under your reply and are in Docs as D-1, D-2. Made at 1024×1536, the picture service's nearest size to portrait (1080×1350).",
        );
        assert.deepStrictEqual(
          placed.map((one) => [one.doc, one.attachment.name, one.attachment.mimeType]),
          [
            [{ key: "D-1", version: 1 }, "mill-at-dawn.png", "image/png"],
            [{ key: "D-2", version: 1 }, "mill-at-dawn-2.png", "image/png"],
          ],
        );
        const [version] = yield* versions("D-1");
        assert.strictEqual(version?.provenance.audience, "shared");
        assert.strictEqual(
          version?.summary,
          "Picture, 1024×1536, generated by OpenAI (gpt-image-2.5-flare) from: The Ambermill mill at dawn, mist on the river, warm light",
        );
        // Asked by Meera, counted to her.
        const counted = sql<{ count: number; person: string | null }>`SELECT count,
            person_id AS person FROM kin_picture_counts WHERE org_id = ${orgId} ORDER BY count_id`;
        assert.deepStrictEqual(yield* counted, [{ count: 2, person: meera }]);
        // A retried call returns the same, and the service is not asked again.
        assert.deepStrictEqual(yield* makePicture(scope, ask), made);
        assert.lengthOf(fake.calls, 1);
        assert.lengthOf(placed, 2);
        assert.deepStrictEqual(yield* counted, [{ count: 2, person: meera }]);

        // Rhea and Meera, who is in the chat, open the doc and its file; Dev, outside it, neither.
        const chats = yield* ChatService.KinChatService;
        const file = version!.file!.attachmentId;
        const opens = (who: KinPersonId) =>
          OwnerDocs.get([person(who)], { orgId, key: "D-1" }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        assert.deepStrictEqual(
          [yield* opens(ownerId), yield* opens(meera), yield* opens(dev)],
          [true, true, false],
        );
        assert.deepStrictEqual(
          [
            yield* chats.attachmentReadable([person(ownerId)], file),
            yield* chats.attachmentReadable([person(meera)], file),
            yield* chats.attachmentReadable([person(dev)], file),
          ],
          [true, true, false],
        );

        // A change in Rhea's own turn is the doc's next version, hers alone again.
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'lead-chat-meera'`;
        yield* turn(2);
        const changed = yield* makePicture(scope, {
          title: "Mill at dawn",
          size: "portrait",
          prompt: "The same mill at dawn, with more mist",
          doc: "D-1",
        });
        assert.deepInclude(changed, { doc: "D-1", version: 2 });
        assert.lengthOf(yield* versions("D-1"), 2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "makes and counts nothing a reply can't take, and files a made batch whole or keeps it for the same call",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* KinPictures).set([person(ownerId)], {
          orgId,
          key: Redacted.make("sk-invented-ambermill"),
        });
        yield* turn(1);
        const ask = {
          title: "Mill at dawn",
          size: "square",
          prompt: "The mill at dawn",
          count: 3,
        } as const;
        const counted = sql<{ count: number }>`SELECT count FROM kin_picture_counts
          WHERE org_id = ${orgId} ORDER BY count_id`;
        // Room for two: the service is never asked, and nothing is counted.
        reply.room = 2;
        assert.include(yield* Effect.flip(makePicture(scope, ask)), {
          reason: "limit",
          message: "This reply has room for 2.",
        });
        assert.deepStrictEqual([fake.calls.length, yield* counted, placed], [0, [], []]);
        // Room for all three; the third can't be placed, so none of them is filed or placed.
        reply.room = 4;
        reply.failOn = `kin-picture:wake-1:${placeKey(ask)}-3`;
        const failed = yield* Effect.flip(makePicture(scope, ask));
        assert.strictEqual(failed.message, `Nothing was posted: the chat changed. ${KEPT}`);
        placed.length = 0;
        assert.deepStrictEqual(
          yield* sql`SELECT key FROM kin_records WHERE org_id = ${orgId} AND register_id = 'docs'`,
          [],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT message_id FROM kin_messages WHERE body = 'Here it is.'`,
          [],
        );
        assert.deepStrictEqual([fake.calls.length, yield* counted], [1, [{ count: 3 }]]);
        // The same call again places what was made, with no second call or count.
        reply.failOn = undefined;
        const made = yield* makePicture(scope, ask);
        assert.deepStrictEqual(
          [made.files.length, placed.length, fake.calls.length, yield* counted],
          [3, 3, 1, [{ count: 3 }]],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "passes on the picture service's sentences word for word, filing and counting nothing",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at));
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* turn(1);
        const ask = { title: "Mill", size: "square", prompt: "The mill at dawn" } as const;
        const refusal = () => Effect.flip(makePicture(scope, ask));
        assert.include(yield* refusal(), {
          reason: "unavailable",
          message: GENERATE_SENTENCES.no_key,
        });
        yield* (yield* KinPictures).set([person(ownerId)], {
          orgId,
          key: Redacted.make("sk-invented-ambermill"),
          monthlyLimit: 1,
        });
        for (const [mode, reason, message] of [
          ["refuse", "invalid_state", GENERATE_SENTENCES.refused],
          ["reject", "unavailable", GENERATE_SENTENCES.key_rejected],
          ["unsent", "unavailable", GENERATE_SENTENCES.unavailable],
        ] as const) {
          fake.control.mode = mode;
          assert.include(yield* refusal(), { reason, message });
        }
        // A rejected key is named only where the owner level alone reads.
        yield* turn(2, "meera", "shared");
        fake.control.mode = "reject";
        assert.include(yield* refusal(), {
          reason: "unavailable",
          message: GENERATE_SENTENCES.not_working,
        });
        fake.control.mode = "ok";
        yield* sql`INSERT INTO kin_picture_counts (org_id, count_id, month, agent_id, count, state, at)
          VALUES (${orgId}, 'earlier', '2026-11', ${lead}, 1, 'made', 0)`;
        assert.include(yield* refusal(), {
          reason: "limit",
          message:
            "This month's 1 generated pictures are used. An owner or co-owner can raise the limit in Settings → Connections → Pictures; it resets on Dec 1.",
        });
        assert.lengthOf(fake.calls, 4);
        assert.deepStrictEqual(placed, []);
        assert.deepStrictEqual(
          yield* sql`SELECT key FROM kin_records WHERE org_id = ${orgId} AND register_id = 'docs'`,
          [],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT count_id FROM kin_picture_counts WHERE org_id = ${orgId} ORDER BY count_id`,
          [{ count_id: "earlier" }],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("takes html or prompt, never both, and count only with a prompt", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      const both = yield* Effect.flip(makePicture(scope, post("48px", { prompt: "The mill" })));
      const neither = yield* Effect.flip(makePicture(scope, { title: "Mill", size: "square" }));
      for (const refused of [both, neither])
        assert.include(refused, {
          reason: "invalid_state",
          message:
            "Give html to draw the picture or prompt to generate it, one of the two, so nothing was made.",
        });
      assert.include(yield* Effect.flip(makePicture(scope, post("48px", { count: 2 }))), {
        message:
          "count is for a generated picture: a drawn one is one picture, so nothing was made.",
      });
      assert.include(
        yield* Effect.flip(
          makePicture(scope, {
            title: "Mill",
            size: "square",
            prompt: "The mill",
            count: 2,
            doc: "D-1",
          }),
        ),
        {
          message:
            "A change makes one picture, the doc's next version: leave count out, so nothing was made.",
        },
      );
      assert.deepStrictEqual([placed, fake.calls], [[], []]);
    }).pipe(Effect.provide(layer)),
  );
});
