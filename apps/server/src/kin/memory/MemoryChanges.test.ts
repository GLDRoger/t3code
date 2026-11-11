import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KIN_MEMORY_CHANGES_CARD,
  KinAgentId,
  KinChatId,
  KinMemoryChangeCard,
  KinMemoryItemId,
  KinMessageId,
  KinPersonId,
  KinWidgetId,
  MemoryItemHead,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Audit from "../approvals/Audit.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import * as Chat from "../chat/layer.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Kin from "../layer.ts";
import { dormantLeadDependencies } from "../lead/layer.testkit.ts";
import { KinMemoryChanges, type KinMemoryUndo } from "./MemoryChanges.ts";

const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const agentId = KinAgentId.make("lead");
const root = Kin.layer.pipe(
  Layer.provide(dormantLeadDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(
    Layer.merge(PendingActions.layer, PendingActions.ledgerLayer).pipe(
      Layer.provideMerge(Audit.layer),
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);
const decodeCard = Schema.decodeUnknownSync(KinMemoryChangeCard);
const encodeCard = Schema.encodeSync(KinMemoryChangeCard);
const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);

it.effect("only the owner can undo an item on an earlier memory change card", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const repo = yield* Repository.KinChatRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* pairSession(session.sessionId);
    const [owner] = yield* identity.resolve(session);
    assert.isDefined(owner);
    const { orgId } = owner;
    yield* repo.insertAgent({
      orgId,
      agentId,
      displayName: "Lead",
      role: "lead",
      ownerPersonId: owner.personId,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const direct = yield* Context.get(services, KinChatService).createDirect(owner, {
      orgId,
      agentId,
    });
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Lead', 'L0', 0, '{}', '[]', ${direct.chatId})`;

    // Cards are no longer posted; ones already in a chat keep their Undo.
    const widgetId = KinWidgetId.make("memory-changes:lead:wake-1");
    const { message } = yield* Context.get(services, KinChatService).notice({
      orgId,
      chatId: direct.chatId,
      messageId: KinMessageId.make(widgetId),
      body: "Memory: 2 changes, including You prefer short replies",
    });
    yield* repo.insertWidget({
      orgId,
      chatId: direct.chatId,
      widgetId,
      messageId: message.messageId,
      widgetClass: "native",
      type: KIN_MEMORY_CHANGES_CARD,
      state: encodeCard({
        agentId,
        wakeupId: "wake-1",
        branch: "kin/shadow/lead",
        base: "a".repeat(40),
        commit: "b".repeat(40),
        items: [
          {
            itemId: KinMemoryItemId.make("short"),
            path: "claims/short.md",
            title: "You prefer short replies",
            change: "created",
            undo: null,
          },
          {
            itemId: KinMemoryItemId.make("repo"),
            path: "claims/repo.md",
            title: "Main repo is GLDRoger/t3code",
            change: "updated",
            undo: null,
          },
        ],
        more: 0,
      }),
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });

    const memory = Context.get(services, KinMemoryChanges);
    const undone: Array<Parameters<KinMemoryUndo>[1]> = [];
    yield* memory.attachWriter({
      undo: (_org, input) =>
        Effect.sync(() => {
          undone.push(input);
          return input.itemId === "short"
            ? { _tag: "undone" as const, commit: "c".repeat(40) }
            : { _tag: "stale" as const };
        }),
      relabel: () => Effect.die("Unused"),
      items: () => Effect.succeed([]),
    });
    const member = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("priya") }];
    const input = { orgId, widgetId, itemId: KinMemoryItemId.make("short") };
    assert.include(yield* memory.undo(member, input).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.deepStrictEqual(undone, []);

    const { card } = yield* memory.undo([owner], input);
    assert.strictEqual(card.items[0]?.undo, "undone");
    assert.deepInclude(undone[0], { itemId: input.itemId, branch: "kin/shadow/lead" });
    // A second tap is answered from the card, not the writer.
    yield* memory.undo([owner], input);
    assert.strictEqual(undone.length, 1);

    const staleInput = { ...input, itemId: KinMemoryItemId.make("repo") };
    assert.include(yield* memory.undo([owner], staleInput).pipe(Effect.flip), {
      reason: "conflict",
    });
    const marked = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
    assert.deepStrictEqual(
      decodeCard(marked.state).items.map(({ undo }) => undo),
      ["undone", "stale"],
    );
  }).pipe(Effect.scoped, Effect.provide(root)),
);

it.effect("only the owner sees what the leads remember and chooses who may know it", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const sql = yield* SqlClient.SqlClient;
    yield* pairSession(session.sessionId);
    const [owner] = yield* Context.get(services, KinIdentity).resolve(session);
    assert.isDefined(owner);
    const { orgId } = owner;
    const head = (id: string, fields: Partial<MemoryItemHead>) =>
      decodeHead({
        id,
        orgId,
        path: `claims/${id}.md`,
        kind: "claim",
        title: `Invented ${id}`,
        status: "open",
        due: null,
        recorded_at: "2026-11-01T00:00:00.000Z",
        valid_from: "2026-11-01T00:00:00.000Z",
        invalid_at: null,
        superseded_by: null,
        review_by: null,
        source: "fixture",
        said_by: "fixture",
        trust: "owner",
        links: [],
        ...fields,
      });
    let items = [
      head("team", { sensitive: false }),
      head("terms", { sensitive: true }),
      head("legacy", {}),
      head("gone", { sensitive: false, invalid_at: "2026-11-02T00:00:00.000Z" }),
      head("said", {
        sensitive: false,
        trust: "member",
        shared_from: {
          person: KinPersonId.make("priya"),
          chat: KinChatId.make("invented-room"),
          name: "Invented person",
          chat_name: "Invented room",
        },
      }),
    ];
    const relabelled: Array<{ itemId: string; sensitive: boolean; person: string }> = [];
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
      items: () => Effect.succeed(items),
      relabel: (_org, input) =>
        Effect.sync(() => {
          relabelled.push(input);
          const next = { ...items.find((item) => item.id === input.itemId)! };
          items = items.map((item) =>
            item.id === input.itemId ? { ...next, sensitive: input.sensitive } : item,
          );
          return { head: { ...next, sensitive: input.sensitive } };
        }),
    });
    const member = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("priya") }];
    const flip = { orgId, itemId: KinMemoryItemId.make("terms"), onlyOwner: false };
    assert.include(yield* memory.list(member, { orgId }).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.include(yield* memory.setVisibility(member, flip).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.deepStrictEqual(relabelled, []);

    const shown = () =>
      memory
        .list([owner], { orgId })
        .pipe(
          Effect.map(({ items }) =>
            Object.fromEntries(items.map((item) => [item.itemId, item.onlyOwner])),
          ),
        );
    // Unlabelled reads as the owner's alone; what is no longer true isn't listed.
    assert.deepStrictEqual(yield* shown(), { team: false, terms: true, legacy: true, said: false });
    assert.deepStrictEqual(
      (yield* memory.list([owner], { orgId })).items.find((item) => item.itemId === "said")?.from,
      { name: "Invented person", chatName: "Invented room" },
    );

    // "Only you" holds from the tap, even if the file's label lands later.
    const team = { ...flip, itemId: KinMemoryItemId.make("team") };
    const keep = yield* memory.setVisibility([owner], { ...team, onlyOwner: true });
    assert.isTrue(keep.item.onlyOwner);
    const held = sql`SELECT item_id FROM kin_memory_labels
      WHERE org_id = ${orgId} AND held_at IS NOT NULL`;
    assert.deepStrictEqual(yield* held, [{ item_id: "team" }]);
    const share = yield* memory.setVisibility([owner], team);
    assert.isFalse(share.item.onlyOwner);
    assert.lengthOf(yield* held, 0);
    assert.deepStrictEqual(relabelled, [
      { itemId: "team", sensitive: true, person: owner.personId },
      { itemId: "team", sensitive: false, person: owner.personId },
    ]);
    assert.include(
      yield* memory
        .setVisibility([owner], { ...flip, itemId: KinMemoryItemId.make("missing") })
        .pipe(Effect.flip),
      { reason: "not_found" },
    );
  }).pipe(Effect.scoped, Effect.provide(root)),
);
