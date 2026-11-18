// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  type KinWorkCommentInput,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadWork from "./leadWork.ts";
import * as OwnerWork from "./ownerWork.ts";
import { commentFileReadable } from "./recordComments.ts";
import * as Comments from "./workComments.ts";

// Invented org, people and work only: Ambermill, its owner Rhea, Zoya and Arjun, and one agent.
const orgId = KinOrgId.make("org");
const rheaId = KinPersonId.make("rhea");
const zoyaId = KinPersonId.make("zoya");
const arjunId = KinPersonId.make("arjun");
const chief = KinAgentId.make("chief");
const at = "2026-11-11T00:00:00.000Z";
const person = (personId: KinPersonId) => ({ _tag: "person" as const, orgId, personId });
const rhea = person(rheaId);
const zoya = person(zoyaId);
const arjun = person(arjunId);
const toChief = { _tag: "agent" as const, agentId: chief };

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("chief-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner: rhea,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: chief,
      ownerPersonId: rheaId,
      threadId: ThreadId.make("chief-thread"),
    }),
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-comments-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Rhea owns Chief of staff and chats with it; Zoya and Arjun are members. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${rheaId}, ${orgId}, 'rhea', 'Rhea', ${at}), (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${at}),
      (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${at})`;
  yield* sql`UPDATE kin_people SET access = 'owner' WHERE person_id = ${rheaId}`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${rheaId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('chief-chat', ${orgId}, 'direct', ${`rhea:${chief}`}, 1, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('chief-chat-rhea', ${orgId}, 'chief-chat', 'person', ${rheaId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('chief-chat-lead', ${orgId}, 'chief-chat', 'agent', ${chief}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 0, 'chief-thread', '{}', '[]', 'chief-chat')`;
});

/** Chief of staff's running turn, woken by Rhea's message in her chat with it. */
const rheaTurn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES ('ask', ${orgId}, 'chief-chat', 1, 'human', ${rheaId}, 'chief-chat-rhea', 'owner',
      'text', 'Invented: plan the launch', '[]', 'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES ('wake', ${orgId}, ${chief}, 'chief-thread', 'test', 0, 'running', '["ask-event"]', 'owner_only')`;
  const event = {
    _tag: "chat.message",
    orgId,
    agentId: chief,
    eventId: "ask-event",
    receivedAt: at,
    dedupeKey: null,
    provenance: { _tag: "human", personId: rheaId, memberId: "chief-chat-rhea" },
    chatId: "chief-chat",
    messageId: "ask",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('ask-event', ${orgId}, ${chief}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', 'wake')`;
});

const task = (title: string, extra: Partial<Parameters<typeof OwnerWork.create>[1]> = {}) =>
  OwnerWork.create([rhea], {
    orgId,
    title: `Invented: ${title}`,
    clientRequestId: title,
    ...extra,
  });
const say = (who: typeof rhea, key: string, body: string, id = body) =>
  Comments.comment([who], { orgId, key, clientRequestId: id, body });
const commentWakes = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<{ json: string }>`SELECT json FROM kin_events
      WHERE tag = 'record.changed' AND json_extract(json, '$.reason') = 'commented'
      ORDER BY event_id`,
  ),
  Effect.map((rows) => rows.map((row) => JSON.parse(row.json) as Record<string, unknown>)),
);

it.effect("a comment is its verified author's, shows on the sheet, and changes nothing else", () =>
  Effect.gen(function* () {
    yield* seed;
    const made = yield* task("book the venue", {
      notes: "Invented brief",
      owner: { _tag: "person", personId: zoyaId },
    });
    // The author is the session's person, whatever the call claims.
    const claimed = {
      orgId,
      key: made.key,
      clientRequestId: "claim",
      body: "Invented: the hall is free Friday",
      author: { _tag: "person", personId: rheaId },
    };
    const input: KinWorkCommentInput = claimed;
    const { comment } = yield* Comments.comment([zoya], input);
    assert.deepInclude(comment, {
      by: { _tag: "person", personId: zoyaId },
      body: "Invented: the hall is free Friday",
      seq: 1,
      canRemove: true,
    });
    const sheet = yield* OwnerWork.get([rhea], { orgId, key: made.key });
    assert.deepStrictEqual(
      sheet.comments?.map((one) => [one.commentId, one.canRemove]),
      [[comment.commentId, true]],
    );
    assert.strictEqual(sheet.olderComments, false);
    // A comment is not a change: the brief, the revision and the history stay as they were.
    assert.include(sheet, { notes: "Invented brief", rev: made.rev });
    assert.lengthOf(sheet.changes, made.changes.length);
    // Zoya's own sheet lets her take back hers.
    const hers = yield* OwnerWork.get([zoya], { orgId, key: made.key });
    assert.deepInclude(hers.comments?.[0], { commentId: comment.commentId, canRemove: true });
    // An identical retry is the same comment; the same key with other words is refused.
    assert.deepInclude(yield* Comments.comment([zoya], input), { comment });
    assert.include(
      yield* Effect.flip(Comments.comment([zoya], { ...input, body: "Invented: other words" })),
      { reason: "not_allowed" },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("someone who can't see an entry can neither comment on it nor read its comments", () =>
  Effect.gen(function* () {
    yield* seed;
    const zoyas = yield* task("pay the printer", { owner: { _tag: "person", personId: zoyaId } });
    const { comment } = yield* say(zoya, zoyas.key, "Invented: paid half");
    const refused = [
      yield* Effect.flip(say(arjun, zoyas.key, "Invented: me too")),
      yield* Effect.flip(Comments.page([arjun], { orgId, key: zoyas.key, beforeSeq: 10 })),
      yield* Effect.flip(OwnerWork.get([arjun], { orgId, key: zoyas.key })),
      yield* Effect.flip(
        Comments.removeOne([arjun], { orgId, key: zoyas.key, commentId: comment.commentId }),
      ),
    ];
    for (const error of refused) assert.include(error, { reason: "not_found" });
    // Nor its files: the file check asks the same question.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_record_comment_files (org_id, attachment_id, comment_id)
      VALUES (${orgId}, 'kin-file-invented', ${comment.commentId})`;
    assert.isFalse(yield* commentFileReadable([arjun], "kin-file-invented"));
    assert.isTrue(yield* commentFileReadable([zoya], "KIN-FILE-INVENTED"));
    assert.isTrue(yield* commentFileReadable([rhea], "kin-file-invented"));
  }).pipe(Effect.provide(layer)),
);

it.effect("a person's comment on an agent's task wakes it once, and a retry wakes nobody", () =>
  Effect.gen(function* () {
    yield* seed;
    const made = yield* task("draft the launch mail", { owner: toChief });
    yield* say(rhea, made.key, "Invented: mention the Friday slot", "first");
    yield* say(rhea, made.key, "Invented: mention the Friday slot", "first");
    const wakes = yield* commentWakes;
    assert.lengthOf(wakes, 1);
    assert.deepInclude(wakes[0], {
      agentId: chief,
      key: made.key,
      reason: "commented",
      note: "Invented: mention the Friday slot",
      provenance: { _tag: "human", personId: rheaId, memberId: "chief-chat-rhea" },
    });
    // A second comment is news of its own.
    yield* say(rhea, made.key, "Invented: and the price", "second");
    assert.lengthOf(yield* commentWakes, 2);
    // Zoya may see it but can't message Chief of staff: her comment stands and wakes nobody.
    yield* OwnerWork.share([rhea], { orgId, keys: [made.key], shared: true });
    assert.include((yield* say(zoya, made.key, "Invented: I can help")).comment, { seq: 3 });
    assert.lengthOf(yield* commentWakes, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("its author takes a comment back, an owner any, and nobody else", () =>
  Effect.gen(function* () {
    yield* seed;
    const made = yield* task("print the flyers", { owner: { _tag: "person", personId: zoyaId } });
    yield* OwnerWork.share([rhea], { orgId, keys: [made.key], shared: true });
    const zoyas = (yield* say(zoya, made.key, "Invented: proofs attached")).comment;
    const arjuns = (yield* say(arjun, made.key, "Invented: looks good")).comment;
    assert.include(
      yield* Effect.flip(
        Comments.removeOne([arjun], { orgId, key: made.key, commentId: zoyas.commentId }),
      ),
      { reason: "not_allowed" },
    );
    const own = yield* Comments.removeOne([zoya], {
      orgId,
      key: made.key,
      commentId: zoyas.commentId,
    });
    assert.deepInclude(own.comment, {
      body: "",
      files: [],
      canRemove: false,
      removed: { at: own.comment.removed!.at, by: { _tag: "person", personId: zoyaId } },
    });
    yield* Comments.removeOne([rhea], { orgId, key: made.key, commentId: arjuns.commentId });
    // Both keep their places, shown as removed, to everyone; a retry is the same answer.
    const page = yield* Comments.page([arjun], { orgId, key: made.key, beforeSeq: 100 });
    assert.deepStrictEqual(
      page.comments.map((one) => [one.seq, one.body, one.removed?.by]),
      [
        [1, "", { _tag: "person", personId: zoyaId }],
        [2, "", { _tag: "person", personId: rheaId }],
      ],
    );
    assert.deepInclude(
      (yield* Comments.removeOne([zoya], { orgId, key: made.key, commentId: zoyas.commentId }))
        .comment,
      { removed: own.comment.removed },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("an agent's task and comment in a person's turn carry that person as who asked", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* rheaTurn;
    const made = yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: plan the launch", owner: "Zoya" }],
    });
    const key = made.records[0]!.key;
    const sheet = yield* OwnerWork.get([rhea], { orgId, key });
    assert.deepInclude(sheet, {
      askedBy: rheaId,
      createdBy: { _tag: "agent", agentId: chief },
    });
    assert.strictEqual(sheet.changes.at(-1)?.askedBy, rheaId);
    // A person's own task: they asked; their changes carry no "via".
    const own = yield* task("own task");
    assert.strictEqual(own.askedBy, rheaId);
    assert.notProperty(own.changes[0]!, "askedBy");
    // Its comment is the agent's, for Rhea, and Zoya, who holds it, is told once in her chat.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
      VALUES (${orgId}, ${chief}, ${zoyaId}, ${rheaId}, 0)`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('zoya-chat', ${orgId}, 'direct', ${`${zoyaId}:${chief}`}, 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('zoya-chat-zoya', ${orgId}, 'zoya-chat', 'person', ${zoyaId}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES ('zoya-chat-lead', ${orgId}, 'zoya-chat', 'agent', ${chief}, 'member', ${at})`;
    // Midday, outside anyone's quiet hours: what she is told arrives now.
    yield* TestClock.setTime(Date.parse("2026-11-11T12:00:00.000Z"));
    const said = yield* Comments.leadComment(scope, { key, body: "Invented: venue booked" });
    assert.deepInclude(said, { told: ["Zoya"] });
    yield* Comments.leadComment(scope, { key, body: "Invented: venue booked" });
    const comments = (yield* OwnerWork.get([zoya], { orgId, key })).comments ?? [];
    assert.deepStrictEqual(
      comments.map((one) => [one.commentId, one.by, one.askedBy, one.canRemove]),
      [[said.commentId, toChief, rheaId, false]],
    );
    const told = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE chat_id = 'zoya-chat' AND kind = 'system' ORDER BY seq`;
    assert.strictEqual(
      told.at(-1)?.body,
      `Chief of staff commented on ${key} Invented: plan the launch: Invented: venue booked.`,
    );
    assert.lengthOf(
      told.filter((one) => one.body.includes("commented")),
      1,
    );
  }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);

it.effect("a mail waiting to be confirmed about an entry shows on the sheet of who reads it", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const made = yield* task("send the October invoice", {
      owner: { _tag: "person", personId: zoyaId },
    });
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES ('card-message', ${orgId}, 'chief-chat', 2, 'system', NULL, NULL, 'member', 'system',
        'Send this email?', '[]', 'posted', ${at})`;
    yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
        revision, state_json, awaiting_json, updated_at)
      VALUES ('card', ${orgId}, 'chief-chat', 'card-message', 'native', 'confirm', 1, '{}', '[]', ${at})`;
    yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
        reach, state, created_at, updated_at)
      VALUES (${orgId}, 'mail', 'Mail', 'remote', 'mail.invalid', 'none', 'open', 'active', 1, 1)`;
    const payload = {
      _tag: "email",
      to: ["accounts@client.invalid"],
      cc: [],
      subject: "Invoice for October",
      body: "Invented body",
      threadId: null,
      inReplyTo: null,
      references: null,
      attachments: [
        {
          key: "D-1",
          recordId: "doc",
          version: 1,
          attachmentId: "kin-file",
          sha256: "0",
          name: "invoice.pdf",
          mimeType: "application/pdf",
          bytes: 10,
          label: null,
          entryRecordId: made.recordId,
        },
      ],
    };
    yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name, pin_digest,
        payload_json, agent_id, wakeup_id, chat_id, widget_id, entry_record_id, proposed_at)
      VALUES (${orgId}, 'ask', 'mail', 'mail_send', 'pin', ${JSON.stringify(payload)}, ${chief},
        'wake', 'chief-chat', 'card', ${made.recordId}, 0)`;
    assert.deepStrictEqual((yield* OwnerWork.get([rhea], { orgId, key: made.key })).waiting, {
      kind: "send",
      chatId: "chief-chat",
      messageId: "card-message",
      widgetId: "card",
      preview: "To accounts@client.invalid: Invoice for October",
      files: [{ name: "invoice.pdf", mimeType: "application/pdf" }],
      at: "1970-01-01T00:00:00.000Z",
    } as never);
    // Zoya holds the task but doesn't read Rhea's chat: no card for her.
    assert.notProperty(yield* OwnerWork.get([zoya], { orgId, key: made.key }), "waiting");
    // Tasks puts the same card on the row, with what its buttons post.
    const rheas = yield* OwnerWork.list([rhea], { orgId, byMove: true });
    assert.deepInclude(rheas.moves?.[0], { key: made.key, group: "needsYou" });
    assert.deepInclude(rheas.moves?.[0]?.card, {
      widgetId: "card",
      revision: 1,
      options: [],
    } as never);
    const hers = yield* OwnerWork.list([zoya], { orgId, byMove: true });
    assert.deepStrictEqual(hers.moves, [{ key: made.key, group: "needsYou" }] as never);
    // Once decided, nothing waits.
    yield* sql`UPDATE kin_connection_asks SET state = 'sent'`;
    assert.notProperty(yield* OwnerWork.get([rhea], { orgId, key: made.key }), "waiting");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "Tasks by whose move: every open match counted past the page, each reader their own",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(Date.parse("2026-11-11T12:00:00.000Z"));
      const toZoya = { owner: { _tag: "person" as const, personId: zoyaId } };
      const later = yield* task("order the banners", { dueAt: "2026-11-20T00:00:00.000Z" });
      const late = yield* task("sign the lease", { dueAt: "2026-11-10T00:00:00.000Z" });
      const waits = yield* task("draft the brochure", {
        ...toZoya,
        dueAt: "2026-11-21T00:00:00.000Z",
      });
      const lateHers = yield* task("call the printer", {
        ...toZoya,
        dueAt: "2026-11-09T00:00:00.000Z",
      });
      // Zoya's own: she asked for it, so it is nobody's move but hers.
      const hersAlone = yield* task("tidy the shelf", toZoya);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET asked_by_person_id = ${zoyaId}, created_by_id = ${zoyaId},
        assigned_by_person_id = NULL
      WHERE org_id = ${orgId} AND key = ${hersAlone.key}`;
      const closed = yield* task("post the letters");
      yield* OwnerWork.update([rhea], { orgId, key: closed.key, rev: closed.rev, state: "done" });
      const page = (who: typeof rhea, cursor?: string) =>
        OwnerWork.list([who], {
          orgId,
          byMove: true,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
      const first = yield* page(rhea);
      assert.deepStrictEqual(first.counts, { needsYou: 3, waiting: 1, rest: 1, doneRecently: 1 });
      assert.strictEqual(first.total, 5);
      const second = yield* page(rhea, first.nextCursor!);
      const third = yield* page(rhea, second.nextCursor!);
      assert.isNull(third.nextCursor);
      assert.deepStrictEqual(
        [...first.moves!, ...second.moves!, ...third.moves!].map((one) => [one.key, one.group]),
        [
          [lateHers.key, "needsYou"],
          [late.key, "needsYou"],
          [later.key, "needsYou"],
          [waits.key, "waiting"],
          [hersAlone.key, "rest"],
        ],
      );
      assert.deepStrictEqual(
        first.records.map((one) => one.key),
        [lateHers.key, late.key],
      );
      // Zoya counts only what she sees; Arjun sees none of it and is given no step for any of it.
      const zoyas = yield* page(zoya);
      assert.deepStrictEqual(zoyas.counts, { needsYou: 3, waiting: 0, rest: 0, doneRecently: 0 });
      const arjuns = yield* page(arjun);
      assert.deepStrictEqual(arjuns.counts, { needsYou: 0, waiting: 0, rest: 0, doneRecently: 0 });
      assert.deepStrictEqual(arjuns.moves, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("asking a late task's holder where it stands posts one line a day in their chat", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
      VALUES (${orgId}, ${chief}, ${rheaId}, 0)`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('zoya-chat', ${orgId}, 'direct', ${`${zoyaId}:${chief}`}, 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('zoya-chat-zoya', ${orgId}, 'zoya-chat', 'person', ${zoyaId}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES ('zoya-chat-lead', ${orgId}, 'zoya-chat', 'agent', ${chief}, 'member', ${at})`;
    yield* TestClock.setTime(Date.parse("2026-11-11T12:00:00.000Z"));
    const made = yield* task("call the printer", {
      owner: { _tag: "person", personId: zoyaId },
      dueAt: "2026-11-09T00:00:00.000Z",
    });
    yield* say(zoya, made.key, "Invented: waiting on the quote");
    const first = yield* OwnerWork.nudge([rhea], { orgId, key: made.key });
    assert.isFalse(first.already);
    const again = yield* OwnerWork.nudge([rhea], { orgId, key: made.key });
    assert.deepStrictEqual(again, { ...first, already: true });
    const told = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE chat_id = 'zoya-chat' AND kind = 'system' AND body LIKE '%asked where%' ORDER BY seq`;
    assert.deepStrictEqual(
      told.map((one) => one.body),
      [`Rhea asked where ${made.key} Invented: call the printer stands.`],
    );
    // The row says it went today, beside the holder's last word.
    const row = (yield* OwnerWork.list([rhea], { orgId, byMove: true })).moves?.[0];
    assert.deepStrictEqual(row, {
      key: made.key,
      group: "needsYou",
      said: "Invented: waiting on the quote",
      nudgedAt: first.nudgedAt,
    } as never);
    // Someone who can't see it, and the holder herself, get nowhere.
    assert.strictEqual(
      (yield* Effect.flip(OwnerWork.nudge([arjun], { orgId, key: made.key }))).reason,
      "not_found",
    );
    assert.strictEqual(
      (yield* Effect.flip(OwnerWork.nudge([zoya], { orgId, key: made.key }))).reason,
      "not_allowed",
    );
  }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);
