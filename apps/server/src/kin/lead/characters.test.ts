// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinChatHub from "../chat/KinChatHub.ts";
import { KinChatRepository, layer as chatRepository } from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { salesRules } from "../sales/instructions.ts";
import { salesRulesFor } from "../sales/seat.ts";
import { companyMoney } from "../work/companyProfile.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { defaultCharacterFor, growthCharacterV1 } from "./characterDefaults.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import {
  answerCharacterCard,
  characters,
  offerNewCharacter,
  seedCharacters,
  setCharacter,
} from "./characters.ts";

// Invented company and people only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("rhea");
const zoyaId = KinPersonId.make("zoya");
const chief = KinAgentId.make("chief");
const growth = KinAgentId.make("growth");
const at = "2026-11-11T00:00:00.000Z";
const isChatError = Schema.is(KinChatError);
const widgetId = KinWidgetId.make(`kin-character-default:growth:2:${orgId}`);

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: chief,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("chief-thread"),
    }),
});
const layer = Layer.mergeAll(KinRecords.layer, identity, KinChatHub.layer).pipe(
  Layer.provideMerge(chatRepository),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-characters-" })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

/** Rhea's company: a Chief of staff and Growth, each with Rhea's direct chat; Zoya sells. */
const seed = (growthDomain = "growth") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner'),
        (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${at}, 'member')`;
    for (const [agentId, name, domain, chat, made] of [
      [chief, "Chief of staff", "chief-of-staff", "chief-chat", "2026-11-01T00:00:00.000Z"],
      [growth, "Growth", growthDomain, "growth-chat", "2026-11-02T00:00:00.000Z"],
    ] as const) {
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
        VALUES (${agentId}, ${orgId}, ${name}, 'lead', ${ownerId}, ${made}, NULL)`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES (${chat}, ${orgId}, 'direct', ${`rhea:${agentId}`}, 0, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES (${`${chat}-rhea`}, ${orgId}, ${chat}, 'person', ${ownerId}, 'owner', ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, domain, level_since, thread_id,
          models_json, worker_projects_json, owner_chat_id)
        VALUES (${agentId}, ${orgId}, ${name}, ${domain}, 0, ${`${agentId}-thread`}, '{}', '[]', ${chat})`;
    }
    yield* seedCharacters(orgId);
  });

/** A company seeded before 20 Nov: Growth's character is the old default, as Kin wrote it then. */
const before = Effect.gen(function* () {
  yield* seed();
  const old = growthCharacterV1(yield* companyMoney(orgId));
  yield* setCharacter(orgId, growth, old);
});
const growthText = Effect.map(
  characters(orgId),
  (all) => all.find((one) => one.agentId === growth)!.body,
);
const tap = (yes: boolean, personId = ownerId) =>
  Effect.gen(function* () {
    const repo = yield* KinChatRepository;
    const card = yield* repo.getWidget({ orgId, widgetId });
    return yield* answerCharacterCard({
      orgId,
      widgetId,
      messageId: Option.getOrThrow(card).messageId,
      personId,
      yes,
    });
  });
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isChatError(error) ? error.reason : error._tag)),
  );

it("each area people type for selling resolves to the sales seat's character", () => {
  const money = { homeCurrency: "EUR", country: null, tax: null };
  const sales = defaultCharacterFor("growth", money);
  for (const domain of ["sales", "sales-and-marketing", "marketing", "business-development"]) {
    assert.strictEqual(defaultCharacterFor(domain, money), sales, domain);
    // Each carries the sales seat's rules too; no other default seat does.
    assert.deepStrictEqual(salesRulesFor(domain), [salesRules], domain);
  }
  for (const domain of ["chief-of-staff", "engineering", "finance", "social", "content"])
    assert.deepStrictEqual(salesRulesFor(domain), [], domain);
  assert.include(defaultCharacterFor("content", money) ?? "", "# Social");
  assert.include(defaultCharacterFor("social", money) ?? "", "# Social");
});

it.effect("a new company's Growth starts with the new character, and is offered nothing", () =>
  Effect.gen(function* () {
    const repo = yield* KinChatRepository;
    yield* seed("sales-and-marketing");
    const today = defaultCharacterFor("growth", yield* companyMoney(orgId)) ?? "";
    assert.strictEqual((yield* growthText).trim(), today.trim());
    assert.isFalse(yield* offerNewCharacter(orgId));
    assert.isTrue(Option.isNone(yield* repo.getWidget({ orgId, widgetId })));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "an unchanged Growth gets one card in the owner's notices chat, once; Keep this one changes nothing",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* KinChatRepository;
      yield* before;
      const old = yield* growthText;
      assert.isTrue(yield* offerNewCharacter(orgId));
      const card = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
      assert.strictEqual(card.chatId, "chief-chat");
      assert.deepStrictEqual(card.awaiting, [ownerId]);
      assert.deepInclude(card.state, {
        question: "Growth has a new character for sales and marketing, for any kind of customer.",
        detail: "Nothing changes until you choose.",
        untilAnswered: true,
      });
      assert.deepStrictEqual(
        (card.state as { options: ReadonlyArray<{ label: string }> }).options.map((o) => o.label),
        ["Use the new one", "Keep this one"],
      );
      // Once per company, ever: a later start posts nothing more.
      assert.isFalse(yield* offerNewCharacter(orgId));
      const [counted] = yield* sql<{ cards: number }>`SELECT COUNT(*) AS cards FROM kin_widgets
        WHERE org_id = ${orgId} AND widget_id LIKE 'kin-character-default:%'`;
      assert.strictEqual(counted?.cards, 1);
      // Only the owner level chooses.
      assert.strictEqual(yield* refusal(tap(true, zoyaId)), "not_allowed");
      assert.strictEqual(yield* growthText, old);
      assert.deepStrictEqual(yield* tap(false), {
        title: "Kept",
        text: "Growth keeps the character it has.",
      });
      assert.strictEqual(yield* growthText, old);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "Use the new one writes it as a new version, and never over an edit made since the card",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* before;
      assert.isTrue(yield* offerNewCharacter(orgId));
      const next = (defaultCharacterFor("growth", yield* companyMoney(orgId)) ?? "").trim();
      const old = yield* growthText;
      // A heading changed after the card was drawn, and then put back: the doc is not at the
      // version drawn, so the tap writes nothing over it and gives a draft of the new text.
      // Each write is its own moment, as a person's edits are.
      yield* TestClock.adjust("1 minute");
      yield* setCharacter(orgId, growth, old.replace("# Growth", "# Growth, Rhea's"), ownerId);
      yield* TestClock.adjust("1 minute");
      yield* setCharacter(orgId, growth, old, ownerId);
      const kept = yield* tap(true);
      assert.strictEqual(kept?.title, "Draft made");
      assert.include(
        kept?.text ?? "",
        "Growth's character was changed since this card, so it stays as written.",
      );
      assert.strictEqual(yield* growthText, old);
      const [draft] = yield* sql<{ body: string }>`SELECT v.body FROM kin_doc_versions v
        JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
        WHERE r.origin_key = ${`${widgetId}:draft`}`;
      assert.strictEqual(draft?.body.trim(), next);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "Use the new one, on the version drawn, writes it on the agent the card names; history keeps the old",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* before;
      // A second agent on the growth seat, made first with the new text: the card still names
      // the one with the old text, and the tap acts on it alone.
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
        VALUES ('marketing', ${orgId}, 'Marketing', 'lead', ${ownerId}, '2026-11-01T12:00:00.000Z', NULL)`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, domain, level_since, thread_id,
          models_json, worker_projects_json, owner_chat_id)
        VALUES ('marketing', ${orgId}, 'Marketing', 'marketing', 0, 'marketing-thread', '{}', '[]', 'growth-chat')`;
      yield* seedCharacters(orgId);
      assert.isTrue(yield* offerNewCharacter(orgId));
      const next = (defaultCharacterFor("growth", yield* companyMoney(orgId)) ?? "").trim();
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* tap(true), {
        title: "New character",
        text: "Growth has the new character. The old one stays in its history.",
      });
      assert.strictEqual((yield* growthText).trim(), next);
      const [counted] = yield* sql<{ versions: number }>`SELECT COUNT(*) AS versions
        FROM kin_doc_versions v JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
        WHERE r.origin_key = ${`kin-character:${growth}`}`;
      assert.isAbove(counted?.versions ?? 0, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the card comes once, ever: not after a clear and a restart, nor from two starts at once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* KinChatRepository;
      yield* before;
      // Two starts at once draw one card between them.
      const drawn = yield* Effect.all([offerNewCharacter(orgId), offerNewCharacter(orgId)], {
        concurrency: 2,
      });
      assert.deepStrictEqual(drawn.toSorted().map(String), ["false", "true"]);
      // Keep, then clear the chat the card is in, then start again: nothing comes back.
      yield* tap(false);
      yield* repo.clearChat({
        orgId,
        chatId: KinChatId.make("chief-chat"),
        clearedAt: at,
        clearedAtMs: 0,
      });
      assert.isTrue(Option.isNone(yield* repo.getWidget({ orgId, widgetId })));
      assert.isFalse(yield* offerNewCharacter(orgId));
      const [counted] = yield* sql<{ cards: number }>`SELECT COUNT(*) AS cards FROM kin_widgets
      WHERE org_id = ${orgId} AND widget_id LIKE 'kin-character-default:%'`;
      assert.strictEqual(counted?.cards, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an edited Growth's card says it stays as written and offers only to show the new one",
  () =>
    Effect.gen(function* () {
      const repo = yield* KinChatRepository;
      yield* seed();
      yield* TestClock.adjust("1 minute");
      yield* setCharacter(orgId, growth, "# Growth\n\nInvented: our own words.", ownerId);
      assert.isTrue(yield* offerNewCharacter(orgId));
      const card = Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId }));
      assert.deepInclude(card.state, {
        question: "You changed Growth's character, so it stays as you wrote it.",
      });
      assert.deepStrictEqual(
        (card.state as { options: ReadonlyArray<{ label: string }> }).options.map((o) => o.label),
        ["See the new one", "Keep mine"],
      );
      const shown = yield* tap(true);
      assert.strictEqual(shown?.title, "Draft made");
      assert.include(shown?.text ?? "", "Growth's character is unchanged.");
      assert.include(yield* growthText, "Invented: our own words.");
    }).pipe(Effect.provide(layer)),
);
