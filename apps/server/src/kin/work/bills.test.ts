// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
// @effect-diagnostics nodeBuiltinImport:off -- uploads are bytes laid in the test's attachments directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinBillBatchCard,
  type KinBillRead,
  KinChatId,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  KinWakeupId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { recordTestUploadOwner, TEST_UPLOAD_OWNER } from "../../assets/AttachmentUpload.testkit.ts";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as AttachmentStore from "../chat/KinAttachmentStore.ts";
import * as KinChatHub from "../chat/KinChatHub.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinFloor from "../floor/KinFloor.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Bills from "./bills.ts";
import { billTurn } from "./billTurn.ts";
import * as KinRecords from "./KinRecords.ts";
import { moneySummary } from "./moneyViews.ts";
import { newExpense } from "./ownerMoneyAnswers.ts";
import { defineList, PRESETS, presetDefinition } from "./registers.ts";
import { KIN_OWNER_LEVEL } from "./teamView.ts";

// Ambermill, an invented company: Rhea owns it, Meera is a co-owner, Zoya a member.
const orgId = KinOrgId.make("kin-default");
const rhea = KinPersonId.make("kin-default-owner");
const meera = KinPersonId.make("meera");
const zoya = KinPersonId.make("zoya");
const finance = KinAgentId.make("finance");
const at = "2026-11-01T00:00:00.000Z";
const NOW = Date.parse("2026-11-20T06:00:00.000Z");
const as = (personId: KinPersonId) => [{ _tag: "person" as const, orgId, personId }];

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: rhea },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: finance,
      ownerPersonId: rhea,
      threadId: ThreadId.make("finance-thread"),
    }),
});
const documents = Layer.succeed(
  DocumentText.DocumentText,
  DocumentText.DocumentText.of({ ensure: () => Effect.succeed(undefined) }),
);
const layer = Layer.mergeAll(KinRecords.layer, identity, KinChatHub.layer, KinFloor.layer).pipe(
  Layer.provideMerge(AttachmentStore.layer),
  Layer.provideMerge(documents),
  Layer.provideMerge(KinChatRepository.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-bills-" })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(7)),
    ),
  ),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

/** A person's fresh upload, as `attachments.createUploadUrl` and its POST leave one. */
const upload = (name: string, text: string, mimeType = "image/png") =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const extension = name.split(".").at(-1)!;
    const id = createPendingAttachmentId(extension === "png" ? undefined : extension)!;
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(attachmentsDir, `${id}.${extension}`),
      new TextEncoder().encode(text),
    );
    recordTestUploadOwner(attachmentsDir, id, TEST_UPLOAD_OWNER);
    return {
      type: mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
      id,
      name,
      mimeType,
      sizeBytes: text.length,
    };
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT OR IGNORE INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [personId, name, access] of [
    [rhea, "Rhea", "owner"],
    [meera, "Meera", "co_owner"],
    [zoya, "Zoya Sheikh", "member"],
  ] as const)
    yield* sql`INSERT OR IGNORE INTO kin_people (person_id, org_id, handle, display_name, created_at,
        access)
      VALUES (${personId}, ${orgId}, ${personId}, ${name}, ${at}, ${access})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
      created_at, retired_at)
    VALUES (${finance}, ${orgId}, 'Finance', 'lead', ${rhea}, ${at}, NULL)`;
  for (const [chatId, personId] of [
    ["rhea-finance", rhea],
    ["meera-finance", meera],
  ] as const) {
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chatId}, ${orgId}, 'direct', ${`${personId}:${finance}`}, 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
        person_id, role, joined_at)
      VALUES (${`${chatId}-person`}, ${orgId}, ${chatId}, 'person', ${personId},
        ${personId === rhea ? "owner" : "member"}, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
        role, joined_at)
      VALUES (${`${chatId}-agent`}, ${orgId}, ${chatId}, 'agent', ${finance}, 'member', ${at})`;
  }
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, domain, level_since, thread_id,
      models_json, worker_projects_json, owner_chat_id)
    VALUES (${finance}, ${orgId}, 'Finance', 'finance', 0, 'finance-thread', '{}', '[]',
      'rhea-finance')`;
  yield* defineList(
    orgId,
    {
      _tag: "new",
      id: "expenses",
      ...PRESETS.expenses,
      definition: presetDefinition("expenses", "INR"),
    },
    NOW,
  );
});

const decodeCard = Schema.decodeUnknownSync(KinBillBatchCard);
const card = (batchId: string) =>
  Effect.gen(function* () {
    const repo = yield* KinChatRepository.KinChatRepository;
    const widget = Option.getOrThrow(
      yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(`bills:${batchId}`) }),
    );
    return { ...decodeCard(widget.state), awaiting: widget.awaiting, closed: widget.closedAt };
  });

/** The Finance agent's next turn: Kin hands it the queued bills, as the runner claims them. */
const claimTurn = (n: number) =>
  Effect.gen(function* () {
    const queue = yield* KinEventQueue.KinEventQueue;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.adjust("3 minutes");
    const wakeupId = KinWakeupId.make(`wake-${n}`);
    const events = yield* Effect.scoped(
      queue.claim({ orgId, agentId: finance, wakeupId, model: "test" }),
    );
    yield* sql`UPDATE kin_wakeups SET thread_id = 'finance-thread' WHERE wakeup_id = ${wakeupId}`;
    return { wakeupId, events };
  });
const endTurn = (wakeupId: KinWakeupId, status: "completed" | "failed" = "completed") =>
  Effect.gen(function* () {
    const queue = yield* KinEventQueue.KinEventQueue;
    yield* queue.finish({ orgId, wakeupId, status });
    yield* Bills.turnEnded(orgId, wakeupId);
  });
const billRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    name: string;
    state: string;
    problem: string | null;
    readJson: string | null;
  }>`SELECT name, state, problem, read_json AS "readJson" FROM kin_bill_reads
    WHERE org_id = ${orgId} ORDER BY added_at, position`;
});
/** Finance's `bill_read` answer, in its latest turn. */
const read = (
  input: KinBillRead & { readonly bill: string; readable?: boolean; cannotRead?: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [latest] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId"
      FROM kin_wakeups WHERE org_id = ${orgId} AND agent_id = ${finance}
      ORDER BY started_at DESC, wakeup_id DESC LIMIT 1`;
    const { bill, readable = true, cannotRead, ...printed } = input;
    return yield* Bills.answer(
      { orgId, agentId: finance, wakeupId: latest!.wakeupId },
      { bill, readable, read: printed, cannotRead },
    );
  });

describe("bills in bulk", () => {
  it.effect(
    "an add keeps each new file once, refuses what isn't a bill alone, and a rerun adds nothing",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const files = [
          yield* upload("IMG_0001.png", "sample cloud bill"),
          yield* upload("IMG_0001.png", "tidewater freight bill"),
          yield* upload("scan.pdf", "%PDF-1.4 rent", "application/pdf"),
          yield* upload("notes.txt", "not a bill", "text/plain"),
        ];
        const input = { orgId, attachments: files, clientRequestId: "add-1" };
        const added = yield* Bills.add(as(rhea), input, TEST_UPLOAD_OWNER);
        assert.deepStrictEqual(
          added.added.map((file) => file.name),
          ["IMG_0001.png", "IMG_0001.png", "scan.pdf"],
        );
        assert.deepStrictEqual(added.refused, [
          { name: "notes.txt", reason: "Only photos and PDFs are read as bills." },
        ]);
        assert.strictEqual(added.chatId, "rhea-finance");
        // The files ride on Kin's own silent message in Rhea's chat with Finance, which wakes no one.
        const [message] = yield* sql<{ authorKind: string; silent: number; files: number }>`
          SELECT author_kind AS "authorKind", silent, json_array_length(attachments_json) AS files
          FROM kin_messages WHERE chat_id = 'rhea-finance'`;
        assert.deepStrictEqual(message, { authorKind: "system", silent: 1, files: 3 });
        const first = yield* card(added.batchId);
        assert.strictEqual(first.text, "Reading 3 bills: 0 done.");
        assert.deepStrictEqual(first.awaiting, []);
        // One group of three, queued below anyone's message to Finance.
        const queued = yield* sql<{ tag: string; priority: string; bills: number }>`SELECT tag,
            priority, json_array_length(json, '$.bills') AS bills FROM kin_events
          WHERE org_id = ${orgId} ORDER BY event_id`;
        assert.deepStrictEqual(queued, [{ tag: "bills.read", priority: "P3", bills: 3 }]);
        assert.deepStrictEqual(
          (yield* billRows).map((row) => row.state),
          ["reading", "reading", "reading"],
        );

        // The same call again is the same answer; the same id with other files is refused.
        assert.deepStrictEqual(yield* Bills.add(as(rhea), input, TEST_UPLOAD_OWNER), added);
        assert.include(
          yield* Bills.add(
            as(rhea),
            { ...input, attachments: [yield* upload("other.png", "other")] },
            TEST_UPLOAD_OWNER,
          ).pipe(Effect.flip),
          { reason: "not_allowed" },
        );

        // The same bytes again, under any name: nothing new, each told as already added.
        const again = yield* Bills.add(
          as(meera),
          {
            orgId,
            attachments: [yield* upload("renamed.png", "sample cloud bill")],
            clientRequestId: "add-2",
          },
          TEST_UPLOAD_OWNER,
        );
        assert.deepStrictEqual(again.added, []);
        assert.deepStrictEqual(
          again.already.map((file) => file.name),
          ["renamed.png"],
        );
        assert.isUndefined(again.chatId);
        assert.lengthOf(yield* billRows, 3);

        // A member reaches none of it.
        for (const refused of [
          Bills.add(as(zoya), { ...input, clientRequestId: "zoya" }, TEST_UPLOAD_OWNER),
          Bills.list(as(zoya), { orgId }),
          Bills.keepRead(as(zoya), { orgId, batchId: added.batchId, clientRequestId: "k" }),
          Bills.addAnyway(as(zoya), { orgId, sha256: "a".repeat(64), clientRequestId: "a" }),
          Bills.dismiss(as(zoya), { orgId, sha256: "a".repeat(64) }),
          Bills.readAgain(as(zoya), { orgId, batchId: added.batchId }),
        ])
          assert.include(yield* refused.pipe(Effect.flip), { reason: "not_allowed" });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a quiet turn answers each bill: a clean read is one suggested expense, a blank stays blank, an unanswered one is unread",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const added = yield* Bills.add(
          as(rhea),
          {
            orgId,
            attachments: [
              yield* upload("a.png", "sample cloud"),
              yield* upload("b.png", "no currency"),
              yield* upload("c.png", "smudged"),
            ],
            clientRequestId: "add",
          },
          TEST_UPLOAD_OWNER,
        );
        // Rhea writes to Finance meanwhile: her message is answered before the bills are read.
        yield* (yield* KinEventQueue.KinEventQueue).enqueue({
          _tag: "chat.message",
          orgId,
          agentId: finance,
          eventId: KinEventId.make("rhea-asks"),
          receivedAt: DateTime.makeUnsafe(NOW + 1),
          dedupeKey: null,
          provenance: {
            _tag: "human",
            personId: rhea,
            memberId: KinMemberId.make("rhea-finance-person"),
          },
          chatId: KinChatId.make("rhea-finance"),
          messageId: KinMessageId.make("rhea-asks"),
        });
        const asked = yield* claimTurn(0);
        assert.deepStrictEqual(
          asked.events.map((event) => event._tag),
          ["chat.message"],
        );
        // Her own turn has no bills to answer.
        assert.include(yield* read({ bill: "B1" }).pipe(Effect.flip), { reason: "not_allowed" });
        yield* endTurn(asked.wakeupId);
        const { wakeupId, events } = yield* claimTurn(1);
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["bills.read"],
        );
        const event = events[0]!;
        assert.strictEqual(event._tag, "bills.read");
        if (event._tag !== "bills.read") return;
        const turn = (yield* billTurn(orgId, event))!;
        assert.deepStrictEqual(
          turn.attachments.map((file) => file.name),
          ["B1.png", "B2.png", "B3.png"],
        );
        assert.include(turn.text, "B1 is image 1, B2 is image 2, B3 is image 3.");
        assert.include(turn.text, "write exactly NO_REPLY.");

        assert.deepStrictEqual(
          yield* read({
            bill: "B1",
            vendor: "Sample Cloud",
            date: "2026-11-03",
            amount: "1,180.00",
            currency: "INR",
            tax: "180",
            category: "Software",
            number: "SC-2211",
          }),
          { bill: "B1", result: "B1 saved; the owner keeps it." },
        );
        yield* read({ bill: "B2", vendor: "Tidewater Freight", date: "2026-11-04", amount: "450" });
        assert.include(yield* read({ bill: "B9" }).pipe(Effect.flip), { reason: "not_found" });
        assert.deepStrictEqual(yield* read({ bill: "B1", vendor: "Changed" }), {
          bill: "B1",
          result: "B1 is already answered.",
        });
        yield* endTurn(wakeupId);

        const rows = yield* billRows;
        assert.deepStrictEqual(
          rows.map(({ state, problem }) => [state, problem]),
          [
            ["read", null],
            ["unreadable", "Couldn't read: currency"],
            ["unreadable", "Kin could not read this one"],
          ],
        );
        // What was read is kept as given, the blank left out.
        assert.deepStrictEqual(JSON.parse(rows[1]!.readJson!), {
          vendor: "Tidewater Freight",
          date: "2026-11-04",
          amount: "450",
        });
        const [expense] = yield* sql<{
          title: string;
          state: string;
          confirmed: number;
          amount: number;
          currency: string;
          category: string;
          fields: string;
          origin: string;
        }>`SELECT title, state, confirmed, amount_minor AS amount, currency, category,
            fields_json AS fields, origin_key AS origin
          FROM kin_records WHERE register_id = 'expenses'`;
        const [bill] = (yield* Bills.list(as(rhea), { orgId, batchId: added.batchId })).bills;
        const fields = JSON.parse(expense!.fields) as Record<string, unknown>;
        assert.deepStrictEqual(
          {
            ...expense,
            fields: Object.keys(fields).toSorted(),
            receipt: fields.receipt,
            tax: fields.tax,
          },
          {
            title: "Sample Cloud, Nov 2026",
            state: "done",
            confirmed: 0,
            amount: 118_000,
            currency: "INR",
            category: "software",
            fields: ["receipt", "tax", "vendor"],
            receipt: [bill!.file.attachmentId],
            tax: { minor: 18_000, currency: "INR" },
            origin: `bill:${bill!.sha256}`,
          },
        );
        // Suggested: no Money figure counts it until someone keeps it.
        const spent = () =>
          moneySummary(orgId, NOW, KIN_OWNER_LEVEL).pipe(
            Effect.map((summary) => summary.spent.thisMonth.total),
          );
        assert.deepStrictEqual(yield* spent(), []);

        const done = yield* card(added.batchId);
        assert.strictEqual(done.text, "3 bills: 1 read, 2 couldn't be read.");
        assert.deepStrictEqual(done.awaiting, [rhea]);
        // After its turn, nothing answers: the turn is over.
        assert.include(yield* read({ bill: "B3" }).pipe(Effect.flip), { reason: "not_allowed" });

        const kept = yield* Bills.keepRead(as(meera), {
          orgId,
          batchId: added.batchId,
          clientRequestId: "keep",
        });
        assert.lengthOf(kept.kept, 1);
        assert.deepStrictEqual(
          kept.skipped.map((one) => one.why),
          ["It wasn't read cleanly.", "It wasn't read cleanly."],
        );
        assert.deepStrictEqual(yield* spent(), [{ minor: 118_000, currency: "INR" }]);
        assert.deepStrictEqual(
          yield* Bills.keepRead(as(meera), {
            orgId,
            batchId: added.batchId,
            clientRequestId: "keep",
          }),
          kept,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a bill like a recorded expense waits as a duplicate; adding it anyway, reading again and dismissing each act once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const records = yield* KinRecords.KinRecords;
        const recorded = yield* records.create(
          orgId,
          { actor: { _tag: "person", personId: rhea }, via: "owner", askedBy: rhea },
          {
            list: "expenses",
            originKey: "expense:freight",
            title: "Freight to Pune",
            owner: { _tag: "person", personId: rhea },
            state: "done",
            amount: { minor: 250_000, currency: "INR" },
            dateAt: Date.parse("2026-11-05T18:29:59.999Z"),
            dateAllDay: true,
            fields: { vendor: "Tidewater Freight" },
          },
        );
        const added = yield* Bills.add(
          as(meera),
          {
            orgId,
            attachments: [
              yield* upload("freight.png", "tidewater"),
              yield* upload("lost.png", "lost"),
              yield* upload("zero.png", "free plan"),
            ],
            clientRequestId: "add",
          },
          TEST_UPLOAD_OWNER,
        );
        // Meera's card is in her own chat with Finance.
        assert.strictEqual(added.chatId, "meera-finance");
        const { wakeupId } = yield* claimTurn(1);
        assert.deepStrictEqual(
          yield* read({
            bill: "B1",
            vendor: "TIDEWATER  freight",
            date: "2026-11-05",
            amount: "2500",
            currency: "INR",
          }),
          { bill: "B1", result: "B1 looks like an expense already recorded." },
        );
        yield* read({ bill: "B2", readable: false, cannotRead: "The photo is blurred." });
        yield* read({
          bill: "B3",
          vendor: "Sample Cloud",
          date: "2026-11-06",
          amount: "0",
          currency: "USD",
        });
        yield* endTurn(wakeupId);
        const list = yield* Bills.list(as(rhea), { orgId, batchId: added.batchId });
        assert.deepStrictEqual(
          list.bills.map((bill) => [bill.state, bill.problem, bill.duplicateOf?.key]),
          [
            ["duplicate", undefined, recorded.row.key],
            ["unreadable", "The photo is blurred.", undefined],
            ["unreadable", "It is for 0", undefined],
          ],
        );
        assert.strictEqual(
          (yield* card(added.batchId)).text,
          "3 bills: 1 looks like a duplicate, 2 couldn't be read.",
        );
        const [duplicate, blurred, zero] = list.bills;

        // Added anyway: its own suggested expense, once, however often asked.
        const anyway = yield* Bills.addAnyway(as(rhea), {
          orgId,
          sha256: duplicate!.sha256,
          clientRequestId: "anyway",
        });
        assert.deepStrictEqual(
          yield* Bills.addAnyway(as(rhea), {
            orgId,
            sha256: duplicate!.sha256,
            clientRequestId: "anyway",
          }),
          anyway,
        );
        assert.include(
          yield* Bills.addAnyway(as(rhea), {
            orgId,
            sha256: blurred!.sha256,
            clientRequestId: "anyway",
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        // Another company's or no bill at all looks unknown.
        assert.include(
          yield* Bills.dismiss(as(rhea), { orgId, sha256: "f".repeat(64) }).pipe(Effect.flip),
          { reason: "not_found" },
        );

        // Read again queues the blurred one once more; dismissing drops the zero one from the list.
        assert.deepStrictEqual(
          yield* Bills.readAgain(as(rhea), { orgId, sha256: blurred!.sha256 }),
          { queued: 1 },
        );
        assert.deepStrictEqual(yield* Bills.dismiss(as(rhea), { orgId, sha256: zero!.sha256 }), {
          dismissed: true,
        });
        const after = yield* Bills.list(as(rhea), { orgId, batchId: added.batchId });
        assert.deepStrictEqual(
          after.bills.map((bill) => [bill.state, bill.expense?.key === anyway.expense]),
          [
            ["read", true],
            ["reading", false],
          ],
        );
        assert.strictEqual((yield* card(added.batchId)).text, "Reading 3 bills: 2 done.");

        // An unread one typed by hand with its file as the receipt is answered by that expense.
        const again = yield* claimTurn(2);
        yield* read({ bill: "B1", readable: false });
        yield* endTurn(again.wakeupId);
        const typed = yield* newExpense(as(rhea), {
          orgId,
          title: "Pune courier",
          amount: { minor: 30_000, currency: "INR" },
          paidOn: "2026-11-07",
          receipt: [blurred!.file.attachmentId],
          clientRequestId: "typed",
        });
        const byHand = (yield* Bills.list(as(rhea), { orgId, batchId: added.batchId })).bills[1]!;
        assert.deepStrictEqual([byHand.state, byHand.expense?.key], ["kept", typed.expense]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("bills a stopped host left mid-read are queued again, once each", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* Bills.add(
        as(rhea),
        { orgId, attachments: [yield* upload("a.png", "bill")], clientRequestId: "add" },
        TEST_UPLOAD_OWNER,
      );
      // The host stopped after its turn ended and before Kin settled its bill.
      const stopped = sql`UPDATE kin_events SET state = 'done' WHERE tag = 'bills.read'`;
      yield* stopped;
      assert.strictEqual(yield* Bills.sweep(), 1);
      assert.deepStrictEqual(
        (yield* sql<{ state: string }>`SELECT state FROM kin_events ORDER BY state`).map(
          (row) => row.state,
        ),
        ["done", "queued"],
      );
      assert.strictEqual(yield* Bills.sweep(), 0);
      yield* stopped;
      yield* Bills.sweep();
      assert.deepStrictEqual(
        (yield* billRows).map(({ state, problem }) => [state, problem]),
        [["unreadable", "Kin could not read this one"]],
      );
    }).pipe(Effect.provide(layer)),
  );
});
