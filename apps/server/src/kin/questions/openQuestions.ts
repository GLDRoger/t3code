import {
  KinAgentId,
  KinChatError,
  KinChatId,
  type KinChoiceOutcome,
  KinEvent,
  KinEventId,
  type KinOrgId,
  KinPersonId,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import type { KinChatService } from "../chat/KinChatService.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import { holdFor } from "../triggers/quietHold.ts";
import { storedWorkHours } from "../triggers/quietHours.ts";
import type * as CardActions from "../widgets/cardActions.ts";
import {
  type AnsweredPlan,
  type CardPlan,
  plansOf,
  sealPlans,
  sealedOptions,
} from "../widgets/cardPlans.ts";
import { choiceCardState } from "../widgets/choiceCard.ts";
import type { KinRecords } from "../work/KinRecords.ts";
import { ownerZone } from "../work/recordRows.ts";
import { allLists } from "../work/registers.ts";
import {
  dayWord,
  defaultDue,
  endingQuestion,
  namedDue,
  normaliseAbout,
  normaliseIntent,
  raiseAt,
  repeats,
  safeDefault,
} from "./rules.ts";
import { TAKEN_KEY, tellDeclined, tellTaken } from "./defaultTaken.ts";

export type QuestionState = "open" | "answered" | "default_taken" | "withdrawn";
export type QuestionRow = {
  readonly questionId: string;
  readonly agentId: KinAgentId;
  readonly agentName: string;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly kind: "card" | "text";
  readonly widgetId: string | null;
  readonly raiseWidgetId: string | null;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
  readonly defaultLabel: string | null;
  readonly safe: boolean;
  readonly about: ReadonlyArray<string>;
  readonly intent: string;
  readonly askedAt: number;
  readonly dueAt: number;
  readonly actAt: number;
  readonly state: QuestionState;
  readonly raisedAt: number | null;
  readonly answer: string | null;
};

/** How a question raised again opens its card, so what answers it can read past it. */
export const STILL_OPEN = "Still open: ";
const OptionsJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ optionId: Schema.String, label: Schema.String })),
);
const decodeOptions = Schema.decodeUnknownOption(OptionsJson);
const encodeOptions = Schema.encodeEffect(OptionsJson);
const validZone = (zone: string) => {
  try {
    DateTime.makeZonedUnsafe(0, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });

const COLUMNS = `q.question_id AS "questionId", q.agent_id AS "agentId",
  COALESCE(l.name, a.display_name, q.agent_id) AS "agentName", q.person_id AS "personId",
  q.chat_id AS "chatId", q.kind, q.widget_id AS "widgetId", q.raise_widget_id AS "raiseWidgetId",
  q.question, q.options_json AS "options", q.default_label AS "defaultLabel", q.safe, q.about,
  q.intent, q.asked_at AS "askedAt", q.due_at AS "dueAt", q.act_at AS "actAt", q.state,
  q.raised_at AS "raisedAt", q.answer`;
const FROM = `FROM kin_questions q
  LEFT JOIN kin_leads l ON l.org_id = q.org_id AND l.agent_id = q.agent_id
  LEFT JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id`;
type Raw = Omit<QuestionRow, "options" | "safe" | "about"> & {
  readonly options: string | null;
  readonly safe: number;
  readonly about: string;
};
const toRow = (raw: Raw): QuestionRow => ({
  ...raw,
  options: raw.options === null ? [] : Option.getOrElse(decodeOptions(raw.options), () => []),
  safe: raw.safe === 1,
  about: raw.about === "" ? [] : raw.about.split(" "),
});

/**
 * The person's clock and working days: the owner's is the company's (`ownerZone`), anyone
 * else's their profile's, else the company's.
 */
const personClock = Effect.fn("KinQuestions.personClock")(function* (
  orgId: KinOrgId,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ zone: string | null; hours: string | null; owner: number }>`
    SELECT time_zone AS zone, work_hours_json AS hours, EXISTS (SELECT 1 FROM kin_agents a
        WHERE a.org_id = p.org_id AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`;
  const company = yield* ownerZone(orgId);
  const own = person?.owner === 1 || person?.zone == null ? undefined : person.zone;
  const zone = own !== undefined && validZone(own) ? own : company;
  return { zone, days: storedWorkHours(person?.hours)?.days };
});

/** The one person in a direct chat; questions are stored only where one person is asked. */
export const personOfChat = Effect.fn("KinQuestions.personOfChat")(function* (
  orgId: KinOrgId,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT m.person_id AS "personId"
    FROM kin_chat_members m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND c.kind = 'direct'
      AND m.person_id IS NOT NULL AND m.left_at IS NULL ORDER BY m.person_id`;
  return rows.length === 1 ? KinPersonId.make(rows[0]!.personId) : undefined;
});

const openFor = Effect.fn("KinQuestions.openFor")(function* (orgId: KinOrgId, personId: string) {
  const sql = yield* SqlClient.SqlClient;
  const raw = yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.person_id = ${personId} AND q.state = 'open'
    ORDER BY q.asked_at, q.question_id`;
  return raw.map(toRow);
});

export const readQuestion = Effect.fn("KinQuestions.read")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [raw] = yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.question_id = ${questionId}`;
  return raw === undefined ? undefined : toRow(raw);
});

/** Whether any of `about` is an entry in a list that carries amounts: an invoice, quote, expense. */
const aboutMoney = Effect.fn("KinQuestions.aboutMoney")(function* (
  orgId: KinOrgId,
  about: ReadonlyArray<string>,
) {
  if (about.length === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ listId: string }>`SELECT DISTINCT register_id AS "listId"
    FROM kin_records WHERE org_id = ${orgId} AND key IN ${sql.in(about)} ORDER BY register_id`;
  if (rows.length === 0) return false;
  const lists = yield* allLists(orgId);
  return rows.some((row) => lists.get(row.listId)?.amount === true);
});

/** "already asked by Finance on Monday: “…”. Default “Draft it” on Wednesday." */
const alreadyAsked = (open: QuestionRow, now: number, zone: string) =>
  `Already asked by ${open.agentName} ${dayWord(open.askedAt, now, zone)}: “${open.question}”. ${
    open.defaultLabel !== null && open.safe
      ? `Default “${open.defaultLabel}” ${dayWord(open.dueAt, now, zone)}`
      : "It has no safe default, so it waits for them"
  }. It is in their Waiting on you; don't ask it again.`;

export type AskPlan = {
  readonly questionId: string;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly question: string;
  readonly defaultLabel: string | null;
  readonly safe: boolean;
  readonly about: ReadonlyArray<string>;
  readonly intent: string;
  readonly askedAt: number;
  readonly dueAt: number;
  readonly actAt: number;
  /** An identical call already recorded it: the retry answers with the same card. */
  readonly retry: boolean;
};

/**
 * Checks a `kin_ask` before its card is posted: its default is one of its options or "none", its
 * day is sane, and no agent already put the same thing to the same person. Undefined when the
 * chat isn't one person's direct chat: the card is then an ordinary one.
 */
export const planAsk = Effect.fn("KinQuestions.planAsk")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly key: string;
  readonly question: string;
  readonly labels: ReadonlyArray<string>;
  readonly default: string;
  readonly by?: string | undefined;
  readonly about?: ReadonlyArray<string> | undefined;
  readonly intent?: string | undefined;
  readonly now: number;
  /** The default's fixed action: a task's done or drop may be taken at its day, any other only by a tap. */
  readonly acts?: CardPlan["kind"] | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const wanted = input.default.trim().toLowerCase();
  const label =
    wanted === "none" ? null : input.labels.find((one) => one.trim().toLowerCase() === wanted);
  if (label === undefined)
    return yield* refuse(
      `default is the label of the option you'll take if they don't answer (one of ${input.labels
        .map((one) => `“${one}”`)
        .join(", ")}), or "none" when nothing is safe to do without them.`,
    );
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const questionId = `q-${hash(input.key).slice(0, 12)}`;
  const [seen] = yield* sql<{ id: string }>`SELECT question_id AS id FROM kin_questions
    WHERE org_id = ${input.orgId} AND question_id = ${questionId}`;
  const clock = yield* personClock(input.orgId, personId);
  const named = input.by === undefined ? undefined : namedDue(input.by, input.now, clock.zone);
  if (named !== undefined && "refused" in named) return yield* refuse(named.refused);
  const dueAt = named?.at ?? defaultDue(input.now, clock.zone, clock.days);
  const about = normaliseAbout(input.about);
  const safe =
    (input.acts === undefined || input.acts === "done" || input.acts === "drop") &&
    safeDefault(label, input.question, {
      labels: input.labels,
      aboutMoney: yield* aboutMoney(input.orgId, about),
    });
  const intent = normaliseIntent(input.intent);
  if (seen === undefined)
    for (const open of yield* openFor(input.orgId, personId))
      if (repeats({ intent, about }, open))
        return yield* refuse(alreadyAsked(open, input.now, clock.zone));
  return {
    questionId,
    orgId: input.orgId,
    agentId: input.agentId,
    personId,
    chatId: input.chatId,
    question: oneLine(input.question, 240),
    defaultLabel: label,
    safe,
    about,
    intent,
    askedAt: input.now,
    dueAt,
    actAt: safe ? dueAt : raiseAt(dueAt, clock.zone, clock.days),
    retry: seen !== undefined,
  } satisfies AskPlan;
});

/** Stores a planned question with the card that asks it; a retry stores nothing more. */
export const recordAsk = Effect.fn("KinQuestions.recordAsk")(function* (
  plan: AskPlan,
  card: {
    readonly widgetId: string;
    readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const options = yield* encodeOptions(card.options).pipe(Effect.orDie);
  yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
      widget_id, question, options_json, default_label, safe, about, intent, asked_at, due_at,
      act_at, state)
    VALUES (${plan.questionId}, ${plan.orgId}, ${plan.agentId}, ${plan.personId}, ${plan.chatId},
      'card', ${card.widgetId}, ${plan.question}, ${options},
      ${plan.defaultLabel}, ${plan.safe ? 1 : 0}, ${plan.about.join(" ")}, ${plan.intent},
      ${plan.askedAt}, ${plan.dueAt}, ${plan.actAt}, 'open')
    ON CONFLICT (question_id) DO NOTHING`;
});

/**
 * A reply that ended on a question to the one person in a direct chat, with no card: stored
 * with no default, so every agent sees it is open. Their next message in that chat answers it,
 * and at its day it lapses quietly. An older open one from the same agent there gives way.
 */
export const recordTextQuestion = Effect.fn("KinQuestions.recordText")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly wakeupId: string;
  readonly question: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const clock = yield* personClock(input.orgId, personId);
  const questionId = `q-${hash(`text:${input.wakeupId}`).slice(0, 12)}`;
  const dueAt = defaultDue(input.now, clock.zone, clock.days);
  yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND chat_id = ${input.chatId}
      AND kind = 'text' AND state = 'open' AND question_id <> ${questionId}`;
  yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
      question, default_label, safe, asked_at, due_at, act_at, state)
    VALUES (${questionId}, ${input.orgId}, ${input.agentId}, ${personId}, ${input.chatId}, 'text',
      ${oneLine(input.question, 240)}, NULL, 0, ${input.now}, ${dueAt}, ${dueAt}, 'open')
    ON CONFLICT (question_id) DO NOTHING`;
  return questionId;
});

/** The person's tap on a question's card: it closes as answered, in the tap's transaction. */
export const answerCard = Effect.fn("KinQuestions.answerCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly label: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_questions SET state = 'answered', answer = ${input.label},
      closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND state = 'open'
      AND (widget_id = ${input.widgetId} OR raise_widget_id = ${input.widgetId})`;
});

/** The person wrote in a chat where an agent's text question waits: that is its answer. */
export const answerByReply = Effect.fn("KinQuestions.answerByReply")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_questions SET state = 'answered', closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.personId}
      AND kind = 'text' AND state = 'open' AND asked_at < ${input.now}`;
});

const cardIds = (row: QuestionRow) =>
  [row.raiseWidgetId ?? row.widgetId].filter((id): id is string => id !== null);

/**
 * Whether this wake-up woke on the person's own message in the question's chat, written after it
 * was asked: the only words its asker may take an answer from. A copy passed on from elsewhere,
 * another chat, another person, a schedule or another agent never counts.
 */
const wokenByTheirWords = Effect.fn("KinQuestions.wokenByTheirWords")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: string,
  row: QuestionRow,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag = 'chat.message' AND json_extract(e.json, '$.origin') IS NULL
      AND m.chat_id = ${row.chatId} AND m.author_kind = 'human'
      AND m.author_person_id = ${row.personId} AND m.origin_json IS NULL
      AND m.status = 'posted' AND m.created_at > ${iso(row.askedAt)}
    LIMIT 1`;
  return rows.length > 0;
});

/** The Undo line on the note of an answer taken from someone's words. */
export const UNDO_ANSWER_LINE = "Open the question again";

/**
 * The person hears, on a note in the question's chat, that the asker took their words as its
 * answer; its Undo opens the question again (`runAnswered`), as a taken default's note does.
 */
const offerUndo = Effect.fn("KinQuestions.offerUndo")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  answer: string | null,
  closedAt: number,
  chat: Pick<KinChatService["Service"], "ask">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string; threadId: string | null }>`SELECT
      a.owner_person_id AS owner, l.thread_id AS "threadId"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId} AND a.retired_at IS NULL`;
  if (agent === undefined || agent.threadId === null) return;
  const plan = (kind: AnsweredPlan["kind"]): AnsweredPlan => ({
    kind,
    questionId: row.questionId,
    agentId: row.agentId,
    answer,
    closedAt,
  });
  const card = yield* chat.ask(
    {
      _tag: "agent",
      orgId,
      agentId: row.agentId,
      ownerPersonId: KinPersonId.make(agent.owner),
      threadId: ThreadId.make(agent.threadId),
      hostPosted: true,
    },
    {
      question: oneLine(
        `I took ${answer === null ? "your answer" : `“${answer}”`} from what you wrote, on “${row.question}”.`,
        240,
      ),
      options: [{ label: "Undo" }, { label: "Keep it" }],
      actions: [{ label: "Undo", line: UNDO_ANSWER_LINE }, undefined],
      untilAnswered: true,
      chatId: row.chatId,
      clientMessageId: `kin-answer-taken:${row.questionId}:${closedAt}`,
    },
  );
  yield* sealPlans({
    orgId,
    chatId: row.chatId,
    widgetId: card.widgetId,
    plans: [
      { optionId: "option-1", plan: plan("undo_answer") },
      { optionId: "option-2", plan: plan("keep_answer") },
    ],
    now: closedAt,
  });
});

/**
 * An agent closes a question: its person answered it in words (`answered`), or it no longer
 * stands (`withdrawn`). Both only by its asker; an answer only in a turn woken by the person's
 * own message in its chat (`wokenByTheirWords`). Its card stops taking taps, and an answer's
 * note offers its person Undo.
 */
export const closeQuestion = Effect.fn("KinQuestions.close")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
    readonly questionId: string;
    readonly outcome: "answered" | "withdrawn";
    readonly answer?: string | undefined;
    readonly now: number;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced" | "ask">,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* readQuestion(input.orgId, input.questionId);
  if (row === undefined) return yield* refuse("No such question. Your seat lists the open ones.");
  if (row.state !== "open")
    return { questionId: row.questionId, state: row.state, changed: false } as const;
  if (input.outcome === "withdrawn" && row.agentId !== input.agentId)
    return yield* refuse(`Only ${row.agentName}, who asked it, can withdraw it.`);
  if (input.outcome === "answered") {
    const who = yield* personName(input.orgId, row.personId);
    if (row.agentId !== input.agentId) return yield* refuse(notTheAsker(row, who));
    if (!(yield* wokenByTheirWords(input.orgId, input.agentId, input.wakeupId, row)))
      return yield* refuse(notTheirWords(who));
  }
  const answer = input.answer === undefined ? null : oneLine(input.answer, 200);
  yield* sql`UPDATE kin_questions SET state = ${input.outcome}, answer = ${answer},
      closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND question_id = ${row.questionId} AND state = 'open'`;
  const cards = cardIds(row);
  for (const widgetId of cards)
    yield* chat.closeReplaced({
      orgId: input.orgId,
      widgetId: KinWidgetId.make(widgetId),
      outcome:
        input.outcome === "answered"
          ? { title: "Answered", text: tookFromWords(row.agentName, answer) }
          : { title: "Withdrawn", text: `${row.agentName} withdrew this question.` },
    });
  if (input.outcome === "answered" && cards.length > 0)
    yield* offerUndo(input.orgId, row, answer, input.now, chat);
  return { questionId: row.questionId, state: input.outcome, changed: true } as const;
});

/** What a question's card says once its asker took its answer from the person's words. */
const tookFromWords = (agentName: string, answer: string | null) =>
  answer === null
    ? `${agentName} took this from what you wrote.`
    : `${agentName} took this from what you wrote: ${answer}`;
const notTheAsker = (row: QuestionRow, who: string) =>
  `Only ${row.agentName}, who asked it, records ${who}'s answer.`;
const notTheirWords = (who: string) =>
  `Only ${who}'s own message in the chat it was asked in, written since, records an answer.`;

/** The asker hears once that the person undid the answer it took, so it doesn't act on it. */
const tellAnswerUndone = Effect.fn("KinQuestions.tellAnswerUndone")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  closedAt: number,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId: KinEventId.make(
      `question_${hash(`${orgId}\0${row.questionId}\0${closedAt}\0answer-undone`).slice(0, 32)}`,
    ),
    orgId,
    agentId: row.agentId,
    receivedAt: iso(now),
    provenance: { _tag: "system" },
    dedupeKey: `question-answer-undone:${row.questionId}:${closedAt}`,
    subject: { type: "question", questionId: row.questionId, undone: true },
    lateByMs: 0,
    ...(lead === undefined || lead.ownerChatId === row.chatId
      ? {}
      : { origin: { agentId: row.agentId, chatId: row.chatId, personId: row.personId } }),
  }).pipe(Effect.orDie);
  // A retired asker has no turn to tell; anything else rolls the whole Undo back.
  yield* (yield* KinEventQueue.KinEventQueue).enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.void,
      KinEventQueueUnknownAgent: () => Effect.void,
      KinEventQueueConflict: () => Effect.fail(undoNotNow),
      KinEventQueueUnknownEvent: () => Effect.fail(undoNotNow),
    }),
  );
});
const undoNotNow = new KinChatError({
  reason: "conflict",
  message: "That couldn't be undone just now, so nothing changed. Try again.",
});

/**
 * A tap on the note of an answer taken from someone's words: Keep leaves it; Undo, only by the
 * person it was asked of and only while that answer stands, opens the question again with its
 * cards, its default and day as they were. A day that passed meanwhile starts afresh from now,
 * as a restored agent's questions do, so no default is taken the moment it reopens.
 */
export const runAnswered = Effect.fn("KinQuestions.runAnswered")(function* (
  tap: { readonly orgId: KinOrgId; readonly personId: KinPersonId; readonly now: number },
  plan: AnsweredPlan,
  chat: Pick<KinChatService["Service"], "reopenClosed">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = tap;
  const row = yield* readQuestion(orgId, plan.questionId);
  if (row !== undefined && row.personId !== tap.personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the person it was asked of can undo this.",
    });
  const [closed] =
    row === undefined
      ? []
      : yield* sql<{ closedAt: number | null }>`SELECT closed_at AS "closedAt"
          FROM kin_questions WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  if (
    row === undefined ||
    row.state !== "answered" ||
    row.agentId !== plan.agentId ||
    closed?.closedAt !== plan.closedAt
  )
    return {
      title: "Nothing was undone",
      text: "That question was settled another way since, so nothing was undone.",
    } satisfies KinChoiceOutcome;
  if (plan.kind === "keep_answer")
    return {
      title: "Kept",
      text: plan.answer === null ? "Your answer stands." : `“${plan.answer}” stands.`,
    } satisfies KinChoiceOutcome;
  const clock = yield* personClock(orgId, row.personId);
  const passed = row.dueAt <= tap.now;
  const dueAt = passed ? defaultDue(tap.now, clock.zone, clock.days) : row.dueAt;
  const actAt = !passed ? row.actAt : row.safe ? dueAt : raiseAt(dueAt, clock.zone, clock.days);
  yield* sql`UPDATE kin_questions SET state = 'open', answer = NULL, closed_at = NULL,
      due_at = ${dueAt}, act_at = ${actAt}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'answered'
      AND closed_at = ${plan.closedAt}`;
  for (const widgetId of cardIds(row))
    yield* chat.reopenClosed({
      orgId,
      widgetId: KinWidgetId.make(widgetId),
      awaiting: [row.personId],
    });
  yield* tellAnswerUndone(orgId, row, plan.closedAt, tap.now);
  const when = dayWord(dueAt, tap.now, clock.zone);
  const next =
    row.defaultLabel === null || !row.safe
      ? "it waits for your answer"
      : `${passed ? "its day had passed, so " : ""}${row.agentName} goes with “${row.defaultLabel}” ${when} unless you answer`;
  return {
    title: "Undone",
    text: oneLine(`“${row.question}” is open again: ${next}.`, 600),
    undone: {
      personId: tap.personId,
      name: yield* personName(orgId, tap.personId),
      at: iso(tap.now),
    },
  } satisfies KinChoiceOutcome;
});

const withdraw = Effect.fn("KinQuestions.withdraw")(function* (
  orgId: KinOrgId,
  rows: ReadonlyArray<QuestionRow>,
  reason: (row: QuestionRow) => string,
  closedAt: number,
  chat: Pick<KinChatService["Service"], "closeReplaced">,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const row of rows) {
    const moved = yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${closedAt}
      WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      RETURNING question_id`;
    if (moved.length === 0) continue;
    for (const widgetId of cardIds(row))
      yield* chat.closeReplaced({
        orgId,
        widgetId: KinWidgetId.make(widgetId),
        outcome: { title: "Closed", text: reason(row) },
      });
  }
});

/** What a retired agent's question card says when it closes. */
export const retiredQuestionText = (agentName: string) =>
  `${agentName} was retired; nothing will happen on this.`;

/**
 * Closes every open question an agent asked, or that waits on a person, in the caller's
 * transaction: each is withdrawn at `closedAt` and its card closes saying `reason`.
 */
export const closeHeldQuestions = Effect.fn("KinQuestions.closeHeld")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly holder:
      | { readonly agentId: KinAgentId; readonly personId?: never }
      | { readonly personId: KinPersonId; readonly agentId?: never };
    readonly reason: (row: QuestionRow) => string;
    readonly closedAt: number;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, holder } = input;
  const rows = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.state = 'open' AND ${
      holder.agentId === undefined
        ? sql`q.person_id = ${holder.personId}`
        : sql`q.agent_id = ${holder.agentId}`
    }
    ORDER BY q.asked_at, q.question_id`).map(toRow);
  yield* withdraw(orgId, rows, input.reason, input.closedAt, chat);
  return rows.length;
});

/**
 * Closes every open question about a record that just closed (`about` names its key), or asked
 * on one of `cards`, in the caller's transaction. One on a card in `sparing` is left to the tap
 * that settles it.
 */
export const closeQuestionsAbout = Effect.fn("KinQuestions.closeAbout")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly key: string;
    readonly cards: ReadonlyArray<string>;
    readonly sparing: ReadonlyArray<string>;
    readonly text: string;
    readonly closedAt: number;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced">,
) {
  const sql = yield* SqlClient.SqlClient;
  const onCards =
    input.cards.length === 0
      ? sql`0`
      : sql`(q.widget_id IN ${sql.in(input.cards)} OR q.raise_widget_id IN ${sql.in(input.cards)})`;
  const rows = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${input.orgId} AND q.state = 'open'
      AND ((' ' || q.about || ' ') LIKE ${`% ${input.key} %`} OR ${onCards})
    ORDER BY q.asked_at, q.question_id`)
    .map(toRow)
    .filter((row) => !input.sparing.some((id) => id === row.widgetId || id === row.raiseWidgetId));
  yield* withdraw(input.orgId, rows, () => input.text, input.closedAt, chat);
  return rows.length;
});

/**
 * Restoring an agent reopens the questions its retirement closed (withdrawn at that very
 * instant), each with a fresh day as if asked now, so no default is taken before the person
 * has had one. Its next raise posts the card again.
 */
export const reopenRetiredQuestions = Effect.fn("KinQuestions.reopenRetired")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly retiredAt: number;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ questionId: string; personId: string; safe: number }>`SELECT
      question_id AS "questionId", person_id AS "personId", safe FROM kin_questions
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'withdrawn'
      AND closed_at = ${input.retiredAt}
    ORDER BY asked_at, question_id`;
  for (const row of rows) {
    const clock = yield* personClock(input.orgId, row.personId);
    const dueAt = defaultDue(input.now, clock.zone, clock.days);
    const actAt = row.safe === 1 ? dueAt : raiseAt(dueAt, clock.zone, clock.days);
    yield* sql`UPDATE kin_questions SET state = 'open', closed_at = NULL, raised_at = NULL,
        due_at = ${dueAt}, act_at = ${actAt}
      WHERE org_id = ${input.orgId} AND question_id = ${row.questionId} AND state = 'withdrawn'`;
  }
  return rows.length;
});

/** The turn that takes a default: one per question, keyed so a replay finds its own. */
const takeEventId = (orgId: string, questionId: string) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}`).slice(0, 32)}`);

type SettleDeps = {
  readonly chat: Pick<KinChatService["Service"], "closeReplaced" | "ask" | "notice">;
  readonly queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">;
  /** Runs a default's own action; without it such a default waits for its person. */
  readonly records?: KinRecords["Service"] | undefined;
};

/**
 * Settles each question whose day came, once: a safe default is taken (its own action run, else
 * the asker's turn queued, as it is marked), one with none is raised once more on the next working
 * morning, a text question lapses. Conditional updates make a rerun do nothing. Then each person
 * a default was taken for is told, once.
 */
export const settleDue = Effect.fn("KinQuestions.settleDue")(function* (
  orgId: KinOrgId,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  // Paused, Kin or its asker, a question waits for resume and fills no pass's batch.
  const due = (yield* isOrgPaused(orgId))
    ? []
    : (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
        WHERE q.org_id = ${orgId} AND q.state = 'open' AND q.act_at <= ${now}
          AND (q.safe = 1 OR q.raised_at IS NULL) AND a.paused_at IS NULL
        ORDER BY q.act_at, q.question_id LIMIT 50`).map(toRow);
  let settled = 0;
  for (const row of due) {
    const done = yield* sql
      .withTransaction(
        row.kind === "text"
          ? lapse(orgId, row, now)
          : row.safe
            ? takeDefault(orgId, row, now, deps)
            : raise(orgId, row, now, deps.chat),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin open question not settled", {
            orgId,
            questionId: row.questionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (done) settled += 1;
  }
  yield* tellDue(orgId, now, deps.chat);
  return settled;
});

/** Notices told in one pass; ones held for someone away or in quiet hours don't count. */
const TELL_PER_PASS = 50;

/**
 * Each default taken since this was built (`raised_at` marks it owed) whose person, still in its
 * chat, hasn't been told: told now, unless their quiet hours or an away day hold it, when a later
 * pass tells them. Owed until told, however long they are away.
 */
const tellDue = Effect.fn("KinQuestions.tellDue")(function* (
  orgId: KinOrgId,
  now: number,
  chat: SettleDeps["chat"],
) {
  const sql = yield* SqlClient.SqlClient;
  const owed = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.state = 'default_taken'
      AND q.raised_at IS NOT NULL AND q.default_label IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kin_pulse_told t
        WHERE t.org_id = q.org_id AND t.person_id = q.person_id
          AND t.fact_key = ${TAKEN_KEY} || q.question_id)
      AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = q.org_id
        AND m.chat_id = q.chat_id AND m.principal_kind = 'person' AND m.person_id = q.person_id
        AND m.left_at IS NULL)
    ORDER BY q.raised_at, q.question_id`).map(toRow);
  let tried = 0;
  for (const row of owed) {
    if (tried >= TELL_PER_PASS) break;
    if ((yield* holdFor({ orgId, personId: row.personId, chatId: row.chatId })) !== undefined)
      continue;
    tried += 1;
    yield* sql
      .withTransaction(
        tellTaken(
          {
            orgId,
            questionId: row.questionId,
            agentId: row.agentId,
            personId: row.personId,
            chatId: row.chatId,
            label: row.defaultLabel!,
            question: row.question,
            about: row.about,
            now,
          },
          chat,
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin couldn't say a default was taken", {
            orgId,
            questionId: row.questionId,
            cause,
          }),
        ),
      );
  }
});

const lapse = Effect.fn("KinQuestions.lapse")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const moved = yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
    RETURNING question_id`;
  return moved.length > 0;
});

/** The pauses the runner keeps to: the company's (`isOrgPaused`) and the agent's own. */
const pausedFor = Effect.fn("KinQuestions.pausedFor")(function* (orgId: KinOrgId, agentId: string) {
  if (yield* isOrgPaused(orgId)) return true;
  const sql = yield* SqlClient.SqlClient;
  const paused = yield* sql`SELECT 1 FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND paused_at IS NOT NULL`;
  return paused.length > 0;
});

const takeDefault = Effect.fn("KinQuestions.takeDefault")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  // Paused, Kin or its asker, it stays due: the first pass after resume takes it.
  if (yield* pausedFor(orgId, row.agentId)) return false;
  // Never before its day, and at most once: only an open row past its day moves. `raised_at`
  // marks its person as owed the news (`tellDue`).
  const moved = yield* sql`UPDATE kin_questions SET state = 'default_taken', closed_at = ${now},
      raised_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      AND safe = 1 AND due_at <= ${now}
    RETURNING question_id`;
  if (moved.length === 0) return false;
  const option = row.options.find((one) => one.label === row.defaultLabel);
  const acts =
    row.widgetId !== null &&
    option !== undefined &&
    (yield* sealedOptions(orgId, row.widgetId)).has(option.optionId);
  const clock = yield* personClock(orgId, row.personId);
  if (acts) {
    // Its own action runs here, as the asker; one that no longer holds waits for its person.
    const plan = (yield* plansOf(orgId, row.widgetId!)).get(option!.optionId);
    const { takeAtDay } = yield* Effect.promise(() => import("../widgets/cardActions.ts"));
    const ran =
      plan !== undefined &&
      deps.records !== undefined &&
      (yield* takeAtDay(orgId, plan, row, deps.records));
    if (!ran) {
      yield* sql`UPDATE kin_questions SET state = 'open', closed_at = NULL, raised_at = NULL,
          safe = 0, act_at = ${raiseAt(row.dueAt, clock.zone, clock.days)}
        WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
      return true;
    }
  } else {
    const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
      FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
    const event = yield* decodeEvent({
      _tag: "deferral.due",
      eventId: takeEventId(orgId, row.questionId),
      orgId,
      agentId: row.agentId,
      receivedAt: iso(now),
      provenance: { _tag: "system" },
      dedupeKey: `question:${row.questionId}`,
      subject: { type: "question", questionId: row.questionId },
      lateByMs: Math.max(0, now - row.dueAt),
      ...(lead?.ownerChatId === row.chatId
        ? {}
        : { origin: { agentId: row.agentId, chatId: row.chatId, personId: row.personId } }),
    });
    yield* deps.queue.enqueue(event);
  }
  // The person's own notice says nobody answered (`tellTaken`): the card only reads as closed.
  const went = `Went with “${row.defaultLabel ?? ""}”`;
  for (const widgetId of cardIds(row))
    yield* deps.chat.closeReplaced({
      orgId,
      widgetId: KinWidgetId.make(widgetId),
      outcome: {
        title: went,
        text: acts ? `${went}.` : `${went}. Say "undo it" in the chat to reverse.`,
      },
    });
  return true;
});

const raise = Effect.fn("KinQuestions.raise")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
  chat: Pick<KinChatService["Service"], "closeReplaced" | "ask" | "notice">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string; threadId: string | null; retiredAt: string | null }>`
    SELECT a.owner_person_id AS owner, l.thread_id AS "threadId", a.retired_at AS "retiredAt"
    FROM kin_agents a LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId}`;
  // Nobody would ever answer it: it closes as retiring does, so a restore reopens it.
  if (agent?.retiredAt != null)
    return (
      (yield* closeHeldQuestions(
        {
          orgId,
          holder: { agentId: row.agentId },
          reason: (one) => retiredQuestionText(one.agentName),
          closedAt: Date.parse(agent.retiredAt),
        },
        chat,
      )) > 0
    );
  const moved = yield* sql`UPDATE kin_questions SET raised_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      AND raised_at IS NULL
    RETURNING question_id`;
  if (moved.length === 0 || row.options.length < 2) return moved.length > 0;
  if (agent === undefined || agent.threadId === null) return true;
  // An option that runs an action is drawn again, as a new card's; one that no longer holds is
  // left off, and a default left off leaves the raised card with none.
  const sealed =
    row.widgetId === null ? new Map<string, CardPlan>() : yield* plansOf(orgId, row.widgetId);
  const acting =
    row.widgetId === null ? new Set<string>() : yield* sealedOptions(orgId, row.widgetId);
  const offered: Array<{
    readonly label: string;
    readonly drawn?: Effect.Success<ReturnType<typeof CardActions.redraw>>;
  }> = [];
  let defaultLabel: string | null = null;
  // Loaded here: cardActions reaches KinChatService, which imports this module.
  const { redraw } = yield* Effect.promise(() => import("../widgets/cardActions.ts"));
  for (const option of row.options) {
    const plan = sealed.get(option.optionId);
    const drawn = plan === undefined ? undefined : yield* redraw(orgId, row.chatId, plan);
    if (acting.has(option.optionId) && drawn === undefined) continue;
    const label = drawn?.label ?? option.label;
    if (option.label === row.defaultLabel) defaultLabel = label;
    offered.push({ label, drawn });
  }
  if (defaultLabel !== row.defaultLabel)
    yield* sql`UPDATE kin_questions SET default_label = ${defaultLabel}
      WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  // Too few left for a card: the first card stays open, each tap on it checked as it runs. A
  // default left off is said once, so it is raised only once its person has heard.
  if (offered.length < 2) {
    if (row.defaultLabel !== null && defaultLabel === null) {
      const option = row.options.find((one) => one.label === row.defaultLabel);
      const plan = option === undefined ? undefined : sealed.get(option.optionId);
      yield* tellDeclined(
        {
          orgId,
          questionId: row.questionId,
          agentId: row.agentId,
          personId: row.personId,
          chatId: row.chatId,
          label: row.defaultLabel,
          recordId: plan !== undefined && "recordId" in plan ? plan.recordId : undefined,
        },
        chat,
      );
    }
    return true;
  }
  const clock = yield* personClock(orgId, row.personId);
  const asked = {
    question: oneLine(`${STILL_OPEN}${row.question}`, 240),
    detail: `${row.agentName} asked ${dayWord(row.askedAt, now, clock.zone)}. Nothing happens until you answer.`,
    options: offered.map((option) => ({ label: option.label })),
    actions: offered.map((option) => option.drawn),
    untilAnswered: true as const,
  };
  const card = yield* chat.ask(
    {
      _tag: "agent",
      orgId,
      agentId: row.agentId,
      ownerPersonId: KinPersonId.make(agent.owner),
      threadId: ThreadId.make(agent.threadId),
      hostPosted: true,
    },
    { ...asked, chatId: row.chatId, clientMessageId: `kin-question-raise:${row.questionId}` },
  );
  const options = choiceCardState(asked).options.map(({ optionId, label }) => ({
    optionId,
    label,
  }));
  yield* sealPlans({
    orgId,
    chatId: row.chatId,
    widgetId: card.widgetId,
    plans: offered.flatMap((option, index) =>
      option.drawn === undefined
        ? []
        : [{ optionId: options[index]!.optionId, plan: option.drawn.plan }],
    ),
    now,
  });
  yield* sql`UPDATE kin_questions SET raise_widget_id = ${card.widgetId},
      options_json = ${yield* encodeOptions(options).pipe(Effect.orDie)}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  if (row.widgetId !== null)
    yield* chat.closeReplaced({ orgId, widgetId: KinWidgetId.make(row.widgetId) });
  return true;
});

const personName = Effect.fn("KinQuestions.personName")(function* (
  orgId: KinOrgId,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  return row?.name ?? "them";
});

/** What the turn that takes a question's default is told; undefined when there is nothing to take. */
export const dueTurnText = Effect.fn("KinQuestions.dueTurnText")(function* (
  orgId: KinOrgId,
  questionId: string,
  now: number,
) {
  const row = yield* readQuestion(orgId, questionId);
  if (row === undefined || row.state !== "default_taken" || row.defaultLabel === null)
    return undefined;
  const clock = yield* personClock(orgId, row.personId);
  const who = yield* personName(orgId, row.personId);
  return {
    text: `Your question to ${who}, asked ${dayWord(row.askedAt, now, clock.zone)}, got no answer by its day, and its card now says you went with your default. Do “${row.defaultLabel}” now with your tools, inside the company only: anything that would send, post or move money stays on its Confirm card. Kin tells ${who} it went with “${row.defaultLabel}”, so don't say that again. Don't ask it again.`,
    data: {
      question: row.question,
      options: row.options.map((option) => option.label),
      default: row.defaultLabel,
      ...(row.about.length === 0 ? {} : { about: row.about }),
    },
  };
});

/** What the asker's turn is told when a default Kin took was undone; undefined when it wasn't. */
export const undoneTurnText = Effect.fn("KinQuestions.undoneTurnText")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const row = yield* readQuestion(orgId, questionId);
  // Open again: its person undid the answer its asker took from their words (`runAnswered`).
  if (row?.state === "open")
    return `Your question to ${yield* personName(orgId, row.personId)}, “${row.question}”: they undid the answer you took from their words, so it is open again on its card. Don't act on that answer; wait for theirs.`;
  if (row === undefined || row.state !== "default_taken" || row.defaultLabel === null)
    return undefined;
  return `Your question to ${yield* personName(orgId, row.personId)}, “${row.question}”, got no answer, so Kin took your default “${row.defaultLabel}”. It has now been undone: what it changed is back as it was. Don't do it again or ask the same again; ask anew only if it still needs deciding.`;
});

/**
 * Every open question to the person this chat is with, whoever asked: listed in each agent's turn
 * like facts already told, so no agent asks one again. Record keys only in owner-only turns.
 */
export const openQuestionsSection = Effect.fn("KinQuestions.section")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly ownerOnly: boolean;
  readonly now: number;
}) {
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const open = yield* openFor(input.orgId, personId);
  if (open.length === 0) return undefined;
  const clock = yield* personClock(input.orgId, personId);
  const who = yield* personName(input.orgId, personId);
  const lines = open.slice(-8).map((row) => {
    const tail =
      row.kind === "text"
        ? "asked in text: their next message in that chat answers it"
        : row.defaultLabel !== null && row.safe
          ? `default “${row.defaultLabel}” ${dayWord(row.dueAt, input.now, clock.zone)}`
          : row.raisedAt === null
            ? `no safe default: raised once more ${dayWord(row.actAt, input.now, clock.zone)}, then it waits for them`
            : "no safe default: waits for them";
    const about = input.ownerOnly && row.about.length > 0 ? ` (about ${row.about.join(", ")})` : "";
    return `- ${row.questionId}, ${row.agentName}, ${dayWord(row.askedAt, input.now, clock.zone).replace(/^on /, "")}: “${row.question}”${about}; ${tail}`;
  });
  return {
    heading: `# Open questions to ${who} (already asked; don't ask or repeat them)`,
    body: [
      "Like a fact already told, each is with them once: never put one to them again, on a card or in words; at most say it is open and what happens at its day. When they answer one in words, kin_ask_close it as answered; withdraw your own when it no longer stands.",
      ...lines,
    ].join("\n"),
  };
});

/**
 * At the end of a turn: when the agent's last words in a direct chat with one person ended on a
 * question, and it asked no card, that question is stored as open (`recordTextQuestion`).
 */
export const flagTextQuestion = Effect.fn("KinQuestions.flagText")(function* (wake: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const said = yield* sql<{ body: string; card: number }>`SELECT body,
      widget_id IS NOT NULL AS card FROM kin_messages
    WHERE org_id = ${wake.orgId} AND chat_id = ${wake.chatId} AND author_kind = 'agent'
      AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
      AND created_at >= ${iso(wake.startedAt)} AND status = 'posted'
    ORDER BY seq`;
  if (said.length === 0 || said.some((row) => row.card === 1)) return undefined;
  const question = endingQuestion(said.at(-1)!.body);
  if (question === undefined) return undefined;
  return yield* recordTextQuestion({
    orgId: wake.orgId,
    agentId: wake.agentId,
    chatId: wake.chatId,
    wakeupId: wake.wakeupId,
    question,
    now: yield* Clock.currentTimeMillis,
  });
});
