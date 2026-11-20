// Loaded first: the chat and trigger modules import each other.
import { KinChatService } from "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import {
  EnvironmentId,
  KIN_WORK_WS_METHODS,
  type KinAgentChange,
  KinAgentId,
  KinChat,
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemberId,
  KinMessageId,
  KinFinanceRpcs,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinTurnChanges,
  type KinRecordDetail,
  KinWakeupId,
  type KinWorkPrincipal,
  type MemoryItemHead,
  ProviderInstanceId,
  ThreadId,
  kinRpcAccess,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnAudience, turnChat, turnPeople } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { TEAMMATE_WORDS, workEventText } from "../lead/LeadPrompt.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
import { readPeople } from "../lead/peopleRead.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { keepAllDayDays } from "./allDayZone.ts";
import { importWork } from "./importWork.ts";
import { newCompanyProfileJson } from "./companyProfile.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadDocs from "./leadDocs.ts";
import * as LeadMoney from "./leadMoney.ts";
import * as LeadWork from "./leadWork.ts";
import { dayIn } from "./money.ts";
import { KIN_OWNER_LEVEL, type KinViewer, teamVisible, viewerOfPeople } from "./teamView.ts";
import { sensitiveShown } from "./sensitiveReads.ts";
import { KinWorkToolkit } from "./mcp/tools.ts";
import * as Docs from "./docs.ts";
import * as OwnerClients from "./ownerClients.ts";
import * as OwnerDocs from "./ownerDocs.ts";
import * as OwnerMoney from "./ownerMoney.ts";
import * as OwnerWork from "./ownerWork.ts";
import { presetDefinition } from "./registers.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import { agentChanges, ownerLevelUndoAgentChange } from "../lead/agentChanges.ts";
import { turnChanges } from "../lead/turnChanges.ts";
import { buildWorkSection } from "./workPrompt.ts";
import { markQuotesSent } from "../connections/Sending.ts";

// Invented org, people and work only; nothing here reads a real database or memory.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const other = KinAgentId.make("other");
const at = "2026-11-11T00:00:00.000Z";
const owner = { _tag: "person" as const, orgId, personId: ownerId };
const mate = { _tag: "person" as const, orgId, personId: mateId };

const scopeOf = (agent: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agent}-thread`),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
});

const identity = Layer.mock(KinIdentity)({
  owner,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: (scope) =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make(scope.thread!.threadId.replace(/-thread$/, "")),
      ownerPersonId: ownerId,
      threadId: scope.thread!.threadId,
    }),
});
// No chat to show a card in: a proposal stands on the owner's typed answer.
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-records-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Two leads with direct chats with the owner, and a teammate. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}), (${mateId}, ${orgId}, 'mate', 'Mate', ${at})`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('mate-session', ${orgId}, ${mateId}, 0)`;
  for (const agent of [lead, other]) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 'lead', ${ownerId}, ${at}, NULL)`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${`${agent}-chat`}, ${orgId}, 'direct', ${`owner:${agent}`}, 1, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${`${agent}-chat-owner`}, ${orgId}, ${`${agent}-chat`}, 'person', ${ownerId}, 'owner', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES (${`${agent}-chat-lead`}, ${orgId}, ${`${agent}-chat`}, 'agent', ${agent}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id)
      VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 0, ${`${agent}-thread`}, '{}', '[]', ${`${agent}-chat`})`;
  }
});

/** A running turn of `lead`, woken by the owner's (or the teammate's) message in its chat. */
const turn = Effect.fn("KinRecordsTest.turn")(function* (
  from: "owner" | "mate" = "owner",
  audience: "owner_only" | "shared" = "owner_only",
) {
  const sql = yield* SqlClient.SqlClient;
  const author = from === "owner" ? ownerId : mateId;
  if (from === "mate")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES ('ask', ${orgId}, 'lead-chat', 1, 'human', ${author},
      ${from === "owner" ? "lead-chat-owner" : "lead-chat-mate"}, ${from === "owner" ? "owner" : "member"},
      'text', 'Track the invented launch steps', '[]', 'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES ('wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '["ask-event"]', ${audience})`;
  const event = {
    _tag: "chat.message",
    orgId,
    agentId: lead,
    eventId: "ask-event",
    receivedAt: at,
    dedupeKey: null,
    provenance: {
      _tag: "human",
      personId: author,
      memberId: from === "owner" ? "lead-chat-owner" : "lead-chat-mate",
    },
    chatId: "lead-chat",
    messageId: "ask",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('ask-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', 'wake')`;
});

const steps = [
  { title: "Write the invented PRD" },
  { title: "Draft the invented pricing page", due: "2026-11-20" },
  { title: "Chase the invented logo", side: "theirs" as const, owner: "owner" },
];
const assignedEvents = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<{ agentId: string; json: string }>`SELECT agent_id AS "agentId", json
      FROM kin_events WHERE tag = 'record.changed' ORDER BY event_id`,
  ),
);

it.effect("record_create makes many entries in one call and a retry makes none", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const input = { sourceEventId: "ask-event", records: steps };
    const first = yield* LeadWork.create(scopeOf(lead), input);
    assert.deepStrictEqual(
      first.records.map((row) => [row.key, row.created]),
      [
        ["W-1", true],
        ["W-2", true],
        ["W-3", true],
      ],
    );
    // QA Q12: a lead's 30 February is refused too, as a day or a time.
    for (const due of ["2026-02-30", "2026-02-30T18:00+05:30"])
      assert.include(
        yield* Effect.flip(
          LeadWork.create(scopeOf(lead), {
            sourceEventId: "ask-event",
            records: [{ title: "Invented: an impossible day", due }],
          }),
        ),
        { reason: "invalid_state" },
      );
    const retry = yield* LeadWork.create(scopeOf(lead), input);
    assert.deepStrictEqual(
      retry.records.map((row) => [row.key, row.created]),
      [
        ["W-1", false],
        ["W-2", false],
        ["W-3", false],
      ],
    );
    // V01: one refused row saves none of the call, and every refused row is named in one answer.
    const refused = yield* Effect.flip(
      LeadWork.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        records: [
          { title: "Invented: send the launch mail" },
          { title: "Invented: book the venue", owner: "Invented Nobody" },
          { title: "Invented: pay the printer", amount: "-500" },
        ],
      }),
    );
    assert.match(refused.message, /^Row 2 \("Invented: book the venue"\): owner: No one called/);
    assert.match(refused.message, /\nRow 3 \("Invented: pay the printer"\): amount: /);
    assert.include(refused.message, "Nothing in this call was saved. Fix these 2 and send all 3");
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_records`, 3);
    // The owner said it, so it is confirmed, linked to the message, and the owner is its assigner.
    const got = yield* LeadWork.get(scopeOf(lead), { key: "W-2" });
    assert.include(got, {
      state: "open",
      due: "2026-11-20",
      owner: "Lead lead (you)",
      assignedBy: "owner",
    });
    assert.notProperty(got, "suggested");
    assert.deepInclude(got.links, { kind: "message", relation: "source", target: "ask" });
    assert.include(yield* LeadWork.get(scopeOf(lead), { key: "W-3" }), { owner: "owner" });
    // Its own entries, and the owner's, wake nobody.
    assert.lengthOf(yield* assignedEvents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect('"me" is the one person who asked in the turn, and "you" is the lead itself', () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const sql = yield* SqlClient.SqlClient;
    const made = yield* LeadWork.create(scopeOf(lead), {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: book the venue" }, { title: "Invented: print the menus" }],
    });
    const give = (key: string, to: string) =>
      LeadWork.assign(scopeOf(lead), {
        sourceEventId: "ask-event",
        tasks: [{ key, to, reason: "Invented: asked" }],
      });
    // K008: the owner's "give it to me" lands on the owner, not on the lead.
    assert.deepStrictEqual((yield* give("W-1", "me")).tasks, [{ key: "W-1", to: "owner" }]);
    const [mine] = yield* sql<{ kind: string; id: string }>`SELECT owner_kind AS kind,
        owner_id AS id FROM kin_records WHERE key = 'W-1'`;
    assert.deepStrictEqual(mine, { kind: "person", id: ownerId });
    assert.deepStrictEqual((yield* give("W-2", "you")).tasks, [
      { key: "W-2", to: "Lead lead (you)" },
    ]);
    const onMe = yield* LeadWork.query(scopeOf(lead), { owner: "me" });
    assert.deepStrictEqual(
      onMe.records.map((row) => row.key),
      [made.records[0]!.key],
    );
    // A turn no person started has no "me"; "you" still works.
    yield* sql`UPDATE kin_events SET tag = 'record.changed',
      json = json_set(json, '$._tag', 'record.changed', '$.provenance', json('{"_tag":"agent","agentId":"other"}'))
      WHERE event_id = 'ask-event'`;
    const refused = yield* Effect.flip(give("W-2", "me"));
    assert.include(refused, { reason: "invalid_state" });
    assert.include(refused.message, 'Use "you" for yourself, or name the person.');
    assert.include(yield* Effect.flip(LeadWork.query(scopeOf(lead), { owner: "me" })), {
      reason: "invalid_state",
    });
    assert.deepStrictEqual((yield* give("W-1", "you")).tasks, [
      { key: "W-1", to: "Lead lead (you)" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("record_update changes only named fields, logs each change, and both of two land", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    yield* LeadWork.create(scopeOf(lead), { sourceEventId: "ask-event", records: steps });
    const records = yield* KinRecords.KinRecords;
    const moved = yield* LeadWork.update(scopeOf(lead), {
      key: "W-2",
      sourceEventId: "ask-event",
      state: "doing",
    });
    assert.deepStrictEqual(moved, { key: "W-2", rev: 2, state: "doing", changed: ["state"] });
    // A teammate retitles it during the turn; the lead's change to another field lands with it.
    yield* TestClock.setTime(Date.parse("2026-11-11T17:50:00Z"));
    const mateWrites = { actor: mate, via: "owner" as const, askedBy: mateId };
    yield* records.update(orgId, mateWrites, "W-2", {
      title: "Draft the invented pricing page v2",
    });
    yield* LeadWork.update(scopeOf(lead), { key: "W-2", sourceEventId: "ask-event", due: null });
    const got = yield* LeadWork.get(scopeOf(lead), { key: "W-2" });
    assert.include(got, { title: "Draft the invented pricing page v2", state: "doing", rev: 4 });
    assert.notProperty(got, "due");
    assert.deepStrictEqual(
      got.history.map((line) => [line.by, line.change]),
      [
        ["Lead lead (you)", "due: cleared"],
        ["Mate", "title: Draft the invented pricing page v2"],
        ["Lead lead (you)", "state: doing"],
        ["Lead lead (you)", "created"],
      ],
    );
    // Nothing to change is no change, and a stale revision is refused.
    assert.deepInclude(
      yield* LeadWork.update(scopeOf(lead), {
        key: "W-2",
        sourceEventId: "ask-event",
        state: "doing",
      }),
      { rev: 4, changed: [] },
    );
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scopeOf(lead), {
          key: "W-2",
          sourceEventId: "ask-event",
          state: "done",
          expectedRev: 2,
        }),
      ),
      { reason: "conflict" },
    );
    yield* records.update(orgId, mateWrites, "W-3", { notes: "Invented: mate's note" });
    // V24: keys changes several entries the same way, all or none.
    const both = yield* LeadWork.updateMany(scopeOf(lead), {
      keys: ["W-1", "W-3"],
      sourceEventId: "ask-event",
      state: "doing",
    });
    assert.deepStrictEqual(
      both.entries.map((one) => [one.key, one.rev, one.changed]),
      [
        ["W-1", 2, ["state"]],
        ["W-3", 3, ["state"]],
      ],
    );
    const none = yield* Effect.flip(
      LeadWork.updateMany(scopeOf(lead), {
        keys: ["W-1", "W-99"],
        sourceEventId: "ask-event",
        notes: "Invented: one note for both",
      }),
    );
    assert.match(none.message, /^W-99/);
    assert.include(none.message, "Nothing in this call was saved");
    assert.include(yield* LeadWork.get(scopeOf(lead), { key: "W-1" }), { rev: 2, notes: "" });
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scopeOf(lead), {
          key: "W-2",
          sourceEventId: "not-this-turn",
          state: "done",
        }),
      ),
      { reason: "invalid_state" },
    );
  }).pipe(Effect.provide(layer)),
);

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeKinEvent = Schema.decodeUnknownEffect(KinEvent);
/**
 * An agent's turn, through the real queue: Owner's messages wake `lead` in its chat, at 10:00
 * in New York; W-1 is the owner's task unless `held` gives it to someone.
 */
const asked = Effect.fn("KinRecordsTest.asked")(function* (
  held: KinWorkPrincipal = { _tag: "person", personId: ownerId },
  sensitive = false,
) {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords.KinRecords;
  const queue = yield* KinEventQueue.KinEventQueue;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'America/New_York', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* TestClock.setTime(Date.parse("2026-11-11T15:00:00Z"));
  const ownerWrites = { actor: owner, via: "owner" as const, askedBy: ownerId };
  const mateWrites = { actor: mate, via: "owner" as const, askedBy: mateId };
  yield* records.create(orgId, ownerWrites, {
    originKey: "owner:pricing",
    title: "Draft the invented pricing page",
    owner: held,
    ...(sensitive ? { sensitive: true } : {}),
  });
  let sent = 10;
  let woken = 0;
  let wakeupId = KinWakeupId.make("none");
  const enqueue = Effect.fn("KinRecordsTest.enqueue")(function* (event: object) {
    const at = isoAt(yield* Clock.currentTimeMillis);
    const decoded = yield* decodeKinEvent({
      orgId,
      agentId: lead,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "system" },
      ...event,
    });
    return (yield* queue.enqueue(decoded)).event.eventId;
  });
  const say = Effect.fn("KinRecordsTest.say")(function* (body: string) {
    const messageId = `say-${++sent}`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${messageId}, ${orgId}, 'lead-chat', ${sent}, 'human', ${ownerId}, 'lead-chat-owner',
        'owner', 'text', ${body}, '[]', 'posted', ${isoAt(yield* Clock.currentTimeMillis)})`;
    return yield* enqueue({
      _tag: "chat.message",
      eventId: `${messageId}-event`,
      provenance: { _tag: "human", personId: ownerId, memberId: "lead-chat-owner" },
      chatId: "lead-chat",
      messageId,
    });
  });
  /** The running wake-up ends and the next claims what is queued, as the runner does. */
  const wake = Effect.fn("KinRecordsTest.wake")(function* () {
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    wakeupId = KinWakeupId.make(`wake-${++woken}`);
    yield* TestClock.adjust(20_000);
    yield* Effect.scoped(queue.claim({ orgId, agentId: lead, wakeupId, model: "test" }));
    yield* sql`UPDATE kin_wakeups SET thread_id = 'lead-thread', run_id = 'run',
        audience = 'owner_only' WHERE wakeup_id = ${wakeupId}`;
  });
  const steer = Effect.suspend(() => queue.steer({ orgId, agentId: lead, wakeupId }));
  const later = TestClock.adjust(60_000);
  const rev = Effect.map(records.get(orgId, "W-1"), (row) => row!.rev);
  const write = (sourceEventId: string, change: object) =>
    LeadWork.update(scopeOf(lead), { key: "W-1", sourceEventId, ...change });
  const agentChanges = Effect.map(
    LeadWork.get(scopeOf(lead), { key: "W-1" }),
    (got) => got.history.filter((line) => line.by === "Lead lead (you)").length,
  );
  return {
    sql,
    records,
    enqueue,
    say,
    wake,
    steer,
    later,
    rev,
    write,
    agentChanges,
    ownerWrites,
    mateWrites,
  };
});
type Scene = Effect.Success<ReturnType<typeof asked>>;
/** The owner asks for a new title; Mate retitles W-1 while the turn runs; the agent's write is refused. */
const retitled = Effect.fn("KinRecordsTest.retitled")(function* () {
  const scene = yield* asked();
  const ask = yield* scene.say("Rename W-1 to Invented pricing, final");
  yield* scene.wake();
  yield* scene.later;
  yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v2" });
  const refused = yield* Effect.flip(
    scene.write(ask, { title: "Invented pricing, final", expectedRev: yield* scene.rev }),
  );
  return { scene, ask, refused };
});
const refusedAs = (error: { readonly message: string }, message: RegExp) => {
  assert.propertyVal(error, "reason", "conflict");
  assert.match(error.message, message);
};
const titleOf = (scene: Scene) => Effect.map(scene.records.get(orgId, "W-1"), (row) => row!.title);

// An agent's write never changes a field a person changed since a person last
// addressed its turn, whatever revision it passes; a person's next word to it lets it through.
const row = <E>(name: string, run: Effect.Effect<void, E, Layer.Success<typeof layer>>) => ({
  name,
  run: Effect.provide(run, layer).pipe(Effect.orDie),
});
const keptForPerson = [
  row(
    "a teammate's retitle after the ask is kept, and the refusal says who and what",
    Effect.gen(function* () {
      const { scene, refused } = yield* retitled();
      assert.deepInclude(refused, {
        reason: "conflict",
        message:
          'Nothing changed on W-1: Mate changed its title to "Invented pricing v2" on Wed 11 Nov, 10:01. Tell whoever asked, and change it only if they say so.',
      });
      assert.strictEqual(yield* titleOf(scene), "Invented pricing v2");
      assert.strictEqual(yield* scene.agentChanges, 0);
    }),
  ),
  ...(["a new wake-up", "the running wake-up, steered"] as const).map((how) =>
    row(
      `the owner's "use mine anyway" in ${how} lets it through`,
      Effect.gen(function* () {
        const { scene } = yield* retitled();
        yield* scene.later;
        const yes = yield* scene.say("Yes, use Invented pricing, final anyway");
        if (how === "a new wake-up") yield* scene.wake();
        else assert.lengthOf(yield* scene.steer, 1);
        yield* scene.write(yes, { title: "Invented pricing, final" });
        assert.strictEqual(yield* titleOf(scene), "Invented pricing, final");
      }),
    ),
  ),
  row(
    "a change that wakes the agent after an older ask is kept; an untouched field is written",
    Effect.gen(function* () {
      const scene = yield* asked({ _tag: "agent", agentId: lead });
      yield* scene.wake();
      const ask = yield* scene.say("Start on W-1");
      yield* scene.later;
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", { state: "done" });
      yield* scene.wake();
      const claimed = yield* scene.sql<{ tag: string }>`SELECT e.tag FROM kin_events e
        JOIN kin_wakeups w ON w.wakeup_id = e.wakeup_id AND w.status = 'running'
        WHERE e.org_id = ${orgId} ORDER BY e.received_at`;
      assert.deepStrictEqual(
        claimed.map((one) => one.tag),
        ["chat.message", "record.changed"],
      );
      refusedAs(
        yield* Effect.flip(scene.write(ask, { state: "doing", expectedRev: yield* scene.rev })),
        /^Nothing changed on W-1: Owner changed its state to /,
      );
      yield* scene.write(ask, { notes: "Invented: pricing tiers" });
      assert.include(yield* scene.records.get(orgId, "W-1"), {
        state: "done",
        notes: "Invented: pricing tiers",
      });
    }),
  ),
  row(
    "a task a person gives the agent: the wake-up it gets sets its state and other fields",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", {
        owner: { _tag: "agent", agentId: lead },
      });
      yield* scene.wake();
      const [given] = yield* scene.sql<{ eventId: string }>`SELECT event_id AS "eventId"
        FROM kin_events WHERE org_id = ${orgId} AND tag = 'record.changed'`;
      yield* scene.write(given!.eventId, {
        state: "doing",
        title: "Invented pricing tiers",
        due: "2026-11-20",
        expectedRev: yield* scene.rev,
      });
      assert.include(yield* scene.records.get(orgId, "W-1"), {
        state: "doing",
        title: "Invented pricing tiers",
        ownerKind: "agent",
      });
    }),
  ),
  row(
    "a state that would clear the waiter a person just set is refused",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", {
        state: "waiting",
        waitingOn: { _tag: "person", personId: ownerId },
      });
      yield* scene.later;
      const ask = yield* scene.say("Start on W-1");
      yield* scene.wake();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", {
        waitingOn: { _tag: "person", personId: mateId },
      });
      refusedAs(
        yield* Effect.flip(scene.write(ask, { state: "doing", expectedRev: yield* scene.rev })),
        /^Nothing changed on W-1: Mate changed who it waits on to Mate on /,
      );
      assert.strictEqual(yield* scene.agentChanges, 0);
    }),
  ),
  row(
    "a hand-back after a person's later state change is refused",
    Effect.gen(function* () {
      const scene = yield* asked({ _tag: "agent", agentId: lead });
      const ask = yield* scene.say("How is W-1 going?");
      yield* scene.wake();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", { state: "doing" });
      refusedAs(
        yield* Effect.flip(
          LeadWork.handBack(scopeOf(lead), {
            key: "W-1",
            sourceEventId: ask,
            note: "Invented: needs the price list",
          }),
        ),
        /^Nothing changed on W-1: Owner changed its state to /,
      );
      const row = yield* scene.records.get(orgId, "W-1");
      assert.include(row, { ownerKind: "agent", state: "doing" });
    }),
  ),
  row(
    "a field no person touched is written, with expectedRev and without",
    Effect.gen(function* () {
      const { scene, ask } = yield* retitled();
      yield* scene.write(ask, { due: "2026-11-20" });
      yield* scene.write(ask, { notes: "Invented: pricing tiers", expectedRev: yield* scene.rev });
      const row = yield* scene.records.get(orgId, "W-1");
      assert.include(row, { title: "Invented pricing v2", notes: "Invented: pricing tiers" });
      assert.isNotNull(row!.dueAt);
    }),
  ),
  row(
    "a check-in keeps a change made during it, not one made before it fired",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v2" });
      yield* scene.later;
      const checkIn = yield* scene.enqueue({
        _tag: "pulse",
        eventId: "check-in-1",
        factKeys: ["check-in:afternoon"],
        checkIn: {
          scheduleId: "schedule-1",
          title: "Afternoon check-in",
          what: "Look over the invented launch",
          slot: "15:00",
        },
      });
      yield* scene.wake();
      yield* scene.write(checkIn, { title: "Invented pricing v3" });
      yield* scene.later;
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v4" });
      refusedAs(
        yield* Effect.flip(
          scene.write(checkIn, { title: "Invented pricing v5", expectedRev: yield* scene.rev }),
        ),
        /^Nothing changed on W-1: Mate changed its title to "Invented pricing v4" on /,
      );
    }),
  ),
  row(
    "a default taken after a person changed the field since the question is refused",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.say("Should W-1 get a shorter name?");
      yield* scene.wake();
      yield* scene.sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id,
          kind, question, default_label, safe, asked_at, due_at, act_at, state)
        VALUES ('q-1', ${orgId}, ${lead}, ${ownerId}, 'lead-chat', 'card', 'Rename W-1 to Pricing?',
          'Rename it', 1, ${yield* Clock.currentTimeMillis}, 0, 0, 'default_taken')`;
      yield* scene.later;
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v2" });
      yield* scene.later;
      const taken = yield* scene.enqueue({
        _tag: "deferral.due",
        eventId: "question-q-1",
        subject: { type: "question", questionId: "q-1" },
        lateByMs: 0,
      });
      yield* scene.wake();
      refusedAs(
        yield* Effect.flip(scene.write(taken, { title: "Pricing", expectedRev: yield* scene.rev })),
        /^Nothing changed on W-1: Mate changed its title/,
      );
    }),
  ),
  row(
    "a person's own write and their coding agent's are never refused, and the key's counts as theirs",
    Effect.gen(function* () {
      const scene = yield* asked({ _tag: "person", personId: mateId });
      const ask = yield* scene.say("Move W-1 along");
      yield* scene.wake();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", {
        title: "Invented pricing v2",
      });
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v3" });
      yield* scene.records.update(
        orgId,
        { actor: mate, via: "owner", codingAgentKey: "key-1" },
        "W-1",
        { state: "doing" },
      );
      assert.include(yield* scene.records.get(orgId, "W-1"), {
        title: "Invented pricing v3",
        state: "doing",
      });
      refusedAs(
        yield* Effect.flip(scene.write(ask, { state: "done", expectedRev: yield* scene.rev })),
        /^Nothing changed on W-1: Mate changed its state to /,
      );
    }),
  ),
  row(
    "a sensitive entry's new value is not quoted",
    Effect.gen(function* () {
      const scene = yield* asked({ _tag: "person", personId: ownerId }, true);
      const ask = yield* scene.say("Rename W-1 to Invented supplier terms");
      yield* scene.wake();
      yield* scene.later;
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", {
        title: "Invented: the quiet supplier",
      });
      const refused = yield* Effect.flip(
        scene.write(ask, { title: "Invented supplier terms", expectedRev: yield* scene.rev }),
      );
      refusedAs(refused, /^Nothing changed on W-1: Mate changed its title \(value not shown\) on /);
      assert.notInclude(refused.message, "quiet supplier");
    }),
  ),
  row(
    "the check is the write's: a person's write after the agent read it is caught",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.say("Rename W-1");
      yield* scene.wake();
      const since = { at: yield* Clock.currentTimeMillis, woke: [] };
      const read = yield* scene.records.get(orgId, "W-1");
      yield* scene.records.update(orgId, scene.mateWrites, "W-1", { title: "Invented pricing v2" });
      const agent = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
      refusedAs(
        yield* Effect.flip(
          scene.records.update(orgId, { ...agent, since }, read!.key, { title: "Pricing" }),
        ),
        /^Nothing changed on W-1: Mate changed its title/,
      );
      assert.strictEqual(yield* titleOf(scene), "Invented pricing v2");
    }),
  ),
  row(
    "a teammate's turn isn't told what its view of the history withholds; the owner's turn is",
    Effect.gen(function* () {
      const scene = yield* asked();
      const project = (title: string, lead: KinWorkPrincipal) =>
        Effect.map(
          scene.records.create(orgId, scene.ownerWrites, {
            list: "projects",
            title,
            owner: lead,
            originKey: title,
          }),
          (made) => made.row.recordId,
        );
      const shown = yield* project("Invented launch", { _tag: "person", personId: mateId });
      const hidden = yield* project("Invented acquisition", { _tag: "person", personId: ownerId });
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", { team: true });
      const since = { at: yield* Clock.currentTimeMillis, woke: [] };
      yield* scene.later;
      yield* scene.records.update(orgId, scene.ownerWrites, "W-1", { projectId: hidden });
      const agent = {
        actor: { _tag: "agent" as const, agentId: lead },
        via: "lead" as const,
        since,
      };
      const move = (writer: KinRecords.Writer) =>
        Effect.flip(scene.records.update(orgId, writer, "W-1", { projectId: shown }));
      assert.deepInclude(yield* move({ ...agent, view: { people: [mateId], askers: [mateId] } }), {
        reason: "conflict",
        message:
          "Nothing changed on W-1: someone changed it since you were asked. Tell whoever asked, and change it only if they say so.",
      });
      refusedAs(
        yield* move(agent),
        /^Nothing changed on W-1: Owner changed its project \(value not shown\) on Wed 11 Nov, 10:01\. /,
      );
      assert.include(yield* scene.records.get(orgId, "W-1"), { projectId: hidden });
    }),
  ),
  row(
    "a confirmed send marking a quote Sent, and keeping an agent's suggestion, is Kin's, not a person's; their own later change is",
    Effect.gen(function* () {
      const scene = yield* asked();
      yield* scene.sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'quotes', 'Quotes', 'QT', 0, 0, ${JSON.stringify(presetDefinition("quotes", "INR"))})`;
      const { row: quote } = yield* scene.records.create(orgId, scene.ownerWrites, {
        list: "quotes",
        originKey: "quote",
        title: "Invented Acme design work",
        owner: { _tag: "person", personId: ownerId },
        amount: { minor: 300_000_00, currency: "INR" },
        confirmed: false,
      });
      const ask = yield* scene.say("Mail QT-1 to Invented Acme and mark it accepted once sent");
      yield* scene.wake();
      yield* scene.later;
      yield* markQuotesSent(scene.records, {
        orgId,
        personId: ownerId,
        wakeupId: "wake-1",
        attachments: [
          {
            key: "DOC-1",
            recordId: "rec-doc",
            version: 1,
            attachmentId: "att-1",
            sha256: "0",
            name: "QT-1.pdf",
            mimeType: "application/pdf",
            bytes: 1,
            label: null,
            entryRecordId: quote.recordId,
            entryRev: quote.rev,
          },
        ],
      });
      const state = Effect.map(scene.records.get(orgId, "QT-1"), (row) => row!.state);
      assert.strictEqual(yield* state, "waiting");
      assert.strictEqual((yield* scene.records.get(orgId, "QT-1"))!.confirmed, 1);
      const accept = Effect.suspend(() =>
        LeadWork.update(scopeOf(lead), { key: "QT-1", sourceEventId: ask, state: "done" }),
      );
      yield* accept;
      assert.strictEqual(yield* state, "done");
      for (const [writes, name, to] of [
        [scene.mateWrites, "Mate", "open"],
        [scene.ownerWrites, "Owner", "waiting"],
      ] as const) {
        yield* scene.later;
        yield* scene.records.update(orgId, writes, "QT-1", { state: to });
        refusedAs(
          yield* Effect.flip(accept),
          new RegExp(
            `^Nothing changed on QT-1: ${name} changed its state \\(value not shown\\) on `,
          ),
        );
        assert.strictEqual(yield* state, to);
      }
    }),
  ),
];
it.effect.each(keptForPerson)("an agent keeps a person's newer change: $name", ({ run }) => run);

it.effect(
  "a task moved to another project takes its client, and another client takes it off the old one's project",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const records = yield* KinRecords.KinRecords;
      const made = (list: "clients" | "projects", title: string, partyId?: string) =>
        records
          .create(orgId, ownerWrites, {
            list,
            originKey: title,
            title,
            owner: { _tag: "person", personId: ownerId },
            ...(partyId === undefined ? {} : { partyId }),
          })
          .pipe(Effect.map(({ row }) => row));
      const grove = yield* made("clients", "Invented Grove");
      const orbit = yield* made("clients", "Invented Orbit");
      const kept = yield* made("clients", "Invented Kept");
      const groveApp = yield* made("projects", "Invented Grove app", grove.recordId);
      const orbitCare = yield* made("projects", "Invented Orbit care", orbit.recordId);
      const plain = yield* made("projects", "Invented plain project");
      const underOld = yield* ownerTask("under the old client", {
        projectId: groveApp.recordId,
        partyId: grove.recordId,
      });
      const noClient = yield* ownerTask("with no client", { projectId: plain.recordId });
      const ownClient = yield* ownerTask("with its own client", {
        projectId: groveApp.recordId,
        partyId: kept.recordId,
      });
      const clientOf = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => row?.partyId ?? null));
      // A person's move: the old project's client follows to the new project's, logged in the write.
      yield* records.update(orgId, ownerWrites, underOld.key, { projectId: orbitCare.recordId });
      assert.strictEqual(yield* clientOf(underOld.key), orbit.recordId);
      const history = (yield* OwnerWork.get([owner], { orgId, key: underOld.key })).changes;
      assert.deepInclude(
        history.map((change) => change.fields.map((field) => [field.field, field.from, field.to])),
        [
          ["party", grove.key, orbit.key],
          ["project", groveApp.key, orbitCare.key],
        ],
      );
      // An agent's record_update goes the same way: none becomes the new project's client.
      yield* LeadWork.update(scopeOf(lead), {
        key: noClient.key,
        sourceEventId: "ask-event",
        project: orbitCare.key,
      });
      assert.strictEqual(yield* clientOf(noClient.key), orbit.recordId);
      // A client of its own, neither project's, stays put for both.
      yield* LeadWork.update(scopeOf(lead), {
        key: ownClient.key,
        sourceEventId: "ask-event",
        project: orbitCare.key,
      });
      assert.strictEqual(yield* clientOf(ownClient.key), kept.recordId);
      // Given another client, a task leaves a project of a different client in the same write.
      const projectOf = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => row?.projectId ?? null));
      const moving = yield* OwnerWork.get([owner], { orgId, key: underOld.key });
      const moved = yield* OwnerWork.update([owner], {
        orgId,
        key: underOld.key,
        rev: moving.rev,
        party: grove.key,
      });
      assert.isUndefined(moved.project);
      assert.deepInclude(
        moved.changes[0]?.fields.map((field) => [field.field, field.from, field.to]) ?? [],
        ["project", orbitCare.key, null],
      );
      assert.strictEqual(yield* clientOf(underOld.key), grove.recordId);
      const left = yield* LeadWork.update(scopeOf(lead), {
        key: ownClient.key,
        sourceEventId: "ask-event",
        client: grove.key,
      });
      assert.isNull(yield* projectOf(ownClient.key));
      assert.include(left.projectLeft, `${orbitCare.key} is another client's project`);
      // Its project's own client, a project with no client, or both given at once: the project stays.
      const stayed = yield* LeadWork.update(scopeOf(lead), {
        key: noClient.key,
        sourceEventId: "ask-event",
        client: orbit.key,
      });
      assert.strictEqual(yield* projectOf(noClient.key), orbitCare.recordId);
      assert.notProperty(stayed, "projectLeft");
      const onPlain = yield* ownerTask("on a plain project", { projectId: plain.recordId });
      yield* records.update(orgId, ownerWrites, onPlain.key, { partyId: kept.recordId });
      assert.strictEqual(yield* projectOf(onPlain.key), plain.recordId);
      yield* LeadWork.update(scopeOf(lead), {
        key: noClient.key,
        sourceEventId: "ask-event",
        client: grove.key,
        project: orbitCare.key,
      });
      assert.strictEqual(yield* projectOf(noClient.key), orbitCare.recordId);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the owner's assignment wakes the lead once, owner-only, in its chat with the owner",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: compare the two hosting quotes",
        clientRequestId: "new-1",
      });
      assert.include(created, { key: "W-1", state: "open" });
      const retry = {
        orgId,
        title: "Invented: compare the two hosting quotes",
        clientRequestId: "new-1",
      };
      assert.include(yield* OwnerWork.create([owner], retry), { key: "W-1" });
      assert.include(
        yield* Effect.flip(OwnerWork.create([owner], { ...retry, title: "Invented: other" })),
        { reason: "not_allowed" },
      );
      // QA Q12: 30 February was saved as 2 March.
      for (const dueAt of ["2026-02-30T00:00:00.000Z", "2026-02-30"])
        assert.include(
          yield* Effect.flip(
            OwnerWork.create([owner], {
              orgId,
              title: "Invented: an impossible day",
              clientRequestId: `day-${dueAt}`,
              dueAt,
              dueAllDay: dueAt.length === 10,
            }),
          ),
          { reason: "invalid_state" },
        );
      assert.lengthOf(yield* assignedEvents, 0);
      const assigned = yield* OwnerWork.assign([owner], {
        orgId,
        key: "W-1",
        to: { _tag: "agent", agentId: other },
      });
      assert.deepInclude(assigned, { assignedBy: { _tag: "person", personId: ownerId } });
      // Assigning again to the same lead is no change and no second wake-up.
      yield* OwnerWork.assign([owner], {
        orgId,
        key: "W-1",
        to: { _tag: "agent", agentId: other },
      });
      const events = yield* assignedEvents;
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]!.agentId, other);
      assert.deepInclude(JSON.parse(events[0]!.json), {
        key: "W-1",
        reason: "assigned",
        provenance: { _tag: "human", personId: ownerId, memberId: "other-chat-owner" },
      });
      // The turn it wakes is the owner's alone and answers in that lead's chat with the owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids)
      VALUES ('other-wake', ${orgId}, ${other}, 'other-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'other-wake'
      WHERE tag = 'record.changed'`;
      const woken = { orgId, agentId: other, wakeupId: "other-wake" };
      assert.strictEqual(yield* turnAudience(woken), "owner_only");
      assert.deepStrictEqual(yield* turnChat(woken), { chatId: "other-chat", asked: false });
      // The lead moving its own entry wakes nothing.
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = 'other-wake'`;
      yield* LeadWork.update(scopeOf(other), {
        key: "W-1",
        sourceEventId: events[0]!.json.match(/"eventId":"([^"]+)"/)![1]!,
        state: "doing",
      });
      assert.lengthOf(yield* assignedEvents, 1);
      // The owner's task is his alone until he shares it: to a teammate it is no task at all.
      for (const hidden of [
        OwnerWork.assign([mate], { orgId, key: "W-1", to: { _tag: "agent", agentId: lead } }),
        OwnerWork.get([mate], { orgId, key: "W-1" }),
      ])
        assert.deepInclude(yield* hidden.pipe(Effect.asVoid, Effect.flip), {
          reason: "not_found",
          message: "No entry W-1 in Work.",
        });
      assert.lengthOf((yield* OwnerWork.list([mate], { orgId })).records, 0);
      assert.include(yield* OwnerWork.summary([mate], { orgId }), { open: 0, closed: 0, seq: 0 });
    }).pipe(Effect.provide(layer)),
);

it.effect("work given away with no stored owner assigner is recorded and wakes nobody", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    // Kin itself (no human asked) and a lead acting on a teammate's word.
    yield* records.create(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {
        originKey: "invented:1",
        title: "Invented: renew the domain",
        owner: { _tag: "agent", agentId: other },
      },
    );
    yield* records.create(
      orgId,
      { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: mateId },
      {
        originKey: "invented:2",
        title: "Invented: update the deck",
        owner: { _tag: "agent", agentId: other },
      },
    );
    const [system, teammate] = (yield* records.query(orgId, {})).rows.toSorted((a, b) =>
      a.key.localeCompare(b.key),
    );
    assert.include(system, { assignedBy: null, ownerId: other });
    assert.include(teammate, { assignedBy: mateId, ownerId: other });
    assert.lengthOf(yield* assignedEvents, 0);
    // The teammate asked, so she gave it; a lead on its own initiative is the giver itself.
    yield* records.create(
      orgId,
      { actor: { _tag: "agent", agentId: lead }, via: "lead" },
      {
        originKey: "invented:3",
        title: "Invented: chase the printer",
        owner: { _tag: "person", personId: mateId },
      },
    );
    const sql = yield* SqlClient.SqlClient;
    const givers = yield* sql<{ key: string; agent: string | null }>`SELECT key,
        assigned_by_agent_id AS agent FROM kin_records WHERE org_id = ${orgId} ORDER BY key`;
    assert.deepStrictEqual(
      givers.map((row) => row.agent),
      [null, null, lead],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a turn others read gets only what they all see, and a member reaches only their reads",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("mate", "shared");
      const shared = { orgId, agentId: lead, wakeupId: "wake" };
      // Read and changed at the teammate's view, and contact logged; defining lists, payments and
      // the profile stay the owner's.
      const view = new Set([
        "records_query",
        "record_get",
        "record_create",
        "record_update",
        "record_assign",
        "record_hand_back",
        "record_comment",
        "record_link",
        "money_summary",
        "dates_query",
        "deal_stages",
        "touch_log",
      ]);
      assert.lengthOf(Object.keys(KinWorkToolkit.tools), 19);
      for (const tool of Object.keys(KinWorkToolkit.tools))
        assert.strictEqual(yield* sharedToolAllowed(shared, tool, {}), view.has(tool), tool);
      // G06: tasks made for the people there, whoever holds them, are shared with the team.
      const made = yield* LeadWork.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        records: steps,
      });
      assert.lengthOf(made.records, 3);
      assert.lengthOf((yield* OwnerWork.list([mate], { orgId })).records, 3);
      // For a company created now with no country, an amount here says whose choice that is,
      // with nothing more promised; a batch with one says nothing in it was saved.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${ownerId})`;
      const priced = (
        records: ReadonlyArray<{ readonly title: string; readonly amount?: string }>,
      ) =>
        LeadWork.create(scopeOf(lead), { sourceEventId: "ask-event", records }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.deepStrictEqual(
        [
          yield* priced([{ title: "Invented printing", amount: "90" }]),
          yield* priced([
            { title: "Invented proofs" },
            { title: "Invented printing", amount: "90" },
          ]),
        ],
        [
          "Nothing was created: this company's country isn't chosen yet, and Kin records no money until an owner chooses it in Settings, Company details.",
          "Nothing was saved: this company's country isn't chosen yet, and Kin records no money until an owner chooses it in Settings, Company details.",
        ],
      );
      yield* sql`DELETE FROM kin_company_profile WHERE org_id = ${orgId}`;
      // The services check again, so a turn that became shared since the gate is refused too.
      const refused = [
        yield* Effect.flip(
          LeadMoney.define(scopeOf(lead), { sourceEventId: "ask-event", template: "expenses" }),
        ),
        yield* Effect.flip(
          LeadMoney.payment(scopeOf(lead), {
            sourceEventId: "ask-event",
            key: "INV-1",
            amount: "100",
            paidOn: "2026-11-11",
          }),
        ),
        yield* Effect.flip(LeadMoney.profile(scopeOf(lead), {})),
      ];
      for (const error of refused) assert.include(error, { reason: "not_allowed" });
      // Every Work method declares whether a member reaches it: tasks, and the Clients and Money
      // reads, where the service shows them only their view; every other write is owner-level.
      const teammate = new Set([
        "kin.work.parties",
        "kin.work.party",
        "kin.work.projects",
        "kin.work.project",
        "kin.work.lists",
        "kin.work.dates",
        "kin.work.money",
        "kin.work.summary",
        "kin.work.list",
        "kin.work.get",
        "kin.work.subscribe",
        "kin.work.create",
        "kin.work.assign",
        "kin.work.handBack",
        // Whoever asked for it, or the owner level (`workMoves.nudge`).
        "kin.work.nudge",
        // Their own; the owner level anyone's (`handOver`).
        "kin.work.handOver",
        "kin.work.update",
        // Anyone who sees the entry; its author or the owner level removes one.
        "kin.work.comment",
        "kin.work.commentRemove",
        "kin.work.comments",
        // Whoever may edit the entry; the service checks `can.edit`.
        "kin.work.linkAdd",
        "kin.work.linkRemove",
        // Its lead too; the service refuses anyone else (`teamGuard`).
        "kin.work.projectPeople",
        // A member with the Clients switch on; the service checks each call (`memberParty`).
        "kin.work.history",
        "kin.work.createParty",
        "kin.work.updateParty",
        "kin.work.createContact",
        "kin.work.updateContact",
        "kin.work.logTouch",
        "kin.work.removeTouch",
        // Reads of what they see in Clients, refused with it off (`ownerMarketing.ts`, crm tests).
        "kin.work.marketing",
        "kin.work.contactList",
        "kin.work.exportContacts",
      ]);
      const methods = [
        ...Object.values(KIN_WORK_WS_METHODS),
        ...KinFinanceRpcs.map((rpc) => rpc._tag),
      ];
      assert.lengthOf(methods, 52);
      for (const method of methods)
        assert.strictEqual(kinRpcAccess(method) === "person", teammate.has(method), method);
    }).pipe(Effect.provide(layer)),
);

const head = (id: string, fields: Partial<MemoryItemHead>) =>
  ({
    id,
    orgId,
    path: `commitments/${id}.md`,
    kind: "commitment",
    title: `Invented ${id}`,
    status: "open",
    due: null,
    invalid_at: null,
    superseded_by: null,
    sensitive: false,
    ...fields,
  }) as MemoryItemHead;

it.effect("the import brings open commitments and objectives in once", () =>
  Effect.gen(function* () {
    yield* seed;
    const items = [
      head("promise", { due: "2026-11-20", chat: "other-chat" as never }),
      head("goal", { kind: "objective", sensitive: undefined }),
      head("kept", { status: "done" }),
      head("fact", { kind: "claim" }),
      head("wrong", { invalid_at: at }),
    ];
    assert.deepStrictEqual(yield* importWork(orgId, items), { memory: 2 });
    const records = yield* KinRecords.KinRecords;
    const rows = (yield* records.query(orgId, {})).rows;
    assert.sameDeepMembers(
      rows.map((row) => [row.title, row.state, row.ownerId, row.sensitive]),
      [
        ["Invented promise", "open", other, 0],
        // Unlabelled memory stays sensitive.
        ["Invented goal", "open", lead, 1],
      ],
    );
    // Run again, after someone moved one and dropped another: nothing new, nothing overwritten.
    const promise = rows.find((row) => row.title === "Invented promise")!;
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "owner" }, promise.key, {
      state: "done",
    });
    const goal = rows.find((row) => row.title === "Invented goal")!;
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "owner" }, goal.key, {
      state: "dropped",
    });
    assert.deepStrictEqual(yield* importWork(orgId, items), { memory: 0 });
    assert.lengthOf((yield* records.query(orgId, {})).rows, 2);
    assert.include(yield* records.get(orgId, promise.key), { state: "done" });
    assert.include(yield* records.get(orgId, goal.key), { state: "dropped" });
  }).pipe(Effect.provide(layer)),
);

it.effect("the Work section shows a change once: after the lead's reply it is not new again", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords.KinRecords;
    const section = buildWorkSection({
      orgId,
      agentId: lead,
      chatId: "lead-chat" as never,
      now: 0,
    });
    // The 10 Nov shape: a worker's entry finished between two of the owner's messages.
    yield* records.create(
      orgId,
      { actor: { _tag: "agent", agentId: lead }, via: "worker" },
      {
        originKey: "worker:readme",
        title: "Invented README worker",
        state: "doing",
        owner: { _tag: "agent", agentId: lead },
      },
    );
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, "W-1", {
      state: "done",
    });
    const first = yield* section;
    assert.deepStrictEqual(
      first.changed.map((change) => [change.key, change.state, change.changes]),
      [["W-1", "done", ["state → done (Kin)"]]],
    );
    // A silent turn told nobody, so the change is still new.
    const reply = (seq: number, silent: number) =>
      sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
          author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
          mentions_json, status, created_at, silent)
        VALUES (${`reply-${seq}`}, ${orgId}, 'lead-chat', ${seq}, 'agent', ${lead}, ${ownerId},
          'lead-thread', 'lead-chat-lead', 'member', 'text', 'Invented reply', '[]', 'posted', ${at},
          ${silent})`;
    yield* reply(2, 1);
    assert.lengthOf((yield* section).changed, 1);
    yield* sql`UPDATE kin_chats SET last_seq = 2 WHERE chat_id = 'lead-chat'`;
    yield* section;
    // The lead's reply posted: the second prompt does not present the finished item again.
    yield* reply(3, 0);
    const second = yield* section;
    assert.deepStrictEqual(second.changed, []);
    assert.strictEqual(second.open, 0);
  }).pipe(Effect.provide(layer)),
);

/** Every Work wake-up so far: who, why, which entry, and whose authority. */
const wakes = assignedEvents.pipe(
  Effect.map((rows) =>
    rows
      .map((row) => {
        const event = JSON.parse(row.json) as {
          reason: string;
          key: string;
          seq: number;
          provenance: { personId: string; memberId: string };
        };
        return {
          seq: event.seq,
          wake: [row.agentId, event.reason, event.key, event.provenance.personId],
        };
      })
      .toSorted((a, b) => a.seq - b.seq)
      .map((row) => row.wake),
  ),
);
const toLead = { _tag: "agent" as const, agentId: lead };

it.effect(
  "the owner edits an entry field by field, in the owner's name, and a retry is a no-op",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: book the venue",
        dueAt: "2026-11-20T10:00:00.000Z",
        clientRequestId: "edit-1",
      });
      const edit = {
        orgId,
        key: created.key,
        rev: created.rev,
        title: "Invented: book the bigger venue",
        notes: "Invented notes",
        category: "obligation" as const,
        dueAt: null,
      };
      const edited = yield* OwnerWork.update([owner], edit);
      assert.include(edited, { rev: 2, title: edit.title, notes: edit.notes, dueAt: null });
      assert.deepStrictEqual(edited.changes[0], {
        seq: edited.seq!,
        at: edited.changes[0]!.at,
        by: { _tag: "person", personId: ownerId },
        via: "owner",
        kind: "updated",
        fields: [
          { field: "title", from: "Invented: book the venue", to: edit.title },
          { field: "due", from: "2026-11-20T10:00:00.000Z", to: null },
          { field: "notes", from: "", to: "Invented notes" },
          { field: "category", from: null, to: "obligation" },
        ],
      });
      // The same edit again, on the revision it was based on, changes nothing and succeeds.
      const retried = yield* OwnerWork.update([owner], edit);
      assert.include(retried, { rev: 2, seq: edited.seq });
      assert.lengthOf(retried.changes, 2);
      assert.include(
        yield* Effect.flip(OwnerWork.update([owner], { ...edit, title: "Invented: other" })),
        { reason: "conflict" },
      );
      // Waiting on someone who is here, then closed, then reopened, then due on a day.
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([owner], {
            orgId,
            key: created.key,
            rev: 2,
            state: "waiting",
            waitingOn: { _tag: "agent", agentId: KinAgentId.make("nobody") },
          }),
        ),
        { reason: "not_found" },
      );
      const waiting = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 2,
        state: "waiting",
        waitingOn: { _tag: "person", personId: mateId },
      });
      assert.deepInclude(waiting, { waitingOn: { _tag: "person", personId: mateId } });
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 3,
        state: "done",
      });
      assert.include(done, { state: "done", waitingOn: null });
      assert.isNotNull(done.closedAt);
      const reopened = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 4,
        state: "open",
        dueAt: "2026-11-25",
        dueAllDay: true,
      });
      assert.include(reopened, { state: "open", closedAt: null, dueAllDay: true });
      assert.deepStrictEqual(
        reopened.changes.slice(0, 3).map((change) => change.fields.map((field) => field.field)),
        [
          ["state", "due", "dueAllDay"],
          ["state", "waitingOn"],
          ["state", "waitingOn"],
        ],
      );
      // The owner's own entry: nobody to tell.
      assert.lengthOf(yield* wakes, 0);
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: created.key, rev: 5, title: "Invented" }),
        ),
        { reason: "not_found" },
      );
      for (const refused of [
        OwnerWork.confirm([mate], { orgId, key: created.key, rev: 5 }),
        OwnerWork.decline([mate], { orgId, key: created.key, rev: 5 }),
      ])
        assert.include(yield* refused.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "closing, reopening or taking back a lead's open entry tells that lead in an owner-only turn",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const give = (id: string) =>
        OwnerWork.create([owner], {
          orgId,
          title: `Invented: ${id}`,
          owner: toLead,
          clientRequestId: id,
        });
      const first = yield* give("first");
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: first.key,
        rev: 1,
        state: "done",
      });
      const reopened = yield* OwnerWork.update([owner], {
        orgId,
        key: first.key,
        rev: done.rev,
        state: "doing",
      });
      assert.deepInclude(reopened, { assignedBy: { _tag: "person", personId: ownerId } });
      const back = yield* OwnerWork.assign([owner], { orgId, key: first.key, to: null });
      assert.deepInclude(back, { owner: { _tag: "person", personId: ownerId } });
      const second = yield* give("second");
      yield* OwnerWork.assign([owner], {
        orgId,
        key: second.key,
        to: { _tag: "agent", agentId: other },
      });
      assert.deepStrictEqual(yield* wakes, [
        [lead, "assigned", "W-1", ownerId],
        [lead, "withdrawn", "W-1", ownerId],
        [lead, "assigned", "W-1", ownerId],
        [lead, "withdrawn", "W-1", ownerId],
        [lead, "assigned", "W-2", ownerId],
        [lead, "withdrawn", "W-2", ownerId],
        [other, "assigned", "W-2", ownerId],
      ]);
      // A withdrawn turn is the owner's alone and answers in the lead's chat with the owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids)
        VALUES ('told', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'told'
        WHERE tag = 'record.changed' AND agent_id = ${lead}
          AND json_extract(json, '$.reason') = 'withdrawn'`;
      const told = { orgId, agentId: lead, wakeupId: "told" };
      assert.strictEqual(yield* turnAudience(told), "owner_only");
      assert.deepStrictEqual(yield* turnChat(told), { chatId: "lead-chat", asked: false });
      // Its own close, Kin's close on a merge, and the owner's own entry wake nobody.
      const third = yield* give("third");
      const fourth = yield* give("fourth");
      const before = (yield* wakes).length;
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = 'told'`;
      const toldEvent = (yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
        FROM kin_events WHERE wakeup_id = 'told' ORDER BY event_id LIMIT 1`)[0]!.eventId;
      yield* LeadWork.update(scopeOf(lead), {
        key: third.key,
        sourceEventId: toldEvent,
        state: "done",
      });
      yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, fourth.key, {
        state: "done",
      });
      yield* OwnerWork.update([owner], { orgId, key: first.key, rev: back.rev, state: "dropped" });
      assert.lengthOf(yield* wakes, before);
    }).pipe(Effect.provide(layer)),
);

it.effect("assigning refuses closed entries and records the session's owner as the assigner", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* OwnerWork.create([owner], {
      orgId,
      title: "Invented: send the invoice",
      clientRequestId: "assign-1",
    });
    const toMate = yield* OwnerWork.assign([owner], {
      orgId,
      key: created.key,
      to: { _tag: "person", personId: mateId },
      rev: created.rev,
    });
    assert.deepInclude(toMate, {
      owner: { _tag: "person", personId: mateId },
      assignedBy: { _tag: "person", personId: ownerId },
    });
    assert.deepInclude(toMate.changes[0], { by: { _tag: "person", personId: ownerId } });
    for (const state of ["done", "dropped"] as const) {
      const current = yield* OwnerWork.get([owner], { orgId, key: created.key });
      yield* OwnerWork.update([owner], { orgId, key: created.key, rev: current.rev, state });
      for (const to of [toLead, null])
        assert.include(
          yield* Effect.flip(OwnerWork.assign([owner], { orgId, key: created.key, to })),
          { reason: "invalid_state" },
        );
    }
    assert.lengthOf(yield* wakes, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "confirming keeps a lead's suggestion, declining drops it, and a kept one can't be declined",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const suggest = (id: string) =>
        records.create(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
          { originKey: id, title: `Invented: ${id}`, owner: toLead, confirmed: false },
        );
      const kept = (yield* suggest("kept")).row;
      const confirmed = yield* OwnerWork.confirm([owner], { orgId, key: kept.key, rev: kept.rev });
      assert.include(confirmed, { confirmed: true, rev: 2 });
      assert.deepInclude(confirmed.changes[0], {
        by: { _tag: "person", personId: ownerId },
        fields: [{ field: "confirmed", from: "false", to: "true" }],
      });
      assert.include(
        yield* Effect.flip(OwnerWork.decline([owner], { orgId, key: kept.key, rev: 2 })),
        { reason: "invalid_state" },
      );
      const declined = (yield* suggest("declined")).row;
      const dropped = yield* OwnerWork.decline([owner], {
        orgId,
        key: declined.key,
        rev: declined.rev,
      });
      assert.include(dropped, { state: "dropped", confirmed: false, rev: 2 });
      // Retried on the revision it saw: already declined, so it succeeds and changes nothing.
      assert.include(
        yield* OwnerWork.decline([owner], { orgId, key: declined.key, rev: declined.rev }),
        { rev: 2 },
      );
      // The lead held it open, so it is told once.
      assert.deepStrictEqual(yield* wakes, [[lead, "withdrawn", declined.key, ownerId]]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the list filters on not late, due after, category and side, and pages keep their time",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        { title: "a", dueAt: 1 * day, category: "task" },
        { title: "b", dueAt: 3 * day, category: "issue", side: "theirs" },
        { title: "c", dueAt: 5 * day, category: "task" },
        { title: "d", dueAt: null, category: "obligation" },
        { title: "e", dueAt: 2 * day, category: "task" },
      ] as const;
      for (const row of rows)
        yield* records.create(
          orgId,
          { actor: { _tag: "person", personId: ownerId }, via: "owner", askedBy: ownerId },
          {
            ...row,
            originKey: row.title,
            title: `Invented ${row.title}`,
            owner: { _tag: "person", personId: ownerId },
          },
        );
      yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, "W-5", {
        state: "done",
      });
      yield* TestClock.adjust("36 hours");
      const titles = (input: Omit<Parameters<typeof OwnerWork.list>[1], "orgId">) =>
        OwnerWork.list([owner], { orgId, ...input }).pipe(
          Effect.map((page) => page.records.map((record) => record.title)),
        );
      assert.deepStrictEqual(yield* titles({ late: false }), [
        "Invented b",
        "Invented c",
        "Invented d",
        "Invented e",
      ]);
      assert.deepStrictEqual(yield* titles({ category: "task", open: true }), [
        "Invented a",
        "Invented c",
      ]);
      assert.deepStrictEqual(yield* titles({ side: "theirs" }), ["Invented b"]);
      // Due this week and not late, a page at a time: b turns late between the pages, and the
      // second page is still judged as of the first, so c is neither skipped nor repeated.
      const week = {
        open: true,
        late: false,
        dueAfter: "1970-01-02T12:00:00.000Z",
        dueBy: "1970-01-09T12:00:00.000Z",
        limit: 1,
      };
      const first = yield* OwnerWork.list([owner], { orgId, ...week });
      assert.deepInclude(first, { total: 2, nextCursor: `o:1:${1.5 * day}` });
      assert.deepStrictEqual(
        first.records.map((record) => [record.title, record.late]),
        [["Invented b", false]],
      );
      yield* TestClock.adjust("3 days");
      const second = yield* OwnerWork.list([owner], { orgId, ...week, cursor: first.nextCursor! });
      assert.deepInclude(second, { total: 2, nextCursor: null, asOf: first.asOf });
      assert.deepStrictEqual(
        second.records.map((record) => record.title),
        ["Invented c"],
      );
      // The cursor the screens already hold still reads.
      assert.lengthOf((yield* OwnerWork.list([owner], { orgId, cursor: "o:4" })).records, 1);
      assert.include(yield* Effect.flip(OwnerWork.list([owner], { orgId, cursor: "o:x" })), {
        reason: "invalid_state",
      });
      assert.include(yield* OwnerWork.summary([owner], { orgId }), { open: 4, closed: 1 });
    }).pipe(Effect.provide(layer)),
);

it.effect("an entry opens by id, and its links carry what opens the other end", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords.KinRecords;
    const writer = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
    const parent = (yield* records.create(orgId, writer, {
      originKey: "parent",
      title: "Invented launch",
      owner: toLead,
    })).row;
    const step = (yield* records.create(orgId, writer, {
      originKey: "step",
      title: "Invented launch step",
      owner: toLead,
    })).row;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
      VALUES ('old', ${orgId}, ${lead}, 'test', 0, 'completed', '[]')`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
        model_json, provenance_json, status, started_at, title, pull_request_url, pull_request_number)
      VALUES ('wk', ${orgId}, ${lead}, 'old', 'build', 'wk-thread', '{}', '{}', 'running', 0,
        'Invented worker', 'https://github.com/invented/repo/pull/7', 7)`;
    yield* records.link(orgId, writer, step.recordId, {
      kind: "record",
      target: parent.recordId,
      relation: "parent",
    });
    yield* records.link(orgId, writer, step.recordId, {
      kind: "worker",
      target: "wk",
      relation: "attempt",
    });
    yield* records.link(orgId, writer, step.recordId, {
      kind: "record",
      target: "rec_gone",
      relation: "relates",
    });
    const byId = yield* OwnerWork.get([owner], {
      orgId,
      recordId: KinRecordId.make(step.recordId),
    });
    assert.strictEqual(byId.key, step.key);
    assert.deepStrictEqual(
      byId.links.map((link) => [link.target, link.record ?? null, link.worker ?? null]),
      [
        [
          parent.recordId,
          { recordId: KinRecordId.make(parent.recordId), key: parent.key, title: parent.title },
          null,
        ],
        ["rec_gone", null, null],
        [
          "wk",
          null,
          {
            threadId: ThreadId.make("wk-thread"),
            remoteEnvironmentId: null,
            running: true,
            pullRequest: { url: "https://github.com/invented/repo/pull/7", number: 7 },
          },
        ],
      ],
    );
    // An agent reads a linked entry that has the number people see by it, with its key.
    yield* turn();
    const linked = () =>
      LeadWork.get(scopeOf(lead), { key: step.key }).pipe(
        Effect.map((got) => got.links.filter((link) => link.kind === "record")),
      );
    assert.deepStrictEqual(
      (yield* linked()).map((link) => link.target),
      [parent.recordId, "rec_gone"],
    );
    yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/26-27/004')
      WHERE org_id = ${orgId} AND record_id = ${parent.recordId}`;
    assert.deepStrictEqual(
      (yield* linked()).map((link) => link.target),
      [`AM/26-27/004 (${parent.key})`, "rec_gone"],
    );
    // Its own change number moves with its links, not with another entry's change.
    assert.strictEqual(byId.seq, byId.changes[0]!.seq);
    yield* records.update(orgId, writer, parent.key, { state: "doing" });
    assert.strictEqual((yield* OwnerWork.get([owner], { orgId, key: step.key })).seq, byId.seq);
    assert.include(
      yield* Effect.flip(OwnerWork.get([owner], { orgId, recordId: KinRecordId.make("rec_x") })),
      { reason: "not_found" },
    );
    assert.include(
      yield* Effect.flip(
        OwnerWork.get([mate], { orgId, recordId: KinRecordId.make(step.recordId) }),
      ),
      { reason: "not_found", message: "No entry with that id in Work." },
    );
  }).pipe(Effect.provide(layer)),
);

const ownerWrites = {
  actor: { _tag: "person" as const, personId: ownerId },
  via: "owner" as const,
  askedBy: ownerId,
};
const keysOf = (page: { readonly records: ReadonlyArray<{ readonly key: string }> }) =>
  page.records.map((record) => record.key).toSorted();
const ownerTask = (title: string, extra: Partial<KinRecords.CreateInput> = {}) =>
  KinRecords.KinRecords.pipe(
    Effect.flatMap((records) =>
      records.create(orgId, ownerWrites, {
        originKey: title,
        title: `Invented ${title}`,
        owner: { _tag: "person", personId: ownerId },
        ...extra,
      }),
    ),
    Effect.map(({ row }) => row),
  );

it.effect(
  "the people behind a turn come from stored authors, reactors, assigners and origins",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("owner");
      const sql = yield* SqlClient.SqlClient;
      const behind = (
        events: ReadonlyArray<{ readonly tag: string; readonly json: Record<string, unknown> }>,
      ) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM kin_events WHERE event_id != 'ask-event'`;
          for (const [index, event] of events.entries())
            yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
              received_at, queued_at, state, wakeup_id)
            VALUES (${`extra-${index}`}, ${orgId}, ${lead}, ${event.tag}, 'P2',
              ${JSON.stringify(event.json)}, 0, 0, 'claimed', 'wake')`;
          return yield* turnPeople({ orgId, agentId: lead, wakeupId: "wake" });
        });
      const human = (personId: string) => ({ _tag: "human", personId, memberId: "m" });
      const rows = [
        { why: "the owner alone", events: [], people: [], askers: [] },
        {
          why: "the owner's message and a teammate's reaction",
          events: [
            { tag: "chat.reaction", json: { chatId: "lead-chat", provenance: human(mateId) } },
          ],
          people: [mateId],
          askers: [mateId],
        },
        {
          why: "a task a teammate gave it",
          events: [{ tag: "record.changed", json: { provenance: human(mateId) } }],
          people: [mateId],
          askers: [mateId],
        },
        {
          why: "a deferral a teammate's turn set up",
          events: [
            { tag: "deferral.due", json: { origin: { chatId: "lead-chat", personId: mateId } } },
          ],
          people: [mateId],
          askers: [mateId],
        },
      ];
      for (const row of rows)
        assert.deepInclude(
          yield* behind(row.events),
          { people: row.people, askers: row.askers },
          row.why,
        );
    }).pipe(Effect.provide(layer)),
);

it.effect("in a teammate's turn the lead reads and changes Work as their own screens do", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn("mate", "shared");
    const hidden = yield* ownerTask("private");
    const shared = yield* ownerTask("shared", { amount: { minor: 500_000, currency: "INR" } });
    const theirs = yield* ownerTask("theirs", { owner: { _tag: "person", personId: mateId } });
    const sharing = yield* OwnerWork.share([owner], { orgId, keys: [shared.key], shared: true });
    assert.strictEqual(sharing.records[0]?.shared, true);
    const scope = scopeOf(lead);
    const listed = yield* LeadWork.query(scope, {});
    assert.deepStrictEqual(keysOf(listed), keysOf(yield* OwnerWork.list([mate], { orgId })));
    assert.deepStrictEqual(keysOf(listed), [shared.key, theirs.key]);
    for (const row of listed.records) assert.notProperty(row, "amount");
    assert.include(yield* Effect.flip(LeadWork.query(scope, { groupBy: "client" })), {
      reason: "not_allowed",
    });
    // A task they can't see is answered exactly as one that never was, read or changed.
    const unknown = (key: string) =>
      new KinChatError({ reason: "not_found", message: `No entry ${key} in Work.` });
    assert.deepStrictEqual(
      yield* Effect.flip(LeadWork.get(scope, { key: "W-99" })),
      unknown("W-99"),
    );
    assert.deepStrictEqual(
      yield* Effect.flip(LeadWork.get(scope, { key: hidden.key })),
      unknown(hidden.key),
    );
    // By the number people see on screen too: theirs to read, else unknown, as a key is.
    const sql = yield* SqlClient.SqlClient;
    const numbered = (key: string, number: string) =>
      sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', ${number})
        WHERE org_id = ${orgId} AND key = ${key}`;
    yield* numbered(shared.key, "AM/26-27/010");
    yield* numbered(hidden.key, "AM/26-27/011");
    assert.strictEqual((yield* LeadWork.get(scope, { key: "AM/26-27/010" })).key, shared.key);
    for (const number of ["AM/26-27/011", "AM/26-27/012"])
      assert.deepStrictEqual(
        yield* Effect.flip(LeadWork.get(scope, { key: number })),
        unknown(number),
      );
    // Two entries showing one number name neither, rather than a guess.
    yield* numbered(theirs.key, "AM/26-27/010");
    assert.deepStrictEqual(
      yield* Effect.flip(LeadWork.get(scope, { key: "AM/26-27/010" })),
      unknown("AM/26-27/010"),
    );
    yield* numbered(theirs.key, "AM/26-27/013");
    assert.deepStrictEqual(
      yield* Effect.flip(
        LeadWork.update(scope, { key: hidden.key, sourceEventId: "ask-event", state: "done" }),
      ),
      unknown(hidden.key),
    );
    assert.notProperty(yield* LeadWork.get(scope, { key: shared.key }), "amount");
    assert.include(
      yield* LeadWork.update(scope, {
        key: theirs.key,
        sourceEventId: "ask-event",
        state: "doing",
      }),
      { state: "doing" },
    );
    // G06: a task shared with the team is theirs to move on too, but never its label or money.
    assert.include(
      yield* LeadWork.update(scope, { key: shared.key, sourceEventId: "ask-event", state: "done" }),
      { state: "done" },
    );
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scope, { key: shared.key, sourceEventId: "ask-event", sensitive: true }),
      ),
      { reason: "not_allowed" },
    );
    // What it files for them is theirs, so they see it.
    const made = yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: fix the login bug" }],
    });
    assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), made.records[0]!.key);
    // A repeat of a task they can't see is made as if it weren't there, and never named.
    const beside = yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented private" }, { title: "invented theirs" }],
    });
    assert.deepStrictEqual(
      beside.records.map((row) => [row.created, row.alsoOpen]),
      [
        [true, undefined],
        [
          true,
          [{ key: theirs.key, title: "Invented theirs", differs: 'titled "Invented theirs"' }],
        ],
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "in a group the lead reads only what every teammate there may see, and files shared work",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("mate", "shared");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('mate-2', ${orgId}, 'mate2', 'Mate Two', ${at})`;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES ('mate-2-session', ${orgId}, 'mate-2', 0)`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-mate-2', ${orgId}, 'lead-chat', 'person', 'mate-2', 'member', ${at})`;
      const theirs = yield* ownerTask("theirs", { owner: { _tag: "person", personId: mateId } });
      yield* ownerTask("the other's", {
        owner: { _tag: "person", personId: KinPersonId.make("mate-2") },
      });
      const shared = yield* ownerTask("shared");
      yield* OwnerWork.share([owner], { orgId, keys: [shared.key], shared: true });
      const scope = scopeOf(lead);
      assert.deepStrictEqual(keysOf(yield* LeadWork.query(scope, {})), [shared.key]);
      // Even the asker's own task: the other teammate may not see it.
      assert.include(
        yield* Effect.flip(
          LeadWork.update(scope, { key: theirs.key, sourceEventId: "ask-event", state: "done" }),
        ),
        { reason: "not_found" },
      );
      // G06: what it files for the people there is shared with the team, so they all see it.
      const [filed] = (yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: meet the invented client", owner: "Mate Two" }],
      })).records;
      assert.include(keysOf(yield* LeadWork.query(scope, {})), filed!.key);
      // In the company chat, everyone on the team reads: what it files is shared with them all.
      yield* sql`UPDATE kin_chats SET kind = 'team_group', direct_key = NULL, team_id = 'company'
        WHERE chat_id = 'lead-chat'`;
      assert.isTrue(
        yield* sharedToolAllowed({ orgId, agentId: lead, wakeupId: "wake" }, "record_create", {}),
      );
      const [made] = (yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: book the launch room" }],
      })).records;
      // G06: a teammate's client meeting, said in the company chat, is recorded under them.
      const [meeting] = (yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          {
            title: "Invented: call with the client",
            category: "meeting",
            owner: "Mate",
            at: "2026-11-19T15:00+05:30",
            attendees: ["Mate"],
          },
        ],
      })).records;
      assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), meeting!.key);
      // Never made private from a room others read: that is taken to a private chat instead.
      assert.include(
        yield* Effect.flip(
          LeadWork.create(scope, {
            sourceEventId: "ask-event",
            records: [{ title: "Invented: their rate", sensitive: true }],
          }),
        ),
        { reason: "not_allowed" },
      );
      assert.deepStrictEqual(
        keysOf(yield* LeadWork.query(scope, {})).toSorted(),
        [shared.key, filed!.key, made!.key, meeting!.key].toSorted(),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate sees tasks shared with them or theirs, never an unshared private one or any money",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const task = (title: string, extra: Partial<KinRecords.CreateInput> = {}) =>
        records
          .create(orgId, ownerWrites, {
            originKey: title,
            title: `Invented ${title}`,
            owner: { _tag: "person", personId: ownerId },
            ...extra,
          })
          .pipe(Effect.map(({ row }) => row));
      // Every task that exists before sharing is the owner's alone.
      const alone = yield* task("private");
      const shared = yield* task("shared");
      const priced = yield* task("priced", { amount: { minor: 500_000, currency: "INR" } });
      yield* task("theirs", { owner: { _tag: "person", personId: mateId } });
      // G03: what they hold stays theirs to see, even labelled after it was given.
      const labelled = yield* task("theirs but sensitive", {
        owner: { _tag: "person", personId: mateId },
      });
      yield* records.update(orgId, ownerWrites, labelled.key, { sensitive: true });
      const client = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "client",
        title: "Invented Confidential Client",
        owner: { _tag: "person", personId: ownerId },
        sensitive: true,
      })).row;
      const forClient = yield* task("for the client", { partyId: client.recordId });
      // A client and project nobody labelled: still the owner's, and no more known to them.
      const plain = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "plain client",
        title: "Invented Plain Client",
        owner: { _tag: "person", personId: ownerId },
      })).row;
      const project = (yield* records.create(orgId, ownerWrites, {
        list: "projects",
        originKey: "plain project",
        title: "Invented Plain Project",
        owner: { _tag: "person", personId: ownerId },
        partyId: plain.recordId,
      })).row;
      const forPlain = yield* task("for the plain project", { projectId: project.recordId });
      const before = yield* OwnerWork.summary([mate], { orgId });
      // Their change number counts only changes to what they could see: their two tasks.
      assert.include(before, { open: 2, seq: 3 });
      yield* OwnerWork.share([owner], {
        orgId,
        keys: [shared.key, priced.key, forClient.key, forPlain.key],
        shared: true,
      });
      // A task never inherits its client's label: shared, it is theirs to see, naming no client.
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        "W-2",
        "W-3",
        "W-4",
        labelled.key,
        forClient.key,
        forPlain.key,
      ]);
      // The shared task names no client or project to them, on the row, the sheet or its history.
      const plainRow = (yield* OwnerWork.list([mate], { orgId, text: "plain project" }))
        .records[0]!;
      const plainSheet = yield* OwnerWork.get([mate], { orgId, key: forPlain.key });
      for (const shown of [plainRow, plainSheet]) {
        assert.notProperty(shown, "party");
        assert.notProperty(shown, "project");
        for (const name of ["Invented Plain", plain.key, project.key, plain.recordId])
          assert.notInclude(JSON.stringify(shown), name);
      }
      // Keys of a client or project that exist answer exactly as keys that never did.
      const same = Effect.fnUntraced(function* <R>(
        absent: Effect.Effect<object, KinChatError, R>,
        present: Effect.Effect<object, KinChatError, R>,
        absentKey: string,
        presentKey: string,
      ) {
        const missing = yield* Effect.flip(absent);
        const there = yield* Effect.flip(present);
        assert.strictEqual(missing.reason, "not_found");
        assert.deepStrictEqual(
          [there.reason, there.message],
          [missing.reason, missing.message.replace(absentKey, presentKey)],
        );
      });
      // A filter by one they can't see is an empty list, as for one never there (#2).
      const emptied = ({ asOf: _asOf, ...page }: { readonly asOf: string }) => page;
      for (const [field, absentKey, presentKey] of [
        ["party", "C-99", plain.key],
        ["project", "P-99", project.key],
      ] as const)
        assert.deepStrictEqual(
          emptied(yield* OwnerWork.list([mate], { orgId, [field]: presentKey })),
          emptied(yield* OwnerWork.list([mate], { orgId, [field]: absentKey })),
        );
      assert.lengthOf((yield* OwnerWork.list([mate], { orgId, party: "C-99" })).records, 0);
      // "No client" filters what they see, refusing nothing.
      assert.isAtLeast((yield* OwnerWork.list([mate], { orgId, party: null })).records.length, 1);
      const theirs = yield* OwnerWork.get([mate], { orgId, key: "W-4" });
      for (const [field, absentKey, presentKey] of [
        ["party", "C-99", plain.key],
        ["project", "P-99", project.key],
      ] as const) {
        yield* same(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            [field]: absentKey,
            clientRequestId: `absent-${field}`,
          }),
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            [field]: presentKey,
            clientRequestId: `present-${field}`,
          }),
          absentKey,
          presentKey,
        );
        yield* same(
          OwnerWork.update([mate], { orgId, key: theirs.key, rev: theirs.rev, [field]: absentKey }),
          OwnerWork.update([mate], {
            orgId,
            key: theirs.key,
            rev: theirs.rev,
            [field]: presentKey,
          }),
          absentKey,
          presentKey,
        );
      }
      // Counts and the change number cover only what they see, and no client or project sums.
      const summary = yield* OwnerWork.summary([mate], { orgId });
      assert.include(summary, { open: 6, closed: 0 });
      assert.deepStrictEqual([summary.parties, summary.projects], [[], []]);
      assert.isBelow(summary.seq, (yield* OwnerWork.summary([owner], { orgId })).seq);
      // The priced task, without its amount anywhere: not on the row, the sheet or its history.
      const row = (yield* OwnerWork.list([mate], { orgId, text: "priced" })).records[0]!;
      assert.notProperty(row, "amount");
      const sheet = yield* OwnerWork.get([mate], { orgId, key: priced.key });
      assert.notProperty(sheet, "amount");
      assert.deepStrictEqual(sheet.source, { chatId: null, messageId: null });
      assert.notInclude(JSON.stringify(sheet), "5,000");
      assert.notInclude(JSON.stringify(sheet.changes), "team");
      // Hidden ones look exactly like keys that were never there, and ids alike.
      const unknown = yield* Effect.flip(OwnerWork.get([mate], { orgId, key: "W-99" }));
      for (const key of [alone.key]) {
        const hidden = yield* Effect.flip(OwnerWork.get([mate], { orgId, key }));
        assert.deepStrictEqual(
          [hidden.reason, hidden.message],
          [unknown.reason, unknown.message.replace("W-99", key)],
        );
      }
      assert.include(
        yield* Effect.flip(
          OwnerWork.get([mate], { orgId, recordId: KinRecordId.make(alone.recordId) }),
        ),
        { reason: "not_found", message: "No entry with that id in Work." },
      );
      // The sensitive client is no client to them, as a filter or on a new task.
      assert.lengthOf((yield* OwnerWork.list([mate], { orgId, party: client.key })).records, 0);
      assert.include(
        yield* Effect.flip(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            party: client.key,
            clientRequestId: "c",
          }),
        ),
        { reason: "not_found" },
      );
      // Sums and money filters over tasks are the owner's, and a list they see nothing of is none.
      assert.include(yield* Effect.flip(OwnerWork.list([mate], { orgId, list: "expenses" })), {
        reason: "not_found",
      });
      for (const asked of [{ totalsBy: "none" as const }, { paidFrom: "2026-11-01" }])
        assert.include(yield* Effect.flip(OwnerWork.list([mate], { orgId, ...asked })), {
          reason: "not_allowed",
        });
      // The owner hides one by labelling it and takes another back: both are gone at once.
      const current = yield* OwnerWork.get([owner], { orgId, key: shared.key });
      yield* OwnerWork.update([owner], {
        orgId,
        key: shared.key,
        rev: current.rev,
        sensitive: true,
      });
      const unshared = yield* OwnerWork.share([owner], {
        orgId,
        keys: [priced.key],
        shared: false,
      });
      // The row says it is shared only while it is, so the owner's switch shows the truth.
      assert.notProperty(unshared.records[0], "shared");
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        "W-4",
        labelled.key,
        forClient.key,
        forPlain.key,
      ]);
      // Sharing is his: a teammate can't share, confirm or lower a label.
      assert.include(
        yield* Effect.flip(OwnerWork.share([mate], { orgId, keys: ["W-4"], shared: true })),
        { reason: "not_allowed" },
      );
      assert.include(
        yield* Effect.flip(OwnerWork.share([owner], { orgId, keys: ["C-1"], shared: true })),
        {
          reason: "invalid_state",
        },
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate files tasks of their own and changes only theirs, never a label or money",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const filed = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: draft the launch post",
        clientRequestId: "same-id",
      });
      assert.deepInclude(filed, {
        owner: { _tag: "person", personId: mateId },
        createdBy: { _tag: "person", personId: mateId },
        assignedBy: { _tag: "person", personId: mateId },
      });
      // A retry is the same task; the owner's request with the same id is his own.
      assert.include(
        yield* OwnerWork.create([mate], {
          orgId,
          title: "Invented: draft the launch post",
          clientRequestId: "same-id",
        }),
        { key: filed.key },
      );
      const owners = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: the owner's own",
        clientRequestId: "same-id",
      });
      assert.notStrictEqual(owners.key, filed.key);
      // What a teammate files is in the open for the team, and the owner sees it as usual.
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([owner], { orgId })), ["W-1", "W-2"]);
      const done = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: filed.rev,
        state: "done",
        notes: "Invented: posted",
      });
      assert.include(done, { state: "done", notes: "Invented: posted" });
      const reopened = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: done.rev,
        state: "open",
      });
      assert.include(reopened, { state: "open" });
      for (const owned of [{ sensitive: true }, { amount: { minor: 100, currency: "INR" } }])
        assert.deepInclude(
          yield* Effect.flip(
            OwnerWork.update([mate], { orgId, key: filed.key, rev: reopened.rev, ...owned }),
          ),
          { reason: "not_allowed", message: "Only the owner or a co-owner changes that." },
        );
      // Whoever gave a task says whether it comes back, once it has a day to come back from.
      assert.isTrue(reopened.can?.repeat);
      const monthly = { every: "month" as const };
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: filed.key, rev: reopened.rev, repeat: monthly }),
        ),
        { message: "A repeating entry needs a due date or a date to repeat from." },
      );
      const repeating = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: reopened.rev,
        dueAt: "2026-12-01",
        dueAllDay: true,
        repeat: monthly,
      });
      assert.deepStrictEqual(repeating.repeat, monthly);
      const stopped = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: repeating.rev,
        repeat: null,
      });
      assert.isUndefined(stopped.repeat);
      const weekly = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: send the weekly note",
        dueAt: "2026-12-04",
        dueAllDay: true,
        repeat: { every: "days", days: 7 },
        clientRequestId: "weekly",
      });
      assert.deepStrictEqual(weekly.repeat, { every: "days", days: 7 });
      // Closed, the next one is made, still in the open for the team as the first was.
      assert.isTrue(weekly.shared);
      yield* OwnerWork.update([mate], { orgId, key: weekly.key, rev: weekly.rev, state: "done" });
      const next = (yield* OwnerWork.list([owner], { orgId })).records.find(
        (one) => one.title === weekly.title && one.state === "open",
      );
      assert.deepInclude(next, { shared: true, repeat: { every: "days", days: 7 } });
      // One the owner gave them is theirs to work on; how it repeats stays with whoever gave it.
      const handed = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: check the stock list",
        dueAt: "2026-12-04",
        dueAllDay: true,
        owner: { _tag: "person", personId: mateId },
        clientRequestId: "handed",
      });
      assert.isFalse((yield* OwnerWork.get([mate], { orgId, key: handed.key })).can?.repeat);
      assert.deepInclude(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: handed.key, rev: handed.rev, repeat: monthly }),
        ),
        {
          reason: "not_allowed",
          message: "Only the owner, a co-owner or whoever gave the task changes how it repeats.",
        },
      );
      // A task the owner shared with them is theirs to read, not to change.
      yield* OwnerWork.share([owner], { orgId, keys: [owners.key], shared: true });
      const seen = yield* OwnerWork.get([mate], { orgId, key: owners.key });
      assert.isFalse(seen.can?.repeat);
      for (const change of [
        OwnerWork.update([mate], { orgId, key: owners.key, rev: seen.rev, state: "done" }),
        OwnerWork.assign([mate], { orgId, key: owners.key, to: null }),
        OwnerWork.update([mate], { orgId, key: owners.key, rev: seen.rev, repeat: monthly }),
      ])
        assert.include(yield* change.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
      // Given to the owner, it stays theirs to change: they gave it.
      const given = yield* OwnerWork.assign([mate], {
        orgId,
        key: filed.key,
        to: { _tag: "person", personId: ownerId },
      });
      assert.deepInclude(given, { assignedBy: { _tag: "person", personId: mateId } });
      assert.include(
        yield* OwnerWork.update([mate], {
          orgId,
          key: filed.key,
          rev: given.rev,
          title: "Invented: v2",
        }),
        { title: "Invented: v2" },
      );
      // Hidden from them since, a retry of its request finds no entry, whatever it asks for now.
      const later = yield* OwnerWork.get([owner], { orgId, key: filed.key });
      yield* OwnerWork.update([owner], { orgId, key: filed.key, rev: later.rev, sensitive: true });
      const retried = yield* Effect.flip(
        OwnerWork.create([mate], {
          orgId,
          title: "Invented: draft the launch post",
          clientRequestId: "same-id",
        }),
      );
      const changed = yield* Effect.flip(
        OwnerWork.create([mate], {
          orgId,
          title: "Invented: something else",
          clientRequestId: "same-id",
        }),
      );
      assert.strictEqual(retried.reason, "not_found");
      assert.deepStrictEqual([changed.reason, changed.message], [retried.reason, retried.message]);
    }).pipe(Effect.provide(layer)),
);

/** The teammate may message `lead`, and has their direct chat with it. */
const mateMayMessage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
    VALUES (${orgId}, ${lead}, ${mateId}, ${ownerId}, 0)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('mate-chat', ${orgId}, 'direct', ${`${mateId}:${lead}`}, 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('mate-chat-mate', ${orgId}, 'mate-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('mate-chat-lead', ${orgId}, 'mate-chat', 'agent', ${lead}, 'member', ${at})`;
});

it.effect(
  "a task a teammate gives an agent runs as theirs: shared, capped, and answered in their chat",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      const sql = yield* SqlClient.SqlClient;
      // An agent the owner restricted for them is no agent to them, and nothing is written.
      yield* Reach.setLimit({
        orgId,
        by: ownerId,
        a: Reach.person(mateId),
        b: Reach.agent(other),
        restricted: true,
      });
      assert.deepInclude(
        yield* Effect.flip(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented: for the other lead",
            owner: { _tag: "agent", agentId: other },
            clientRequestId: "other",
          }),
        ),
        { reason: "not_found", message: "No agent other here to own it." },
      );
      assert.lengthOf((yield* OwnerWork.list([owner], { orgId })).records, 0);
      const given = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: summarise the call notes",
        owner: toLead,
        clientRequestId: "lead",
      });
      assert.deepInclude(given, { assignedBy: { _tag: "person", personId: mateId } });
      const [event] = yield* assignedEvents;
      assert.deepInclude(JSON.parse(event!.json), {
        reason: "assigned",
        provenance: { _tag: "human", personId: mateId, memberId: "mate-chat-mate" },
        chatId: "mate-chat",
        origin: { agentId: lead, chatId: "mate-chat", personId: mateId },
      });
      // Its turn: shared, in their chat, at a teammate's level, and asked by no owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids)
        VALUES ('mate-wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'mate-wake'
        WHERE tag = 'record.changed'`;
      const woken = { orgId, agentId: lead, wakeupId: "mate-wake" };
      assert.strictEqual(yield* turnAudience(woken), "shared");
      assert.deepStrictEqual(yield* turnChat(woken), { chatId: "mate-chat", asked: true });
      assert.isFalse(yield* KinLevels.ownerAlone(woken));
      // L1: talk only, as a teammate's own messages get.
      assert.strictEqual(yield* KinLevels.originCap(woken), "L1");
      // It reads Work as they do: the owner's private task is no task at all, by list or key.
      assert.deepInclude(yield* turnPeople(woken), { people: [mateId], askers: [mateId] });
      const hidden = yield* ownerTask("owner only", { sensitive: true });
      const scope = scopeOf(lead);
      assert.deepStrictEqual(
        keysOf(yield* LeadWork.query(scope, {})),
        keysOf(yield* OwnerWork.list([mate], { orgId })),
      );
      assert.notInclude(keysOf(yield* LeadWork.query(scope, {})), hidden.key);
      assert.include(yield* Effect.flip(LeadWork.get(scope, { key: hidden.key })), {
        reason: "not_found",
      });
      assert.include(
        yield* Effect.flip(
          LeadWork.update(scope, {
            key: hidden.key,
            sourceEventId: JSON.parse(event!.json).eventId,
            state: "done",
          }),
        ),
        { reason: "not_found" },
      );
      // It counts as one of their turns today, and one still queued is dropped with their access.
      assert.include(yield* LeadAccess.recentTurns({ orgId, personId: mateId, now: 0 }), {
        turns: 1,
      });
      yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: a second ask",
        owner: toLead,
        clientRequestId: "lead-2",
      });
      assert.strictEqual(
        yield* LeadAccess.dropQueued({ orgId, agentId: lead }, KinChatId.make("mate-chat")),
        1,
      );
      // Closing it tells nobody: only the lead's owner withdraws work.
      yield* OwnerWork.update([mate], { orgId, key: given.key, rev: given.rev, state: "done" });
      assert.lengthOf(yield* assignedEvents, 2);
      // A day of turns used up under a limit: giving it again is refused and changes nothing.
      yield* sql`INSERT INTO kin_budget_limits (org_id, limits_json)
        VALUES (${orgId}, '{"leadUnits":1000,"workerUnits":1000}')`;
      for (let n = 0; n < 50; n++)
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
            received_at, queued_at, state)
          VALUES (${`used-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0',
            ${JSON.stringify({ provenance: { _tag: "human", personId: mateId } })}, 0, 0, 'done')`;
      const closed = yield* OwnerWork.get([mate], { orgId, key: given.key });
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: given.key, rev: closed.rev, state: "open" }),
        ),
        { reason: "not_allowed" },
      );
      assert.include(yield* OwnerWork.get([mate], { orgId, key: given.key }), { state: "done" });
      assert.lengthOf(yield* assignedEvents, 2);
      // With no limit the cap is lifted, and the same change goes through.
      yield* sql`UPDATE kin_budget_limits SET limits_json = '{"leadUnits":null,"workerUnits":null}'
        WHERE org_id = ${orgId}`;
      yield* OwnerWork.update([mate], { orgId, key: given.key, rev: closed.rev, state: "open" });
      assert.lengthOf(yield* assignedEvents, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("a task a teammate holds and gives an agent wakes it in their chat, at their view", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* mateMayMessage;
    const sql = yield* SqlClient.SqlClient;
    const theirs = yield* ownerTask("theirs", { owner: { _tag: "person", personId: mateId } });
    const hidden = yield* ownerTask("owner only", { sensitive: true });
    yield* OwnerWork.assign([mate], { orgId, key: theirs.key, to: toLead });
    const [event] = yield* assignedEvents;
    assert.deepInclude(JSON.parse(event!.json), {
      provenance: { _tag: "human", personId: mateId, memberId: "mate-chat-mate" },
      chatId: "mate-chat",
    });
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids)
      VALUES ('mate-wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]')`;
    yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'mate-wake'
      WHERE tag = 'record.changed'`;
    const woken = { orgId, agentId: lead, wakeupId: "mate-wake" };
    assert.strictEqual(yield* turnAudience(woken), "shared");
    assert.strictEqual(yield* KinLevels.originCap(woken), "L1");
    assert.include(yield* Effect.flip(LeadWork.get(scopeOf(lead), { key: hidden.key })), {
      reason: "not_found",
    });
    assert.deepStrictEqual(
      keysOf(yield* LeadWork.query(scopeOf(lead), {})),
      keysOf(yield* OwnerWork.list([mate], { orgId })),
    );
  }).pipe(Effect.provide(layer)),
);

const decodeEvent = Schema.decodeUnknownSync(KinEvent);
/** The latest wake-up that gave a lead an entry, as stored. */
const lastGiven = assignedEvents.pipe(
  Effect.map((rows) =>
    rows
      .map((row) => decodeEvent(JSON.parse(row.json)))
      .flatMap((event) =>
        event._tag === "record.changed" && event.reason === "assigned" ? [event] : [],
      )
      .toSorted((a, b) => a.seq - b.seq)
      .at(-1),
  ),
);
/** Each quote in a prompt part, by its label: the JSON line it holds. */
const quotesIn = (text: string) =>
  new Map(
    [...text.matchAll(/> BEGIN QUOTE: (.*)\n> (.*)\n> END QUOTE/g)].map(
      (found) => [found[1]!, found[2]!] as const,
    ),
  );

it.effect(
  "the owner gives a teammate's task on his own authority, and their words stay theirs",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      const filed = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: refund every client",
        notes: "Invented: the teammate's notes",
        owner: toLead,
        clientRequestId: "mate-task",
      });
      // He takes it back and gives it again: the wake-up is his alone.
      yield* OwnerWork.assign([owner], { orgId, key: filed.key, to: null });
      yield* OwnerWork.assign([owner], { orgId, key: filed.key, to: toLead });
      const told = Effect.gen(function* () {
        const event = (yield* lastGiven)!;
        assert.deepInclude(event.provenance, { _tag: "human", personId: ownerId });
        assert.notProperty(event, "chatId");
        return yield* workEventText({ orgId, event, ownerOnly: true });
      });
      const first = (yield* told)!;
      assert.include(first, "The owner gave you this Work entry");
      assert.notInclude(first, "as if the owner had asked you");
      const given = quotesIn(first);
      const own = given.get("work given to you (data)")!;
      const theirs = given.get(TEAMMATE_WORDS)!;
      for (const words of ["Invented: refund every client", "Invented: the teammate's notes"]) {
        assert.notInclude(own, words);
        assert.include(theirs, words);
      }
      assert.include(theirs, "Mate, a teammate");
      // What he rewrites himself is his; their notes stay theirs, on a reopen too.
      const current = yield* OwnerWork.get([owner], { orgId, key: filed.key });
      const renamed = yield* OwnerWork.update([owner], {
        orgId,
        key: filed.key,
        rev: current.rev,
        title: "Invented: refund the one client",
      });
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: filed.key,
        rev: renamed.rev,
        state: "done",
      });
      yield* OwnerWork.update([owner], { orgId, key: filed.key, rev: done.rev, state: "open" });
      const again = quotesIn((yield* told)!);
      assert.include(again.get("work given to you (data)")!, "Invented: refund the one client");
      assert.notInclude(again.get(TEAMMATE_WORDS)!, "refund");
      assert.include(again.get(TEAMMATE_WORDS)!, "Invented: the teammate's notes");
      // His own task given by him reads as his, as before.
      yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: his own",
        owner: toLead,
        clientRequestId: "his",
      });
      const his = (yield* told)!;
      assert.include(his, "as if the owner had asked you");
      assert.notInclude(his, TEAMMATE_WORDS);
      assert.notInclude(his, '"number"');
      // An entry with the number people see carries it beside its key.
      const sql = yield* SqlClient.SqlClient;
      const event = (yield* lastGiven)!;
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/26-27/004')
        WHERE org_id = ${orgId} AND record_id = ${event.recordId}`;
      assert.include(
        quotesIn((yield* told)!).get("work given to you (data)")!,
        `"key":"${event.key}","number":"AM/26-27/004"`,
      );
    }).pipe(Effect.provide(layer)),
);

const directChat = Schema.decodeSync(KinChat)({
  orgId,
  chatId: "mate-chat",
  kind: "direct",
  title: null,
  teamId: null,
  lastSeq: 0,
  lastMessageAt: null,
  createdAt: at,
  archivedAt: null,
});

it.effect("a teammate's change stands only on what is still true when it commits", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* mateMayMessage;
    const sql = yield* SqlClient.SqlClient;
    const services = yield* Effect.context<
      KinRecords.KinRecords | KinIdentity | SqlClient.SqlClient
    >();
    const filed = (title: string, clientRequestId: string) =>
      OwnerWork.create([mate], { orgId, title, clientRequestId });
    // The owner acts after their call is let in and before its write: opening the agent's chat.
    const givenMeanwhile = <E>(
      key: string,
      meanwhile: Effect.Effect<
        unknown,
        E,
        KinRecords.KinRecords | KinIdentity | SqlClient.SqlClient
      >,
    ) =>
      Effect.flip(
        OwnerWork.assign([mate], { orgId, key, to: toLead }).pipe(
          Effect.provide(
            Layer.mock(KinChatService)({
              createDirect: () =>
                meanwhile.pipe(
                  Effect.provideContext(services),
                  Effect.orDie,
                  Effect.as(directChat),
                ),
            }),
          ),
        ),
      );
    const unknown = yield* Effect.flip(
      OwnerWork.assign([mate], { orgId, key: "W-99", to: toLead }),
    );
    const hidden = yield* filed("Invented: hidden on the way", "hidden");
    const hiding = yield* givenMeanwhile(
      hidden.key,
      OwnerWork.update([owner], { orgId, key: hidden.key, rev: hidden.rev, sensitive: true }),
    );
    assert.deepStrictEqual(
      [hiding.reason, hiding.message],
      [unknown.reason, unknown.message.replace("W-99", hidden.key)],
    );
    const taken = yield* filed("Invented: taken on the way", "taken");
    const taking = yield* givenMeanwhile(
      taken.key,
      OwnerWork.assign([owner], { orgId, key: taken.key, to: null }),
    );
    assert.strictEqual(taking.reason, "not_allowed");
    // Their access removed on the way: nothing they sent lands either.
    const kept = yield* filed("Invented: theirs still", "still");
    const removing = yield* givenMeanwhile(
      kept.key,
      sql`UPDATE kin_session_bindings SET revoked_at = 1 WHERE person_id = ${mateId}`,
    );
    assert.strictEqual(removing.reason, "not_allowed");
    // None of them was given to the agent, and the agent was never woken.
    for (const key of [hidden.key, taken.key, kept.key])
      assert.notDeepEqual((yield* OwnerWork.get([owner], { orgId, key })).owner, toLead);
    assert.lengthOf(yield* assignedEvents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate's change numbers move only with what they can see, on every read", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const theirs = yield* OwnerWork.create([mate], {
      orgId,
      title: "Invented: theirs",
      clientRequestId: "theirs",
    });
    const at = (yield* OwnerWork.summary([mate], { orgId })).seq;
    // The owner's own work, however busy, moves nothing they read.
    const busy = (yield* records.create(orgId, ownerWrites, {
      originKey: "busy",
      title: "Invented busy",
      owner: { _tag: "person", personId: ownerId },
    })).row;
    for (const n of [1, 2, 3])
      yield* records.update(orgId, ownerWrites, busy.key, { notes: `Invented ${n}` });
    yield* records.update(orgId, ownerWrites, busy.key, {
      amount: { minor: 100, currency: "INR" },
    });
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, at);
    // One change to their task is one more: on the reply, the counts, the page and the sheet.
    const moved = yield* OwnerWork.update([mate], {
      orgId,
      key: theirs.key,
      rev: theirs.rev,
      notes: "Invented: moved",
    });
    assert.strictEqual(moved.seq, at + 1);
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, at + 1);
    assert.strictEqual((yield* OwnerWork.list([mate], { orgId })).seq, at + 1);
    assert.strictEqual((yield* OwnerWork.get([mate], { orgId, key: theirs.key })).seq, at + 1);
    // Shared after a history they can't all read: its lines are numbered among themselves.
    yield* OwnerWork.share([owner], { orgId, keys: [busy.key], shared: true });
    const sheet = yield* OwnerWork.get([mate], { orgId, key: busy.key });
    assert.strictEqual(sheet.seq, at + 2);
    assert.deepStrictEqual(
      sheet.changes.map((change) => change.seq),
      [4, 3, 2, 1],
    );
    // The owner's numbers are the org's, as before.
    assert.strictEqual(
      (yield* OwnerWork.summary([owner], { orgId })).seq,
      yield* records.seq(orgId),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate's live changes name only tasks they see, and one hidden from them once", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const sql = yield* SqlClient.SqlClient;
    const heard = yield* Queue.unbounded<{
      readonly seq: number;
      readonly key?: string;
      readonly list?: string;
    }>();
    yield* OwnerWork.subscribe([mate], { orgId }).pipe(
      Stream.runForEach((event) => Queue.offer(heard, event)),
      Effect.forkChild,
    );
    // Each is taken before the next write: a notice nobody should get would come first instead.
    const next = Queue.take(heard).pipe(Effect.map((event) => [event.key ?? null, event.seq]));
    assert.deepStrictEqual(yield* next, [null, 0]);
    const create = (title: string, owner = ownerId) =>
      records.create(orgId, ownerWrites, {
        originKey: title,
        title: `Invented ${title}`,
        owner: { _tag: "person", personId: owner },
      });
    yield* create("owner's");
    yield* create("for mate", mateId);
    // Their own numbers: one more for each change to what they could see, so nothing else shows.
    // The list is named, so their screens read again only what Work's own list can change.
    const theirs = yield* Queue.take(heard);
    assert.deepStrictEqual([theirs.key, theirs.seq, theirs.list], ["W-2", 1, "work"]);
    yield* create("to share");
    yield* OwnerWork.share([owner], { orgId, keys: ["W-3"], shared: true });
    assert.deepStrictEqual(yield* next, ["W-3", 2]);
    // G03: labelled private, what they hold is still theirs.
    yield* records.update(orgId, ownerWrites, "W-2", { sensitive: true });
    assert.deepStrictEqual(yield* next, ["W-2", 3]);
    yield* records.update(orgId, ownerWrites, "W-2", { title: "Invented still theirs" });
    assert.deepStrictEqual(yield* next, ["W-2", 4]);
    yield* records.update(orgId, ownerWrites, "W-1", { title: "Invented still the owner's" });
    // A client's label never hides its shared task: a task is private only by its own.
    const client = (yield* records.create(orgId, ownerWrites, {
      list: "clients",
      originKey: "client",
      title: "Invented Client",
      owner: { _tag: "person", personId: ownerId },
    })).row;
    yield* records.create(orgId, ownerWrites, {
      originKey: "client work",
      title: "Invented client work",
      owner: { _tag: "person", personId: ownerId },
      partyId: client.recordId,
      team: true,
    });
    assert.deepStrictEqual(yield* next, ["W-4", 5]);
    yield* records.update(orgId, ownerWrites, client.key, { title: "Invented Client renamed" });
    yield* records.update(orgId, ownerWrites, client.key, { sensitive: true });
    // Shared and hidden again before they hear of it: by then it is no task of theirs, so never named.
    yield* sql.withTransaction(
      Effect.andThen(
        OwnerWork.share([owner], { orgId, keys: ["W-1"], shared: true }),
        records.update(orgId, ownerWrites, "W-1", { sensitive: true }),
      ),
    );
    yield* records.update(orgId, ownerWrites, "W-3", { title: "Invented shared, renamed" });
    const [key, seq] = yield* next;
    assert.strictEqual(key, "W-3");
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, seq);
    assert.strictEqual(yield* Queue.size(heard), 0);
  }).pipe(Effect.provide(layer)),
);

const places = (clients: number, docs: number, money: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`UPDATE kin_people SET sees_clients = ${clients}, sees_docs = ${docs},
        sees_money = ${money} WHERE person_id = ${mateId}`,
    ),
  );
const flipped = <A, R>(effect: Effect.Effect<A, KinChatError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => [error.reason, error.message]));

it.effect("a member sees a place only while it is on, and nothing of it while it is off", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const client = (yield* records.create(orgId, ownerWrites, {
      list: "clients",
      originKey: "client",
      title: "Invented Acme",
      owner: { _tag: "person", personId: ownerId },
      fields: { terms: "Invented net 30" },
    })).row;
    const priya = yield* records.create(orgId, ownerWrites, {
      list: "contacts",
      originKey: "contact",
      title: "Invented Priya",
      owner: { _tag: "person", personId: ownerId },
      partyId: client.recordId,
      fields: { email: "priya@acme.example" },
    });
    yield* records.create(orgId, ownerWrites, {
      list: "clients",
      originKey: "secret client",
      title: "Invented Secret Client",
      owner: { _tag: "person", personId: ownerId },
      sensitive: true,
    });
    const doc = (text: string) =>
      Docs.create(
        orgId,
        ownerWrites,
        {},
        {
          title: `Invented ${text}`,
          body: `# Invented ${text}\n\nThe invented zebra plan.\n`,
          owner: { _tag: "person", personId: ownerId },
          summary: "Created",
          originKey: text,
        },
      ).pipe(Effect.map(({ row }) => row));
    const shared = yield* doc("handbook");
    const secret = yield* doc("salaries");
    yield* OwnerWork.share([owner], { orgId, keys: [shared.key], shared: true });

    // Everything off, as every teammate already here: refused at the door, no trace inside.
    yield* places(0, 0, 0);
    for (const refused of [
      yield* Effect.flip(OwnerClients.parties([mate], { orgId })),
      yield* Effect.flip(OwnerDocs.list([mate], { orgId })),
      yield* Effect.flip(OwnerMoney.money([mate], { orgId })),
    ])
      assert.include(refused, { reason: "not_allowed" });
    assert.lengthOf((yield* OwnerDocs.search([mate], { orgId, text: "zebra" })).hits, 0);
    assert.deepStrictEqual(yield* flipped(OwnerWork.get([mate], { orgId, key: client.key })), [
      "not_found",
      `No entry ${client.key} in Work.`,
    ]);

    // Clients on: names, contacts and the contact log, never terms or the sensitive client.
    yield* places(1, 0, 0);
    const parties = yield* OwnerClients.parties([mate], { orgId });
    assert.deepStrictEqual(
      parties.parties.map((party) => party.name),
      ["Invented Acme"],
    );
    assert.strictEqual(parties.parties[0]!.lastContactAt, null);
    const page = yield* OwnerClients.party([mate], { orgId, key: client.key });
    assert.deepStrictEqual(
      page.contacts.map((one) => [one.name, one.email]),
      [["Invented Priya", "priya@acme.example"]],
    );
    assert.isNull(page.party.terms);
    assert.notInclude(JSON.stringify(page), "net 30");
    // Search finds the contact with its client, whose page opens for it.
    assert.deepStrictEqual(
      (yield* OwnerDocs.search([mate], { orgId, text: "Priya" })).hits.map((hit) => [
        hit.key,
        "client" in hit ? hit.client : undefined,
      ]),
      [[priya.row.key, client.key]],
    );
    assert.include(yield* Effect.flip(OwnerDocs.list([mate], { orgId })), {
      reason: "not_allowed",
    });

    // Docs on: the shared doc in the list, by key and in search; the other is no doc at all.
    yield* places(1, 1, 0);
    const unknownDoc = yield* flipped(OwnerDocs.get([mate], { orgId, key: "D-99" }));
    assert.deepStrictEqual(
      (yield* OwnerDocs.list([mate], { orgId })).docs.map((one) => one.key),
      [shared.key],
    );
    assert.strictEqual((yield* OwnerDocs.get([mate], { orgId, key: shared.key })).key, shared.key);
    assert.deepStrictEqual(yield* flipped(OwnerDocs.get([mate], { orgId, key: secret.key })), [
      unknownDoc[0],
      unknownDoc[1]!.replace("D-99", secret.key),
    ]);
    assert.deepStrictEqual(
      (yield* OwnerDocs.search([mate], { orgId, text: "zebra" })).hits.map((hit) => hit.key),
      [shared.key],
    );
    // Their Tasks stay tasks, whatever else they see.
    assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), []);
    // Money on: figures of only what is shared with them, here none.
    yield* places(1, 1, 1);
    const money = yield* OwnerMoney.money([mate], { orgId });
    assert.deepStrictEqual([money.owed.total, money.upcoming], [[], []]);
    // H17: leading the client's project without Clients gives the people there by name only.
    yield* records.create(orgId, ownerWrites, {
      list: "projects",
      originKey: "acme project",
      title: "Invented Acme app",
      owner: { _tag: "person", personId: mateId },
      partyId: client.recordId,
    });
    yield* places(0, 1, 1);
    assert.notProperty(
      (yield* OwnerClients.parties([mate], { orgId })).parties[0]!,
      "lastContactAt",
    );
    const led = yield* OwnerClients.party([mate], { orgId, key: client.key });
    assert.deepStrictEqual(
      led.contacts.map((one) => [one.name, one.email]),
      [["Invented Priya", null]],
    );
    const named = yield* OwnerWork.get([mate], { orgId, key: priya.row.key });
    assert.strictEqual(named.title, "Invented Priya");
    assert.notInclude(JSON.stringify(named), "priya@acme");
    // Run 4: Money counted a lead's coming-up dates, then refused to list them. One read, one
    // rule: the list holds what the count counted, and not the owner's own dates.
    const sql = yield* SqlClient.SqlClient;
    const [project] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
      WHERE org_id = ${orgId} AND register_id = 'projects'`;
    const now = yield* Clock.currentTimeMillis;
    for (const [originKey, title, projectId] of [
      ["their date", "Invented app review", project!.id],
      ["owner date", "Invented rent renewal", undefined],
    ] as const)
      yield* records.create(orgId, ownerWrites, {
        originKey,
        title,
        dueAt: now + 5 * 86_400_000,
        owner: { _tag: "person", personId: ownerId },
        ...(projectId === undefined ? {} : { projectId }),
      });
    const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
    const window = { orgId, from: iso(now), to: iso(now + 30 * 86_400_000), open: true };
    const counted = (yield* OwnerMoney.money([mate], { orgId })).upcomingTotal;
    const listed = yield* OwnerMoney.dates([mate], window);
    assert.deepStrictEqual(
      [counted, listed.rows.map((row) => row.record.title)],
      [1, ["Invented app review"]],
    );
    assert.strictEqual((yield* OwnerMoney.dates([owner], window)).total, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("a record lists what links to it, of what the reader sees, newest first and capped", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    yield* places(0, 1, 0);
    const doc = (yield* Docs.create(
      orgId,
      ownerWrites,
      {},
      {
        title: "Invented brief",
        body: "# Invented brief\n\nThe invented plan.\n",
        owner: { _tag: "person", personId: ownerId },
        summary: "Created",
        originKey: "brief",
      },
    )).row;
    yield* OwnerWork.share([owner], { orgId, keys: [doc.key], shared: true });
    const theirs = yield* ownerTask("their task", { owner: { _tag: "person", personId: mateId } });
    const mine = yield* ownerTask("owner's task");
    const both = yield* ownerTask("linked both ways");
    const linkTo = (from: { readonly recordId: string }, to: string) =>
      records.link(orgId, ownerWrites, from.recordId, {
        kind: "record",
        target: to,
        relation: "relates",
      });
    yield* linkTo(theirs, doc.recordId);
    yield* TestClock.adjust("1 second");
    yield* linkTo(mine, doc.recordId);
    yield* Docs.link(orgId, ownerWrites, { key: doc.key }, [both.key], "relates");
    const from = (detail: Pick<KinRecordDetail, "linkedFrom" | "linkedFromMore">) => [
      detail.linkedFrom?.map((link) => [link.record?.key, link.target, link.number]),
      detail.linkedFromMore,
    ];
    // An issued number goes with the link, both ways round.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/7')
      WHERE record_id = ${mine.recordId}`;
    // Newest first; one the doc links back to is in its own links, not here.
    assert.deepStrictEqual(from(yield* OwnerDocs.get([owner], { orgId, key: doc.key })), [
      [
        [mine.key, mine.recordId, "AM/7"],
        [theirs.key, theirs.recordId, undefined],
      ],
      undefined,
    ]);
    // A teammate who may not see the owner's task never learns of it, by key, title or count.
    const seen = yield* OwnerDocs.get([mate], { orgId, key: doc.key });
    assert.deepStrictEqual(from(seen), [[[theirs.key, theirs.recordId, undefined]], undefined]);
    assert.notInclude(JSON.stringify(seen), "owner's task");
    // The task's sheet reads the same way round: the doc is in its links, and nothing links to it.
    yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/8')
      WHERE record_id = ${doc.recordId}`;
    const task = yield* OwnerWork.get([owner], { orgId, key: theirs.key });
    assert.deepStrictEqual(
      [task.links.map((link) => [link.record?.key, link.number]), task.linkedFrom],
      [[[doc.key, "AM/8"]], undefined],
    );

    for (let n = 0; n < 60; n++) yield* linkTo(yield* ownerTask(`linker ${n}`), mine.recordId);
    assert.deepStrictEqual(
      (({ linkedFrom, linkedFromMore }) => [linkedFrom?.length, linkedFromMore])(
        yield* OwnerWork.get([owner], { orgId, key: mine.key }),
      ),
      [50, 10],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a picker finds any client by name past the first page, and none the person can't see",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      // 140 clients, every seventh labelled sensitive: the teammate may see 120 of them.
      const name = (n: number) =>
        n === 118
          ? "Invented Quillfeather Studio"
          : n === 133
            ? "Invented Hollowbrook Mills"
            : `Invented Client ${n}`;
      for (let n = 1; n <= 140; n += 1)
        yield* records.create(orgId, ownerWrites, {
          list: "clients",
          originKey: `client ${n}`,
          title: name(n),
          owner: { _tag: "person", personId: ownerId },
          ...(n % 7 === 0 ? { sensitive: true } : {}),
        });
      yield* places(1, 0, 0);
      const first = yield* OwnerClients.parties([mate], { orgId, limit: 100 });
      assert.strictEqual(first.total, 120);
      assert.notInclude(
        first.parties.map((party) => party.name),
        "Invented Quillfeather Studio",
      );
      const found = (text: string, people = [mate]) =>
        OwnerClients.parties(people, { orgId, text, limit: 30 }).pipe(
          Effect.map((result) => result.parties.map((party) => party.name)),
        );
      assert.deepStrictEqual(yield* found("quillf"), ["Invented Quillfeather Studio"]);
      assert.deepStrictEqual(yield* found("  STUDIO "), ["Invented Quillfeather Studio"]);
      assert.deepStrictEqual(yield* found("hollowbrook"), []);
      assert.deepStrictEqual(yield* found("hollowbrook", [owner]), ["Invented Hollowbrook Mills"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a member finds the projects they are on: in the list, its count and the client page",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const client = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "client",
        title: "Invented Acme",
        owner: { _tag: "person", personId: ownerId },
      })).row;
      const project = (title: string, extra: Partial<KinRecords.CreateInput> = {}) =>
        records.create(orgId, ownerWrites, {
          list: "projects",
          originKey: title,
          title: `Invented ${title}`,
          owner: { _tag: "person", personId: ownerId },
          partyId: client.recordId,
          ...extra,
        });
      const on = (yield* project("app", { fields: { members: [`person:${mateId}`] } })).row;
      yield* project("api");
      yield* project("pricing", { fields: { members: [`person:${mateId}`] }, sensitive: true });
      yield* places(1, 0, 0);
      const listed = yield* OwnerClients.projects([mate], { orgId });
      assert.deepStrictEqual([listed.projects.map((one) => one.key), listed.total], [[on.key], 1]);
      // A picker's search by name keeps to the same rule: theirs found, the others not at all.
      const found = (text: string, people = [mate]) =>
        OwnerClients.projects(people, { orgId, text }).pipe(
          Effect.map((result) => result.projects.map((one) => one.name)),
        );
      assert.deepStrictEqual(yield* found("APP"), ["Invented app"]);
      assert.deepStrictEqual(yield* found("api"), []);
      assert.deepStrictEqual(yield* found("pricing"), []);
      assert.deepStrictEqual(yield* found("api", [owner]), ["Invented api"]);
      const page = yield* OwnerClients.party([mate], { orgId, key: client.key });
      assert.deepStrictEqual(
        page.projects.map((one) => one.key),
        [on.key],
      );
      // The page a list row opens: the same project, without what only its lead reads.
      const opened = yield* OwnerClients.project([mate], { orgId, key: on.key });
      assert.strictEqual(opened.project.key, on.key);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a project's lead runs their project and no other, drafts but never issues money, until it is taken away",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
      const project = (title: string, lead: KinPersonId) =>
        records
          .create(orgId, ownerWrites, {
            list: "projects",
            originKey: title,
            title: `Invented ${title}`,
            owner: { _tag: "person", personId: lead },
          })
          .pipe(Effect.map(({ row }) => row));
      const mine = yield* project("Atlas", mateId);
      const theirs = yield* project("Borealis", ownerId);
      const mineTask = yield* ownerTask("atlas task", { projectId: mine.recordId });
      const theirTask = yield* ownerTask("borealis task", { projectId: theirs.recordId });
      const draft = (yield* records.create(orgId, ownerWrites, {
        list: "invoices",
        originKey: "draft",
        title: "Invented Atlas retainer",
        owner: { _tag: "person", personId: ownerId },
        projectId: mine.recordId,
        amount: { minor: 100_000, currency: "INR" },
        state: "open",
      })).row;
      yield* places(0, 0, 0);

      // Their project, all of it, from Tasks, the project page and Money; never the other one.
      const tasks = yield* OwnerWork.list([mate], { orgId });
      assert.deepStrictEqual(keysOf(tasks), [mineTask.key]);
      assert.strictEqual(tasks.records[0]!.project?.key, mine.key);
      assert.strictEqual(
        (yield* OwnerClients.project([mate], { orgId, key: mine.key })).project.key,
        mine.key,
      );
      const unknown = yield* flipped(OwnerClients.project([mate], { orgId, key: "P-99" }));
      assert.deepStrictEqual(
        yield* flipped(OwnerClients.project([mate], { orgId, key: theirs.key })),
        [unknown[0], unknown[1]!.replace("P-99", theirs.key)],
      );
      assert.deepStrictEqual(
        (yield* OwnerClients.projects([mate], { orgId })).projects.map((one) => one.key),
        [mine.key],
      );
      assert.deepStrictEqual(
        (yield* OwnerWork.list([mate], { orgId, list: "invoices" })).records.map((one) => [
          one.key,
          one.amount?.minor,
        ]),
        [[draft.key, 100_000]],
      );
      assert.include(yield* Effect.flip(OwnerWork.get([mate], { orgId, key: theirTask.key })), {
        reason: "not_found",
      });

      // They file, date and hand out its work, and add milestones, without asking.
      const filed = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented atlas launch",
        project: mine.key,
        owner: { _tag: "person", personId: ownerId },
        dueAt: "2026-12-01",
        dueAllDay: true,
        clientRequestId: "atlas-launch",
      });
      assert.strictEqual(filed.project?.key, mine.key);
      yield* OwnerWork.create([mate], {
        orgId,
        list: "milestones",
        title: "Invented atlas beta",
        project: mine.key,
        clientRequestId: "atlas-beta",
      });
      const moved = yield* OwnerWork.update([mate], {
        orgId,
        key: mineTask.key,
        rev: mineTask.rev,
        dueAt: "2026-12-02",
        dueAllDay: true,
      });
      assert.isDefined(moved.dueAt);
      assert.include(
        yield* Effect.flip(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            project: theirs.key,
            clientRequestId: "borealis",
          }),
        ),
        { reason: "not_found" },
      );
      // A draft's figures are theirs to change; issuing, sending or marking it paid never is.
      const drafted = yield* OwnerWork.update([mate], {
        orgId,
        key: draft.key,
        rev: draft.rev,
        amount: { minor: 120_000, currency: "INR" },
      });
      assert.strictEqual(drafted.amount?.minor, 120_000);
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: draft.key, rev: drafted.rev, state: "done" }),
        ),
        {
          reason: "not_allowed",
          message:
            "Only the owner or a co-owner issues, sends or marks a quote or invoice paid; a project's lead keeps it a draft (state open).",
        },
      );
      for (const method of ["kin.work.issue", "kin.work.recordPayment", "kin.work.void"])
        assert.strictEqual(kinRpcAccess(method), "owner_level", method);

      // Their agent works at the same level in their chat with it, and no further.
      yield* turn("mate", "shared");
      const made = yield* LeadWork.create(scopeOf(lead), {
        sourceEventId: "ask-event",
        records: [{ title: "Invented atlas QA", project: mine.key, owner: "owner" }],
      });
      assert.isTrue(made.records[0]!.created);
      assert.include(
        yield* Effect.flip(
          LeadWork.create(scopeOf(lead), {
            sourceEventId: "ask-event",
            records: [{ title: "Invented", project: theirs.key }],
          }),
        ),
        { reason: "not_found" },
      );
      assert.include(
        yield* Effect.flip(
          LeadWork.update(scopeOf(lead), {
            key: draft.key,
            sourceEventId: "ask-event",
            state: "done",
          }),
        ),
        { reason: "not_allowed" },
      );

      // Taken away, it is gone from the very next request; what they filed stays theirs, bare.
      const current = yield* records.get(orgId, mine.key);
      yield* records.update(
        orgId,
        ownerWrites,
        mine.key,
        { owner: { _tag: "person", personId: ownerId } },
        current!.rev,
      );
      const left = yield* OwnerWork.list([mate], { orgId });
      assert.deepStrictEqual(keysOf(left), [filed.key, made.records[0]!.key].toSorted());
      for (const record of left.records) assert.notProperty(record, "project");
      assert.include(yield* Effect.flip(OwnerClients.projects([mate], { orgId })), {
        reason: "not_allowed",
      });
      assert.include(yield* Effect.flip(OwnerWork.get([mate], { orgId, key: mineTask.key })), {
        reason: "not_found",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent gives out a plan from a turn shown money: assigning shares it, one message each, and a hand back goes to who asked",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      // 16:00 on the company's clock, outside quiet hours: what she is told arrives now.
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/Los_Angeles', '08:30',
          '18:30', '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')
        ON CONFLICT (org_id) DO UPDATE SET time_zone = 'America/Los_Angeles'`;
      // Her own clock is a day ahead: a due day is still the company's, not hers.
      yield* sql`UPDATE kin_people SET time_zone = 'Pacific/Auckland'
        WHERE org_id = ${orgId} AND person_id = ${mateId}`;
      const scope = scopeOf("lead");
      // G03: the owner's turn has seen a price; what it writes is still not private for that.
      yield* sensitiveShown({ orgId, wakeupId: "wake" });
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { title: "Invented: draft the onboarding copy" },
          { title: "Invented: fix the login screen", size: "M", due: "2026-11-20" },
          { title: "Invented: salary review", sensitive: true },
        ],
      });
      const plan = yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: ["W-1", "W-2", "W-3"].map((key) => ({ key, to: "Mate", reason: "iOS, 0 open" })),
      });
      assert.deepStrictEqual(plan.told, ["Mate"]);
      assert.deepStrictEqual(
        plan.tasks.map((task) => task.to),
        ["Mate", "Mate", "Mate"],
      );
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        "W-1",
        "W-2",
        "W-3",
      ]);
      // One message for the whole plan, in their chat with the agent, with why and when.
      const told = yield* sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE chat_id = 'mate-chat' ORDER BY seq`;
      assert.lengthOf(told, 1);
      assert.include(told[0]!.body, "gave you 3 tasks");
      assert.include(told[0]!.body, "W-2 Invented: fix the login screen, due Fri 20 Nov. Why: iOS");
      yield* sql`UPDATE kin_people SET time_zone = NULL
        WHERE org_id = ${orgId} AND person_id = ${mateId}`;
      // The agent reads the day the owner named, west of UTC too.
      assert.include(yield* LeadWork.get(scope, { key: "W-2" }), {
        due: "2026-11-20",
        dueDay: "Fri 20 Nov 2026",
      });
      // The owner asked, so the owner gave it; the agent only carried it.
      const given = yield* OwnerWork.get([mate], { orgId, key: "W-2" });
      assert.deepInclude(given, {
        assignedBy: { _tag: "person", personId: ownerId },
        reason: "iOS, 0 open",
      });
      assert.notProperty(given, "assignedByAgent");
      // The owner's own turn reads what each holds; a turn others read doesn't.
      const turnOf = { orgId, agentId: lead, wakeupId: "wake" };
      yield* TestClock.setTime(Date.parse("2026-11-16T00:00:00.000Z"));
      assert.include(
        (yield* readPeople(turnOf)).quoted,
        '"load":{"open":3,"late":0,"dueThisWeek":1,"openBySize":{"S":0,"M":1,"L":0,"unsized":2},"overloaded":false}',
      );
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      assert.notInclude((yield* readPeople(turnOf)).quoted, '"load"');
      // Handed back from the app, it goes to the owner who asked for it.
      assert.deepStrictEqual(
        yield* OwnerWork.handBack([mate], { orgId, key: "W-2", note: "I'm on the release" }),
        { key: "W-2", to: { _tag: "person", personId: ownerId } },
      );
      const returned = yield* OwnerWork.get([owner], { orgId, key: "W-2" });
      assert.deepInclude(returned, {
        owner: { _tag: "person", personId: ownerId },
        assignedBy: { _tag: "person", personId: ownerId },
        state: "open",
      });
      // Why it was given no longer holds; who handed it back, and when, does.
      assert.isUndefined(returned.reason);
      assert.deepStrictEqual(returned.handedBack, {
        by: { _tag: "person", personId: mateId },
        at: "2026-11-16T00:00:00.000Z",
      });
      // Only whoever holds it hands it back.
      assert.include(
        yield* Effect.flip(
          OwnerWork.handBack([mate], { orgId, key: "W-1" }).pipe(
            Effect.andThen(OwnerWork.handBack([mate], { orgId, key: "W-1" })),
          ),
        ),
        { reason: "not_found" },
      );
      // H15: the owner moving a task on his screen tells its holders as an agent would, and the
      // agent's why goes with the agent's assignment.
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, ${lead}, ${ownerId}, ${at})`;
      const notices = sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE chat_id = 'mate-chat' AND message_id LIKE 'kin-assign-%' ORDER BY seq`;
      const before = (yield* notices).length;
      const mateHolds = { _tag: "person" as const, personId: mateId };
      yield* OwnerWork.assign([owner], { orgId, key: "W-2", to: null });
      yield* OwnerWork.assign([owner], { orgId, key: "W-3", to: null });
      yield* OwnerWork.assign([owner], { orgId, key: "W-2", to: mateHolds });
      // Given again, it is no longer marked handed back.
      assert.isUndefined((yield* OwnerWork.get([owner], { orgId, key: "W-2" })).handedBack);
      assert.deepStrictEqual(
        (yield* notices).slice(before).map((row) => row.body),
        [
          "Owner took over W-3 Invented: salary review.",
          "Owner gave you W-2 Invented: fix the login screen, due Fri 20 Nov.",
        ],
      );
      assert.isUndefined((yield* OwnerWork.get([owner], { orgId, key: "W-3" })).reason);
      // Model tasks: handed back on the screen to the person who gave it, that person is told.
      yield* OwnerWork.handBack([mate], { orgId, key: "W-2", note: "Invented: blocked on design" });
      assert.deepStrictEqual(
        (yield* sql<{ body: string }>`SELECT body FROM kin_messages
          WHERE chat_id = 'lead-chat' AND message_id LIKE 'kin-assign-%' ORDER BY seq`).map(
          (row) => row.body,
        ),
        ["Mate handed W-2 Invented: fix the login screen back: Invented: blocked on design."],
      );
      // Given on from one teammate to another, each reads who gave it to whom from their side.
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('mate-2', ${orgId}, 'mate2', 'Mate Two', ${at})`;
      const mateTwoHolds = { _tag: "person" as const, personId: KinPersonId.make("mate-2") };
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('mate-2-chat', ${orgId}, 'direct', ${`mate-2:${lead}`}, 0, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('mate-2-chat-mate', ${orgId}, 'mate-2-chat', 'person', 'mate-2', 'member', ${at})`;
      const mateTwoNotices = sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE chat_id = 'mate-2-chat' AND message_id LIKE 'kin-assign-%' ORDER BY seq`;
      const givenOn = (yield* notices).length;
      yield* OwnerWork.assign([owner], { orgId, key: "W-1", to: mateHolds });
      yield* OwnerWork.assign([owner], { orgId, key: "W-1", to: mateTwoHolds });
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = 'wake'`;
      // The owner asks after moving it on the screen, so the agent's moves don't write over his.
      yield* TestClock.adjust(1_000);
      const askedAt = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
          queued_at, state, wakeup_id)
        SELECT 'ask-again', org_id, agent_id, tag, priority, json, ${askedAt}, ${askedAt}, state,
          wakeup_id FROM kin_events WHERE event_id = 'ask-event'`;
      yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key: "W-1", to: "Mate", reason: "Invented: on leave" }],
      });
      yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key: "W-1", to: "Lead lead", reason: "Invented: quicker" }],
      });
      assert.deepStrictEqual(
        (yield* notices).slice(givenOn).map((row) => row.body),
        [
          "Owner gave you W-1 Invented: draft the onboarding copy.",
          "Owner gave W-1 Invented: draft the onboarding copy to Mate Two.",
          "Lead lead gave you W-1 Invented: draft the onboarding copy. Why: Invented: on leave.",
          "Lead lead took over W-1 Invented: draft the onboarding copy: Invented: quicker.",
        ],
      );
      assert.deepStrictEqual(
        (yield* mateTwoNotices).map((row) => row.body),
        [
          "Owner gave you W-1 Invented: draft the onboarding copy.",
          "Lead lead gave W-1 Invented: draft the onboarding copy to Mate: Invented: on leave.",
        ],
      );
      // K016: tell false gives it to her without a word; given to her again, she is told once.
      const quiet = (yield* notices).length;
      const untold = (key: string) =>
        OwnerWork.get([owner], { orgId, key }).pipe(
          Effect.map((sheet) => sheet.changes[0]?.fields.find((one) => one.field === "untold")),
        );
      const holding = yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key: "W-1", to: "Mate", reason: "Invented: after the launch" }],
        tell: false,
      });
      assert.deepStrictEqual([holding.told, holding.held], [undefined, ["Mate"]]);
      assert.lengthOf((yield* notices).slice(quiet), 0);
      assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), "W-1");
      assert.deepInclude(yield* untold("W-1"), { from: null, to: `person:${mateId}` });
      const telling = () =>
        LeadWork.assign(scope, {
          sourceEventId: "ask-event",
          tasks: [{ key: "W-1", to: "Mate", reason: "Invented: after the launch" }],
        });
      assert.deepStrictEqual((yield* telling()).told, ["Mate"]);
      assert.deepInclude(yield* untold("W-1"), { from: `person:${mateId}`, to: null });
      assert.isUndefined((yield* telling()).told);
      assert.deepStrictEqual(
        (yield* notices).slice(quiet).map((row) => row.body),
        [
          "Lead lead gave you W-1 Invented: draft the onboarding copy. Why: Invented: after the launch.",
        ],
      );
      // Held, then moved on: the one never told hears nothing of it, and the mark goes. A new
      // turn, so the owner's hand moves above came before it.
      yield* sql`UPDATE kin_wakeups SET started_at = ${yield* Clock.currentTimeMillis}
        WHERE wakeup_id = 'wake'`;
      yield* LeadWork.update(scope, {
        sourceEventId: "ask-event",
        key: "W-3",
        owner: "Mate",
        tell: false,
      });
      const moved = yield* LeadWork.update(scope, {
        sourceEventId: "ask-event",
        key: "W-3",
        owner: "you",
      });
      assert.isUndefined(moved.told);
      assert.deepInclude(yield* untold("W-3"), { from: `person:${mateId}`, to: null });
      assert.lengthOf((yield* notices).slice(quiet), 1);
      // Run 4: a meeting already held is recorded, one to come is attended: neither is a task.
      const meetings = [];
      for (const at of ["2026-11-15T17:00+05:30", "2026-11-19T15:00+05:30"])
        meetings.push(
          ...(yield* LeadWork.create(scope, {
            sourceEventId: "ask-event",
            records: [{ title: `Invented review ${at}`, category: "meeting", owner: "Mate", at }],
          })).records.map((one) => one.past ?? false),
        );
      assert.deepStrictEqual(meetings, [true, false]);
      const [held, coming] = (yield* notices).slice(-2).map((row) => row.body);
      assert.match(
        held!,
        /^Lead lead recorded your meeting W-\d+ Invented review .+ on Sun 15 Nov \d{1,2}:\d\d [ap]m\.$/u,
      );
      assert.match(
        coming!,
        /^Lead lead added you to the meeting W-\d+ Invented review .+ on Thu 19 Nov \d{1,2}:\d\d [ap]m\.$/u,
      );
      // Put on a project from the app, or made its lead, they are told once, with its key.
      const portal = yield* OwnerClients.createProject([owner], {
        orgId,
        name: "Invented portal",
        clientRequestId: "portal",
      });
      const added = yield* OwnerClients.projectPeople([owner], {
        orgId,
        key: portal.key,
        add: [mateHolds],
      });
      yield* OwnerClients.projectPeople([owner], { orgId, key: portal.key, add: [mateHolds] });
      yield* OwnerClients.updateProject([owner], {
        orgId,
        key: portal.key,
        rev: added.rev,
        owner: mateHolds,
      });
      assert.deepStrictEqual(
        (yield* notices).slice(-2).map((row) => row.body),
        [
          `Owner added you to ${portal.key} Invented portal.`,
          `Owner made you the lead of ${portal.key} Invented portal.`,
        ],
      );
    }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);

// Play-test (Nov 2026): the owner opened Kin where it was the next day, his device stored that
// zone as the company's, and a due read a day later on Tasks, to the agent, in a hand-over
// notice and on a Changes line made before.
it.effect(
  "a due keeps its day for everyone when the company's zone moves east across midnight",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Etc/GMT+5', '08:30', '18:30',
        '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')`;
      const scope = scopeOf("lead");
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: send the plan", due: "2026-11-22" }],
      });
      yield* LeadWork.update(scope, { key: "W-1", sourceEventId: "ask-event", due: "2026-11-27" });
      // What `KinRoutines.setTimeZone` writes, in one transaction: the zone, and the days kept.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Asia/Kolkata' WHERE org_id = ${orgId}`;
          yield* keepAllDayDays(orgId, "Etc/GMT+5", "Asia/Kolkata");
        }),
      );
      const zone = "Asia/Kolkata";
      // (a) Tasks.
      const [task] = (yield* OwnerWork.list([owner], { orgId })).records;
      assert.strictEqual(dayIn(Date.parse(task!.dueAt!), zone), "2026-11-27");
      // (b) The agent's work tool.
      assert.include(yield* LeadWork.get(scope, { key: "W-1" }), {
        due: "2026-11-27",
        dueDay: "Fri 27 Nov 2026",
      });
      // (c) A hand-over after the move, at 11:30 on the company's clock, outside quiet hours.
      yield* TestClock.setTime(Date.parse("2026-11-11T06:00:00.000Z"));
      yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key: "W-1", to: "Mate", reason: "she has the plan" }],
      });
      const [notice] = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE chat_id = 'mate-chat' ORDER BY seq DESC LIMIT 1`;
      assert.include(notice!.body, "W-1 Invented: send the plan, due Fri 27 Nov.");
      // (d) The Changes line made before the move, on the agent's page and the entry's.
      const moved = (yield* agentChanges(KIN_OWNER_LEVEL, orgId, lead))
        .flatMap((change) => (change.kind === "updated" ? change.fields : []))
        .find((one) => one.field === "due")!;
      assert.deepStrictEqual(
        [moved.from, moved.to].map((one) => dayIn(Date.parse(one!), zone)),
        ["2026-11-22", "2026-11-27"],
      );
      const history = (yield* OwnerWork.get([owner], { orgId, key: "W-1" })).changes.flatMap(
        (change) => change.fields.filter((one) => one.field === "due"),
      );
      assert.deepStrictEqual(
        history.map((one) => [one.from, one.to].map((at) => at && dayIn(Date.parse(at), zone))),
        [
          ["2026-11-22", "2026-11-27"],
          [null, "2026-11-22"],
        ],
      );
    }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);

// Walk 6 (Nov 2026): no one place listed what one agent changed, nor undid one change of it.
it.effect(
  "an agent's page lists its changes; Undo puts back one, recorded as the person's, and never over a later change",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const scope = scopeOf(lead);
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: pricing page" }, { title: "Invented: brochure" }],
      });
      yield* LeadWork.update(scope, {
        key: "W-1",
        sourceEventId: "ask-event",
        title: "Invented: pricing v2",
      });
      yield* LeadWork.update(scope, { key: "W-2", sourceEventId: "ask-event", state: "doing" });
      const changes = yield* agentChanges(KIN_OWNER_LEVEL, orgId, lead);
      assert.deepStrictEqual(
        changes.map((change) => [change.key, change.kind, change.undo, change.since]),
        [
          ["W-2", "updated", true, false],
          ["W-1", "updated", true, false],
          ["W-2", "created", false, true],
          ["W-1", "created", false, true],
        ],
      );
      const undo = (seq: number) =>
        ownerLevelUndoAgentChange({ orgId, agentId: lead, seq, by: ownerId });
      yield* undo(changes[1]!.seq);
      const back = yield* OwnerWork.get([owner], { orgId, key: "W-1" });
      assert.strictEqual(back.title, "Invented: pricing page");
      assert.deepStrictEqual(back.changes[0]!.by, { _tag: "person", personId: ownerId });
      // Undone once, it changed since: a second Undo is refused, not put back again.
      assert.include(yield* Effect.flip(undo(changes[1]!.seq)), { reason: "invalid_state" });
      // The page says it was put back, not that something else changed it.
      assert.deepInclude((yield* agentChanges(KIN_OWNER_LEVEL, orgId, lead))[1]!, {
        undo: false,
        since: true,
        undone: true,
      });
      // Someone else's change to the same field since the agent's: refused too.
      const w2 = yield* OwnerWork.get([owner], { orgId, key: "W-2" });
      yield* OwnerWork.update([owner], { orgId, key: "W-2", rev: w2.rev, state: "done" });
      assert.include(yield* Effect.flip(undo(changes[0]!.seq)), { reason: "invalid_state" });
      // Another agent's change isn't on this page.
      assert.include(
        yield* Effect.flip(
          ownerLevelUndoAgentChange({ orgId, agentId: other, seq: changes[0]!.seq, by: ownerId }),
        ),
        { reason: "not_found" },
      );
      // A link is one change though both entries name each other; Undo takes off both halves.
      const brief = yield* LeadDocs.create(scope, {
        sourceEventId: "ask-event",
        title: "Invented brief",
        body: "Invented.",
        card: false,
      });
      yield* LeadDocs.link(scope, { key: brief.key, sourceEventId: "ask-event", to: ["W-1"] });
      const sql = yield* SqlClient.SqlClient;
      // Off the test clock, the half back is written a moment after the first.
      const [w1] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
        WHERE org_id = ${orgId} AND key = 'W-1'`;
      yield* sql`UPDATE kin_record_changes SET at = at + 2
        WHERE org_id = ${orgId} AND record_id = ${w1!.id} AND kind = 'linked'`;
      yield* sql`UPDATE kin_record_links SET created_at = created_at + 2
        WHERE org_id = ${orgId} AND record_id = ${w1!.id} AND kind = 'record'`;
      const links = yield* agentChanges(KIN_OWNER_LEVEL, orgId, lead).pipe(
        Effect.map((all) => all.filter((change) => change.kind === "linked")),
      );
      assert.deepStrictEqual(
        links.map((change) => [change.key, change.undo]),
        [[brief.key, true]],
      );
      yield* undo(links[0]!.seq);
      const [left] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM kin_record_links l
        JOIN kin_records r ON r.org_id = l.org_id AND r.key IN (${brief.key}, 'W-1')
        WHERE l.org_id = ${orgId} AND l.kind = 'record'
          AND (l.record_id = r.record_id OR l.target = r.record_id)`;
      assert.strictEqual(left?.n, 0);
      assert.deepInclude(
        (yield* agentChanges(KIN_OWNER_LEVEL, orgId, lead)).find(
          (change) => change.seq === links[0]!.seq,
        ),
        { undo: false, undone: true },
      );
      assert.strictEqual(
        (yield* OwnerWork.get([owner], { orgId, key: "W-1" })).changes[0]!.by._tag,
        "person",
      );
    }).pipe(Effect.provide(layer)),
);

// Loop 2 (Nov 2026): one doc linked to four entries in a minute read as four identical rows, and
// only the newest could be undone.
it.effect(
  "each link on an agent's page names its other end and undoes on its own; a link blocks no field's undo",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const scope = scopeOf(lead);
      const sql = yield* SqlClient.SqlClient;
      const titles = [
        "Invented: north invoice",
        "Invented: south invoice",
        "Invented: east invoice",
        "Invented: west invoice",
      ];
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: titles.map((title) => ({ title })),
      });
      yield* LeadWork.update(scope, {
        key: "W-1",
        sourceEventId: "ask-event",
        title: "Invented: north v2",
      });
      const notes = yield* LeadDocs.create(scope, {
        sourceEventId: "ask-event",
        title: "Invented dunning notes",
        body: "Invented.",
        card: false,
      });
      for (const key of ["W-1", "W-2", "W-3", "W-4"])
        yield* LeadDocs.link(scope, { key: notes.key, sourceEventId: "ask-event", to: [key] });
      // The owner writes W-1's notes after: its title can still go back, the field is untouched.
      const w1 = yield* OwnerWork.get([owner], { orgId, key: "W-1" });
      yield* OwnerWork.update([owner], { orgId, key: "W-1", rev: w1.rev, notes: "Invented note." });
      const read = (viewer: KinViewer = KIN_OWNER_LEVEL) => agentChanges(viewer, orgId, lead);
      const linkRows = (all: ReadonlyArray<KinAgentChange>) =>
        all
          .filter((change) => change.kind === "linked")
          .map((change) => [
            change.key,
            change.linkedTo,
            change.undo,
            change.since,
            change.undone ?? false,
          ]);
      const end = (key: string, title: string) => ({ key: KinRecordKey.make(key), title });
      assert.deepStrictEqual(linkRows(yield* read()), [
        [notes.key, end("W-4", titles[3]!), true, false, false],
        [notes.key, end("W-3", titles[2]!), true, false, false],
        [notes.key, end("W-2", titles[1]!), true, false, false],
        [notes.key, end("W-1", "Invented: north v2"), true, false, false],
      ]);
      const before = yield* read();
      assert.deepInclude(
        before.find((change) => change.key === "W-1" && change.kind === "updated"),
        {
          undo: true,
          since: false,
        },
      );
      // An add: any later change stands in its way, and one with only links says so.
      const added = (key: string) =>
        before.find((change) => change.key === key && change.kind === "created")!;
      assert.deepInclude(added("W-2"), { undo: false, since: true, linkedSince: true });
      assert.deepInclude(added("W-1"), { undo: false, since: true });
      assert.notProperty(added("W-1"), "linkedSince");
      // Kin never takes back a doc it added, so nothing later is "in the way" of it.
      assert.deepInclude(added(notes.key), { undo: false, since: false });
      const second = before.filter((change) => change.kind === "linked")[2]!;
      yield* ownerLevelUndoAgentChange({ orgId, agentId: lead, seq: second.seq, by: ownerId });
      const left = yield* sql<{ key: string; n: number }>`SELECT o.key, count(*) AS n
        FROM kin_record_links l JOIN kin_records d ON d.org_id = l.org_id AND d.key = ${notes.key}
        JOIN kin_records o ON o.org_id = l.org_id
          AND ((l.record_id = d.record_id AND l.target = o.record_id)
            OR (l.target = d.record_id AND l.record_id = o.record_id))
        WHERE l.org_id = ${orgId} AND l.kind = 'record' GROUP BY o.key ORDER BY o.key`;
      assert.deepStrictEqual(
        left.map((row) => [row.key, row.n]),
        [
          ["W-1", 2],
          ["W-3", 2],
          ["W-4", 2],
        ],
      );
      assert.deepStrictEqual(linkRows(yield* read()), [
        [notes.key, end("W-4", titles[3]!), true, false, false],
        [notes.key, end("W-3", titles[2]!), true, false, false],
        [notes.key, end("W-2", titles[1]!), false, false, true],
        [notes.key, end("W-1", "Invented: north v2"), true, false, false],
      ]);
      assert.include(
        yield* Effect.flip(
          ownerLevelUndoAgentChange({ orgId, agentId: lead, seq: second.seq, by: ownerId }),
        ),
        { reason: "invalid_state" },
      );
      // A teammate reads only what they see: the doc and the task they hold, the rest unnamed.
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE org_id = ${orgId} AND key = ${notes.key}`;
      yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE org_id = ${orgId} AND person_id = ${mateId}`;
      yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${mateId}
        WHERE org_id = ${orgId} AND key = 'W-3'`;
      const theirs = yield* read(viewerOfPeople([mateId]));
      assert.deepStrictEqual(linkRows(theirs), [
        [notes.key, null, true, false, false],
        [notes.key, end("W-3", titles[2]!), true, false, false],
        [notes.key, null, false, false, true],
        [notes.key, null, true, false, false],
      ]);
      assert.deepStrictEqual(
        [...new Set(theirs.map((change) => change.key))].sort(),
        [notes.key, "W-3"].sort(),
      );
      // A move to another project names both by title, but only those this viewer may see.
      const project = (name: string) =>
        OwnerClients.createProject([owner], { orgId, name, clientRequestId: name });
      const from = yield* project("Invented portal");
      const to = yield* project("Invented rebrand");
      yield* LeadWork.update(scope, { key: "W-3", sourceEventId: "ask-event", project: from.key });
      yield* LeadWork.update(scope, { key: "W-3", sourceEventId: "ask-event", project: to.key });
      const moved = (all: ReadonlyArray<KinAgentChange>) => all[0];
      assert.deepInclude(moved(yield* read()), {
        fields: [{ field: "project", from: from.key, to: to.key }],
        named: [end(from.key, "Invented portal"), end(to.key, "Invented rebrand")],
      });
      yield* OwnerClients.projectPeople([owner], {
        orgId,
        key: to.key,
        add: [{ _tag: "person", personId: mateId }],
      });
      assert.deepInclude(moved(yield* read(viewerOfPeople([mateId]))), {
        fields: [{ field: "project", from: from.key, to: to.key }],
        named: [end(to.key, "Invented rebrand")],
      });
    }).pipe(Effect.provide(layer)),
);

// Walk 5 (Nov 2026): someone off for a week had their tasks moved one by one.
it.effect(
  "give all open tasks to someone: one move each, one message, undone by giving those back; a teammate gives only their own",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, ${lead}, ${ownerId}, ${at})`;
      // Midday on the company's clock and hers, so what she is told arrives now.
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:00', '18:00', '02:00',
          0, 1, '09:00', '{}') ON CONFLICT (org_id) DO UPDATE SET time_zone = 'UTC'`;
      yield* TestClock.setTime(Date.parse("2026-11-16T12:00:00.000Z"));
      const meeraId = KinPersonId.make("meera");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${meeraId}, ${orgId}, 'meera', 'Meera', ${at}, 'co_owner')`;
      const meera = { _tag: "person" as const, orgId, personId: meeraId };
      const mateHolds = { _tag: "person" as const, personId: mateId };
      const meeraHolds = { _tag: "person" as const, personId: meeraId };
      const keys = yield* Effect.forEach(
        ["Invented: copy", "Invented: icons", "Invented: done one"],
        (title) =>
          OwnerWork.create([owner], {
            orgId,
            title,
            owner: mateHolds,
            clientRequestId: title,
          }).pipe(Effect.map((made) => made.key)),
      );
      // One repeats and is open to everyone on the team; both go with it, as they are.
      const weekly = { every: "days" as const, days: 7 };
      const first = (yield* OwnerWork.get([owner], { orgId, key: keys[0]! })).rev;
      yield* OwnerWork.update([owner], {
        orgId,
        key: keys[0]!,
        rev: first,
        dueAt: "2026-11-20",
        dueAllDay: true,
        repeat: weekly,
      });
      yield* OwnerWork.share([owner], { orgId, keys: [keys[0]!], shared: true });
      const keepsItsWay = Effect.fn(function* () {
        assert.deepInclude(yield* OwnerWork.get([owner], { orgId, key: keys[0]! }), {
          shared: true,
          repeat: weekly,
        });
      });
      const done = (yield* OwnerWork.get([owner], { orgId, key: keys[2]! })).rev;
      yield* OwnerWork.update([owner], { orgId, key: keys[2]!, rev: done, state: "done" });
      const told = sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE chat_id = 'mate-chat' AND message_id LIKE 'kin-assign-%' ORDER BY seq`;
      const before = (yield* told).length;
      // A teammate gives away only their own.
      assert.include(
        yield* Effect.flip(
          OwnerWork.handOver([mate], {
            orgId,
            from: { _tag: "person", personId: ownerId },
            to: mateHolds,
          }),
        ),
        { reason: "not_allowed" },
      );
      // The count first, before anyone is chosen, then the move: open ones only, each recorded as a reassignment.
      assert.deepStrictEqual(
        yield* OwnerWork.handOver([meera], {
          orgId,
          from: mateHolds,
          to: mateHolds,
          dryRun: true,
        }),
        { keys: [keys[0], keys[1]], kept: 0 },
      );
      const moved = yield* OwnerWork.handOver([meera], { orgId, from: mateHolds, to: meeraHolds });
      assert.deepStrictEqual(moved, { keys: [keys[0], keys[1]], kept: 0 });
      for (const key of moved.keys) {
        const task = yield* OwnerWork.get([owner], { orgId, key });
        assert.deepStrictEqual(task.owner, meeraHolds);
        assert.deepInclude(task.changes[0]!.fields, {
          field: "owner",
          from: `person:${mateId}`,
          to: `person:${meeraId}`,
        });
      }
      assert.deepStrictEqual(
        (yield* OwnerWork.get([owner], { orgId, key: keys[2]! })).owner,
        mateHolds,
      );
      yield* keepsItsWay();
      // Told once for both.
      const after = (yield* told).slice(before).map((row) => row.body);
      assert.lengthOf(after, 1);
      assert.include(after[0], keys[0]!);
      assert.include(after[0], keys[1]!);
      // Undo gives exactly those back.
      yield* OwnerWork.assign([owner], { orgId, key: keys[2]!, to: meeraHolds }).pipe(
        Effect.ignore,
      );
      assert.deepStrictEqual(
        yield* OwnerWork.handOver([meera], {
          orgId,
          from: meeraHolds,
          to: mateHolds,
          keys: moved.keys,
        }),
        { keys: moved.keys, kept: 0 },
      );
      for (const key of moved.keys)
        assert.deepStrictEqual((yield* OwnerWork.get([owner], { orgId, key })).owner, mateHolds);
      yield* keepsItsWay();
      // Her own, to the owner.
      assert.deepStrictEqual(
        (yield* OwnerWork.handOver([mate], {
          orgId,
          from: mateHolds,
          to: { _tag: "person", personId: ownerId },
        })).keys,
        moved.keys,
      );
    }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);

it.effect(
  "G04 G05: the owner gives any task in any project, an agent's edit keeps it with its holder, and a project's members see its tasks",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      yield* sensitiveShown({ orgId, wakeupId: "wake" });
      const records = yield* KinRecords.KinRecords;
      const ownerHolds = { _tag: "person" as const, personId: ownerId };
      const client = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "client",
        title: "Invented Pinecrest",
        owner: ownerHolds,
        sensitive: true,
      })).row;
      const project = (yield* records.create(orgId, ownerWrites, {
        list: "projects",
        originKey: "project",
        title: "Invented pharmacy app",
        owner: ownerHolds,
        partyId: client.recordId,
      })).row;
      // G05: inside a private client's project, to a teammate who doesn't lead it.
      const given = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: login screens",
        owner: { _tag: "person", personId: mateId },
        project: project.key,
        clientRequestId: "g05",
      });
      assert.notProperty(given, "sensitiveInherited");
      const loose = yield* ownerTask("brand board", {
        owner: { _tag: "person", personId: mateId },
      });
      // G04: the agent in a turn shown a price dates both and files the loose one in the project.
      const scope = scopeOf(lead);
      yield* LeadWork.update(scope, {
        key: given.key,
        sourceEventId: "ask-event",
        due: "2026-11-20",
      });
      const moved = yield* LeadWork.update(scope, {
        key: loose.key,
        sourceEventId: "ask-event",
        project: project.key,
        due: "2026-11-21",
      });
      assert.notProperty(moved, "noLongerSeenBy");
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        given.key,
        loose.key,
      ]);
      // Marked private on purpose, it stays with whoever holds it, and the result says who lost it.
      const ownersOwn = yield* ownerTask("owner's copy", {
        projectId: project.recordId,
        team: true,
      });
      const hidden = yield* LeadWork.update(scope, {
        key: ownersOwn.key,
        sourceEventId: "ask-event",
        sensitive: true,
      });
      assert.deepStrictEqual(hidden.noLongerSeenBy, ["Mate"]);
      // A project's members see its tasks and milestones not marked private.
      const plan = yield* ownerTask("plan review", { projectId: project.recordId });
      const milestone = (yield* records.create(orgId, ownerWrites, {
        list: "milestones",
        originKey: "milestone",
        title: "Invented beta",
        owner: ownerHolds,
        projectId: project.recordId,
      })).row;
      assert.notInclude(keysOf(yield* OwnerWork.list([mate], { orgId })), plan.key);
      const byProject = OwnerWork.list([mate], { orgId, project: project.key });
      const mateHolds = { _tag: "person" as const, personId: mateId };
      yield* OwnerClients.projectPeople([owner], { orgId, key: project.key, add: [mateHolds] });
      assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), plan.key);
      // Its page lists them too, as the member sees them: the private one stays out.
      const onPage = keysOf(yield* byProject);
      assert.include(onPage, plan.key);
      assert.notInclude(onPage, ownersOwn.key);
      assert.isTrue(
        (yield* teamVisible(orgId, mateId, [milestone.recordId])).has(milestone.recordId),
      );
      // A member changes nobody's place on a project they don't lead, their own included; one
      // they can't see answers as no project at all.
      const portal = (yield* records.create(orgId, ownerWrites, {
        list: "projects",
        originKey: "portal",
        title: "Invented portal",
        owner: ownerHolds,
      })).row;
      const people = (
        key: string,
        change: { add?: ReadonlyArray<KinWorkPrincipal>; remove?: ReadonlyArray<KinWorkPrincipal> },
      ) => OwnerClients.projectPeople([mate], { orgId, key, ...change });
      assert.include(yield* Effect.flip(people(portal.key, { add: [mateHolds] })), {
        reason: "not_found",
      });
      yield* OwnerClients.projectPeople([owner], { orgId, key: portal.key, add: [mateHolds] });
      const agentOn = { _tag: "agent" as const, agentId: lead };
      for (const change of [{ remove: [mateHolds] }, { add: [agentOn] }])
        assert.include(yield* Effect.flip(people(portal.key, change)), { reason: "not_allowed" });
      // Its lead puts people and agents on it and takes them off.
      yield* records.update(orgId, ownerWrites, portal.key, { owner: mateHolds });
      assert.deepStrictEqual((yield* people(portal.key, { add: [agentOn] })).members, [
        mateHolds,
        agentOn,
      ]);
      assert.deepStrictEqual((yield* people(portal.key, { remove: [agentOn] })).members, [
        mateHolds,
      ]);
      // The lead marks a task of theirs "Only me": they keep it, and take the mark off again.
      const draft = yield* ownerTask("portal copy", { projectId: portal.recordId });
      const marked = yield* OwnerWork.update([mate], {
        orgId,
        key: draft.key,
        rev: draft.rev,
        sensitive: true,
      });
      assert.deepInclude(marked, { sensitive: true, markedBy: mateId });
      assert.isTrue(marked.can?.unmark);
      assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), draft.key);
      assert.isFalse(
        (yield* OwnerWork.update([mate], {
          orgId,
          key: draft.key,
          rev: marked.rev,
          sensitive: false,
        })).sensitive,
      );
      // One the owner marked stays his to unmark.
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: ownersOwn.key, rev: 99, sensitive: false }),
        ),
        { reason: "not_found" },
      );
      // Taken off a project, its tasks leave their view at once.
      yield* OwnerClients.projectPeople([owner], { orgId, key: project.key, remove: [mateHolds] });
      assert.notInclude(keysOf(yield* OwnerWork.list([mate], { orgId })), plan.key);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "G13: a task handed back goes to the same holder again only after it changed or the owner said so",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      const scope = scopeOf(lead);
      const [made] = (yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: set up the repo" }],
      })).records;
      const key = made!.key;
      const give = LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key, to: other, reason: "Invented: owns infra" }],
      });
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES ('other-wake', ${orgId}, ${other}, 'other-thread', 'test', 0, 'running', '[]',
        'owner_only')`;
      const bounce = Effect.gen(function* () {
        yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'other-wake'
          WHERE tag = 'record.changed' AND agent_id = ${other}`;
        const [event] = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
          FROM kin_events WHERE wakeup_id = 'other-wake' ORDER BY event_id DESC LIMIT 1`;
        return yield* LeadWork.handBack(scopeOf(other), {
          key,
          sourceEventId: event!.eventId,
          note: "Invented: no repo yet; needs its URL",
        });
      });
      yield* give;
      yield* bounce;
      // A copy of an owner-level person's words Kin passed on (`origin`) is no word of theirs here.
      const copied = (origin: string | null) =>
        sql`UPDATE kin_messages SET origin_json = ${origin} WHERE org_id = ${orgId}
          AND message_id = (SELECT json_extract(json, '$.messageId') FROM kin_events
            WHERE org_id = ${orgId} AND event_id = 'ask-event')`;
      yield* copied(JSON.stringify({ agentId: "chief", chatId: "first-chat", messageId: "first" }));
      assert.include((yield* Effect.flip(give)).message, "no repo yet");
      // Said here, the owner's own word sends it back.
      yield* copied(null);
      yield* give;
      yield* bounce;
      // A turn the owner's words didn't start, as a hand back's wake: it doesn't go straight back.
      yield* sql`UPDATE kin_events SET tag = 'chat.reaction' WHERE event_id = 'ask-event'`;
      assert.include((yield* Effect.flip(give)).message, "no repo yet");
      // Once what blocked it is addressed, it may.
      yield* LeadWork.update(scope, {
        key,
        sourceEventId: "ask-event",
        notes: "Invented: repo is invented/app",
      });
      yield* give;
      // Model tasks: given to someone else meanwhile, it still doesn't bounce back to the agent
      // that handed it back before, nothing on it having changed since.
      yield* bounce;
      yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: [{ key, to: "Mate", reason: "Invented: has time" }],
      });
      yield* OwnerWork.handBack([mate], { orgId, key, note: "Invented: not my area" });
      assert.include((yield* Effect.flip(give)).message, "no repo yet");
      // Model people: someone removed from the company is given nothing.
      yield* sql`UPDATE kin_people SET removed_at = 1 WHERE person_id = ${mateId}`;
      yield* LeadWork.update(scope, {
        key,
        sourceEventId: "ask-event",
        notes: "Invented: design is ready",
      });
      const toGone = yield* Effect.flip(
        LeadWork.assign(scope, {
          sourceEventId: "ask-event",
          tasks: [{ key, to: "Mate", reason: "Invented: has time" }],
        }),
      );
      assert.include(toGone.message, "No one called Mate is in the company");
    }).pipe(Effect.provide(layer)),
);

/** The reply bridge's post for `wakeupId`, as it stores one. */
const reply = (id: string, wakeupId: string) =>
  ChatRepository.KinChatRepository.pipe(
    Effect.flatMap((repo) =>
      repo.insertMessage({
        orgId,
        chatId: KinChatId.make("lead-chat"),
        audience: "chat",
        messageId: KinMessageId.make(id),
        author: {
          _tag: "agent",
          agentId: lead,
          memberId: KinMemberId.make("lead-chat-lead"),
          ownerPersonId: ownerId,
          threadId: ThreadId.make("lead-thread"),
        },
        kind: "text",
        body: `Invented reply ${id}.`,
        intent: "answer",
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        createdAt: at,
        editedAt: null,
        clientMessageId: { kind: "send", id: `reply:${id}` },
        wakeupId: KinWakeupId.make(wakeupId),
        placeReplyFigures: true,
      }),
    ),
  );
const ownerReads = ChatRepository.KinChatRepository.pipe(
  Effect.flatMap((repo) =>
    repo.history({
      orgId,
      chatId: KinChatId.make("lead-chat"),
      beforeSeq: 100,
      limit: 50,
      viewerMemberId: KinMemberId.make("lead-chat-owner"),
    }),
  ),
  Effect.map((page) => new Map(page.messages.map((message) => [message.messageId, message]))),
);
const receiptRows = (turn: KinTurnChanges | undefined) =>
  turn?.items.map((item) => [item.key, item.what, item.undoable, item.undone]);
const receiptLayer = Layer.provideMerge(
  ChatHub.layer,
  Layer.provideMerge(ChatRepository.layer, layer),
);

// Turn receipts (Nov 2026): what a turn changed was shown only on the agent's own page.
it.effect("an agent's reply carries what its own wake-up changed, as each reader may see it", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* ChatRepository.KinChatRepository;
    yield* repo.registerAgentThread({
      orgId,
      agentId: lead,
      threadId: ThreadId.make("lead-thread"),
      startedAt: at,
      endedAt: null,
    });
    yield* sql`UPDATE kin_agents SET display_name = 'Finance' WHERE agent_id = ${other}`;
    const scope = scopeOf(lead);
    yield* OwnerWork.create([owner], {
      orgId,
      title: "Invented: reconcile the bank feed",
      clientRequestId: "before-turn",
    });
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: pricing page" }],
    });
    yield* LeadWork.assign(scope, {
      sourceEventId: "ask-event",
      tasks: [{ key: "W-1", to: "Finance", reason: "Invented: month end" }],
    });
    // Named in no link of the reply: the receipt alone says it opens as a client, and a contact
    // as its client's page.
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [
        { list: "clients", title: "Invented Acme" },
        { list: "contacts", title: "Invented Ola", client: "Invented Acme" },
      ],
    });
    yield* reply("first", "wake");
    // The next wake-up, in the same chat, changes seven things.
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wake'`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids, audience)
        VALUES ('wake-2', ${orgId}, ${lead}, 'lead-thread', 'test', 1, 'running', '["ask-event"]',
          'owner_only')`;
    yield* sql`UPDATE kin_events SET wakeup_id = 'wake-2' WHERE event_id = 'ask-event'`;
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: launch plan" }, { title: "Invented: press list" }],
    });
    yield* LeadWork.update(scope, { key: "W-3", sourceEventId: "ask-event", state: "done" });
    yield* LeadWork.update(scope, {
      key: "W-4",
      sourceEventId: "ask-event",
      notes: "Invented: two outlets",
    });
    yield* LeadWork.update(scope, { key: "W-4", sourceEventId: "ask-event", due: "2026-11-24" });
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: venue" }, { title: "Invented: caterer" }],
    });
    yield* reply("second", "wake-2");
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wake-2'`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids, audience)
        VALUES ('wake-3', ${orgId}, ${lead}, 'lead-thread', 'test', 2, 'running', '[]', 'owner_only')`;
    yield* reply("empty", "wake-3");
    const read = yield* ownerReads;
    const first = read.get(KinMessageId.make("first"))!.turnChanges;
    assert.deepInclude(first, { count: 4, more: 0 });
    assert.deepStrictEqual(receiptRows(first), [
      ["W-2", "created", true, false],
      ["W-1", "given to Finance", true, false],
      ["C-1", "created", false, false],
      ["CT-1", "created", false, false],
    ]);
    assert.deepStrictEqual(
      first!.items.map((item) => [item.kind, item.party]),
      [
        ["task", undefined],
        ["task", undefined],
        ["client", undefined],
        ["entry", "C-1"],
      ],
    );
    assert.deepStrictEqual(first!.items[0]!.change.agentId, lead);
    // A turn that changed nothing says so, unlike an older server.
    assert.deepStrictEqual(read.get(KinMessageId.make("empty"))!.turnChanges, {
      count: 0,
      items: [],
      more: 0,
    });
    const second = read.get(KinMessageId.make("second"))!.turnChanges;
    assert.deepInclude(second, { count: 7, more: 2 });
    assert.deepStrictEqual(
      second!.items.map((item) => [item.key, item.what]),
      [
        ["W-3", "created"],
        ["W-4", "created"],
        ["W-3", "done"],
        ["W-4", "notes changed"],
        ["W-4", "due moved to 24 Nov"],
      ],
    );
    // A person's own message and Kin's notice carry none, even one of the same wake-up.
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role,
          kind, body, mentions_json, status, created_at, source_wakeup_id)
        VALUES ('notice', ${orgId}, 'lead-chat', 50, 'system', 'member', 'system', 'Invented notice',
          '[]', 'posted', ${at}, 'wake')`;
    const notices = yield* ownerReads;
    for (const id of ["ask", "notice"])
      assert.notProperty(notices.get(KinMessageId.make(id))!, "turnChanges");
    // A teammate reads only what they see, counted as they see it, and can't Undo it.
    yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${mateId}
        WHERE org_id = ${orgId} AND key = 'W-5'`;
    const theirs = yield* turnChanges(viewerOfPeople([mateId]), orgId, ["first", "second"]);
    assert.deepStrictEqual(theirs.get("first"), { count: 0, items: [], more: 0 });
    assert.deepInclude(theirs.get("second"), { count: 1, more: 0 });
    assert.deepStrictEqual(receiptRows(theirs.get("second")), [["W-5", "created", false, false]]);
  }).pipe(Effect.provide(receiptLayer)),
);

it.effect(
  "an Undo from a receipt reads back as undone, sent once to every reader of the reply",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn();
      const repo = yield* ChatRepository.KinChatRepository;
      yield* repo.registerAgentThread({
        orgId,
        agentId: lead,
        threadId: ThreadId.make("lead-thread"),
        startedAt: at,
        endedAt: null,
      });
      const scope = scopeOf(lead);
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: pricing page" }],
      });
      yield* LeadWork.update(scope, {
        key: "W-1",
        sourceEventId: "ask-event",
        title: "Invented: pricing v2",
      });
      const posted = yield* reply("done", "wake");
      const before = (yield* ownerReads).get(posted.messageId)!;
      const [, renamed] = before.turnChanges!.items;
      assert.deepInclude(renamed, { what: "renamed", undoable: true, undone: false });
      const events = yield* (yield* KinChatHub).subscribeAll;
      yield* ownerLevelUndoAgentChange({
        orgId,
        agentId: renamed!.change.agentId,
        seq: renamed!.change.seq,
        by: ownerId,
      });
      yield* (yield* KinChatHub).publish({
        type: "read.updated",
        orgId,
        chatId: KinChatId.make("lead-chat"),
        memberId: KinMemberId.make("lead-chat-owner"),
        seq: 0,
      });
      const sent = yield* events.pipe(
        Stream.takeUntil((event) => event.type === "read.updated"),
        Stream.runCollect,
      );
      const changed = sent.filter(
        (event) => event.type === "message.changed" && event.message.messageId === posted.messageId,
      );
      assert.lengthOf(changed, 1);
      const after = (yield* ownerReads).get(posted.messageId)!;
      assert.isAbove(after.changeSeq!, before.changeSeq!);
      assert.deepInclude(after.turnChanges!.items[1], { undoable: false, undone: true });
      // The Undo is the owner's change, never counted in the agent's turn.
      assert.strictEqual(after.turnChanges!.count, 2);
    }).pipe(Effect.provide(receiptLayer)),
);
