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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

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
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
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
      yield* memory.confirmSuggestions(member, { orgId, asOf: 10 }).pipe(Effect.flip),
      { reason: "not_allowed" },
    );
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
    const { suggestionsAsOf } = yield* memory.list([owner], { orgId });
    yield* suggest(orgId, "later", words("later"));
    const confirmed = yield* memory.confirmSuggestions([owner], { orgId, asOf: suggestionsAsOf });
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
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, suggested_rev)
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
        AND suggested_rev IS NOT NULL AND shared_content IS NULL`,
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

// Review of 8c8ee76d04: a suggestion bound after a listing kept its old revision, inside its yes.
it.effect("a suggestion first bound after a listing stays out of that listing's yes", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const sql = yield* SqlClient.SqlClient;
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
    let items = [item("seen")];
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
      items: () => Effect.succeed(items),
      relabel: (_org, input) =>
        Effect.sync(() => {
          items = items.map((each) =>
            each.head.id === input.itemId
              ? { ...each, head: { ...each.head, sensitive: input.sensitive } }
              : each,
          );
          return { head: items.find((each) => each.head.id === input.itemId)!.head };
        }),
    });
    // An earlier version's suggestion of X, with no words; X's file isn't on this host yet.
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, suggested_rev) VALUES (${orgId}, 'x', 1)`;
    yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision) VALUES (${orgId}, 9)
      ON CONFLICT (org_id) DO UPDATE SET revision = 9`;
    yield* suggest(orgId, "seen", fingerprint(items[0]!));
    // Listing A shows only `seen`.
    const a = yield* memory.list([owner], { orgId });
    assert.strictEqual(a.suggestionsAsOf, 10);
    assert.deepStrictEqual(
      a.items.map((each) => each.itemId),
      ["seen"],
    );
    // X arrives, and another listing binds it to its words.
    items = [...items, item("x")];
    const b = yield* memory.list([owner], { orgId });
    assert.strictEqual(b.items.find((each) => each.itemId === "x")?.visibility, "suggested");
    const confirmed = yield* memory.confirmSuggestions([owner], { orgId, asOf: a.suggestionsAsOf });
    assert.deepStrictEqual(
      confirmed.items.map((each) => each.itemId),
      ["seen"],
    );
    const after = yield* memory.list([owner], { orgId });
    assert.strictEqual(after.items.find((each) => each.itemId === "x")?.visibility, "suggested");
  }).pipe(Effect.scoped, Effect.provide(root)),
);

/** `sql`, running `before` ahead of each statement it returns an effect for, and `entering` ahead of a transaction. */
const gatedSql = (
  sql: SqlClient.SqlClient,
  hooks: {
    readonly before?: (text: string) => Effect.Effect<void> | undefined;
    readonly entering?: Effect.Effect<void>;
  },
) =>
  new Proxy(sql, {
    apply: (target, self, args: Parameters<SqlClient.SqlClient>) => {
      const [strings] = args;
      const gate =
        Array.isArray(strings) && "raw" in strings ? hooks.before?.(strings.join("?")) : undefined;
      const statement: unknown = Reflect.apply(target, self, args);
      // Only template calls are gated, and those return a statement.
      return gate === undefined
        ? statement
        : Effect.andThen(gate, statement as Statement.Statement<unknown>);
    },
    get: (target, key) =>
      key === "withTransaction" && hooks.entering !== undefined
        ? <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.andThen(hooks.entering!, target.withTransaction(effect))
        : Reflect.get(target, key, target),
  });

// Review of 17822434f4: a suggestion that took its revision before a listing but stored it after
// came in at the listing's revision, so that listing's yes let the team know it unseen.
it.effect("a suggestion stored after a listing stays out of that listing's yes", () =>
  Effect.gen(function* () {
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const sql = yield* SqlClient.SqlClient;
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
    const items = [item("a"), item("b")];
    const memory = Context.get(services, KinMemoryChanges);
    yield* memory.attachWriter({
      undo: () => Effect.die("Unused"),
      items: () => Effect.succeed(items),
      relabel: (_org, input) =>
        Effect.succeed({ head: items.find((each) => each.head.id === input.itemId)!.head }),
    });
    const paused = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const waits = yield* Deferred.make<void>();
    let gated = false;
    // A pauses just before it stores its suggestion.
    const sqlA = gatedSql(sql, {
      before: (text) => {
        if (gated || !text.includes("INSERT INTO kin_memory_labels")) return undefined;
        gated = true;
        return Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)));
      },
    });
    const a = yield* suggest(orgId, "a", fingerprint(items[0]!)).pipe(
      Effect.provideService(SqlClient.SqlClient, sqlA),
      Effect.forkChild,
    );
    yield* Deferred.await(paused);
    // B suggests and the owner lists while A is paused, unless B must wait for A to finish.
    const listing = yield* suggest(orgId, "b", fingerprint(items[1]!)).pipe(
      Effect.provideService(
        SqlClient.SqlClient,
        gatedSql(sql, { entering: Deferred.succeed(waits, undefined).pipe(Effect.asVoid) }),
      ),
      Effect.andThen(memory.list([owner], { orgId })),
      Effect.forkChild,
    );
    yield* Effect.raceFirst(Fiber.await(listing).pipe(Effect.asVoid), Deferred.await(waits));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(a);
    const listed = yield* Fiber.join(listing);
    const shown: Array<string> = listed.items
      .filter((each) => each.visibility === "suggested")
      .map((each) => each.itemId);
    const confirmed = yield* memory.confirmSuggestions([owner], {
      orgId,
      asOf: listed.suggestionsAsOf,
    });
    // Only what the listing showed is confirmed; anything it didn't show is still waiting.
    assert.includeMembers(
      shown,
      confirmed.items.map((each) => each.itemId),
    );
    const after = yield* memory.list([owner], { orgId });
    for (const id of ["a", "b"])
      if (!shown.includes(id))
        assert.strictEqual(after.items.find((each) => each.itemId === id)?.visibility, "suggested");
  }).pipe(Effect.scoped, Effect.provide(root)),
);
