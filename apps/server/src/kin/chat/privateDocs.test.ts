import { assert, it } from "@effect/vitest";
import {
  KIN_DOC_CARD,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinWidgetId,
  type KinMessage,
  type KinWidget,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { docsForViewer, PRIVATE_DOC } from "./privateDocs.ts";

// Invented org, people and doc only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const chatId = KinChatId.make("room");
const at = "2026-11-12T00:00:00.000Z";
const layer = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const message: KinMessage = {
  orgId,
  chatId,
  messageId: KinMessageId.make("ask"),
  seq: 1,
  author: { _tag: "human", personId: ownerId, memberId: KinMemberId.make("owner-member") },
  authorRole: "owner",
  kind: "text",
  body: "Can we lower this?",
  refs: [
    {
      _tag: "doc",
      key: "D-1",
      version: 1,
      section: "pricing",
      title: "Invented plan",
      sectionTitle: "Pricing",
    },
  ],
  intent: null,
  mentions: [],
  replyTo: null,
  widgetId: null,
  floorRunId: null,
  status: "posted",
  sentBy: null,
  createdAt: at,
  editedAt: null,
} satisfies KinMessage;
const card = {
  orgId,
  chatId,
  widgetId: KinWidgetId.make("doc:card"),
  messageId: KinMessageId.make("card"),
  widgetClass: "native",
  type: KIN_DOC_CARD,
  revision: 1,
  state: {
    recordId: KinRecordId.make("doc-plan"),
    key: "D-1",
    title: "Invented plan",
    version: 1,
    change: {
      at,
      by: { _tag: "person", personId: ownerId },
      kind: "created",
      summary: "Priced the starter plan",
    },
    previousVersion: null,
    draft: {
      kind: "post",
      text: "Invented launch line",
      sendTo: { personId: ownerId, name: "Owner" },
    },
  },
  source: null,
  feed: null,
  awaiting: [],
  pinnedAt: null,
  closedAt: null,
  updatedAt: at,
} satisfies KinWidget;

it.effect("shows a doc labelled sensitive since as a private document to all but the owner", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}, 'owner'),
        (${mateId}, ${orgId}, 'mate', 'Mate', ${at}, 'member')`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('lead', ${orgId}, 'Lead', 'lead', ${ownerId}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id)
      VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', 'lead-chat')`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'docs', 'Docs', 'D', 1, 0)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
      VALUES (${orgId}, 'doc-plan', 'docs', 'D-1', 'Invented plan', 'agent', 'lead', 0, 'agent',
        'doc-plan', 0, 0)`;
    const page = { messages: [message], widgets: [card] };
    const seenBy = (personId: KinPersonId) => docsForViewer(orgId, { personId }, page);
    // Not sensitive: everyone in the chat sees it as it was sent.
    assert.deepStrictEqual(yield* seenBy(mateId), page);

    yield* sql`UPDATE kin_records SET sensitive = 1 WHERE org_id = ${orgId} AND key = 'D-1'`;
    const mate = yield* seenBy(mateId);
    assert.deepStrictEqual(mate.messages[0]!.refs, [
      {
        _tag: "doc",
        key: "D-1",
        version: 1,
        section: null,
        title: PRIVATE_DOC,
        sectionTitle: null,
      },
    ]);
    assert.include(mate.widgets[0]!.state, { title: PRIVATE_DOC });
    assert.notInclude(JSON.stringify(mate), "Invented plan");
    assert.notInclude(JSON.stringify(mate), "Pricing");
    assert.notInclude(JSON.stringify(mate), "starter plan");
    // A draft's card carries none of the draft: no text to copy, nothing to send up.
    assert.notProperty(mate.widgets[0]!.state, "draft");
    // The owner still sees it normally.
    assert.deepStrictEqual(yield* seenBy(ownerId), page);

    // A teammate's own priced draft keeps its label: she sees her card whole, no one else does,
    // until a person marks it themselves.
    const otherId = KinPersonId.make("other");
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${otherId}, ${orgId}, 'other', 'Other', ${at}, 'member')`;
    yield* sql`UPDATE kin_records SET category = 'proposal',
        fields_json = json_object('draftFor', ${mateId})
      WHERE org_id = ${orgId} AND key = 'D-1'`;
    assert.deepStrictEqual(yield* seenBy(mateId), page);
    assert.include((yield* seenBy(otherId)).widgets[0]!.state, { title: PRIVATE_DOC });
    // Her read lasts while every version is hers: her agent's in a turn she reads, or her own hand.
    // The owner's hand, or an agent's in a turn only owners read, ends it, and her card blanks.
    for (const [actor, by, audience, keeps] of [
      ["agent", "lead", "shared", true],
      ["person", mateId, null, true],
      ["agent", "lead", "owner_only", false],
      ["person", ownerId, null, false],
      ["system", null, null, false],
    ] as const) {
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, title, kind, summary,
          operations_json, actor_kind, actor_id, via, audience, origin_key, created_at)
        VALUES (${orgId}, 'doc-plan', 2, 'Invented plan', 'edited', 'Edited', '[]', ${actor},
          ${by}, 'lead', ${audience}, 'v2', 0)`;
      const state = (yield* seenBy(mateId)).widgets[0]!.state;
      assert.strictEqual("draft" in (state as object), keeps, `${actor} ${by} ${audience}`);
      yield* sql`DELETE FROM kin_doc_versions WHERE org_id = ${orgId} AND version = 2`;
    }
    assert.deepStrictEqual(yield* seenBy(mateId), page);
    yield* sql`UPDATE kin_records SET marked_by_person_id = ${ownerId}
      WHERE org_id = ${orgId} AND key = 'D-1'`;
    assert.notProperty((yield* seenBy(mateId)).widgets[0]!.state, "draft");
  }).pipe(Effect.provide(layer)),
);
