import { expect, it } from "@effect/vitest";
import { KIN_TEAM_ROOM_TEAM_ID, KinMessageId, type KinAuthor, KinEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Chat from "../chat/KinChatRepository.ts";
import { directKey } from "./LeadAccess.ts";
import contextBudget from "../mcp/agentContextBudget.json" with { type: "json" };
import { KinLeadPrompt } from "./LeadPrompt.ts";
import {
  agentId,
  chatId,
  decodeEvent,
  input,
  layer,
  leadWithOwner,
  memberId,
  orgId,
  personId,
  stored,
  teammateId,
  teammateMember,
  timestamp,
} from "./LeadPrompt.testkit.ts";

const system = { orgId, agentId, receivedAt: timestamp, provenance: { _tag: "system" } } as const;
const owner = { _tag: "human", personId, memberId } as const;
const teammate = { _tag: "human", personId: teammateId, memberId: teammateMember } as const;

const said = Effect.fn("test.said")(function* (id: string, author: KinAuthor) {
  const repo = yield* Chat.KinChatRepository;
  yield* repo.insertMessage({
    audience: "chat",
    orgId,
    chatId,
    messageId: KinMessageId.make(id),
    author,
    kind: "text",
    body: `Invented: can you send Meera the launch brief by Friday? (${id})`,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt: timestamp,
    editedAt: null,
    clientMessageId: null,
  });
  return decodeEvent({
    ...system,
    _tag: "chat.message",
    chatId,
    messageId: id,
    eventId: `event-${id}`,
    dedupeKey: null,
    provenance: author,
  });
});

/** The owner's message in the lead's direct chat with them. */
const ownerAsks = Effect.gen(function* () {
  yield* leadWithOwner;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_chats SET kind = 'direct', direct_key = ${directKey(personId, agentId)}
    WHERE chat_id = ${chatId}`;
  return yield* said("asked", owner);
});

const withTeammate = Effect.fn("test.withTeammate")(function* () {
  const repo = yield* leadWithOwner;
  yield* repo.insertPerson({
    orgId,
    personId: teammateId,
    displayName: "Meera",
    handle: "meera",
    githubLogin: null,
    createdAt: timestamp,
  });
  yield* repo.addMember({
    orgId,
    chatId,
    memberId: teammateMember,
    principal: { _tag: "person", personId: teammateId },
    role: "member",
    joinedAt: timestamp,
    leftAt: null,
    mutedUntil: null,
  });
  return yield* said("asked", teammate);
});

const checkIn = (scheduleId: string) =>
  Effect.gen(function* () {
    yield* leadWithOwner;
    return decodeEvent({
      ...system,
      _tag: "pulse",
      eventId: `pulse-${scheduleId}`,
      dedupeKey: null,
      factKeys: [],
      checkIn: { scheduleId, title: "Check-in", what: "Look.", slot: "s" },
    });
  });

const due = (
  subject: Extract<typeof KinEvent.Encoded, { readonly _tag: "deferral.due" }>["subject"],
) =>
  Effect.gen(function* () {
    yield* leadWithOwner;
    return decodeEvent({
      ...system,
      _tag: "deferral.due",
      eventId: "due",
      dedupeKey: null,
      subject,
      lateByMs: 0,
    });
  });

/** The eight kinds of turn a lead is woken for, as `LeadPrompt.test.ts` builds each. */
const TURN_KINDS = {
  ownerReply: { mode: "reply", event: ownerAsks },
  // The Chief of staff's set-up turn: the owner's first word to the company's first agent.
  setUp: {
    mode: "reply",
    event: Effect.gen(function* () {
      const event = yield* ownerAsks;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_leads SET domain = 'chief-of-staff' WHERE agent_id = ${agentId}`;
      return event;
    }),
  },
  checkIn: { mode: "notice", event: checkIn("checkin-morning") },
  pulse: { mode: "notice", event: checkIn("checkin-afternoon") },
  scheduled: {
    mode: "notice",
    event: due({ type: "scheduled_task", itemId: "sch-owner", runId: "run-sch-owner" }),
  },
  reminder: { mode: "notice", event: due({ type: "reminder", itemId: "rem" }) },
  groupReply: { mode: "reply", event: withTeammate() },
  teamRoom: {
    mode: "reply",
    event: Effect.gen(function* () {
      yield* leadWithOwner;
      const event = yield* said("asked", owner);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_chats SET team_id = ${KIN_TEAM_ROOM_TEAM_ID} WHERE chat_id = ${chatId}`;
      return event;
    }),
  },
} as const satisfies Record<
  string,
  {
    readonly mode: "reply" | "notice";
    readonly event: Effect.Effect<KinEvent, unknown, unknown>;
  }
>;

// CI rejects a PR that raises a pinned value, so growth needs the agent-context-increase label.
it.effect.each(Object.keys(TURN_KINDS) as Array<keyof typeof TURN_KINDS>)(
  "a lead's %s turn weighs what the budget pins",
  (kind) =>
    Effect.gen(function* () {
      const turn = TURN_KINDS[kind];
      const event = yield* turn.event;
      yield* stored(input.wakeupId, [event]);
      const built = yield* (yield* KinLeadPrompt).build({
        ...input,
        lane: { chatId, mode: turn.mode },
        events: [event],
      });
      expect(
        Buffer.byteLength(built, "utf8"),
        "Set kinLeadPromptBytes in agentContextBudget.json to the measured value. Before you cut text to fit, run the evals that cover it (evals/README.md).",
      ).toBe(contextBudget.kinLeadPromptBytes[kind]);
    }).pipe(Effect.provide(layer)),
);
