import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinMemoryChangeCard,
  KinMemoryItemId,
  KinPersonId,
  KinWidgetId,
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
import { MemoryChangeHooks } from "./MemoryWriter.ts";

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

it.effect("a wake-up's memory changes post one card, and only the owner can undo", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const repo = yield* Repository.KinChatRepository;
    const sql = yield* SqlClient.SqlClient;
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

    const changes = {
      orgId,
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
          change: "created" as const,
        },
        {
          itemId: KinMemoryItemId.make("repo"),
          path: "claims/repo.md",
          title: "Main repo is GLDRoger/t3code",
          change: "updated" as const,
        },
      ],
    };
    const hooks = Context.get(services, MemoryChangeHooks);
    yield* hooks.committed(changes);
    yield* hooks.committed(changes);
    const widgetId = KinWidgetId.make("memory-changes:lead:wake-1");
    const widget = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
    assert.strictEqual(widget.chatId, direct.chatId);
    assert.deepStrictEqual(
      decodeCard(widget.state).items.map(({ title, undo }) => [title, undo]),
      [
        ["You prefer short replies", null],
        ["Main repo is GLDRoger/t3code", null],
      ],
    );
    const message = Option.getOrThrow(
      yield* repo.getMessage({ orgId, messageId: widget.messageId }),
    );
    assert.strictEqual(message.body, "Memory: 2 changes, including You prefer short replies");
    const [cards] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
      WHERE org_id = ${orgId} AND type = 'memory_changes'`;
    assert.strictEqual(cards?.n, 1);

    const memory = Context.get(services, KinMemoryChanges);
    const undone: Array<Parameters<KinMemoryUndo>[1]> = [];
    yield* memory.attachWriter((_org, input) =>
      Effect.sync(() => {
        undone.push(input);
        return input.itemId === "short"
          ? { _tag: "undone" as const, commit: "c".repeat(40) }
          : { _tag: "stale" as const };
      }),
    );
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
