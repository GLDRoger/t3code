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
import { authorise, fingerprint, suggest } from "./sensitivity.ts";

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
      audience: "chat",
      orgId,
      chatId: direct.chatId,
      messageId: KinMessageId.make(widgetId),
      body: "Memory: 2 changes, including You prefer short replies",
    });
    yield* repo.insertWidget({
      audience: "chat",
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
      retire: () => Effect.die("Unused"),
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
    const body = "Invented body.\n";
    let items = [
      head("team", { sensitive: false }),
      head("terms", { sensitive: true }),
      head("legacy", { what: "Invented summary." }),
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
      // A lead said the team could know these, in turns no owner message started.
      head("hinted", { sensitive: false }),
      head("later", { sensitive: false }),
      // Its file says the team can know it; nothing stored says so.
      head("claimed", { sensitive: false }),
      // Suggested by an earlier version, which recorded no words.
      head("migrated", { sensitive: false }),
    ].map((item) => ({ head: item, body }));
    const relabelled: Array<{ itemId: string; sensitive: boolean; person: string }> = [];
    const retired: Array<{ itemId: string; by: string }> = [];
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
      retire: (_org, input) =>
        Effect.sync(() => {
          retired.push(input);
          return { retired: true };
        }),
      items: () => Effect.succeed(items),
      relabel: (_org, input) =>
        Effect.sync(() => {
          relabelled.push(input);
          const next = { ...items.find((item) => item.head.id === input.itemId)!.head };
          items = items.map((item) =>
            item.head.id === input.itemId
              ? { head: { ...next, sensitive: input.sensitive }, body }
              : item,
          );
          return { head: { ...next, sensitive: input.sensitive } };
        }),
    });
    const words = (id: string) => fingerprint(items.find((item) => item.head.id === id)!);
    // What stored rows say: the owner let the team know `team`, a teammate said `said`.
    yield* authorise(orgId, "team", words("team"), "owner_setting");
    yield* authorise(orgId, "said", words("said"), "teammate");
    yield* suggest(orgId, "hinted", words("hinted"));
    const member = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("priya") }];
    const letKnow = (id: string) => ({
      orgId,
      itemId: KinMemoryItemId.make(id),
      onlyOwner: false as const,
      version: words(id),
    });
    const flip = letKnow("terms");
    assert.include(yield* memory.list(member, { orgId }).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.include(yield* memory.setVisibility(member, flip).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.include(
      yield* memory
        .confirmSuggestions(member, {
          orgId,
          itemIds: [KinMemoryItemId.make("hinted")],
          versions: { hinted: words("hinted") },
        })
        .pipe(Effect.flip),
      { reason: "not_allowed" },
    );
    const forgotten = { orgId, itemId: KinMemoryItemId.make("later") };
    assert.include(yield* memory.forget(member, forgotten).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.include(
      yield* memory
        .forget([owner], { orgId, itemId: KinMemoryItemId.make("never-saved") })
        .pipe(Effect.flip),
      { reason: "not_found" },
    );
    assert.deepStrictEqual(retired, []);
    assert.deepStrictEqual(yield* memory.forget([owner], forgotten), { itemId: "later" });
    assert.deepStrictEqual(retired, [{ itemId: "later", by: "owner" }]);
    assert.deepStrictEqual(relabelled, []);

    const shown = () =>
      memory
        .list([owner], { orgId })
        .pipe(
          Effect.map(({ items }) =>
            Object.fromEntries(items.map((item) => [item.itemId, item.visibility])),
          ),
        );
    // Unlabelled, or labelled only by a file, reads as the owner's alone; what is no longer true
    // isn't listed.
    assert.deepStrictEqual(yield* shown(), {
      team: "team",
      terms: "only_owner",
      legacy: "only_owner",
      said: "team",
      hinted: "suggested",
      later: "only_owner",
      claimed: "only_owner",
      migrated: "only_owner",
    });
    const listed = (yield* memory.list([owner], { orgId })).items;
    assert.deepStrictEqual(listed.find((item) => item.itemId === "said")?.from, {
      name: "Invented person",
      chatName: "Invented room",
    });
    // Each item says what it holds in a line: its own summary, else the start of its words.
    assert.strictEqual(listed.find((item) => item.itemId === "terms")?.preview, "Invented body.");
    assert.strictEqual(
      listed.find((item) => item.itemId === "legacy")?.preview,
      "Invented summary.",
    );

    // Confirming everything the owner was shown takes nothing suggested after it.
    const waiting = (yield* memory.list([owner], { orgId })).items.filter(
      (item) => item.visibility === "suggested",
    );
    yield* suggest(orgId, "later", words("later"));
    const confirmed = yield* memory.confirmSuggestions([owner], {
      orgId,
      itemIds: waiting.map((item) => item.itemId),
      versions: Object.fromEntries(waiting.map((item) => [item.itemId, String(item.version)])),
    });
    assert.deepStrictEqual(
      confirmed.items.map((item) => [item.itemId, item.visibility]),
      [["hinted", "team"]],
    );
    assert.strictEqual((yield* shown()).later, "suggested");
    // Review of e1460657a0: a yes by id without the listed version confirmed whatever it said.
    const unseen = yield* memory.confirmSuggestions([owner], {
      orgId,
      itemIds: [KinMemoryItemId.make("later")],
      versions: {},
    });
    assert.deepStrictEqual(unseen.items, []);
    assert.strictEqual((yield* shown()).later, "suggested");
    // By id, only what is still suggested: a file's say-so is not a suggestion.
    const byId = yield* memory.confirmSuggestions([owner], {
      orgId,
      itemIds: [KinMemoryItemId.make("later"), KinMemoryItemId.make("claimed")],
      versions: { later: words("later"), claimed: words("claimed") },
    });
    assert.deepStrictEqual(
      byId.items.map((item) => item.itemId),
      ["later"],
    );
    assert.strictEqual((yield* shown()).claimed, "only_owner");

    // Review of 9de4e8d197: a suggestion with no words confirmed whatever the item said by then.
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, suggested_at)
      VALUES (${orgId}, 'migrated', 1)`;
    const migrated = KinMemoryItemId.make("migrated");
    const confirm = (versions: Record<string, string> = {}) =>
      memory
        .confirmSuggestions([owner], { orgId, itemIds: [migrated], versions })
        .pipe(Effect.map(({ items }) => items.map((item) => item.itemId)));
    // Not confirmable unseen: it binds to the words the owner is first shown.
    assert.deepStrictEqual(yield* confirm(), []);
    const migratedRow = (yield* memory.list([owner], { orgId })).items.find(
      (item) => item.itemId === "migrated",
    );
    assert.deepStrictEqual(
      [migratedRow?.visibility, migratedRow?.version],
      ["suggested", words("migrated")],
    );
    // Reworded outside the server since: neither confirmation lets the team know the new words.
    items = items.map((item) =>
      item.head.id === "migrated" ? { ...item, body: "Invented reworded body.\n" } : item,
    );
    assert.deepStrictEqual(yield* confirm(), []);
    assert.deepStrictEqual(yield* confirm({ migrated: String(migratedRow?.version) }), []);
    assert.include(
      yield* memory
        .setVisibility([owner], {
          orgId,
          itemId: migrated,
          onlyOwner: false,
          version: String(migratedRow?.version),
        })
        .pipe(Effect.flip),
      { reason: "conflict" },
    );
    assert.strictEqual((yield* shown()).migrated, "only_owner");
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_memory_labels WHERE org_id = ${orgId} AND item_id = 'migrated'
        AND suggested_at IS NOT NULL AND shared_content IS NULL`,
      1,
    );

    // "Only you" holds from the tap, even if the file's label lands later.
    const keep = yield* memory.setVisibility([owner], {
      orgId,
      itemId: KinMemoryItemId.make("team"),
      onlyOwner: true,
    });
    assert.strictEqual(keep.item.visibility, "only_owner");
    const held = sql`SELECT item_id FROM kin_memory_labels
      WHERE org_id = ${orgId} AND held_at IS NOT NULL`;
    assert.deepStrictEqual(yield* held, [{ item_id: "team" }]);
    const share = yield* memory.setVisibility([owner], letKnow("team"));
    assert.strictEqual(share.item.visibility, "team");
    assert.lengthOf(yield* held, 0);
    // The owner's own choice lets the team know even what no one suggested.
    const terms = yield* memory.setVisibility([owner], flip);
    assert.strictEqual(terms.item.visibility, "team");
    assert.deepStrictEqual(relabelled, [
      { itemId: "hinted", sensitive: false, person: owner.personId },
      { itemId: "later", sensitive: false, person: owner.personId },
      { itemId: "team", sensitive: true, person: owner.personId },
      { itemId: "team", sensitive: false, person: owner.personId },
      { itemId: "terms", sensitive: false, person: owner.personId },
    ]);
    assert.include(
      yield* memory
        .setVisibility([owner], { ...flip, itemId: KinMemoryItemId.make("missing") })
        .pipe(Effect.flip),
      { reason: "not_found" },
    );
  }).pipe(Effect.scoped, Effect.provide(root)),
);

// Review of 69b673e063: a dream suggested X while X was only on its branch; the owner listed Y
// alone; the branch merged, and the old listing's yes-to-all let the team know X, never shown.
it.effect(
  "the owner's list says who said each item and when, quoting only what he can still read",
  () =>
    Effect.gen(function* () {
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const repo = yield* Repository.KinChatRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(session.sessionId);
      const [owner] = yield* Context.get(services, KinIdentity).resolve(session);
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
      const chats = Context.get(services, KinChatService);
      const direct = yield* chats.createDirect(owner, { orgId, agentId });
      const said = yield* chats.send(owner, {
        chatId: direct.chatId,
        body: "Invented: the demo client wants every report as a PDF.",
        clientMessageId: "said",
      });
      const removed = yield* chats.send(owner, {
        chatId: direct.chatId,
        body: "Invented words the owner later deleted.",
        clientMessageId: "removed",
      });
      yield* sql`UPDATE kin_messages SET body = '', status = 'deleted'
      WHERE org_id = ${orgId} AND message_id = ${removed.messageId}`;
      // A room the owner has since left: what was said there is no longer his to open.
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES ('left-room', ${orgId}, 'team_group', 1, '2026-11-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, left_at)
      VALUES ('owner-left', ${orgId}, 'left-room', 'person', ${owner.personId}, 'member',
        '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES ('left-message', ${orgId}, 'left-room', 1, 'human', ${owner.personId}, 'owner-left',
        'member', 'text', 'Invented words in a room he left.', '[]', 'posted', '2026-11-01T10:00:00.000Z')`;
      const chatSource = (chatId: string, messageId: string) =>
        `kin:chat:${chatId}:message:${messageId}`;
      const item = (id: string, fields: Partial<MemoryItemHead>) => ({
        head: decodeHead({
          id,
          orgId,
          path: `claims/${id}.md`,
          kind: "claim",
          title: `Invented ${id}`,
          status: "open",
          due: null,
          recorded_at: "2026-11-03T00:00:00.000Z",
          valid_from: "2026-11-03T00:00:00.000Z",
          invalid_at: null,
          superseded_by: null,
          review_by: null,
          source: chatSource(direct.chatId, said.messageId),
          said_by: "fixture-owner",
          trust: "owner",
          links: [],
          ...fields,
        }),
        body: "Invented body.\n",
      });
      const items = [
        item("quoted", { quote: "every report as a PDF" }),
        // Saved before quotes: who and when, and no words.
        item("old", {}),
        item("deleted", {
          source: chatSource(direct.chatId, removed.messageId),
          quote: "Invented words the owner later deleted",
        }),
        item("left", {
          source: chatSource("left-room", "left-message"),
          quote: "Invented words in a room he left",
        }),
        item("inferred", { source: "wakeup:invented", said_by: agentId, trust: "agent" }),
      ];
      const memory = Context.get(services, KinMemoryChanges);
      yield* memory.attachWriter({
        undo: () => Effect.die("Unused"),
        retire: () => Effect.die("Unused"),
        relabel: () => Effect.die("Unused"),
        items: () => Effect.succeed(items),
      });
      const listed = Object.fromEntries(
        (yield* memory.list([owner], { orgId })).items.map((entry) => [
          entry.itemId,
          entry.provenance,
        ]),
      );
      const stated = {
        saidBy: "fixture-owner",
        trust: "owner" as const,
        recordedAt: "2026-11-03T00:00:00.000Z",
      };
      assert.deepStrictEqual(listed, {
        quoted: { ...stated, saidAt: said.createdAt, quote: "every report as a PDF" },
        old: { ...stated, saidAt: said.createdAt, quote: null },
        deleted: { ...stated, saidAt: null, quote: null },
        left: { ...stated, saidAt: null, quote: null },
        inferred: {
          saidBy: agentId,
          trust: "agent" as const,
          recordedAt: "2026-11-03T00:00:00.000Z",
          saidAt: null,
          quote: null,
        },
      });
      // Only the owner lists memory at all, so no teammate is ever handed these words.
      const member = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("priya") }];
      assert.include(yield* memory.list(member, { orgId }).pipe(Effect.flip), {
        reason: "not_allowed",
      });
    }).pipe(Effect.scoped, Effect.provide(root)),
);

it.effect("a yes takes only the items and words the owner was shown", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    yield* pairSession(session.sessionId);
    const [owner] = yield* Context.get(services, KinIdentity).resolve(session);
    assert.isDefined(owner);
    const { orgId } = owner;
    const item = (id: string) => ({
      head: decodeHead({
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
        sensitive: false,
      }),
      body: "Invented body.\n",
    });
    // X is on the dream's review branch only; Y is on the default branch.
    let items = [item("y")];
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
      retire: () => Effect.die("Unused"),
      items: () => Effect.succeed(items),
      relabel: (_org, input) =>
        Effect.succeed({ head: items.find((each) => each.head.id === input.itemId)!.head }),
    });
    yield* suggest(orgId, "x", fingerprint(item("x")));
    yield* suggest(orgId, "y", fingerprint(item("y")));
    const listing = yield* memory.list([owner], { orgId });
    assert.deepStrictEqual(
      listing.items.map((each) => [each.itemId, each.visibility]),
      [["y", "suggested"]],
    );
    // The branch merges: X is current, and suggested as these very words.
    items = [...items, item("x")];
    const shown = listing.items.filter((each) => each.visibility === "suggested");
    const confirmed = yield* memory.confirmSuggestions([owner], {
      orgId,
      itemIds: shown.map((each) => each.itemId),
      versions: Object.fromEntries(shown.map((each) => [each.itemId, String(each.version)])),
    });
    assert.deepStrictEqual(
      confirmed.items.map((each) => each.itemId),
      ["y"],
    );
    const after = yield* memory.list([owner], { orgId });
    assert.deepStrictEqual(
      Object.fromEntries(after.items.map((each) => [each.itemId, each.visibility])),
      { y: "team", x: "suggested" },
    );
  }).pipe(Effect.scoped, Effect.provide(root)),
);
