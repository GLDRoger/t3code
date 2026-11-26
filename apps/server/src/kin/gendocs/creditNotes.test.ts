import "../chat/KinChatService.ts";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinAgentId, KinOrgId, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { moneySummary } from "../work/moneyViews.ts";
import { presetList } from "../work/registers.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import * as CreditNotes from "./creditNotes.ts";
import * as Numbers from "./numbering.ts";

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const now = Date.parse("2026-11-12T06:00:00Z");
const owner = { _tag: "person", personId: ownerId } as const;
const writer = { actor: owner, via: "owner" } as const;
const layer = KinRecords.layer.pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-credit-notes-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("issues and voids a credit note without changing cash received or tax withheld", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords.KinRecords;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-12T06:00:00Z')`;
    yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, created_at, access)
      VALUES (${orgId}, ${ownerId}, 'rhea', 'Rhea', '2026-11-12T06:00:00Z', 'owner')`;
    yield* presetList(orgId, "invoices", now);
    const { row } = yield* records.create(orgId, writer, {
      list: "invoices",
      title: "Tidewater freight",
      owner,
      amount: { minor: 400_000, currency: "USD" },
      originKey: "invoice",
    });
    yield* Numbers.issue(orgId, writer, row.key);
    yield* records.pay(orgId, writer, row.key, {
      amount: { minor: 100_000, currency: "USD" },
      paidOn: "2026-11-12",
      note: "First payment",
      originKey: "bank-payment",
    });
    const notes = yield* CreditNotes.CreditNotes;
    const input = {
      invoice: KinRecordKey.make(row.key),
      amount: { minor: 120_000, currency: "USD" },
      reason: "Scope reduced",
      originKey: "one",
    };
    const note = yield* notes.draft(orgId, writer, input);
    assert.strictEqual((yield* notes.draft(orgId, writer, input)).row.key, note.row.key);
    const invoiceNumber = (yield* records.detail((yield* records.get(orgId, row.key))!)).fields
      ?.number;
    assert.strictEqual(note.row.title, `Credit note for ${invoiceNumber}`);
    assert.include(
      yield* Effect.flip(
        notes.issue(
          orgId,
          {
            actor: { _tag: "agent", agentId: KinAgentId.make("finance") },
            via: "lead",
          },
          note.row.key,
        ),
      ),
      { reason: "not_allowed" },
    );
    const before = yield* moneySummary(orgId, now, KIN_OWNER_LEVEL);
    const issued = yield* notes.issue(orgId, writer, note.row.key);
    assert.isNotNull(issued.number);
    const detail = yield* records.detail((yield* records.get(orgId, row.key))!);
    assert.deepInclude(detail, {
      balance: { minor: 180_000, currency: "USD" },
      received: { minor: 100_000, currency: "USD" },
      credited: { minor: 120_000, currency: "USD" },
    });
    assert.isUndefined(detail.tdsDeducted);
    const reduction = detail.payments?.find((one) => one.creditNote !== undefined);
    assert.deepStrictEqual(reduction?.creditNote, { key: note.row.key, number: issued.number });
    assert.isTrue(reduction?.withheld);
    const after = yield* moneySummary(orgId, now, KIN_OWNER_LEVEL);
    assert.deepStrictEqual(after.received, before.received);
    assert.deepStrictEqual(after.tdsDeducted, before.tdsDeducted);
    yield* notes.voidEntry(orgId, writer, note.row.key);
    assert.strictEqual((yield* records.get(orgId, row.key))!.paid, 100_000);
  }).pipe(Effect.provide(CreditNotes.layer.pipe(Layer.provideMerge(layer)))),
);
