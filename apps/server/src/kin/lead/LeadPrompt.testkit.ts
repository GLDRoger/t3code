import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  MemoryItemHead,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Chat from "../chat/KinChatRepository.ts";
import { authorityLayer } from "../chat/WakeupAuthority.testkit.ts";
import * as Memory from "../memory/Memory.ts";
import { buildIndex } from "../memory/buildIndex.ts";
import { KinLeadPrompt, type KinLeadPromptInput } from "./LeadPrompt.ts";

export const decodeEvent = Schema.decodeSync(KinEvent);
export const decodeUnknownEvent = Schema.decodeUnknownSync(KinEvent);
export const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);
export const decodeEventEffect = Schema.decodeEffect(KinEvent);
export const decodeBody = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String })),
);
export const orgId = KinOrgId.make("fixture-org");
export const agentId = KinAgentId.make("fixture-lead");
export const chatId = KinChatId.make("fixture-chat");
export const personId = KinPersonId.make("fixture-owner");
export const memberId = KinMemberId.make("fixture-member");
export const timestamp = "2026-11-08T00:00:00.000Z";
export const input: KinLeadPromptInput = {
  orgId,
  agentId,
  wakeupId: KinWakeupId.make("fixture-wake"),
  memoryHead: "head-one",
  events: [],
};
export const event = (messageId: string) =>
  decodeEvent({
    _tag: "chat.message",
    orgId,
    agentId,
    chatId,
    messageId,
    eventId: `event-${messageId}`,
    receivedAt: timestamp,
    dedupeKey: null,
    provenance: { _tag: "system" },
  });
// The repository only takes a lead's message inside its running wake-up; these are history.
export const insertLeadMessage = Effect.fn("test.insertLeadMessage")(function* (
  id: string,
  body: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_chats SET last_seq = last_seq + 1 WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
      author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, mentions_json,
      status, created_at)
    SELECT ${id}, ${orgId}, ${chatId}, last_seq, 'agent', ${agentId}, ${personId}, 'fixture-thread',
      'lead-member', 'member', 'text', ${body}, '[]', 'posted', ${timestamp}
    FROM kin_chats WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
});
export const task = (id: string, trust: "owner" | "member") => ({
  head: decodeHead({
    orgId,
    id,
    path: `deferrals/${id}.md`,
    kind: "deferral",
    title: "Open PRs digest",
    status: "open",
    due: null,
    every: { at: "08:00", days: [1, 2, 3, 4, 5] },
    what: "List the open PRs and who blocks each one.",
    recorded_at: timestamp,
    valid_from: timestamp,
    invalid_at: null,
    superseded_by: null,
    review_by: null,
    source: "owner-chat",
    said_by: trust === "owner" ? "owner" : "fixture-member",
    trust,
    links: [],
  }),
  body: "Every weekday at 8, tell me which PRs are stuck.\n",
});
const reminder = {
  head: decodeHead({
    ...task("rem", "owner").head,
    title: "Stretch",
    what: "Stretch",
    due: "2026-11-08T00:00:00Z",
    every: undefined,
    on_due: "remind",
  }),
  body: "Stretch\n",
};
// Asked for in a turn that was shown something sensitive.
const markedReminder = {
  head: decodeHead({
    ...reminder.head,
    id: "rem-marked",
    source_event: "marked-wake:event-marked",
  }),
  body: reminder.body,
};
const dueItems = new Map([
  ["sch-owner", task("sch-owner", "owner")],
  ["sch-member", task("sch-member", "member")],
  ["rem", reminder],
  ["rem-marked", markedReminder],
]);
const roomReminder = decodeHead({
  ...task("rem-room", "owner").head,
  title: "Invented room reminder",
  every: undefined,
  chat: "fixture-room",
  source_event: "room-ask:event-room",
});
// From before reminders recorded their source event: where it was asked can't be resolved.
const legacyReminder = decodeHead({
  ...task("rem-legacy", "owner").head,
  title: "Invented legacy reminder",
  every: undefined,
  chat: "fixture-room",
});
const note = (id: string, title: string, fields: Partial<MemoryItemHead>) =>
  decodeHead({
    ...task(id, "owner").head,
    kind: "claim",
    path: `claims/${id}.md`,
    title,
    every: undefined,
    what: undefined,
    ...fields,
  });
export const noteBody = "Invented note body.\n";
// What the leads remember: one thing the team can know, one for the owner alone, one nobody has
// labelled, one a teammate said in a room, and one the owner has since asked to keep.
export const notes = [
  note("team", "Invented-team-status-zq", { sensitive: false }),
  note("terms", "Invented-client-terms-zq", { sensitive: true }),
  note("legacy", "Invented-unlabelled-zq", {}),
  note("said", "Invented-teammate-said-zq", {
    sensitive: false,
    trust: "member",
    said_by: "teammate",
    shared_from: {
      person: KinPersonId.make("fixture-teammate"),
      chat: KinChatId.make("fixture-chat"),
      name: "Teammate",
      chat_name: "Invented room",
    },
  }),
  note("kept", "Invented-kept-since-zq", { sensitive: false }),
  // Written before labels: the nightly pass suggested the team can know it, which is not enough.
  note("sorted", "Invented-sorted-overnight-zq", {}),
  // Its file says the team can know it, but no one with the authority to say so did.
  note("claimed", "Invented-model-labelled-zq", { sensitive: false }),
  // The owner let the team know it, then it was reworded without them.
  note("reworded", "Invented-reworded-since-zq", { sensitive: false }),
  // What the lead's seat lists: a standing permission and a position of its own.
  note("permit", "Invented-permission-zq", {
    kind: "decision",
    links: ["permission:Lead"],
    sensitive: true,
  }),
  note("stance", "Invented-position-zq", {
    kind: "decision",
    trust: "agent",
    links: ["position:Lead"],
    sensitive: true,
  }),
];
export const database = authorityLayer;
export const repository = Chat.layer.pipe(Layer.provide(database));
export const memory = Layer.succeed(
  Memory.Memory,
  Memory.Memory.of({
    withWriterLock: (_org, effect) => effect,
    anchor: () => Effect.succeed("fixture"),
    record: () => Effect.void,
    recover: () => Effect.void,
    withHistoryRewrite: () => Effect.die("Unused"),
    withLandingLock: (_org, effect) => effect,
    landingState: () => Effect.die("Unused"),
    purgeInFlight: () => Effect.die("Unused"),
    historyGeneration: () => Effect.die("Unused"),
    items: () => Effect.die("Unused"),
    readPromptSnapshot: (org, head) =>
      org !== orgId || !["head-one", "head-two"].includes(head)
        ? Effect.fail(new Memory.MemoryError({ orgId: org, operation: "promptSnapshot" }))
        : Effect.succeed({
            rules: `Invented rules ${head}`,
            index: `Invented index ${head}\n- [deferral] Invented room reminder (deferrals/rem-room.md)\n- [deferral] Invented legacy reminder (deferrals/rem-legacy.md)\n${buildIndex(notes, {}, Date.parse(timestamp), "UTC").split("\n").slice(1).join("\n")}`,
            items: notes,
            bodies: new Map(notes.map((head) => [head.path, noteBody])),
          }),
    ensureCheckouts: () => Effect.die("Unused"),
    prepareWakeup: () => Effect.die("Unused"),
    readIndex: () => Effect.die("Unused"),
    readRules: () => Effect.die("Unused"),
    // A reminder asked for in fixture-room, which only some tests create.
    query: () =>
      Effect.succeed([
        { ...roomReminder, duplicate: false },
        { ...legacyReminder, duplicate: false },
      ]),
    readItem: () => Effect.die("Unused"),
    readItemQuietly: (org, id) => {
      const found = org === orgId ? dueItems.get(id) : undefined;
      return found === undefined
        ? Effect.fail(new Memory.MemoryNotFound({ orgId: org, id }))
        : Effect.succeed(found);
    },
    rebuildIndex: () => Effect.die("Unused"),
    rebuildCache: () => Effect.die("Unused"),
    syncCheckout: () => Effect.die("Unused"),
  }),
);
export const teamMemory = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env));
export const layer = KinLeadPrompt.layer.pipe(
  Layer.provideMerge(Layer.merge(repository, memory)),
  Layer.provideMerge(database),
  Layer.merge(teamMemory({ KIN_TEAM_MEMORY: "on" })),
);
export const seed = Effect.gen(function* () {
  const repo = yield* Chat.KinChatRepository;
  yield* repo.insertOrg({ orgId, name: "Invented team", createdAt: timestamp });
  // Pinned: unset, the owner's zone is the host's, which differs between machines.
  yield* (yield* SqlClient.SqlClient)`INSERT INTO kin_trigger_settings (org_id, time_zone,
      morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday,
      owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* repo.insertPerson({
    orgId,
    personId,
    displayName: "Fixture",
    handle: "fixture",
    githubLogin: null,
    createdAt: timestamp,
  });
  yield* repo.createChat({
    orgId,
    chatId,
    kind: "team_group",
    title: null,
    teamId: null,
    lastMessageAt: null,
    createdAt: timestamp,
    archivedAt: null,
    directKey: null,
  });
  return repo;
});

export const teammateId = KinPersonId.make("fixture-teammate");
export const teammateMember = KinMemberId.make("fixture-teammate-member");
export const routineEvent = decodeEvent({
  _tag: "routine",
  orgId,
  agentId,
  eventId: "routine",
  receivedAt: timestamp,
  provenance: { _tag: "system" },
  dedupeKey: null,
  routine: "morning_brief",
});
/** The lead and its owner in `chatId`, the lead's owner chat; nobody else unless a test adds them. */
export const leadWithOwner = Effect.gen(function* () {
  const repo = yield* seed;
  const sql = yield* SqlClient.SqlClient;
  yield* repo.insertAgent({
    orgId,
    agentId,
    displayName: "Fixture lead",
    role: "lead",
    ownerPersonId: personId,
    createdAt: timestamp,
  });
  for (const [id, principal, role] of [
    [memberId, { _tag: "person", personId }, "owner"],
    [KinMemberId.make("lead-member"), { _tag: "agent", agentId }, "member"],
  ] as const)
    yield* repo.addMember({
      orgId,
      chatId,
      memberId: id,
      principal,
      role,
      joinedAt: timestamp,
      leftAt: null,
      mutedUntil: null,
    });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${orgId}, 'Lead', 0, '{}', '[]', ${chatId})`;
  return repo;
});
/** A finished wake-up whose stored events are `events`, which is all the audience reads. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const stored = Effect.fn("test.stored")(function* (
  wakeupId: string,
  events: ReadonlyArray<KinEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
    VALUES (${wakeupId}, ${orgId}, ${agentId}, 'model', 0, 'completed', '[]')`;
  for (const item of events)
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES (${`${wakeupId}:${item.eventId}`}, ${orgId}, ${agentId}, ${item._tag}, 'P0', ${encodeJson(item)}, 0, 0, 'done', ${wakeupId})`;
});
