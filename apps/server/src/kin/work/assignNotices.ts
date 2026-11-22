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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { turnChat } from "../lead/Audience.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { MINUTE_MS } from "../durations.ts";
import { awayBackOn, heldUntil, holdFor, holdLine } from "../triggers/quietHold.ts";
import { textLocale, type TextClock } from "./companyProfile.ts";
import { parseFields } from "./lists.ts";
import {
  byId,
  dueWhenText,
  isClosed,
  isSuggestion,
  ownerZone,
  type RecordRow,
} from "./recordRows.ts";

/**
 * What a turn did to one person's task: gave it to them, took it from them, or gave it back; or
 * to a project: put them on it, or made them its lead.
 */
const NOTICE_KINDS = [
  "given",
  "taken",
  "returned",
  "added",
  "lead",
  "commented",
  "nudged",
] as const;
export type AssignNotice = {
  readonly personId: KinPersonId;
  readonly kind: (typeof NOTICE_KINDS)[number];
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
  // A suggestion is nobody's until a person keeps it: its holder hears of it then, once.
  if (isSuggestion(after)) return [];
  const kept = before !== undefined && isSuggestion(before);
  if (
    before !== undefined &&
    !kept &&
    before.ownerKind === after.ownerKind &&
    before.ownerId === after.ownerId
  )
    return [];
  const why = reasonOf(after);
  return [
    ...(after.ownerKind === "person"
      ? [{ personId: KinPersonId.make(after.ownerId), kind: "given" as const, row: after, why }]
      : []),
    ...(before?.ownerKind === "person" && !kept && before.ownerId !== after.ownerId
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

/** The reader's clock and the company's zone, whose calendar a due day is on. */
type NoticeClock = TextClock & { readonly company: string };

const dueText = (row: RecordRow, clock: NoticeClock) =>
  row.dueAt === null
    ? ""
    : `, due ${dueWhenText(row.dueAt, row.dueAllDay === 1, clock.company, clock).replace(/,/g, "")}`;

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
const line = (notice: AssignNotice, clock: NoticeClock, gaveTo: string | null = null) => {
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
  clock: NoticeClock,
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
  const company = yield* ownerZone(orgId);
  const clock = { zone: profile?.zone ?? company, company, locale: yield* textLocale(orgId) };
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
  // An agent's held "gave you" line, or a person's held news that they gave it (`tellOnTasks`).
  const [held] = yield* sql`SELECT 1 FROM kin_held_posts
    WHERE org_id = ${orgId} AND person_id = ${holder.personId} AND delivered_at IS NULL
      AND (substr(kind, 1, ${prefix.length}) = ${prefix}
        OR (substr(kind, 1, ${TASK_NEWS.length}) = ${TASK_NEWS}
          AND json_extract(body, '$.kind') = 'given'
          AND json_extract(body, '$.recordId') = ${recordId}))
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

/** Their open direct chat with `via`, if they have one. */
const directChat = Effect.fn("KinAssignNotices.directChat")(function* (
  orgId: KinOrgId,
  person: KinPersonId,
  via: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [open] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${person} AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct'
      AND c.direct_key = ${LeadAccess.directKey(person, via)}
    ORDER BY c.chat_id LIMIT 1`;
  return open === undefined ? undefined : KinChatId.make(open.chatId);
});

/**
 * Tells each person what an agent's turn did to their tasks, in one message: in their direct chat
 * with the agent, else with the team agent, opened if needed. Someone in the turn's own chat
 * already reads the reply, so is not told twice. Returns who was told, and until when it waits
 * for whom. A person's own moves are told on Tasks instead (`tellOnTasks`).
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
  const here = yield* turnChat(turn);
  const [agent] = yield* sql<{ name: string; owner: string }>`SELECT display_name AS name,
      owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId}`;
  if (agent === undefined) return { told, waits };
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
    // No agent that may message them carries it: the task is on their own Tasks all the same.
    const via = yield* Reach.carrierFor(turn.orgId, person, turn.agentId);
    if (via === null) continue;
    const open = yield* directChat(turn.orgId, person, via);
    const chatId =
      open !== undefined
        ? open
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
      if (to === undefined || (to.kind === "agent" && to.id === turn.agentId)) continue;
      const [holder] =
        to.kind === "person"
          ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
              WHERE org_id = ${turn.orgId} AND person_id = ${to.id}`
          : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
              WHERE org_id = ${turn.orgId} AND agent_id = ${to.id}`;
      if (holder !== undefined) names.set(notice, holder.name);
    }
    const giver = agent.name;
    const clock = {
      zone: profile?.zone ?? fallbackZone,
      company: fallbackZone,
      locale: yield* textLocale(turn.orgId),
    };
    const now = yield* Clock.currentTimeMillis;
    const gaveTo = (notice: AssignNotice) => names.get(notice) ?? null;
    const body = bodyFor(giver, theirs, clock, now, gaveTo);
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

/**
 * What a person did to someone's task or project on their own screen: held here for one banner
 * (`deliverHeld`, `taskNewsBanner`), never a chat line. A nudge's stays as that day's record of it.
 */
export const TASK_NEWS = "kin-task-news:";
export const isTaskNews = (kind: string) => kind.startsWith(TASK_NEWS);
/** One mover's taps on someone's tasks within this long are told as one banner. */
const NEWS_BURST_MS = MINUTE_MS;
const TaskNews = Schema.Struct({
  by: KinPersonId,
  name: Schema.String,
  kind: Schema.Literals(NOTICE_KINDS),
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  register: Schema.String,
  /** Who a task taken from them went to, unless whoever moved it took it. */
  to: Schema.NullOr(Schema.String),
});
type TaskNews = typeof TaskNews.Type;
const encodeNews = Schema.encodeEffect(Schema.fromJsonString(TaskNews));
const decodeNews = Schema.decodeUnknownOption(Schema.fromJsonString(TaskNews));

/**
 * Holds what `mover` just did for each person it touched, with any news of theirs already
 * waiting, else for a minute, or until their quiet hours, time off or away end. Returns who it
 * holds news for.
 */
export const tellOnTasks = Effect.fn("KinAssignNotices.tellOnTasks")(function* (
  mover: {
    readonly orgId: KinOrgId;
    readonly personId: KinPersonId;
    /** Whose direct chat with them, muted, keeps the banner silent; null in a company with none. */
    readonly agentId: KinAgentId | null;
    /** Keys each hold, so a retried call holds nothing more. */
    readonly change: string;
    /** The one hold's key in place of the change's: a nudge is one a day. */
    readonly key?: string;
  },
  notices: ReadonlyArray<AssignNotice>,
) {
  const told = new Set<string>();
  if (notices.length === 0) return told;
  const { orgId } = mover;
  const sql = yield* SqlClient.SqlClient;
  const nameOf = (kind: "person" | "agent", id: string) =>
    (kind === "person"
      ? sql<{ name: string }>`SELECT display_name AS name FROM kin_people
          WHERE org_id = ${orgId} AND person_id = ${id}`
      : sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
          WHERE org_id = ${orgId} AND agent_id = ${id}`
    ).pipe(Effect.map((rows) => rows[0]?.name ?? null));
  const name = (yield* nameOf("person", mover.personId)) ?? "Someone";
  const now = yield* Clock.currentTimeMillis;
  const byPerson = new Map<string, Array<AssignNotice>>();
  for (const notice of notices)
    byPerson.set(notice.personId, [...(byPerson.get(notice.personId) ?? []), notice]);
  for (const [personId, all] of byPerson) {
    const person = KinPersonId.make(personId);
    if (person === mover.personId) continue;
    const theirs = yield* dropUnheard(orgId, person, all);
    if (theirs.length === 0) continue;
    const via =
      mover.agentId === null ? null : yield* Reach.carrierFor(orgId, person, mover.agentId);
    const chatId = via === null ? undefined : yield* directChat(orgId, person, via);
    const [waiting] = yield* sql<{ at: number }>`SELECT deliver_at AS at FROM kin_held_posts
      WHERE org_id = ${orgId} AND person_id = ${person} AND delivered_at IS NULL
        AND substr(kind, 1, ${TASK_NEWS.length}) = ${TASK_NEWS}
        AND json_extract(body, '$.by') = ${mover.personId}
      ORDER BY deliver_at LIMIT 1`;
    const at =
      waiting?.at ??
      Math.max(
        now + NEWS_BURST_MS,
        (yield* holdFor({ orgId, personId: person, chatId: undefined, unasked: true }))?.at ?? now,
      );
    for (const notice of theirs) {
      const kind = `${TASK_NEWS}${mover.key ?? `${mover.change}:${notice.kind}:${notice.row.recordId}`}`;
      const [held] = yield* sql`SELECT 1 FROM kin_held_posts
        WHERE org_id = ${orgId} AND person_id = ${person} AND kind = ${kind} LIMIT 1`;
      if (held !== undefined) continue;
      const to = notice.to;
      const body = yield* encodeNews({
        by: mover.personId,
        name,
        kind: notice.kind,
        recordId: notice.row.recordId,
        key: notice.row.key,
        title: notice.row.title,
        register: notice.row.registerId,
        to:
          to === undefined || (to.kind === "person" && to.id === mover.personId)
            ? null
            : yield* nameOf(to.kind, to.id),
      }).pipe(Effect.orDie);
      yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
          audience, held_at, deliver_at)
        VALUES (${SecureRandom.uuidV4Unsafe()}, ${orgId}, ${chatId ?? ""}, ${person}, ${kind},
          ${body}, 'chat', ${now}, ${at})`;
    }
    told.add(person);
  }
  return told;
});

const NEWS_ONE: Record<TaskNews["kind"], (task: string, to: string | null) => string> = {
  given: (task) => `gave you ${task}`,
  taken: (task, to) => (to === null ? `took over ${task}` : `gave ${task} to ${to}`),
  returned: (task) => `handed back ${task}`,
  added: (task) => `added you to ${task}`,
  lead: (task) => `made you the lead of ${task}`,
  commented: (task) => `commented on ${task}`,
  nudged: (task) => `asked where ${task} stands`,
};
const NEWS_MANY: Record<TaskNews["kind"], (count: number) => string> = {
  given: (count) => `gave you ${count} tasks`,
  taken: (count) => `reassigned ${count} of your tasks`,
  returned: (count) => `handed back ${count} tasks`,
  added: (count) => `added you to ${count} projects`,
  lead: (count) => `made you the lead of ${count} projects`,
  commented: (count) => `commented on ${count} tasks`,
  nudged: (count) => `asked where ${count} tasks stand`,
};

/** "Dev handed back 7 tasks"; one task by name; several kinds of change, "updated". */
const newsText = (news: ReadonlyArray<TaskNews>) => {
  const first = news[0]!;
  const records = new Set(news.map((one) => one.recordId)).size;
  const mixed = new Set(news.map((one) => one.kind)).size > 1;
  const task = `${first.key} ${first.title}`;
  return `${first.name} ${
    records === 1
      ? mixed
        ? `updated ${task}`
        : NEWS_ONE[first.kind](task, first.to)
      : mixed
        ? `updated ${records} of your tasks`
        : NEWS_MANY[first.kind](records)
  }`;
};

/** News a later change made untrue, such as a task given and taken back, is not told. */
const stillNews = (news: TaskNews, row: RecordRow | undefined, person: KinPersonId) => {
  if (row === undefined) return false;
  const theirs = row.ownerKind === "person" && row.ownerId === person;
  if (news.kind === "taken") return !theirs;
  if (news.kind === "given" || news.kind === "returned") return theirs && !isClosed(row.state);
  return news.kind !== "nudged" || !isClosed(row.state);
};

/**
 * The one banner for held news `holdIds` (one person's, from one mover): its words, the chat whose
 * mute keeps it silent, and the one task or project it opens, else none (their Tasks).
 */
export const taskNewsBanner = Effect.fn("KinAssignNotices.taskNewsBanner")(function* (
  orgId: KinOrgId,
  holdIds: ReadonlyArray<string>,
) {
  if (holdIds.length === 0) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: KinPersonId; chatId: string; body: string }>`SELECT
      person_id AS "personId", chat_id AS "chatId", body FROM kin_held_posts
    WHERE org_id = ${orgId} AND hold_id IN ${sql.in(holdIds)}
      AND substr(kind, 1, ${TASK_NEWS.length}) = ${TASK_NEWS}
    ORDER BY held_at, rowid`;
  const person = rows[0]?.personId;
  if (person === undefined) return undefined;
  const told: Array<TaskNews> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const news = Option.getOrUndefined(decodeNews(row.body));
    const id = news === undefined ? "" : `${news.recordId}:${news.kind}`;
    if (news === undefined || row.personId !== person || seen.has(id)) continue;
    seen.add(id);
    if (stillNews(news, yield* byId(orgId, news.recordId), person)) told.push(news);
  }
  if (told.length === 0) return undefined;
  const opened = new Map(
    told.filter((news) => news.kind !== "taken").map((news) => [news.recordId, news]),
  );
  const [only, ...more] = opened.values();
  const chatId = rows.find((row) => row.chatId !== "")?.chatId;
  return {
    personId: person,
    body: newsText(told),
    /** Some of it is work now theirs: given to them, or handed back. */
    gives: told.some((news) => news.kind === "given" || news.kind === "returned"),
    chatId: chatId === undefined ? undefined : KinChatId.make(chatId),
    opens:
      only === undefined || more.length > 0 || !["work", "projects"].includes(only.register)
        ? undefined
        : { key: only.key, project: only.register === "projects" },
  };
});

/** Today's nudges of `recordIds` to `personId`, who holds them: who asked, latest first. */
export const askedOf = Effect.fn("KinAssignNotices.askedOf")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
  since: number,
) {
  const asked = new Map<string, KinPersonId>();
  if (recordIds.length === 0) return asked;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT body FROM kin_held_posts
    WHERE org_id = ${orgId} AND person_id = ${personId} AND held_at >= ${since}
      AND substr(kind, 1, ${TASK_NEWS.length}) = ${TASK_NEWS}
      AND json_extract(body, '$.kind') = 'nudged'
      AND json_extract(body, '$.recordId') IN ${sql.in(recordIds)}
    ORDER BY held_at DESC, rowid DESC`;
  for (const row of rows) {
    const news = Option.getOrUndefined(decodeNews(row.body));
    if (news !== undefined && !asked.has(news.recordId)) asked.set(news.recordId, news.by);
  }
  return asked;
});
