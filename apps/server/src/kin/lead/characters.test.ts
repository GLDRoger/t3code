// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KIN_CHARACTER_SEATS,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as Docs from "../work/docs.ts";
import { choiceCardState } from "../widgets/choiceCard.ts";
import { defaultCharacterFor, shippedLines } from "./characterDefaults.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import {
  type Character,
  characterForTurn,
  characters,
  colleagueLine,
  kinPartFor,
  ownersPart,
  seedCharacters,
  setCharacter,
  splitCharacters,
} from "./characters.ts";

// Invented company and people only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("rhea");
const chief = KinAgentId.make("chief");
const growth = KinAgentId.make("growth");
const at = "2026-11-11T00:00:00.000Z";
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

/** Rhea's company: a Chief of staff and Growth, each with Rhea's direct chat. */
const seed = (growthDomain = "growth") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner')`;
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
  // The New agent form says a ready-made character comes exactly when one does.
  for (const seat of KIN_CHARACTER_SEATS) assert.isString(defaultCharacterFor(seat, money), seat);
  assert.isUndefined(defaultCharacterFor("hiring", money));
});

const pounds = { homeCurrency: "GBP", country: "GB", tax: { name: "VAT" } };
const dollars = { homeCurrency: "USD", country: "US", tax: null };

it("the owner's part of an old character doc is his lines that no default Kin shipped", () => {
  const growthNow = kinPartFor("growth", "Growth", pounds) ?? "";
  const financeNow = kinPartFor("finance", "Finance", dollars) ?? "";
  const reworded = growthNow.replace(
    "Two to four lines, under 70 words.",
    "Three lines at most, and never on a Sunday.",
  );
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly doc: string;
    readonly domain?: string;
    readonly money?: typeof pounds;
    readonly own: string;
  }> = [
    { name: "a default untouched", doc: `${growthNow}\n`, own: "" },
    {
      name: "a line of an older release, untouched",
      doc: `# Finance\n\nFigure first, then the date, then the verdict. No exclamation marks, no emoji, ever. Your humour is dry, rare and the gallows kind.\n`,
      domain: "finance",
      own: "",
    },
    {
      name: "one line added",
      doc: growthNow.replace(
        "## Examples",
        "We sell tiles to clinics, nothing else.\n\n## Examples",
      ),
      own: "We sell tiles to clinics, nothing else.",
    },
    {
      name: "a default line reworded",
      doc: reworded,
      own: reworded.split("\n").find((line) => line.startsWith("Three lines at most"))!,
    },
    {
      name: "a section of his own, after the examples",
      doc: `${growthNow}\n\n## Our clients\n\nClinics in the north.\nNever cold-call a vet.\n`,
      own: "## Our clients\n\nClinics in the north.\nNever cold-call a vet.",
    },
    {
      name: "an example of his own under Kin's heading",
      doc: `${growthNow}\n6. "Invented: Corran wants the pilot by March."\n`,
      own: '## Examples\n\n6. "Invented: Corran wants the pilot by March."',
    },
    {
      name: "everything rewritten",
      doc: `# Growth\n\nTo colleagues: Sells loudly.\n\nYou are loud and kind.\n\n## Examples\n1. "Invented: hello!"\n`,
      own: 'To colleagues: Sells loudly.\n\nYou are loud and kind.\n\n## Examples\n\n1. "Invented: hello!"',
    },
    {
      name: "a company in dollars, compared with its own default",
      doc: financeNow,
      domain: "finance",
      money: dollars,
      own: "",
    },
    {
      name: "an agent renamed: its own name's heading goes too",
      doc: growthNow.replace("# Growth", "# Closer"),
      own: "",
    },
  ];
  for (const row of rows) {
    const domain = row.domain ?? "growth";
    const name = row.doc.startsWith("# Closer")
      ? "Closer"
      : domain === "finance"
        ? "Finance"
        : "Growth";
    assert.strictEqual(
      ownersPart(row.doc, name, shippedLines(domain, row.money ?? pounds)),
      row.own,
      row.name,
    );
  }
  // The dollar default is not a pound company's: compared with the wrong one, its figures look his.
  assert.notStrictEqual(ownersPart(financeNow, "Finance", shippedLines("finance", pounds)), "");
  // An agent with no default keeps its whole doc as the owner's part.
  const own = "# Hiring\n\nInvented: warm with candidates.";
  assert.strictEqual(ownersPart(own, "Hiring", shippedLines("hiring", pounds)), own);
  // Split again, nothing changes.
  const once = ownersPart(rows[4]!.doc, "Growth", shippedLines("growth", pounds));
  assert.strictEqual(ownersPart(once, "Growth", shippedLines("growth", pounds)), once);
});

it("a turn reads Kin's part, then the owner's under one line, and neither when an agent has no default", () => {
  const kin = kinPartFor("growth", "Growth", pounds)!;
  const base = { agentId: "growth", name: "Growth", key: "D-7" };
  const kinOnly: Character = { ...base, body: "", kin };
  const both: Character = {
    ...base,
    body: "To colleagues: Talk tiles.\n\nNever on a Sunday.",
    kin,
  };
  const custom: Character = { ...base, body: "# Growth\n\nInvented: our own.", kin: undefined };
  // Owner-only turns: the doc to change, Kin's part, and the owner's after it when he has one.
  assert.match(characterForTurn(kinOnly, true), /^Doc D-7\b/);
  assert.isTrue(characterForTurn(kinOnly, true).endsWith(kin));
  const whole = characterForTurn(both, true);
  assert.isTrue(whole.indexOf(kin) < whole.indexOf("Never on a Sunday."));
  // Where others read: the voices alone, Kin's then the owner's, no examples.
  assert.notInclude(characterForTurn(kinOnly, false), "## Examples");
  assert.isTrue(characterForTurn(both, false).endsWith("Never on a Sunday."));
  assert.notInclude(characterForTurn(both, false), "To colleagues");
  // No default: the doc is the whole character, as before there were two parts.
  assert.isTrue(characterForTurn(custom, true).endsWith("# Growth\n\nInvented: our own."));
  assert.strictEqual(characterForTurn(custom, false), "Invented: our own.");
  // Colleagues hear the owner's line where he wrote one, else Kin's.
  assert.strictEqual(colleagueLine(both), "- Growth: Talk tiles.");
  assert.include(colleagueLine(kinOnly), "Finds and wins customers");
});

/** The card an earlier release posted in the Chief of staff's chat, as it stored it. */
const oldCard = (answered: boolean) =>
  Effect.gen(function* () {
    const repo = yield* KinChatRepository;
    const chatId = KinChatId.make("chief-chat");
    const [doc] = yield* characters(orgId, growth);
    const message = yield* repo.insertMessage({
      orgId,
      chatId,
      audience: "owner",
      messageId: KinMessageId.make(`${widgetId}:see:${growth}:${doc!.key}:2`),
      author: { _tag: "system" },
      kind: "system",
      body: "You changed Growth's character, so it stays as you wrote it.",
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: at,
      editedAt: null,
    });
    const state = choiceCardState({
      question: "You changed Growth's character, so it stays as you wrote it.",
      detail: "Nothing changes until you choose.",
      options: [
        { label: "See the new one", kind: "yes" },
        { label: "Keep mine", kind: "no" },
      ],
      untilAnswered: true,
    });
    yield* repo.insertWidget({
      orgId,
      chatId,
      messageId: message.messageId,
      widgetId,
      widgetClass: "native",
      type: "choice",
      state,
      source: null,
      feed: null,
      awaiting: [ownerId],
      pinnedAt: null,
      closedAt: answered ? at : null,
      updatedAt: at,
      audience: "owner",
    });
  });

const versionsOf = (agentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ version: number; summary: string; body: string }>`SELECT v.version,
        v.summary, v.body FROM kin_doc_versions v
      JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
      WHERE r.org_id = ${orgId} AND r.origin_key = ${`kin-character:${agentId}`}
      ORDER BY v.version`,
  );

/** A doc as an earlier release left it: the whole character, Kin's text and the owner's. */
const wroteWhole = (agentId: string, body: string) =>
  Effect.gen(function* () {
    const [doc] = yield* characters(orgId, agentId);
    yield* Docs.replaceBody(
      orgId,
      { actor: { _tag: "person", personId: ownerId }, via: "owner" },
      {},
      { key: doc!.key },
      { body, summary: "Edited on its page", originKey: `whole:${agentId}:${body.length}` },
    );
  });

it.effect(
  "at start, each company's docs keep only the owner's lines, once, and the old card closes",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const money = yield* companyMoney(orgId);
      const chiefKin = kinPartFor("chief-of-staff", "Chief of staff", money)!;
      const growthKin = kinPartFor("growth", "Growth", money)!;
      yield* wroteWhole(chief, `${chiefKin}\n`);
      yield* wroteWhole(
        growth,
        growthKin.replace("## Examples", "Invented: we sell tiles to clinics.\n\n## Examples"),
      );
      yield* oldCard(false);
      const closed: Array<{ widgetId: string; text: string }> = [];
      const chat = {
        closeReplaced: (input: {
          readonly widgetId: string;
          readonly outcome?: { readonly title: string; readonly text: string };
        }) =>
          Effect.sync(
            () => void closed.push({ widgetId: input.widgetId, text: input.outcome?.text ?? "" }),
          ),
      };
      assert.strictEqual(yield* splitCharacters(orgId, chat), 2);
      const [chiefNow, growthNow] = yield* characters(orgId);
      assert.strictEqual(chiefNow!.body.trim(), "");
      assert.strictEqual(growthNow!.body.trim(), "Invented: we sell tiles to clinics.");
      // Nothing is lost: the whole text is the version before Kin's.
      const history = yield* versionsOf(growth);
      assert.deepStrictEqual(history.map((one) => one.summary).slice(-2), [
        "Edited on its page",
        "Kept your own lines; Kin's part is now separate",
      ]);
      assert.include(history.at(-2)!.body, "Finds and wins customers");
      assert.deepStrictEqual(closed, [
        { widgetId, text: "Growth now has Kin's part and yours; nothing to choose." },
      ]);
      // A second start changes nothing, even after a new whole text lands.
      yield* wroteWhole(chief, `${chiefKin}\n\n`);
      assert.strictEqual(yield* splitCharacters(orgId, chat), 0);
      assert.strictEqual((yield* characters(orgId, chief))[0]!.body.trim(), chiefKin);
      assert.lengthOf(closed, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("the split writes only over the version it read", () =>
  Effect.gen(function* () {
    yield* seed();
    const [doc] = yield* characters(orgId, growth);
    yield* wroteWhole(growth, "Invented: edited since.");
    const written = yield* Docs.replaceBody(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {},
      { key: doc!.key },
      { body: "", summary: "Kept your own lines", originKey: "split:stale", atVersion: 1 },
    );
    assert.isFalse(written.created);
    assert.strictEqual(
      (yield* characters(orgId, growth))[0]!.body.trim(),
      "Invented: edited since.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a new agent's part starts empty, and editing it never stores or changes Kin's part",
  () =>
    Effect.gen(function* () {
      yield* seed("sales-and-marketing");
      const today = kinPartFor("growth", "Growth", yield* companyMoney(orgId))!;
      const [fresh] = yield* characters(orgId, growth);
      assert.strictEqual(fresh!.body, "");
      assert.strictEqual(fresh!.kin, today);
      // A page that knows only the single field sends both parts back: only the rest is kept.
      yield* setCharacter(orgId, growth, `${today}\n\nInvented: be more direct.`, ownerId);
      const [mine] = yield* characters(orgId, growth);
      assert.strictEqual(mine!.body.trim(), "Invented: be more direct.");
      assert.strictEqual(mine!.kin, today);
      // Clearing his part is a way back.
      yield* TestClock.adjust("1 minute");
      yield* setCharacter(orgId, growth, "", ownerId);
      assert.strictEqual((yield* characters(orgId, growth))[0]!.body.trim(), "");
    }).pipe(Effect.provide(layer)),
);
