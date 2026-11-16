// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  type KinAgentId,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { turnChat } from "../lead/Audience.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { holdFor, holdLine } from "../triggers/quietHold.ts";
import { parseFields } from "./lists.ts";
import { ownerZone, type RecordRow } from "./recordRows.ts";
import { ownerLevel } from "../people/KinAccess.ts";

/** What a turn did to one person's task: gave it to them, took it from them, or gave it back. */
export type AssignNotice = {
  readonly personId: KinPersonId;
  readonly kind: "given" | "taken" | "returned";
  readonly row: RecordRow;
  /** The agent's one line on why, or the holder's words on a hand back. */
  readonly why: string | null;
  /** Who handed it back, when it is not the agent telling them. */
  readonly by?: string;
};
type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** Keys the message, so a retry posts nothing more. */
  readonly wakeupId: string;
  /** A person who gave it on their own screen: named in place of the agent, and no turn chat. */
  readonly by?: string;
};

const reasonOf = (row: RecordRow) => {
  const reason = parseFields(row.fieldsJson).reason;
  return typeof reason === "string" ? reason : null;
};
/** Who to tell that a task came to them or left them, and why. */
export const movedNotices = (
  before: RecordRow | undefined,
  after: RecordRow,
): Array<AssignNotice> => {
  if (after.registerId !== "work") return [];
  if (
    before !== undefined &&
    before.ownerKind === after.ownerKind &&
    before.ownerId === after.ownerId
  )
    return [];
  const why = reasonOf(after);
  return [
    ...(after.ownerKind === "person"
      ? [{ personId: KinPersonId.make(after.ownerId), kind: "given" as const, row: after, why }]
      : []),
    ...(before?.ownerKind === "person"
      ? [{ personId: KinPersonId.make(before.ownerId), kind: "taken" as const, row: after, why }]
      : []),
  ];
};

const dueText = (row: RecordRow, zone: string) => {
  if (row.dueAt === null) return "";
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(row.dueAllDay === 1 ? {} : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  });
  return `, due ${format.format(row.dueAt).replace(/,/g, "")}`;
};

const meetingAt = (row: RecordRow, zone: string) =>
  row.dateAt === null
    ? ""
    : ` on ${new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(row.dateAt)
        .replace(/,/g, "")}`;

/** A meeting given to someone is theirs to attend, or, once held, on record: never a task to do. */
const meetingLine = (agent: string, notice: AssignNotice, zone: string, now: number) => {
  const { row } = notice;
  const held = row.dateAt !== null && row.dateAt <= now;
  return ended(
    `${agent} ${held ? "recorded your meeting" : "added you to the meeting"} ${row.key} ${row.title}${meetingAt(row, zone)}`,
  );
};

const line = (notice: AssignNotice, zone: string) => {
  const task = `${notice.row.key} ${notice.row.title}`;
  const why = notice.why === null ? "" : `: ${notice.why}`;
  return notice.kind === "given"
    ? `${task}${dueText(notice.row, zone)}${notice.why === null ? "" : `. Why: ${notice.why}`}`
    : notice.kind === "taken"
      ? `took over ${task}${why}`
      : `${notice.by === undefined ? "" : `${notice.by} `}handed ${task} back${why}`;
};
/** A sentence ends once: a note that ends in its own stop gets no second one. */
const ended = (text: string) => (/[.!?…]["”’)]?$/.test(text) ? text : `${text}.`);

/** One message for the person: a line when it is one task, else a list under one heading. */
const bodyFor = (
  agent: string,
  notices: ReadonlyArray<AssignNotice>,
  zone: string,
  now: number,
) => {
  const given = notices.filter((notice) => notice.kind === "given");
  const other = notices.filter((notice) => notice.kind !== "given");
  if (notices.length === 1)
    return given.length === 1
      ? given[0]!.row.category === "meeting"
        ? meetingLine(agent, given[0]!, zone, now)
        : ended(`${agent} gave you ${line(given[0]!, zone)}`)
      : ended(
          other[0]!.by === undefined ? `${agent} ${line(other[0]!, zone)}` : line(other[0]!, zone),
        );
  return [
    given.length === 0
      ? `${agent}:`
      : `${agent} gave you ${given.length === 1 ? "a task" : `${given.length} tasks`}:`,
    ...given.map((notice) => `• ${line(notice, zone)}`),
    ...other.map((notice) => `• ${notice.by === undefined ? "It " : ""}${line(notice, zone)}`),
  ].join("\n");
};

/**
 * Tells each person what this call did to their tasks, in one message: in their direct chat with
 * the agent, else with the team agent, opened if needed. Someone in the turn's own chat already
 * reads the reply, so is not told twice. Returns who was told.
 */
export const tellPeople = Effect.fn("KinAssignNotices.tell")(function* (
  turn: Turn,
  notices: ReadonlyArray<AssignNotice>,
) {
  const told = new Set<string>();
  if (notices.length === 0) return told;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Effect.serviceOption(KinChatRepository);
  if (Option.isNone(repo)) return told;
  const chats = yield* Effect.serviceOption(KinChatService);
  const hub = yield* Effect.serviceOption(KinChatHub);
  const here = turn.by === undefined ? yield* turnChat(turn) : undefined;
  const [agent] = yield* sql<{ name: string; owner: string }>`SELECT display_name AS name,
      owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId}`;
  if (agent === undefined) return told;
  const teamAgent = yield* LeadAccess.teamAgent(turn.orgId);
  const fallbackZone = yield* ownerZone(turn.orgId);
  const byPerson = new Map<string, Array<AssignNotice>>();
  for (const notice of notices)
    byPerson.set(notice.personId, [...(byPerson.get(notice.personId) ?? []), notice]);
  for (const [personId, theirs] of byPerson) {
    const person = KinPersonId.make(personId);
    if (here !== undefined) {
      const reading = yield* sql`SELECT 1 FROM kin_chat_members WHERE org_id = ${turn.orgId}
        AND chat_id = ${here.chatId} AND principal_kind = 'person' AND person_id = ${person}
        AND left_at IS NULL LIMIT 1`;
      if (reading.length > 0) continue;
    }
    const mayMessage =
      agent.owner === person ||
      (yield* ownerLevel(turn.orgId, person)) ||
      (yield* LeadAccess.allowed({ orgId: turn.orgId, agentId: turn.agentId, personId: person }));
    const via = mayMessage ? turn.agentId : teamAgent;
    if (via === null) continue;
    const [open] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
      JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'person' AND m.person_id = ${person} AND m.left_at IS NULL
      WHERE c.org_id = ${turn.orgId} AND c.kind = 'direct'
        AND c.direct_key = ${LeadAccess.directKey(person, via)}
      ORDER BY c.chat_id LIMIT 1`;
    const chatId =
      open !== undefined
        ? KinChatId.make(open.chatId)
        : Option.isNone(chats)
          ? undefined
          : yield* chats.value
              .createDirect(
                { _tag: "person", orgId: turn.orgId, personId: person },
                { orgId: turn.orgId, agentId: via },
              )
              .pipe(
                Effect.map((chat) => chat.chatId),
                Effect.orElseSucceed(() => undefined),
              );
    if (chatId === undefined) continue;
    const [profile] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone FROM kin_people
      WHERE org_id = ${turn.orgId} AND person_id = ${person}`;
    const body = bodyFor(
      turn.by ?? agent.name,
      theirs,
      profile?.zone ?? fallbackZone,
      yield* Clock.currentTimeMillis,
    );
    // The same lines from the same turn are one message, so a retried call posts nothing more.
    const messageId = KinMessageId.make(
      `kin-assign-${NodeCrypto.createHash("sha256")
        .update(`${turn.wakeupId}:${person}:${body}`)
        .digest("hex")
        .slice(0, 32)}`,
    );
    if (Option.isSome(yield* repo.value.getMessage({ orgId: turn.orgId, messageId }))) {
      told.add(person);
      continue;
    }
    // In their quiet hours it waits for their end; they are told all the same.
    const held = yield* holdFor({ orgId: turn.orgId, personId: person, chatId });
    if (held !== undefined) {
      yield* holdLine({
        orgId: turn.orgId,
        chatId,
        personId: person,
        key: messageId,
        body,
        audience: "chat",
        at: held.at,
      });
      told.add(person);
      continue;
    }
    const message = yield* repo.value.insertMessage({
      orgId: turn.orgId,
      chatId,
      // Fixed words about tasks this person sees, in their own chat.
      audience: "chat",
      messageId,
      author: { _tag: "system" },
      kind: "system",
      body,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      editedAt: null,
    });
    if (Option.isSome(hub))
      yield* hub.value.publish({ type: "message.posted", orgId: turn.orgId, message });
    told.add(person);
  }
  return told;
});
