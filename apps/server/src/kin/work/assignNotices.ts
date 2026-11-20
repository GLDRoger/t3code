// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  type KinAgentId,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  type KinWorkPrincipal,
  formatKinWhen,
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
import * as Reach from "../lead/Reach.ts";
import { awayBackOn, heldUntil, holdFor, holdLine } from "../triggers/quietHold.ts";
import { textLocale, type TextClock } from "./companyProfile.ts";
import { parseFields } from "./lists.ts";
import { byId, isClosed, ownerZone, type RecordRow } from "./recordRows.ts";

/**
 * What a turn did to one person's task: gave it to them, took it from them, or gave it back; or
 * to a project: put them on it, or made them its lead.
 */
export type AssignNotice = {
  readonly personId: KinPersonId;
  readonly kind: "given" | "taken" | "returned" | "added" | "lead" | "commented" | "nudged";
  readonly row: RecordRow;
  /** The agent's one line on why, or the holder's words on a hand back. */
  readonly why: string | null;
  /** Who handed it back, when it is not the agent telling them. */
  readonly by?: string;
  /** Where a task taken from them went: words it as given on, unless whoever moved it took it. */
  readonly to?: { readonly kind: "person" | "agent"; readonly id: string };
};
type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** Keys the message, so a retry posts nothing more. */
  readonly wakeupId: string;
  /** A person who gave it on their own screen: named in place of the agent, and no turn chat. */
  readonly by?: string;
  readonly byPersonId?: KinPersonId;
  /** The message's id in place of one from the turn and the words: a nudge is one a day. */
  readonly messageId?: KinMessageId;
};

const reasonOf = (row: RecordRow) => {
  const reason = parseFields(row.fieldsJson).reason;
  return typeof reason === "string" ? reason : null;
};
const peopleOn = (row: RecordRow | undefined) => {
  const members = row === undefined ? undefined : parseFields(row.fieldsJson).members;
  return new Set(
    (Array.isArray(members) ? members : []).flatMap((one) =>
      typeof one === "string" && one.startsWith("person:") ? [one.slice("person:".length)] : [],
    ),
  );
};

/** Who to tell that a project now has them on it, or as its lead: each person once. */
const projectNotices = (before: RecordRow | undefined, after: RecordRow): Array<AssignNotice> => {
  const lead =
    after.ownerKind === "person" &&
    !(before?.ownerKind === "person" && before.ownerId === after.ownerId)
      ? after.ownerId
      : null;
  const had = peopleOn(before);
  const added = [...peopleOn(after)].filter((person) => !had.has(person) && person !== lead);
  return [
    ...(lead === null
      ? []
      : [{ personId: KinPersonId.make(lead), kind: "lead" as const, row: after, why: null }]),
    ...added.map((person) => ({
      personId: KinPersonId.make(person),
      kind: "added" as const,
      row: after,
      why: null,
    })),
  ];
};

/** Who to tell that a task came to them or left them, and why; or that a project took them on. */
export const movedNotices = (
  before: RecordRow | undefined,
  after: RecordRow,
): Array<AssignNotice> => {
  if (after.registerId === "projects") return projectNotices(before, after);
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
      ? [
          {
            personId: KinPersonId.make(before.ownerId),
            kind: "taken" as const,
            row: after,
            why,
            to: { kind: after.ownerKind, id: after.ownerId },
          },
        ]
      : []),
  ];
};

const dueText = (row: RecordRow, clock: TextClock) => {
  if (row.dueAt === null) return "";
  const style = row.dueAllDay === 1 ? "day" : "dayTime";
  return `, due ${formatKinWhen(row.dueAt, style, clock).replace(/,/g, "")}`;
};

const meetingAt = (row: RecordRow, clock: TextClock) =>
  row.dateAt === null ? "" : ` on ${formatKinWhen(row.dateAt, "dayTime", clock).replace(/,/g, "")}`;

/** A meeting given to someone is theirs to attend, or, once held, on record: never a task to do. */
const meetingLine = (agent: string, notice: AssignNotice, clock: TextClock, now: number) => {
  const { row } = notice;
  const held = row.dateAt !== null && row.dateAt <= now;
  return ended(
    `${agent} ${held ? "recorded your meeting" : "added you to the meeting"} ${row.key} ${row.title}${meetingAt(row, clock)}`,
  );
};

/** `gaveTo` names who a taken task went to, or is null when whoever moved it took it. */
const line = (notice: AssignNotice, clock: TextClock, gaveTo: string | null = null) => {
  const task = `${notice.row.key} ${notice.row.title}`;
  const why = notice.why === null ? "" : `: ${notice.why}`;
  if (notice.kind === "added") return `added you to ${task}`;
  if (notice.kind === "lead") return `made you the lead of ${task}`;
  if (notice.kind === "commented") return `commented on ${task}${why}`;
  if (notice.kind === "nudged") return `asked where ${task} stands`;
  return notice.kind === "given"
    ? `${task}${dueText(notice.row, clock)}${notice.why === null ? "" : `. Why: ${notice.why}`}`
    : notice.kind === "taken"
      ? gaveTo === null
        ? `took over ${task}${why}`
        : `gave ${task} to ${gaveTo}${why}`
      : `${notice.by === undefined ? "" : `${notice.by} `}handed ${task} back${why}`;
};
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A sentence ends once: a note that ends in its own stop gets no second one. */
const ended = (text: string) => (/[.!?…]["”’)]?$/.test(text) ? text : `${text}.`);

/** One message for the person: a line when it is one task, else a list under one heading. */
const bodyFor = (
  agent: string,
  notices: ReadonlyArray<AssignNotice>,
  clock: TextClock,
  now: number,
  gaveTo: (notice: AssignNotice) => string | null,
) => {
  const given = notices.filter((notice) => notice.kind === "given");
  const projects = notices.filter((notice) => notice.kind === "added" || notice.kind === "lead");
  const other = notices.filter(
    (notice) =>
      notice.kind === "taken" ||
      notice.kind === "returned" ||
      notice.kind === "commented" ||
      notice.kind === "nudged",
  );
  if (notices.length === 1)
    return given.length === 1
      ? given[0]!.row.category === "meeting"
        ? meetingLine(agent, given[0]!, clock, now)
        : ended(`${agent} gave you ${line(given[0]!, clock)}`)
      : projects.length === 1
        ? ended(`${agent} ${line(projects[0]!, clock)}`)
        : ended(
            other[0]!.by === undefined
              ? `${agent} ${line(other[0]!, clock, gaveTo(other[0]!))}`
              : line(other[0]!, clock),
          );
  return [
    given.length === 0
      ? `${agent}:`
      : `${agent} gave you ${given.length === 1 ? "a task" : `${given.length} tasks`}:`,
    ...given.map((notice) => `• ${line(notice, clock)}`),
    ...projects.map((notice) => `• ${capital(line(notice, clock))}`),
    ...other.map(
      (notice) => `• ${notice.by === undefined ? "It " : ""}${line(notice, clock, gaveTo(notice))}`,
    ),
  ].join("\n");
};

/** A held "gave you" line: the task, its rev and who gave it, so a retried call holds nothing more. */
const GIVEN_HELD = "kin-assign-given:";
export const isGivenHeld = (kind: string) => kind.startsWith(GIVEN_HELD);
const givenHeld = (row: RecordRow, by: string) => `${GIVEN_HELD}${row.recordId}:${row.rev}:${by}`;
const heldTask = (kind: string) => {
  const [recordId = "", , ...by] = kind.slice(GIVEN_HELD.length).split(":");
  return { recordId, by: by.join(":") };
};

/**
 * The held "gave you" lines for `personId` as one message, worded from each task as it stands
 * when it posts; a task no longer theirs, or closed, is left out. Undefined when none is left.
 */
export const heldGivenBody = Effect.fn("KinAssignNotices.heldGiven")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  kinds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const byGiver = new Map<string, Array<AssignNotice>>();
  const seen = new Set<string>();
  for (const kind of kinds) {
    const { recordId, by } = heldTask(kind);
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    const row = yield* byId(orgId, recordId);
    if (row === undefined || row.ownerKind !== "person" || row.ownerId !== personId) continue;
    if (isClosed(row.state)) continue;
    byGiver.set(by, [
      ...(byGiver.get(by) ?? []),
      { personId, kind: "given", row, why: reasonOf(row) },
    ]);
  }
  if (byGiver.size === 0) return undefined;
  const [profile] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  const clock = {
    zone: profile?.zone ?? (yield* ownerZone(orgId)),
    locale: yield* textLocale(orgId),
  };
  const now = yield* Clock.currentTimeMillis;
  return [...byGiver]
    .map(([by, notices]) => bodyFor(by, notices, clock, now, () => null))
    .join("\n\n");
});

/** The day a task's holder is back and hears it is theirs, while that line waits on them away. */
export const toldWhenBack = Effect.fn("KinAssignNotices.toldWhenBack")(function* (
  orgId: KinOrgId,
  recordId: string,
  holder: KinWorkPrincipal,
) {
  if (holder._tag !== "person") return undefined;
  const sql = yield* SqlClient.SqlClient;
  const prefix = `${GIVEN_HELD}${recordId}:`;
  const [held] = yield* sql`SELECT 1 FROM kin_held_posts
    WHERE org_id = ${orgId} AND person_id = ${holder.personId} AND delivered_at IS NULL
      AND substr(kind, 1, ${prefix.length}) = ${prefix}
    LIMIT 1`;
  return held === undefined ? undefined : yield* awayBackOn(orgId, holder.personId);
});

/**
 * A task that leaves someone before their held "gave you" line posts was never theirs to hear
 * of: the line is dropped, and so is the notice that it was taken. Returns the notices left.
 */
const dropUnheard = Effect.fn("KinAssignNotices.dropUnheard")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  notices: ReadonlyArray<AssignNotice>,
) {
  const sql = yield* SqlClient.SqlClient;
  const left: Array<AssignNotice> = [];
  for (const notice of notices) {
    if (notice.kind !== "taken") {
      left.push(notice);
      continue;
    }
    const prefix = `${GIVEN_HELD}${notice.row.recordId}:`;
    const dropped = yield* sql`DELETE FROM kin_held_posts
      WHERE org_id = ${orgId} AND person_id = ${personId} AND delivered_at IS NULL
        AND substr(kind, 1, ${prefix.length}) = ${prefix}
      RETURNING hold_id`;
    if (dropped.length === 0) left.push(notice);
  }
  return left;
});

/**
 * Tells each person what this call did to their tasks, in one message: in their direct chat with
 * the agent, else with the team agent, opened if needed. Someone in the turn's own chat already
 * reads the reply, so is not told twice. Returns who was told, and until when it waits for whom.
 */
export const tellHolding = Effect.fn("KinAssignNotices.tell")(function* (
  turn: Turn,
  notices: ReadonlyArray<AssignNotice>,
) {
  const told = new Set<string>();
  const waits = new Map<string, Parameters<typeof heldUntil>[1]>();
  if (notices.length === 0) return { told, waits };
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Effect.serviceOption(KinChatRepository);
  if (Option.isNone(repo)) return { told, waits };
  const chats = yield* Effect.serviceOption(KinChatService);
  const hub = yield* Effect.serviceOption(KinChatHub);
  const here = turn.by === undefined ? yield* turnChat(turn) : undefined;
  const [agent] = yield* sql<{ name: string; owner: string }>`SELECT display_name AS name,
      owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId}`;
  if (agent === undefined) return { told, waits };
  const teamAgent = yield* LeadAccess.teamAgent(turn.orgId);
  const fallbackZone = yield* ownerZone(turn.orgId);
  const byPerson = new Map<string, Array<AssignNotice>>();
  for (const notice of notices)
    byPerson.set(notice.personId, [...(byPerson.get(notice.personId) ?? []), notice]);
  for (const [personId, all] of byPerson) {
    const person = KinPersonId.make(personId);
    const theirs = yield* dropUnheard(turn.orgId, person, all);
    if (theirs.length === 0) continue;
    if (here !== undefined) {
      const reading = yield* sql`SELECT 1 FROM kin_chat_members WHERE org_id = ${turn.orgId}
        AND chat_id = ${here.chatId} AND principal_kind = 'person' AND person_id = ${person}
        AND left_at IS NULL LIMIT 1`;
      if (reading.length > 0) continue;
    }
    const mayMessage = yield* Reach.reaches(
      turn.orgId,
      Reach.person(person),
      Reach.agent(turn.agentId),
    );
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
    const names = new Map<AssignNotice, string | null>();
    for (const notice of theirs) {
      const to = notice.to;
      // Whoever moved it and now holds it took it over; anyone else was given it.
      if (
        to === undefined ||
        (turn.by === undefined
          ? to.kind === "agent" && to.id === turn.agentId
          : to.kind === "person" && to.id === turn.byPersonId)
      )
        continue;
      const [holder] =
        to.kind === "person"
          ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
              WHERE org_id = ${turn.orgId} AND person_id = ${to.id}`
          : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
              WHERE org_id = ${turn.orgId} AND agent_id = ${to.id}`;
      if (holder !== undefined) names.set(notice, holder.name);
    }
    const giver = turn.by ?? agent.name;
    const clock = { zone: profile?.zone ?? fallbackZone, locale: yield* textLocale(turn.orgId) };
    const now = yield* Clock.currentTimeMillis;
    const gaveTo = (notice: AssignNotice) => names.get(notice) ?? null;
    const body = bodyFor(giver, theirs, clock, now, gaveTo);
    // The same lines from the same turn are one message, so a retried call posts nothing more.
    const messageId =
      turn.messageId ??
      KinMessageId.make(
        `kin-assign-${NodeCrypto.createHash("sha256")
          .update(`${turn.wakeupId}:${person}:${body}`)
          .digest("hex")
          .slice(0, 32)}`,
      );
    if (Option.isSome(yield* repo.value.getMessage({ orgId: turn.orgId, messageId }))) {
      told.add(person);
      continue;
    }
    // In their quiet hours or while away it waits; tasks given meanwhile post as one (`heldGivenBody`).
    const held = yield* holdFor({ orgId: turn.orgId, personId: person, chatId, unasked: true });
    if (held !== undefined) {
      const hold = (key: string, lines: string) =>
        holdLine({
          orgId: turn.orgId,
          chatId,
          personId: person,
          key,
          body: lines,
          audience: "chat",
          at: held.at,
        });
      const rest = theirs.filter((notice) => notice.kind !== "given");
      for (const notice of theirs)
        if (notice.kind === "given")
          yield* hold(givenHeld(notice.row, giver), bodyFor(giver, [notice], clock, now, gaveTo));
      if (rest.length > 0)
        yield* hold(
          messageId,
          rest.length === theirs.length ? body : bodyFor(giver, rest, clock, now, gaveTo),
        );
      told.add(person);
      waits.set(person, held);
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
  return { told, waits };
});
export const tellPeople = (turn: Turn, notices: ReadonlyArray<AssignNotice>) =>
  tellHolding(turn, notices).pipe(Effect.map((result) => result.told));
