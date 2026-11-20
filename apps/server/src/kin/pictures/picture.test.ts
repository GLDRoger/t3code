// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import * as AttachmentStore from "../chat/KinAttachmentStore.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Render from "../gendocs/render.ts";
import { KinToolchain } from "../gendocs/toolchain.ts";
import * as Workspace from "../gendocs/workspace.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { SHARED_TOOLS, sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Docs from "../work/docs.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as OwnerDocs from "../work/ownerDocs.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import { makePicture, type PictureInput } from "./picture.ts";
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

// What each picture put on the turn's reply; `KinChatService.test.ts` places it on the message.
const placed: Array<Parameters<KinLevelGate["Service"]["picture"]>[1]> = [];
const gate = Layer.mock(KinLevelGate)({
  picture: (_agent, input) =>
    Effect.sync(() => {
      // A retry carries the image its first call staged, as `KinChatService.picture` answers.
      const earlier = placed.find((one) => one.clientMessageId === input.clientMessageId);
      if (earlier === undefined) placed.push(input);
      return { placed: "reply" as const, attachmentId: (earlier ?? input).attachment.id };
    }),
});
// A 1x1 PNG stands in for the browser's drawing (`renderer.test.ts` draws for real).
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const drawing: { next: PictureDrawn | undefined } = { next: undefined };
const renderer = Layer.succeed(
  KinPictureRenderer,
  KinPictureRenderer.of({
    render: () =>
      Effect.succeed(
        drawing.next ?? { _tag: "drawn" as const, png: PNG, width: 1080, height: 1080 },
      ),
  }),
);
const toolchain = Layer.succeed(KinToolchain, {
  ensure: () =>
    Effect.fail(new KinChatError({ reason: "unavailable", message: "no Typst in these tests" })),
  present: () => Effect.undefined,
  fonts: () => Effect.undefined,
});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate, renderer).pipe(
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
  drawing.next = undefined;
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

/** A running turn woken by Rhea's (or Meera's) message `n` in the lead's chat. */
const turn = Effect.fn("KinPicturesTest.turn")(function* (
  n: number,
  from: "rhea" | "meera" = "rhea",
  audience: "owner_only" | "shared" = "owner_only",
) {
  const sql = yield* SqlClient.SqlClient;
  const author = from === "rhea" ? ownerId : meera;
  const member = `lead-chat-${from}`;
  if (from === "meera")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-meera', ${orgId}, 'lead-chat', 'person', ${meera}, 'member', ${at})
      ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES (${`ask-${n}`}, ${orgId}, 'lead-chat', ${n}, 'human', ${author}, ${member},
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
    chatId: "lead-chat",
    messageId: `ask-${n}`,
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', ${`wake-${n}`})`;
});

const post = (headline: string, more: Partial<PictureInput> = {}): PictureInput => ({
  title: "Ambermill launch",
  size: "square",
  html: `<h1 style="font-size:${headline}">Ambermill opens Monday</h1>`,
  ...more,
});
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
        assert.deepStrictEqual(placed.at(-1)!.doc, { key: "D-1", version: 2 });

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
        const notPicture = yield* Effect.flip(makePicture(scope, post("72px", { doc: "D-2" })));
        assert.strictEqual(
          notPicture.message,
          "D-2 isn't a picture, so nothing was made. Leave doc out to make a new picture.",
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
        const opens = (who: KinPersonId) =>
          OwnerDocs.list([person(who)], { orgId }).pipe(
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
});
